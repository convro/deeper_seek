"""
image_search.py — Search and download high-quality images for projects.

Sources (all free, no API key needed, high resolution):
  1. Unsplash Source (random HD photos by keyword)
  2. Pexels HTML scraping (curated HD stock photos)
  3. Pixabay HTML scraping (free images)

Downloads images directly to a target directory.
No copyright restrictions enforced — this is an experimental/personal tool.
"""

import json
import os
import re
import time
import urllib.request
import urllib.parse
import urllib.error
import hashlib
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

# Realistic browser headers
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,"
              "image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.google.com/",
}


def execute(
    query: str,
    num_images: int = 5,
    save_dir: str = "",
    min_width: int = 800,
    orientation: str = "any",
    **kwargs,
) -> dict:
    """
    Search and download high-quality images.

    Args:
        query:       Search keywords (e.g. "african gold mine landscape")
        num_images:  How many images to download (1-15)
        save_dir:    Directory to save images (auto-created).
                     If empty, uses workspace/images/<query_slug>/
        min_width:   Minimum image width in px (default 800)
        orientation: "any", "landscape", "portrait", "square"
    """
    start = time.time()
    num_images = max(1, min(num_images, 15))

    # Determine save directory
    if not save_dir:
        slug = re.sub(r"[^a-z0-9]+", "_", query.lower().strip())[:50]
        save_dir = str(PROJECT_ROOT / "workspace" / "images" / slug)

    os.makedirs(save_dir, exist_ok=True)

    downloaded = []
    errors = []
    seen_urls = set()

    # Collect image URLs from multiple sources
    candidate_urls = []

    # Source 1: Unsplash (high quality, easy to scrape)
    try:
        urls = _unsplash_search(query, num_images * 2, orientation)
        candidate_urls.extend(urls)
    except Exception as e:
        errors.append(f"Unsplash: {e}")

    # Source 2: Pexels
    try:
        urls = _pexels_search(query, num_images * 2)
        candidate_urls.extend(urls)
    except Exception as e:
        errors.append(f"Pexels: {e}")

    # Source 3: Pixabay
    try:
        urls = _pixabay_search(query, num_images)
        candidate_urls.extend(urls)
    except Exception as e:
        errors.append(f"Pixabay: {e}")

    # Download images
    for img_url in candidate_urls:
        if len(downloaded) >= num_images:
            break
        if img_url in seen_urls:
            continue
        seen_urls.add(img_url)

        try:
            filepath, info = _download_image(img_url, save_dir, min_width)
            if filepath:
                downloaded.append({
                    "path": filepath,
                    "url": img_url,
                    "width": info.get("width"),
                    "height": info.get("height"),
                    "size_kb": info.get("size_kb"),
                    "format": info.get("format"),
                })
        except Exception as e:
            errors.append(f"Download {img_url[:80]}: {e}")

    return {
        "status": "ok" if downloaded else "error",
        "result": {
            "query": query,
            "downloaded": downloaded,
            "count": len(downloaded),
            "save_dir": save_dir,
            "errors": errors[:5] if errors else None,
        },
        "error": None if downloaded else f"No images found for '{query}'. Errors: {'; '.join(errors[:3])}",
        "metadata": {"tool": "image_search", "duration_ms": _ms(start)},
    }


# ── Source: Unsplash ─────────────────────────────────────────────────────────

def _unsplash_search(query: str, num: int, orientation: str = "any") -> list:
    """Search Unsplash via their public HTML page and extract image URLs."""
    encoded = urllib.parse.quote_plus(query)
    orient_param = ""
    if orientation in ("landscape", "portrait", "squarish"):
        orient_param = f"&orientation={orientation}"

    url = f"https://unsplash.com/s/photos/{encoded}?per_page={min(num, 30)}{orient_param}"
    html = _fetch(url)

    # Extract image URLs from srcset or src attributes (prefer high-res)
    urls = []

    # Look for photo URLs in the JSON data embedded in the page
    # Unsplash embeds photo data in script tags
    photo_patterns = re.findall(
        r'"(https://images\.unsplash\.com/photo-[^"]+)"',
        html
    )

    for raw_url in photo_patterns:
        # Clean and request a good resolution
        base = raw_url.split("?")[0]
        # Request 1600px wide version
        clean_url = f"{base}?w=1600&q=80&auto=format"
        if clean_url not in urls:
            urls.append(clean_url)
        if len(urls) >= num:
            break

    # Fallback: direct source URLs
    if len(urls) < num:
        src_urls = re.findall(
            r'src="(https://images\.unsplash\.com/photo-[^"?]+)',
            html
        )
        for u in src_urls:
            clean = f"{u}?w=1600&q=80&auto=format"
            if clean not in urls:
                urls.append(clean)
            if len(urls) >= num:
                break

    return urls[:num]


# ── Source: Pexels ───────────────────────────────────────────────────────────

def _pexels_search(query: str, num: int) -> list:
    """Search Pexels via HTML scraping."""
    encoded = urllib.parse.quote_plus(query)
    url = f"https://www.pexels.com/search/{encoded}/"
    html = _fetch(url)

    urls = []
    # Pexels uses data-large-src or srcset with high-res URLs
    patterns = re.findall(
        r'(?:data-large-src|srcset)="([^"]*pexels[^"]*)"',
        html
    )
    for raw in patterns:
        # Get largest URL from srcset
        parts = raw.split(",")
        best = parts[-1].strip().split(" ")[0] if parts else raw
        if best.startswith("http") and "pexels" in best:
            # Request a good size
            clean = re.sub(r'\?.*', '?auto=compress&cs=tinysrgb&w=1600', best)
            if clean not in urls:
                urls.append(clean)
        if len(urls) >= num:
            break

    # Fallback: look for direct photo URLs
    if len(urls) < num:
        img_urls = re.findall(
            r'"(https://images\.pexels\.com/photos/\d+/[^"?]+)',
            html
        )
        for u in img_urls:
            clean = f"{u}?auto=compress&cs=tinysrgb&w=1600"
            if clean not in urls:
                urls.append(clean)
            if len(urls) >= num:
                break

    return urls[:num]


# ── Source: Pixabay ──────────────────────────────────────────────────────────

def _pixabay_search(query: str, num: int) -> list:
    """Search Pixabay via HTML scraping."""
    encoded = urllib.parse.quote_plus(query)
    url = f"https://pixabay.com/images/search/{encoded}/"
    html = _fetch(url)

    urls = []
    # Pixabay embeds image URLs in various formats
    img_urls = re.findall(
        r'src="(https://cdn\.pixabay\.com/photo/[^"]+)"',
        html
    )
    for u in img_urls:
        # Skip tiny thumbnails
        if "_150" in u or "_180" in u or "_340" in u:
            continue
        if u not in urls:
            urls.append(u)
        if len(urls) >= num:
            break

    return urls[:num]


# ── Download & validate ──────────────────────────────────────────────────────

def _download_image(url: str, save_dir: str, min_width: int = 800):
    """Download an image and validate it. Returns (filepath, info) or (None, {})."""
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = resp.read()
        content_type = resp.headers.get("Content-Type", "")

    if len(data) < 5000:  # Too small, probably an error page
        return None, {}

    # Determine extension
    if "png" in content_type:
        ext = ".png"
    elif "webp" in content_type:
        ext = ".webp"
    elif "gif" in content_type:
        ext = ".gif"
    else:
        ext = ".jpg"

    # Generate filename from URL hash
    url_hash = hashlib.md5(url.encode()).hexdigest()[:12]
    filename = f"img_{url_hash}{ext}"
    filepath = os.path.join(save_dir, filename)

    # Write file
    with open(filepath, "wb") as f:
        f.write(data)

    # Validate with PIL if available
    info = {"size_kb": round(len(data) / 1024, 1), "format": ext.lstrip(".")}
    try:
        from PIL import Image
        img = Image.open(filepath)
        w, h = img.size
        info["width"] = w
        info["height"] = h

        if w < min_width:
            os.remove(filepath)
            return None, {}
    except ImportError:
        pass
    except Exception:
        pass

    return filepath, info


# ── Utilities ────────────────────────────────────────────────────────────────

def _fetch(url: str, timeout: int = 15) -> str:
    """Fetch URL and return HTML text."""
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _ms(start):
    return int((time.time() - start) * 1000)
