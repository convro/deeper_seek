"""
image_search.py — Find and download high-quality images from the open web.

Sources (queried in parallel; editorial/wiki/news first, stock last):
  • Google Images          — broad index, best for specific things
  • Bing Images            — large index, good metadata
  • DuckDuckGo Images      — privacy proxy
  • Yandex Images          — strong for photos & reverse lookups
  • Wikimedia Commons      — high-res, editorial, well-described
  • Flickr                 — real photography, huge variety
  • Pexels / Unsplash / Pixabay — polished stock (used last, deprioritized)

Pipeline: gather candidates → flip rank (editorial > stock) → parallel
download → validate (dims, magic bytes) → perceptual-hash dedup → drop blurry
→ strip EXIF → score → return best N.

Pass a natural query. You can also use dork-style operators in `query`
(e.g. `site:wikimedia.org "sukiennice krakow"`) — they'll be forwarded.
"""

from __future__ import annotations

import html as html_mod
import os
import re
import time
import urllib.parse
from pathlib import Path

from tools.web._common import fetch_sync, normalize_url, domain_of
from tools.web._images import (
    download_many, STOCK_HOSTS, PREFERRED_HOSTS,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


def execute(query: str, num_images: int = 6, save_dir: str = "",
            min_width: int = 900, min_height: int = 600,
            orientation: str = "any",
            sources: str = "auto", avoid_stock: bool = True,
            normalize: bool = False,
            **kwargs) -> dict:
    """
    Search the web for real photographs/images and download the best ones.

    Args:
      query:       What to look for. Natural language + dork operators welcome.
      num_images:  Final count to keep (1-25).
      save_dir:    Target directory. Auto-created. Defaults to
                   workspace/images/<slug>/.
      min_width:   Minimum accepted image width.
      min_height:  Minimum accepted image height.
      orientation: "any" | "landscape" | "portrait" | "square".
      sources:     "auto" (all) | comma-separated: google,bing,ddg,yandex,
                   wikimedia,flickr,pexels,unsplash,pixabay
      avoid_stock: If True (default), deprioritize stock hosts; once 3+ non-stock
                   images found, skip remaining stock candidates.
      normalize:   Convert webp/avif to jpg/png for downstream compatibility.
    """
    start = time.time()
    num_images = max(1, min(num_images, 25))
    if not save_dir:
        slug = re.sub(r"[^a-z0-9]+", "_", query.lower().strip())[:60] or "images"
        save_dir = str(PROJECT_ROOT / "workspace" / "images" / slug)
    os.makedirs(save_dir, exist_ok=True)

    if sources == "auto":
        active = ["wikimedia", "flickr", "google", "bing", "ddg", "yandex",
                  "unsplash", "pexels", "pixabay"]
    else:
        active = [s.strip().lower() for s in sources.split(",") if s.strip()]

    # ── Gather candidate URLs in parallel via threads ────────────────────────
    import concurrent.futures
    candidates: list = []
    errors: list = []
    by_source: dict = {}

    source_fns = {
        "google": _google_images,
        "bing": _bing_images,
        "ddg": _ddg_images,
        "yandex": _yandex_images,
        "wikimedia": _wikimedia_images,
        "flickr": _flickr_images,
        "unsplash": _unsplash,
        "pexels": _pexels,
        "pixabay": _pixabay,
    }

    target_candidates = max(num_images * 6, 30)
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(active))) as pool:
        futs = {pool.submit(source_fns[s], query, target_candidates, orientation): s
                for s in active if s in source_fns}
        for fut in concurrent.futures.as_completed(futs):
            s = futs[fut]
            try:
                urls = fut.result() or []
                by_source[s] = len(urls)
                candidates.extend(urls)
            except Exception as e:
                by_source[s] = 0
                errors.append(f"{s}: {e}")

    # Dedup while preserving order (by source priority)
    seen: set = set()
    unique: list = []
    for u in candidates:
        n = normalize_url(u)
        if n in seen:
            continue
        seen.add(n)
        unique.append(n)

    # ── Download + filter ────────────────────────────────────────────────────
    infos = download_many(
        unique, save_dir=save_dir, target_n=num_images,
        referer="https://www.google.com/", min_width=min_width,
        min_height=min_height, avoid_stock=avoid_stock,
    )

    if normalize:
        from tools.web._images import normalize_format
        for info in infos:
            info["path"] = normalize_format(info["path"])

    out_items = [{
        "path": i["path"],
        "url": i.get("source_url", ""),
        "width": i.get("width"),
        "height": i.get("height"),
        "size_kb": i.get("size_kb"),
        "format": i.get("format"),
        "score": i.get("score"),
        "preferred": i.get("preferred"),
        "stock": i.get("stock"),
        "domain": domain_of(i.get("source_url", "")),
    } for i in infos]

    return {
        "status": "ok" if out_items else "error",
        "result": {
            "query": query,
            "count": len(out_items),
            "images": out_items,
            "save_dir": save_dir,
            "sources_tried": active,
            "candidates_per_source": by_source,
            "total_candidates": len(unique),
            "errors": errors[:4] if errors else None,
        },
        "error": None if out_items else f"No images passed filters. Errors: {'; '.join(errors[:3])}",
        "metadata": {"tool": "image_search", "duration_ms": _ms(start)},
    }


# ── Sources: Google Images ───────────────────────────────────────────────────

def _google_images(query: str, num: int, orientation: str = "any") -> list:
    encoded = urllib.parse.quote_plus(query)
    orient = ""
    if orientation == "landscape":
        orient = ",iar:w"
    elif orientation == "portrait":
        orient = ",iar:t"
    elif orientation == "square":
        orient = ",iar:s"
    url = f"https://www.google.com/search?q={encoded}&tbm=isch&tbs=isz:l{orient}&hl=en"
    res = fetch_sync(url, timeout=15, referer="https://www.google.com/")
    if not res.ok:
        return []
    html = res.text
    urls: list = []
    for rx in (
        r'\["(https?://[^"]+\.(?:jpg|jpeg|png|webp|gif|avif)(?:\?[^"]*)?)",[0-9]+,[0-9]+\]',
        r'"ou":"(https?://[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?)"',
        r'imgurl=(https?%3A%2F%2F[^&]+\.(?:jpg|jpeg|png|webp))',
    ):
        for m in re.findall(rx, html, re.IGNORECASE):
            u = urllib.parse.unquote(m) if "%3A" in m else m
            if _valid_img_url(u):
                urls.append(u)
            if len(urls) >= num:
                return urls
    # Broad fallback — any absolute image URL on the page
    if len(urls) < num:
        for m in re.findall(
            r'(https?://[^\s"\'<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^\s"\'<>]*)?)',
            html, re.IGNORECASE,
        ):
            if _valid_img_url(m) and m not in urls:
                urls.append(m)
            if len(urls) >= num:
                break
    return urls


# ── Sources: Bing Images ─────────────────────────────────────────────────────

def _bing_images(query: str, num: int, orientation: str = "any") -> list:
    encoded = urllib.parse.quote_plus(query)
    orient = ""
    if orientation == "landscape":
        orient = "+filterui:aspect-wide"
    elif orientation == "portrait":
        orient = "+filterui:aspect-tall"
    elif orientation == "square":
        orient = "+filterui:aspect-square"
    url = (f"https://www.bing.com/images/search?q={encoded}{orient}"
           f"&qft=+filterui:imagesize-large&form=IRFLTR")
    res = fetch_sync(url, timeout=15, referer="https://www.bing.com/")
    if not res.ok:
        return []
    html = res.text
    urls: list = []
    # Bing embeds a JSON "m" attr with real URL under "murl"
    for m in re.findall(r'"murl":"(https?:[^"]+)"', html):
        u = m.replace("\\/", "/")
        if _valid_img_url(u):
            urls.append(u)
        if len(urls) >= num:
            break
    if len(urls) < num:
        for m in re.findall(
            r'mediaurl=(https?%3A%2F%2F[^&"]+)', html, re.IGNORECASE,
        ):
            u = urllib.parse.unquote(m)
            if _valid_img_url(u) and u not in urls:
                urls.append(u)
            if len(urls) >= num:
                break
    return urls


# ── Sources: DuckDuckGo Images ───────────────────────────────────────────────

def _ddg_images(query: str, num: int, orientation: str = "any") -> list:
    # DDG requires a vqd token. Fetch the search page first.
    q = urllib.parse.quote_plus(query)
    res0 = fetch_sync(f"https://duckduckgo.com/?q={q}&iar=images&iax=images&ia=images",
                      timeout=15, referer="https://duckduckgo.com/")
    if not res0.ok:
        return []
    vqd_m = re.search(r'vqd="([\w\d-]+)"', res0.text) or re.search(r'vqd=([\w\d-]+)', res0.text)
    vqd = vqd_m.group(1) if vqd_m else ""
    if not vqd:
        return []
    size = "Large" if orientation != "square" else ""
    api = (f"https://duckduckgo.com/i.js?l=us-en&o=json&q={q}&vqd={vqd}"
           f"&f=,,,type:photo,{'size:' + size if size else ''}&p=1")
    res = fetch_sync(api, timeout=15,
                     referer=f"https://duckduckgo.com/?q={q}&iar=images",
                     headers={"X-Requested-With": "XMLHttpRequest"})
    if not res.ok:
        return []
    import json as _json
    try:
        data = _json.loads(res.text)
    except Exception:
        return []
    urls: list = []
    for r in data.get("results", []):
        u = r.get("image") or r.get("url")
        if u and _valid_img_url(u):
            urls.append(u)
        if len(urls) >= num:
            break
    return urls


# ── Sources: Yandex Images ───────────────────────────────────────────────────

def _yandex_images(query: str, num: int, orientation: str = "any") -> list:
    encoded = urllib.parse.quote_plus(query)
    url = f"https://yandex.com/images/search?text={encoded}&isize=large"
    res = fetch_sync(url, timeout=15, referer="https://yandex.com/")
    if not res.ok:
        return []
    html = res.text
    urls: list = []
    # Yandex serves a JSON blob inside data-state attribute
    for m in re.findall(r'"img_href":"(https?:\\?/\\?/[^"]+)"', html):
        u = m.replace("\\/", "/").replace("\\u0026", "&")
        if _valid_img_url(u):
            urls.append(u)
        if len(urls) >= num:
            break
    if len(urls) < num:
        for m in re.findall(r'"origin":\{"url":"(https?:[^"]+)"', html):
            u = m.replace("\\/", "/")
            if _valid_img_url(u) and u not in urls:
                urls.append(u)
            if len(urls) >= num:
                break
    return urls


# ── Sources: Wikimedia Commons ───────────────────────────────────────────────

def _wikimedia_images(query: str, num: int, orientation: str = "any") -> list:
    """Wikimedia API — original (full-resolution) image URLs, well-curated."""
    params = {
        "action": "query", "format": "json", "generator": "search",
        "gsrnamespace": "6", "gsrsearch": query, "gsrlimit": str(min(num * 2, 50)),
        "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata",
        "iiurlwidth": "1600",
    }
    url = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params)
    res = fetch_sync(url, timeout=15)
    if not res.ok:
        return []
    import json as _json
    try:
        data = _json.loads(res.text)
    except Exception:
        return []
    urls: list = []
    pages = (data.get("query") or {}).get("pages") or {}
    for p in pages.values():
        ii = (p.get("imageinfo") or [{}])[0]
        u = ii.get("url") or ii.get("thumburl")
        mime = ii.get("mime", "")
        if u and mime.startswith("image/") and "svg" not in mime:
            urls.append(u)
        if len(urls) >= num:
            break
    return urls


# ── Sources: Flickr ──────────────────────────────────────────────────────────

def _flickr_images(query: str, num: int, orientation: str = "any") -> list:
    encoded = urllib.parse.quote_plus(query)
    url = f"https://www.flickr.com/search/?text={encoded}&view_all=1&dimension_search_mode=min&height=1024&width=1024"
    res = fetch_sync(url, timeout=15, referer="https://www.flickr.com/")
    if not res.ok:
        return []
    html = res.text
    urls: list = []
    for m in re.findall(r'"url_[lkhob]":"(\\?/\\?/live\.staticflickr\.com[^"]+)"', html):
        u = "https:" + m.replace("\\/", "/")
        if _valid_img_url(u) and u not in urls:
            urls.append(u)
        if len(urls) >= num:
            break
    if len(urls) < num:
        for m in re.findall(r'https?://live\.staticflickr\.com/[^"\'\s>]+\.(?:jpg|png|webp)', html):
            if _valid_img_url(m) and m not in urls:
                # Bump to large via _b or _k suffix heuristic
                urls.append(_flickr_upscale(m))
            if len(urls) >= num:
                break
    return urls


def _flickr_upscale(u: str) -> str:
    # Flickr URLs: …_<id>_<size>.jpg where size b=1024, h=1600, k=2048
    return re.sub(r"_([a-z])\.", "_b.", u, count=1) if re.search(r"_[a-z]\.", u) else u


# ── Sources: Pexels / Unsplash / Pixabay (stock; kept low priority) ──────────

def _pexels(query: str, num: int, orientation: str = "any") -> list:
    encoded = urllib.parse.quote_plus(query)
    orient_path = ""
    if orientation == "landscape":
        orient_path = "&orientation=landscape"
    elif orientation == "portrait":
        orient_path = "&orientation=portrait"
    url = f"https://www.pexels.com/search/{encoded}/?size=large{orient_path}"
    res = fetch_sync(url, timeout=15, referer="https://www.pexels.com/")
    if not res.ok:
        return []
    html = res.text
    urls: list = []
    for m in re.findall(r'"(https://images\.pexels\.com/photos/\d+/[^"?]+)"', html):
        urls.append(f"{m}?auto=compress&cs=tinysrgb&w=1920")
        if len(urls) >= num:
            break
    return urls


def _unsplash(query: str, num: int, orientation: str = "any") -> list:
    encoded = urllib.parse.quote_plus(query)
    orient = ""
    if orientation in ("landscape", "portrait", "squarish"):
        orient = f"&orientation={orientation}"
    elif orientation == "square":
        orient = "&orientation=squarish"
    url = f"https://unsplash.com/s/photos/{encoded}?per_page=30{orient}"
    res = fetch_sync(url, timeout=15, referer="https://unsplash.com/")
    if not res.ok:
        return []
    html = res.text
    urls: list = []
    for m in re.findall(r'"(https://images\.unsplash\.com/photo-[^"?]+)"', html):
        clean = f"{m}?w=1920&q=85&auto=format"
        if clean not in urls:
            urls.append(clean)
        if len(urls) >= num:
            break
    return urls


def _pixabay(query: str, num: int, orientation: str = "any") -> list:
    encoded = urllib.parse.quote_plus(query)
    orient = ""
    if orientation == "landscape":
        orient = "&orientation=horizontal"
    elif orientation == "portrait":
        orient = "&orientation=vertical"
    url = f"https://pixabay.com/images/search/{encoded}/?min_width=1920{orient}"
    res = fetch_sync(url, timeout=15, referer="https://pixabay.com/")
    if not res.ok:
        return []
    html = res.text
    urls: list = []
    for m in re.findall(r'(https://cdn\.pixabay\.com/photo/[^"\s]+\.(?:jpg|png|webp))', html):
        if any(t in m for t in ("_150.", "_180.", "_340.")):
            continue
        if m not in urls:
            urls.append(m)
        if len(urls) >= num:
            break
    return urls


# ── URL sanity ───────────────────────────────────────────────────────────────

def _valid_img_url(u: str) -> bool:
    if not u or len(u) > 2000 or not u.startswith("http"):
        return False
    low = u.lower()
    skip = (
        "gstatic.com/images", "google.com/images", "googleusercontent.com/favicon",
        "pinimg.com/originals", "/favicon", "/sprite", "/icon-", "/logo-", "/1x1.",
        "base64,", "data:image",
    )
    if any(s in low for s in skip):
        return False
    return True


def _ms(start):
    return int((time.time() - start) * 1000)
