"""
page_images.py — Scrape ALL images from a single web page.

Finds images in:
  • <img src> and srcset (picks highest-res variant)
  • <picture><source srcset>
  • <link rel="preload" as="image">
  • CSS background-image in <style> tags and inline styles
  • og:image / twitter:image meta tags
  • JSON-LD `image` fields
  • Generic hrefs/URLs that end with .jpg/.png/.webp/etc.

Optionally downloads them to disk with the same quality/dedup pipeline
used by `image_search`.
"""

from __future__ import annotations

import html as html_mod
import json
import os
import re
import time
import urllib.parse
from pathlib import Path

from tools.web._common import fetch_sync, normalize_url, domain_of, absolutize
from tools.web._extract import extract_jsonld, extract_metadata
from tools.web._images import download_many

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

_IMG_EXT_RX = re.compile(
    r'https?://[^\s"\'<>]+\.(?:jpg|jpeg|png|webp|gif|avif)(?:\?[^\s"\'<>]*)?',
    re.IGNORECASE,
)
_IMG_TAG_RX = re.compile(r"<img\b[^>]+>", re.IGNORECASE)
_ATTR_RX = re.compile(r'(\w[\w:-]*)\s*=\s*"([^"]*)"')
_SOURCE_TAG_RX = re.compile(r"<source\b[^>]+srcset=['\"]([^'\"]+)['\"]", re.IGNORECASE)
_PRELOAD_RX = re.compile(
    r"<link[^>]+rel=['\"]preload['\"][^>]+as=['\"]image['\"][^>]+href=['\"]([^'\"]+)['\"]",
    re.IGNORECASE,
)
_STYLE_BG_RX = re.compile(
    r'background(?:-image)?\s*:\s*url\((["\']?)([^"\')]+)\1\)', re.IGNORECASE,
)


def execute(url: str, download: bool = False, save_dir: str = "",
            max_download: int = 20, min_width: int = 400, min_height: int = 300,
            include_hero: bool = True, use_browser: bool = False,
            timeout: int = 20, **kwargs) -> dict:
    """
    Args:
      url:           Page URL to scan.
      download:      If True, download images to save_dir.
      save_dir:      Directory for downloaded images (auto-created).
                     Defaults to workspace/images/<domain>/.
      max_download:  Upper bound on downloads.
      min_width/height: Size filters when downloading.
      include_hero:  Also include og:image/twitter:image and JSON-LD images.
      use_browser:   Render with Playwright before scraping (for JS-heavy pages).
    """
    start = time.time()

    if use_browser:
        from tools.web import web_browse as wb
        b = wb.execute(url, screenshot=False, return_html=True,
                       extract=False, scroll=True)
        if b.get("status") != "ok":
            return _err(b.get("error") or "browse failed", "page_images", start, url=url)
        data = b["result"]
        html = data.get("html", "")
        final_url = data.get("url") or url
        browser_imgs = [i.get("url") for i in data.get("images", []) if i.get("url")]
    else:
        res = fetch_sync(url, timeout=timeout, use_cache=True)
        if not res.ok:
            return _err(res.error or "fetch failed", "page_images", start, url=url)
        html = res.text
        final_url = res.final_url or url
        browser_imgs = []

    candidates = _collect_candidates(html, final_url, include_hero=include_hero)
    if browser_imgs:
        for u in browser_imgs:
            if u not in candidates:
                candidates.append(u)

    candidates = [normalize_url(u) for u in candidates]
    # Dedup preserving order
    seen: set = set()
    unique = []
    for u in candidates:
        if u in seen:
            continue
        seen.add(u)
        unique.append(u)

    saved: list = []
    if download and unique:
        if not save_dir:
            slug = domain_of(final_url).replace(".", "_") or "images"
            save_dir = str(PROJECT_ROOT / "workspace" / "images" / slug)
        os.makedirs(save_dir, exist_ok=True)
        infos = download_many(
            unique, save_dir=save_dir, target_n=max_download,
            referer=final_url, min_width=min_width, min_height=min_height,
            avoid_stock=False,  # On-page scrape — keep whatever's there
        )
        saved = [{
            "path": i["path"],
            "url": i.get("source_url"),
            "width": i.get("width"),
            "height": i.get("height"),
            "size_kb": i.get("size_kb"),
            "score": i.get("score"),
        } for i in infos]

    return {
        "status": "ok",
        "result": {
            "url": final_url,
            "found": len(unique),
            "image_urls": unique[:500],
            "downloaded": saved,
            "save_dir": save_dir if download else None,
        },
        "error": None,
        "metadata": {"tool": "page_images", "duration_ms": _ms(start)},
    }


# ── Collection ───────────────────────────────────────────────────────────────

def _collect_candidates(html: str, base_url: str, include_hero: bool = True) -> list:
    urls: list = []

    # 1. <img>
    for tag in _IMG_TAG_RX.findall(html):
        attrs = dict(_ATTR_RX.findall(tag))
        src = (attrs.get("src") or attrs.get("data-src") or
               attrs.get("data-original") or attrs.get("data-lazy-src") or "")
        srcset = attrs.get("srcset") or attrs.get("data-srcset") or ""
        if src:
            urls.append(absolutize(base_url, html_mod.unescape(src)))
        if srcset:
            best = _best_from_srcset(srcset)
            if best:
                urls.append(absolutize(base_url, html_mod.unescape(best)))

    # 2. <picture><source srcset>
    for srcset in _SOURCE_TAG_RX.findall(html):
        best = _best_from_srcset(srcset)
        if best:
            urls.append(absolutize(base_url, html_mod.unescape(best)))

    # 3. <link rel=preload as=image>
    for href in _PRELOAD_RX.findall(html):
        urls.append(absolutize(base_url, html_mod.unescape(href)))

    # 4. CSS backgrounds
    for _q, u in _STYLE_BG_RX.findall(html):
        urls.append(absolutize(base_url, html_mod.unescape(u)))

    # 5. Meta images
    if include_hero:
        meta = extract_metadata(html)
        hero = meta.get("image")
        if hero:
            urls.append(absolutize(base_url, hero))
        for k, v in (meta.get("all") or {}).items():
            if isinstance(v, str) and ("image" in k and v.startswith("http")):
                urls.append(v)

    # 6. JSON-LD images
    if include_hero:
        for block in extract_jsonld(html):
            _dig_images(block, base_url, urls)

    # 7. Loose scan of any URL ending in .jpg/.png/.webp/... in HTML text
    for m in _IMG_EXT_RX.findall(html):
        urls.append(m)

    # 8. Filter obvious junk
    return [u for u in urls if _plausible_image(u)]


def _best_from_srcset(srcset: str) -> str:
    best_url = ""
    best_w = -1
    for part in srcset.split(","):
        p = part.strip().split()
        if not p:
            continue
        u = p[0]
        w = -1
        if len(p) > 1:
            m = re.match(r"(\d+)([wx])", p[1])
            if m:
                w = int(m.group(1))
        if w > best_w:
            best_w = w
            best_url = u
    return best_url


def _dig_images(block, base_url: str, out: list):
    if isinstance(block, dict):
        for k, v in block.items():
            if k.lower() == "image":
                if isinstance(v, str) and v.startswith(("http", "//")):
                    out.append(absolutize(base_url, v))
                elif isinstance(v, dict):
                    u = v.get("url") or v.get("@id")
                    if u:
                        out.append(absolutize(base_url, u))
                elif isinstance(v, list):
                    for item in v:
                        if isinstance(item, str) and item.startswith(("http", "//")):
                            out.append(absolutize(base_url, item))
                        elif isinstance(item, dict):
                            u = item.get("url") or item.get("@id")
                            if u:
                                out.append(absolutize(base_url, u))
            elif isinstance(v, (dict, list)):
                _dig_images(v, base_url, out)
    elif isinstance(block, list):
        for item in block:
            _dig_images(item, base_url, out)


def _plausible_image(url: str) -> bool:
    if not url or len(url) > 2000:
        return False
    low = url.lower().split("?")[0]
    if any(s in url for s in ("data:image", "base64,")):
        return False
    if any(s in low for s in ("/favicon", "/sprite", "blank.gif", "pixel.gif",
                              "/1x1.", "/spacer.")):
        return False
    if not low.startswith(("http://", "https://")):
        return False
    return True


# ── Err ──────────────────────────────────────────────────────────────────────

def _err(msg, tool, start, url=""):
    return {"status": "error", "result": {"url": url} if url else None,
            "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
