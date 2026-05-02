"""
image_reverse.py — Reverse image search.

Takes either:
  • path  — a local image file, or
  • url   — a public image URL

Queries Yandex (best results for generic images) and Google Lens, returning
visually-similar matches and the pages they appear on. Useful for finding:

  • The highest-resolution original of a known image
  • The source / context of an image (where it came from)
  • More images from the same photoshoot / series
  • Identifying a subject (landmark, product, plant, person)

Yandex's reverse endpoint accepts public URLs without auth; for local files
we upload via their form endpoint when possible, otherwise fall back to
serving the image through a temporary data URL + Google Lens.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
from pathlib import Path

from tools.web._common import fetch_sync


def execute(path: str = "", url: str = "", max_results: int = 15,
            engines: str = "yandex,google,bing", **kwargs) -> dict:
    start = time.time()
    if not path and not url:
        return _err("Provide either 'path' or 'url'.", "image_reverse", start)

    img_url = url.strip()
    if path and not img_url:
        # We need a public URL. If /workspace/images/... is inside the project,
        # we can't expose it — but many callers just want URL-based reverse.
        # For now require url; advise user.
        if not os.path.exists(path):
            return _err(f"File not found: {path}", "image_reverse", start)
        return _err(
            "Reverse search from a local file currently requires uploading. "
            "Host the image somewhere public and pass its URL instead.",
            "image_reverse", start,
        )

    active = [e.strip() for e in engines.split(",") if e.strip()]
    results = {}
    errors = []
    pages: list = []
    similar_images: list = []

    for eng in active:
        try:
            if eng == "yandex":
                data = _yandex(img_url, max_results)
            elif eng == "google":
                data = _google_lens(img_url, max_results)
            elif eng == "bing":
                data = _bing(img_url, max_results)
            else:
                continue
            results[eng] = data
            pages.extend(data.get("pages", []))
            similar_images.extend(data.get("similar", []))
        except Exception as e:
            errors.append(f"{eng}: {e}")

    # Dedup
    pages = _dedup(pages, key="url")[:max_results * 2]
    similar_images = _dedup(similar_images, key="url")[:max_results * 2]

    return {
        "status": "ok" if (pages or similar_images) else "error",
        "result": {
            "query_url": img_url,
            "engines": active,
            "pages": pages,
            "similar_images": similar_images,
            "by_engine": results,
            "errors": errors or None,
        },
        "error": None if (pages or similar_images) else f"No reverse hits. Errors: {'; '.join(errors[:3])}",
        "metadata": {"tool": "image_reverse", "duration_ms": _ms(start)},
    }


# ── Yandex reverse ───────────────────────────────────────────────────────────

def _yandex(img_url: str, limit: int) -> dict:
    q = urllib.parse.urlencode({"url": img_url, "rpt": "imageview"})
    url = f"https://yandex.com/images/search?{q}"
    res = fetch_sync(url, timeout=20, referer="https://yandex.com/",
                     use_cache=False)
    if not res.ok:
        raise RuntimeError(res.error or f"HTTP {res.status}")
    html = res.text

    pages: list = []
    similar: list = []

    # Pages where it appears
    for m in re.finditer(
        r'"sites"\s*:\s*\[(.*?)\]', html, re.DOTALL,
    ):
        blob = "[" + m.group(1) + "]"
        try:
            arr = json.loads(blob.replace("\\/", "/"))
            for s in arr[:limit * 2]:
                pages.append({
                    "title": s.get("title") or "",
                    "url": s.get("url") or s.get("originalUrl") or "",
                    "description": s.get("description") or "",
                    "image": s.get("thumb") or s.get("originalImage") or "",
                })
        except Exception:
            continue

    # Visually similar
    for m in re.findall(r'"img_href":"(https?:\\?/\\?/[^"]+)"', html):
        similar.append({"url": m.replace("\\/", "/")})
    if not similar:
        for m in re.findall(r'"origin":\{"url":"(https?:[^"]+)"', html):
            similar.append({"url": m.replace("\\/", "/")})

    # Extra: try the tags / description fields
    tags: list = []
    for m in re.findall(r'"tags"\s*:\s*\[(.*?)\]', html, re.DOTALL):
        for t in re.findall(r'"text":"([^"]+)"', m):
            tags.append(t)
    return {"pages": pages[:limit], "similar": similar[:limit], "tags": tags[:20]}


# ── Google Lens (URL form) ───────────────────────────────────────────────────

def _google_lens(img_url: str, limit: int) -> dict:
    q = urllib.parse.urlencode({"url": img_url})
    # Old image-search endpoint with image_url param
    url = f"https://www.google.com/searchbyimage?image_url={urllib.parse.quote_plus(img_url)}&client=app"
    res = fetch_sync(url, timeout=20, referer="https://www.google.com/",
                     use_cache=False)
    if not res.ok:
        raise RuntimeError(res.error or f"HTTP {res.status}")
    html = res.text

    pages: list = []
    similar: list = []
    for m in re.finditer(
        r'<a[^>]+href="(https?://[^"#]+)"[^>]*>.*?<h3[^>]*>(.*?)</h3>',
        html, re.DOTALL,
    ):
        href = m.group(1)
        if "google.com" in href and "/search" in href:
            continue
        pages.append({"url": href, "title": _clean(m.group(2))})
        if len(pages) >= limit:
            break
    for m in re.findall(r'"ou":"(https?://[^"]+)"', html):
        similar.append({"url": m})
    return {"pages": pages[:limit], "similar": similar[:limit]}


# ── Bing visual search ───────────────────────────────────────────────────────

def _bing(img_url: str, limit: int) -> dict:
    q = urllib.parse.urlencode({"q": "imgurl:" + img_url, "view": "detailv2",
                                "iss": "sbi"})
    url = f"https://www.bing.com/images/search?{q}"
    res = fetch_sync(url, timeout=20, referer="https://www.bing.com/",
                     use_cache=False)
    if not res.ok:
        raise RuntimeError(res.error or f"HTTP {res.status}")
    html = res.text
    pages: list = []
    similar: list = []
    for m in re.findall(r'"murl":"(https?:[^"]+)"', html):
        similar.append({"url": m.replace("\\/", "/")})
    for m in re.findall(r'"purl":"(https?:[^"]+)"', html):
        pages.append({"url": m.replace("\\/", "/")})
    return {"pages": pages[:limit], "similar": similar[:limit]}


# ── Helpers ──────────────────────────────────────────────────────────────────

def _clean(s: str) -> str:
    import html as html_mod
    s = re.sub(r"<[^>]+>", "", s)
    return html_mod.unescape(re.sub(r"\s+", " ", s)).strip()


def _dedup(items: list, key: str) -> list:
    seen = set()
    out = []
    for it in items:
        k = (it.get(key) or "").strip().rstrip("/")
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(it)
    return out


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
