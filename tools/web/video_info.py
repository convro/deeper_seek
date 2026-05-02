"""
video_info.py — Video metadata + transcript extraction.

Supported sources (auto-detected from URL):
  • YouTube     — metadata via oEmbed + watch page, transcripts via
                  timedtext API (no login, no API key needed).
  • Vimeo       — metadata via oEmbed.
  • Generic     — extracts og:video / og:title / og:description when possible.

Features:
  • Auto-detect language, optional language preference, auto-translation.
  • Returns both segmented (with timestamps) and plain-text transcript.
  • Related videos from the watch page (best effort, YouTube only).
  • Graceful degradation when transcript is unavailable.

Args:
  url, transcript (default True), lang (e.g. "en"), translate_to, timeout,
  max_related, max_transcript_chars

Returns:
  {status, result: {
      source, video_id, title, description, channel, duration, views,
      published, thumbnail, url,
      transcript: {language, auto_generated, translated,
                   segments: [{start, dur, text}], text},
      related: [{id, title, channel, url}]
  }, error, metadata}
"""

from __future__ import annotations

import html as _html
import json
import re
import time
from urllib.parse import parse_qs, quote, urlparse

MAX_TRANSCRIPT = 80_000


def execute(url: str, transcript: bool = True, lang: str = "",
            translate_to: str = "", timeout: int = 20,
            max_related: int = 10, max_transcript_chars: int = MAX_TRANSCRIPT,
            **kwargs) -> dict:
    start = time.time()
    try:
        import httpx  # type: ignore
    except ImportError:
        return _err("httpx required", start)

    url = (url or "").strip()
    if not url:
        return _err("url is required", start)

    source, vid = _detect(url)
    try:
        if source == "youtube":
            data = _youtube(vid, transcript, lang, translate_to,
                            timeout, max_related, max_transcript_chars)
        elif source == "vimeo":
            data = _vimeo(url, timeout)
        else:
            data = _generic(url, timeout)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}", start)

    data["source"] = source
    return {"status": "ok", "result": data, "error": None,
            "metadata": {"tool": "video_info",
                         "duration_ms": int((time.time() - start) * 1000)}}


# ── URL detection ───────────────────────────────────────────────────────────

def _detect(url: str) -> tuple[str, str]:
    u = urlparse(url)
    host = (u.hostname or "").lower()
    if "youtube.com" in host or "youtu.be" in host or "youtube-nocookie.com" in host:
        return "youtube", _yt_id(url)
    if "vimeo.com" in host:
        return "vimeo", (u.path.strip("/").split("/")[0] or "")
    return "generic", ""


def _yt_id(url: str) -> str:
    u = urlparse(url)
    host = (u.hostname or "").lower()
    if "youtu.be" in host:
        return u.path.lstrip("/").split("/")[0]
    if u.path == "/watch":
        return parse_qs(u.query).get("v", [""])[0]
    parts = u.path.strip("/").split("/")
    if parts and parts[0] in ("shorts", "embed", "v", "live") and len(parts) > 1:
        return parts[1]
    return ""


# ── YouTube ─────────────────────────────────────────────────────────────────

_YT_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/125 Safari/537.36")


def _youtube(vid: str, want_tx: bool, lang: str, translate_to: str,
             timeout: int, max_related: int, max_chars: int) -> dict:
    import httpx  # type: ignore
    if not vid:
        raise ValueError("could not extract YouTube video id")

    watch = f"https://www.youtube.com/watch?v={vid}"
    with httpx.Client(timeout=timeout, follow_redirects=True,
                      headers={"User-Agent": _YT_UA,
                               "Accept-Language": "en-US,en;q=0.9"}) as c:
        r = c.get(watch)
        html = r.text if r.status_code < 400 else ""
        # oEmbed: title, author, thumbnail
        oembed = {}
        try:
            oe = c.get(f"https://www.youtube.com/oembed"
                       f"?url={quote(watch, safe='')}&format=json")
            if oe.status_code < 400:
                oembed = oe.json()
        except Exception:
            pass

    # Parse ytInitialPlayerResponse
    meta = _parse_yt_player(html)
    vd = meta.get("videoDetails", {}) or {}
    mfmt = meta.get("microformat", {}) or {}
    pmr = (mfmt.get("playerMicroformatRenderer") or {})

    info = {
        "video_id": vid,
        "title": vd.get("title") or oembed.get("title") or "",
        "description": vd.get("shortDescription") or "",
        "channel": vd.get("author") or oembed.get("author_name") or "",
        "channel_url": oembed.get("author_url"),
        "duration": _safe_int(vd.get("lengthSeconds")),
        "views": _safe_int(vd.get("viewCount")),
        "is_live": vd.get("isLiveContent"),
        "thumbnail": oembed.get("thumbnail_url")
                     or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
        "url": watch,
        "published": pmr.get("publishDate"),
        "category": pmr.get("category"),
        "keywords": vd.get("keywords", [])[:20] if isinstance(vd.get("keywords"), list) else [],
    }

    if want_tx:
        try:
            info["transcript"] = _yt_transcript(meta, lang, translate_to,
                                                timeout, max_chars)
        except Exception as e:
            info["transcript"] = {"error": str(e)}

    if max_related > 0:
        try:
            info["related"] = _yt_related(html, max_related)
        except Exception:
            info["related"] = []

    return info


def _parse_yt_player(html: str) -> dict:
    m = re.search(r"var ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*var",
                  html, re.DOTALL)
    if not m:
        m = re.search(r"ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;",
                      html, re.DOTALL)
    if not m:
        return {}
    try:
        return json.loads(m.group(1))
    except Exception:
        return {}


def _yt_transcript(player: dict, lang: str, translate_to: str,
                   timeout: int, max_chars: int) -> dict:
    import httpx  # type: ignore
    ct = (((player.get("captions") or {})
           .get("playerCaptionsTracklistRenderer") or {})
          .get("captionTracks") or [])
    if not ct:
        return {"error": "no captions available"}

    # Choose track
    track = None
    if lang:
        for t in ct:
            if (t.get("languageCode") or "").lower() == lang.lower():
                track = t; break
    if not track:
        # Prefer manual over auto
        manual = [t for t in ct if (t.get("kind") or "") != "asr"]
        track = (manual or ct)[0]

    base = track.get("baseUrl") or ""
    if not base:
        return {"error": "no baseUrl"}
    if translate_to:
        base += f"&tlang={translate_to}"

    with httpx.Client(timeout=timeout,
                      headers={"User-Agent": _YT_UA}) as c:
        r = c.get(base)
    if r.status_code >= 400:
        return {"error": f"HTTP {r.status_code}"}

    segs = _parse_timedtext_xml(r.text)
    text = " ".join(s["text"] for s in segs if s["text"]).strip()
    if len(text) > max_chars:
        text = text[:max_chars] + "…"

    return {
        "language": track.get("languageCode"),
        "language_name": (track.get("name") or {}).get("simpleText"),
        "auto_generated": (track.get("kind") == "asr"),
        "translated": bool(translate_to),
        "segments": segs[:1500],
        "text": text,
    }


def _parse_timedtext_xml(xml: str) -> list:
    out = []
    for m in re.finditer(
        r'<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>(.*?)</text>',
        xml, re.DOTALL,
    ):
        start = float(m.group(1))
        dur = float(m.group(2)) if m.group(2) else 0.0
        raw = m.group(3)
        # unescape + strip tags
        txt = _html.unescape(re.sub(r"<[^>]+>", "", raw))
        txt = re.sub(r"\s+", " ", txt).strip()
        if txt:
            out.append({"start": round(start, 2),
                        "dur": round(dur, 2), "text": txt})
    return out


def _yt_related(html: str, limit: int) -> list:
    m = re.search(r"var ytInitialData\s*=\s*(\{.+?\});\s*</script>",
                  html, re.DOTALL)
    if not m:
        return []
    try:
        data = json.loads(m.group(1))
    except Exception:
        return []
    out = []
    stack = [data]
    while stack and len(out) < limit * 3:
        node = stack.pop()
        if isinstance(node, dict):
            cvr = node.get("compactVideoRenderer")
            if isinstance(cvr, dict):
                vid = cvr.get("videoId")
                title = _text(cvr.get("title"))
                channel = _text(cvr.get("longBylineText"))
                if vid and title:
                    out.append({"id": vid, "title": title,
                                "channel": channel,
                                "url": f"https://www.youtube.com/watch?v={vid}"})
            for v in node.values():
                if isinstance(v, (dict, list)):
                    stack.append(v)
        elif isinstance(node, list):
            stack.extend(node)
    # De-dup
    seen = set(); uniq = []
    for r in out:
        if r["id"] in seen: continue
        seen.add(r["id"]); uniq.append(r)
        if len(uniq) >= limit: break
    return uniq


def _text(node) -> str:
    if not isinstance(node, dict): return ""
    if "simpleText" in node: return node["simpleText"]
    runs = node.get("runs") or []
    return "".join(r.get("text", "") for r in runs if isinstance(r, dict))


# ── Vimeo ───────────────────────────────────────────────────────────────────

def _vimeo(url: str, timeout: int) -> dict:
    import httpx  # type: ignore
    with httpx.Client(timeout=timeout, follow_redirects=True,
                      headers={"User-Agent": _YT_UA}) as c:
        r = c.get(f"https://vimeo.com/api/oembed.json"
                  f"?url={quote(url, safe='')}")
    if r.status_code >= 400:
        raise RuntimeError(f"vimeo oembed HTTP {r.status_code}")
    d = r.json()
    return {
        "video_id": str(d.get("video_id", "")),
        "title": d.get("title"),
        "description": d.get("description"),
        "channel": d.get("author_name"),
        "channel_url": d.get("author_url"),
        "duration": d.get("duration"),
        "thumbnail": d.get("thumbnail_url"),
        "url": url,
        "published": d.get("upload_date"),
    }


# ── Generic og:video ────────────────────────────────────────────────────────

def _generic(url: str, timeout: int) -> dict:
    import httpx  # type: ignore
    with httpx.Client(timeout=timeout, follow_redirects=True,
                      headers={"User-Agent": _YT_UA}) as c:
        r = c.get(url)
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}")
    html = r.text
    def og(prop):
        m = re.search(
            rf'<meta[^>]+property=["\']{re.escape(prop)}["\'][^>]+content=["\']([^"\']+)',
            html, re.IGNORECASE)
        if m: return _html.unescape(m.group(1))
        m = re.search(
            rf'<meta[^>]+name=["\']{re.escape(prop)}["\'][^>]+content=["\']([^"\']+)',
            html, re.IGNORECASE)
        return _html.unescape(m.group(1)) if m else None
    title_m = re.search(r"<title[^>]*>(.*?)</title>", html,
                        re.IGNORECASE | re.DOTALL)
    return {
        "video_id": "",
        "title": og("og:title") or (title_m.group(1).strip() if title_m else ""),
        "description": og("og:description") or og("description") or "",
        "channel": og("og:site_name") or "",
        "thumbnail": og("og:image") or og("og:video:image"),
        "video_file": og("og:video") or og("og:video:url") or og("og:video:secure_url"),
        "url": url,
        "published": og("article:published_time"),
    }


# ── Helpers ─────────────────────────────────────────────────────────────────

def _safe_int(v):
    try: return int(v)
    except (TypeError, ValueError): return None


def _err(msg, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": "video_info",
                         "duration_ms": int((time.time() - start) * 1000)}}
