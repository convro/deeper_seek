"""
_images.py — Image download, validation, dedup and quality filtering.

  • download_image(url)     → (filepath, info) with bytes validation + PIL check
  • phash(path)             → perceptual hash (64-bit int) for dedup
  • is_blurry(path)         → boolean via Laplacian variance / FFT fallback
  • has_watermark_hint(url, info) → heuristic boolean
  • strip_exif(path)        → saves a clean copy (in place)
  • normalize_format(path)  → webp/avif → jpg or png, returns new path
  • score_image(info)       → 0..100 quality score
  • download_many(urls, save_dir, target_n) → parallel pipeline with filters
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import math
import os
import random
import re
import time
import urllib.parse
from pathlib import Path
from typing import Iterable, Optional

from tools.web._common import (
    default_headers, domain_of, fetch_sync, normalize_url, GLOBAL_LIMITER,
)

# Host fragments that almost always indicate stock / generic imagery
STOCK_HOSTS = (
    "shutterstock.com", "istockphoto.com", "gettyimages.com", "stock.adobe.com",
    "depositphotos.com", "dreamstime.com", "alamy.com", "123rf.com",
    "freepik.com", "img.freepik.com", "vecteezy.com", "pngtree.com",
    "canstockphoto.com", "bigstockphoto.com", "envato.com", "fotolia.com",
    "stockvault.net", "stocksnap.io", "pikbest.com", "lovepik.com",
)

# Hosts that indicate editorial / news / wiki / high-value imagery
PREFERRED_HOSTS = (
    "upload.wikimedia.org", "commons.wikimedia.org", "staticflickr.com",
    "flickr.com", "nasa.gov", "noaa.gov", "europa.eu", "reuters.com",
    "bbc.co.uk", "bbci.co.uk", "nytimes.com", "guim.co.uk", "theguardian.com",
    "apnews.com", "npr.org", "cnn.com", "nationalgeographic.com",
    "ft.com", "bloomberg.com", "washingtonpost.com", "wsj.net",
    "archive.org", "loc.gov", "si.edu", "metmuseum.org", "rijksmuseum.nl",
)

# Common watermark / overlay hints in URLs and hosts
WATERMARK_URL_HINTS = ("watermark", "preview", "thumbnail", "comp_", "-wm-",
                       "/wm/", "/comp/", "preview/", "/thumb/", "thumb_",
                       "/ss_", "/samples/")

# Minimum bytes for a "real" image (filter tiny placeholders)
MIN_BYTES = 6000

ALLOWED_CT = ("image/jpeg", "image/jpg", "image/png", "image/webp",
              "image/gif", "image/avif", "image/heic", "image/heif")


# ── Download ─────────────────────────────────────────────────────────────────

def download_image(url: str, save_dir: str, referer: Optional[str] = None,
                   min_width: int = 400, min_height: int = 300,
                   max_bytes: int = 25_000_000, timeout: int = 25) -> tuple[Optional[str], dict]:
    """Fetch an image URL, validate, save to disk. Returns (path, info)."""
    os.makedirs(save_dir, exist_ok=True)
    url_norm = normalize_url(url)

    res = fetch_sync(url_norm, timeout=timeout, referer=referer,
                     use_cache=False, return_bytes=True, max_bytes=max_bytes)
    if not res.ok or not res.raw:
        return None, {"error": res.error or "no data"}
    raw = res.raw
    ctype = (res.content_type or "").lower().split(";")[0].strip()

    if len(raw) < MIN_BYTES:
        return None, {"error": f"too small ({len(raw)}B)"}
    if ctype and not any(ct in ctype for ct in ALLOWED_CT) and not _sniff_image(raw):
        return None, {"error": f"not an image: {ctype}"}

    ext = _ext_from_ctype(ctype) or _ext_from_url(url_norm) or _ext_from_magic(raw) or ".jpg"
    name = "img_" + hashlib.sha1(url_norm.encode()).hexdigest()[:14] + ext
    path = os.path.join(save_dir, name)
    with open(path, "wb") as f:
        f.write(raw)

    info: dict = {
        "size_kb": round(len(raw) / 1024, 1),
        "bytes": len(raw),
        "content_type": ctype,
        "source_url": url_norm,
    }

    # PIL-based validation
    try:
        from PIL import Image, ImageOps
        with Image.open(path) as im:
            im.verify()
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)
            w, h = im.size
            info["width"] = w
            info["height"] = h
            info["format"] = (im.format or "").lower()
            info["mode"] = im.mode
            if w < min_width or h < min_height:
                try:
                    os.remove(path)
                except OSError:
                    pass
                return None, {"error": f"too small ({w}x{h})"}
    except ImportError:
        pass
    except Exception as e:
        try:
            os.remove(path)
        except OSError:
            pass
        return None, {"error": f"invalid image: {e}"}

    # Perceptual hash
    try:
        info["phash"] = phash(path)
    except Exception:
        info["phash"] = None

    info["preferred"] = any(h in url_norm for h in PREFERRED_HOSTS)
    info["stock"] = any(h in url_norm for h in STOCK_HOSTS)
    info["watermark_hint"] = has_watermark_hint(url_norm)
    info["score"] = score_image(info)
    info["path"] = path
    return path, info


def _ext_from_ctype(ctype: str) -> str:
    m = {
        "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/pjpeg": ".jpg",
        "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
        "image/avif": ".avif", "image/heic": ".heic", "image/heif": ".heif",
    }
    return m.get(ctype, "")


def _ext_from_url(url: str) -> str:
    path = urllib.parse.urlparse(url).path.lower()
    for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".heic"):
        if path.endswith(ext):
            return ".jpg" if ext == ".jpeg" else ext
    return ""


def _ext_from_magic(raw: bytes) -> str:
    if raw.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return ".webp"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if raw[4:8] == b"ftyp":
        return ".heic"
    return ""


def _sniff_image(raw: bytes) -> bool:
    return bool(_ext_from_magic(raw))


# ── Perceptual hash / dedup ──────────────────────────────────────────────────

def phash(path: str) -> Optional[int]:
    try:
        import imagehash
        from PIL import Image
        with Image.open(path) as im:
            return int(str(imagehash.phash(im.convert("RGB"))), 16)
    except ImportError:
        return _fallback_dhash(path)
    except Exception:
        return None


def _fallback_dhash(path: str) -> Optional[int]:
    try:
        from PIL import Image
        with Image.open(path) as im:
            im = im.convert("L").resize((9, 8))
            pixels = list(im.getdata())
        bits = 0
        for row in range(8):
            for col in range(8):
                left = pixels[row * 9 + col]
                right = pixels[row * 9 + col + 1]
                bits = (bits << 1) | (1 if left > right else 0)
        return bits
    except Exception:
        return None


def hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


# ── Blur / quality ───────────────────────────────────────────────────────────

def is_blurry(path: str, threshold: float = 60.0) -> bool:
    """Laplacian-variance style blur detection (pure-Python fallback)."""
    try:
        from PIL import Image, ImageFilter
        with Image.open(path) as im:
            gray = im.convert("L").resize((256, 256))
            edges = gray.filter(ImageFilter.FIND_EDGES)
        data = list(edges.getdata())
        n = len(data)
        mean = sum(data) / n
        var = sum((x - mean) ** 2 for x in data) / n
        return var < threshold
    except Exception:
        return False


def has_watermark_hint(url: str, info: Optional[dict] = None) -> bool:
    u = url.lower()
    if any(h in u for h in WATERMARK_URL_HINTS):
        return True
    if any(h in u for h in STOCK_HOSTS):
        # Stock previews often carry watermarks in small sizes
        if info and info.get("width", 99999) < 1000:
            return True
    return False


# ── EXIF strip + format normalization ────────────────────────────────────────

def strip_exif(path: str) -> bool:
    try:
        from PIL import Image
        with Image.open(path) as im:
            data = list(im.getdata())
            clean = Image.new(im.mode, im.size)
            clean.putdata(data)
            fmt = im.format or "JPEG"
            save_kwargs = {"optimize": True}
            if fmt.upper() == "JPEG":
                save_kwargs["quality"] = 92
                save_kwargs["progressive"] = True
            clean.save(path, format=fmt, **save_kwargs)
        return True
    except Exception:
        return False


def normalize_format(path: str, prefer: str = "jpg") -> str:
    """Convert webp/avif/heic → jpg/png for broader compatibility."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".jpg", ".jpeg", ".png", ".gif"):
        return path
    try:
        from PIL import Image
        with Image.open(path) as im:
            rgb = im.convert("RGBA" if prefer == "png" else "RGB")
            new_path = os.path.splitext(path)[0] + ("." + prefer)
            if prefer == "png":
                rgb.save(new_path, "PNG", optimize=True)
            else:
                rgb.save(new_path, "JPEG", quality=92, optimize=True, progressive=True)
        try:
            os.remove(path)
        except OSError:
            pass
        return new_path
    except Exception:
        return path


# ── Quality scoring ──────────────────────────────────────────────────────────

def score_image(info: dict) -> int:
    w = info.get("width", 0) or 0
    h = info.get("height", 0) or 0
    bytes_ = info.get("bytes", 0) or 0
    score = 0
    # Resolution
    score += min(40, int(math.sqrt(max(w, 1) * max(h, 1)) / 40))
    # Byte weight (penalize tiny, reward hefty)
    score += min(20, int(bytes_ / 80_000))
    # Preferred host
    if info.get("preferred"):
        score += 25
    # Stock penalty
    if info.get("stock"):
        score -= 20
    # Watermark penalty
    if info.get("watermark_hint"):
        score -= 15
    # Format bonus (jpeg/png > gif/webp for our use)
    fmt = (info.get("format") or "").lower()
    if fmt in ("jpeg", "jpg", "png"):
        score += 5
    elif fmt in ("gif",):
        score -= 5
    # Aspect ratio sanity — nothing absurdly narrow
    if w and h:
        ratio = max(w / h, h / w)
        if ratio > 4:
            score -= 10
    return max(0, min(100, score + 20))


# ── Bulk download pipeline ───────────────────────────────────────────────────

def download_many(urls: Iterable[str], save_dir: str, target_n: int = 10,
                  referer: Optional[str] = None, min_width: int = 800,
                  min_height: int = 500, phash_threshold: int = 8,
                  avoid_stock: bool = True) -> list[dict]:
    """
    Download images with:
      • bytes/dim validation
      • dedup via perceptual hash (Hamming ≤ phash_threshold)
      • optional stock avoidance (deprioritize, not exclude)
      • quality scoring

    Returns list of info dicts (path, width, height, score, ...) — best first.
    """
    urls = list(dict.fromkeys(urls))  # preserve order, drop dupes
    # Reorder: preferred first, non-stock before stock
    urls.sort(key=lambda u: (
        0 if any(h in u for h in PREFERRED_HOSTS) else
        (2 if any(h in u for h in STOCK_HOSTS) else 1)
    ))

    downloaded: list[dict] = []
    hashes: list[int] = []

    for u in urls:
        if len(downloaded) >= target_n:
            break
        if avoid_stock and any(h in u for h in STOCK_HOSTS) and len(downloaded) >= max(3, target_n // 2):
            # Have some non-stock results already — skip remaining stock URLs
            continue
        path, info = download_image(u, save_dir, referer=referer,
                                    min_width=min_width, min_height=min_height)
        if not path:
            continue
        ph = info.get("phash")
        if ph is not None:
            if any(hamming(ph, h) <= phash_threshold for h in hashes):
                try:
                    os.remove(path)
                except OSError:
                    pass
                continue
            hashes.append(ph)
        # Skip very blurry
        if is_blurry(path, threshold=40.0):
            try:
                os.remove(path)
            except OSError:
                pass
            continue
        # Strip EXIF for hygiene
        strip_exif(path)
        downloaded.append(info)

    # Sort final list by score desc
    downloaded.sort(key=lambda d: d.get("score", 0), reverse=True)
    return downloaded
