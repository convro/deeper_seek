"""
_common.py — Shared HTTP infrastructure for the web toolset.

Provides:
  • USER_AGENTS pool + default_headers()
  • RateLimiter (per-domain token bucket)
  • CacheStore (on-disk JSON cache with TTL)
  • fetch_sync()  — urllib-based
  • fetch_async() / fetch_many() — httpx-based (auto-fallback to urllib)
  • URL helpers: normalize_url, domain_of, is_pdf, absolutize
  • Response object: FetchResult
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Iterable, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
CACHE_DIR = PROJECT_ROOT / "runtime" / "cache" / "web"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ── UA pool (real, recent Chrome/Firefox/Safari/Edge fingerprints) ───────────

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.6 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
]

DEFAULT_ACCEPT = (
    "text/html,application/xhtml+xml,application/xml;q=0.9,"
    "image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"
)


def default_headers(referer: Optional[str] = None, extra: Optional[dict] = None) -> dict:
    h = {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": DEFAULT_ACCEPT,
        "Accept-Language": "en-US,en;q=0.9,pl;q=0.6",
        "Accept-Encoding": "gzip, deflate",
        "DNT": "1",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
    }
    if referer:
        h["Referer"] = referer
    if extra:
        h.update(extra)
    return h


# ── Rate limiter (per-domain, simple interval pacing) ────────────────────────

class RateLimiter:
    """Per-domain pacing — ensures ≥ min_interval seconds between requests."""

    def __init__(self, min_interval: float = 0.35):
        self.min_interval = min_interval
        self._last: dict[str, float] = {}
        self._lock = asyncio.Lock()

    def sync_acquire(self, domain: str):
        now = time.monotonic()
        last = self._last.get(domain, 0.0)
        wait = self.min_interval - (now - last)
        if wait > 0:
            time.sleep(wait)
        self._last[domain] = time.monotonic()

    async def acquire(self, domain: str):
        async with self._lock:
            now = time.monotonic()
            last = self._last.get(domain, 0.0)
            wait = self.min_interval - (now - last)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last[domain] = time.monotonic()


GLOBAL_LIMITER = RateLimiter(min_interval=0.30)


# ── On-disk cache ────────────────────────────────────────────────────────────

class CacheStore:
    """JSON file cache. Each record embeds a TTL; expired records are ignored."""

    def __init__(self, subdir: str = "pages", ttl: int = 6 * 3600):
        self.dir = CACHE_DIR / subdir
        self.dir.mkdir(parents=True, exist_ok=True)
        self.ttl = ttl

    def _path(self, key: str) -> Path:
        h = hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]
        return self.dir / f"{h}.json"

    def get(self, key: str) -> Optional[dict]:
        p = self._path(key)
        if not p.exists():
            return None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None
        if data.get("expires_at", 0) < time.time():
            return None
        return data.get("value")

    def set(self, key: str, value: dict, ttl: Optional[int] = None):
        p = self._path(key)
        rec = {
            "key": key,
            "value": value,
            "expires_at": time.time() + (ttl if ttl is not None else self.ttl),
        }
        try:
            p.write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass


GLOBAL_CACHE = CacheStore("pages", ttl=3 * 3600)


# ── URL helpers ──────────────────────────────────────────────────────────────

_TRACKING_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "utm_id", "utm_name", "utm_reader", "utm_referrer", "utm_social",
    "utm_social-type", "utm_brand", "gclid", "fbclid", "mc_cid", "mc_eid",
    "yclid", "_openstat", "igshid", "msclkid", "ref", "ref_src", "ref_url",
    "vero_id", "vero_conv", "hsCtaTracking", "hsa_acc", "hsa_cam", "hsa_grp",
    "hsa_ad", "hsa_src", "hsa_tgt", "hsa_kw", "hsa_mt", "hsa_net", "hsa_ver",
}


def normalize_url(url: str) -> str:
    try:
        p = urllib.parse.urlparse(url)
        if p.query:
            q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True)
                 if k.lower() not in _TRACKING_PARAMS]
            new_query = urllib.parse.urlencode(q)
        else:
            new_query = ""
        return urllib.parse.urlunparse(p._replace(query=new_query, fragment=""))
    except Exception:
        return url


def domain_of(url: str) -> str:
    try:
        host = urllib.parse.urlparse(url).netloc.lower()
        if host.startswith("www."):
            host = host[4:]
        return host
    except Exception:
        return ""


def absolutize(base: str, href: str) -> str:
    try:
        return urllib.parse.urljoin(base, href)
    except Exception:
        return href


def is_pdf(url: str = "", content_type: str = "") -> bool:
    if "application/pdf" in (content_type or "").lower():
        return True
    if url and url.lower().split("?")[0].endswith(".pdf"):
        return True
    return False


# ── Fetch result ─────────────────────────────────────────────────────────────

@dataclass
class FetchResult:
    ok: bool
    url: str
    final_url: str = ""
    status: int = 0
    content_type: str = ""
    text: str = ""
    bytes_len: int = 0
    raw: Optional[bytes] = None
    error: Optional[str] = None
    elapsed_ms: int = 0
    from_cache: bool = False

    def to_json(self) -> dict:
        d = asdict(self)
        d.pop("raw", None)
        return d


# ── Sync fetch (urllib, gzip-aware) ──────────────────────────────────────────

def _decompress(raw: bytes, encoding: str) -> bytes:
    enc = (encoding or "").lower()
    try:
        if "gzip" in enc:
            import gzip
            return gzip.decompress(raw)
        if "deflate" in enc:
            import zlib
            try:
                return zlib.decompress(raw)
            except zlib.error:
                return zlib.decompress(raw, -zlib.MAX_WBITS)
        if "br" in enc:
            try:
                import brotli  # type: ignore
                return brotli.decompress(raw)
            except Exception:
                return raw
    except Exception:
        return raw
    return raw


def _decode(raw: bytes, content_type: str) -> tuple[str, str]:
    enc = "utf-8"
    m = re.search(r"charset=([^\s;]+)", content_type or "", re.IGNORECASE)
    if m:
        enc = m.group(1).strip('"\' ').lower()
    for candidate in (enc, "utf-8", "latin-1", "windows-1252", "cp1250"):
        try:
            return raw.decode(candidate), candidate
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace"), "utf-8"


def fetch_sync(
    url: str,
    timeout: int = 20,
    referer: Optional[str] = None,
    headers: Optional[dict] = None,
    use_cache: bool = True,
    return_bytes: bool = False,
    max_bytes: int = 8_000_000,
) -> FetchResult:
    """Blocking fetch using urllib. Returns FetchResult."""
    start = time.time()
    url_norm = normalize_url(url)
    cache_key = f"GET::{url_norm}"

    if use_cache and not return_bytes:
        cached = GLOBAL_CACHE.get(cache_key)
        if cached:
            return FetchResult(
                ok=True, url=url_norm, final_url=cached.get("final_url", url_norm),
                status=cached.get("status", 200),
                content_type=cached.get("content_type", ""),
                text=cached.get("text", ""),
                bytes_len=cached.get("bytes_len", 0),
                elapsed_ms=int((time.time() - start) * 1000),
                from_cache=True,
            )

    try:
        GLOBAL_LIMITER.sync_acquire(domain_of(url_norm))
        h = default_headers(referer=referer, extra=headers)
        req = urllib.request.Request(url_norm, headers=h)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            final_url = resp.geturl()
            ctype = resp.headers.get("Content-Type", "")
            enc = resp.headers.get("Content-Encoding", "")
            raw = resp.read(max_bytes + 1)
            status = resp.status

        if len(raw) > max_bytes:
            raw = raw[:max_bytes]

        raw = _decompress(raw, enc)

        if return_bytes or (
            ctype.startswith("image/") or ctype.startswith("application/octet") or is_pdf(url_norm, ctype)
        ):
            return FetchResult(
                ok=True, url=url_norm, final_url=final_url, status=status,
                content_type=ctype, text="", raw=raw, bytes_len=len(raw),
                elapsed_ms=int((time.time() - start) * 1000),
            )

        text, _ = _decode(raw, ctype)
        result = FetchResult(
            ok=True, url=url_norm, final_url=final_url, status=status,
            content_type=ctype, text=text, bytes_len=len(raw),
            elapsed_ms=int((time.time() - start) * 1000),
        )

        if use_cache and len(text) < 1_500_000:
            GLOBAL_CACHE.set(cache_key, {
                "final_url": final_url, "status": status, "content_type": ctype,
                "text": text, "bytes_len": len(raw),
            })
        return result

    except urllib.error.HTTPError as e:
        return FetchResult(ok=False, url=url_norm, status=e.code,
                           error=f"HTTP {e.code}: {e.reason}",
                           elapsed_ms=int((time.time() - start) * 1000))
    except urllib.error.URLError as e:
        return FetchResult(ok=False, url=url_norm,
                           error=f"URL error: {e.reason}",
                           elapsed_ms=int((time.time() - start) * 1000))
    except Exception as e:
        return FetchResult(ok=False, url=url_norm, error=str(e),
                           elapsed_ms=int((time.time() - start) * 1000))


# ── Async fetch (httpx if available; otherwise parallel sync via threads) ────

async def fetch_async(url: str, client=None, timeout: int = 20,
                      referer: Optional[str] = None, headers: Optional[dict] = None,
                      use_cache: bool = True) -> FetchResult:
    start = time.time()
    url_norm = normalize_url(url)
    cache_key = f"GET::{url_norm}"

    if use_cache:
        cached = GLOBAL_CACHE.get(cache_key)
        if cached:
            return FetchResult(
                ok=True, url=url_norm, final_url=cached.get("final_url", url_norm),
                status=cached.get("status", 200),
                content_type=cached.get("content_type", ""),
                text=cached.get("text", ""),
                bytes_len=cached.get("bytes_len", 0),
                elapsed_ms=int((time.time() - start) * 1000),
                from_cache=True,
            )

    try:
        await GLOBAL_LIMITER.acquire(domain_of(url_norm))
        import httpx
        close_after = False
        if client is None:
            client = httpx.AsyncClient(
                follow_redirects=True, timeout=timeout, http2=False,
                headers=default_headers(referer=referer, extra=headers),
            )
            close_after = True
        try:
            r = await client.get(url_norm, headers=default_headers(referer=referer, extra=headers))
            ctype = r.headers.get("content-type", "")
            text = r.text if not (ctype.startswith("image/") or is_pdf(url_norm, ctype)) else ""
            result = FetchResult(
                ok=r.is_success, url=url_norm, final_url=str(r.url),
                status=r.status_code, content_type=ctype, text=text,
                raw=r.content if (ctype.startswith("image/") or is_pdf(url_norm, ctype)) else None,
                bytes_len=len(r.content),
                elapsed_ms=int((time.time() - start) * 1000),
            )
            if r.is_success and use_cache and len(text) < 1_500_000 and text:
                GLOBAL_CACHE.set(cache_key, {
                    "final_url": str(r.url), "status": r.status_code,
                    "content_type": ctype, "text": text, "bytes_len": len(r.content),
                })
            return result
        finally:
            if close_after:
                await client.aclose()
    except Exception as e:
        return FetchResult(ok=False, url=url_norm, error=str(e),
                           elapsed_ms=int((time.time() - start) * 1000))


async def fetch_many(urls: Iterable[str], concurrency: int = 8,
                     timeout: int = 20, use_cache: bool = True) -> list[FetchResult]:
    """Parallel fetch of many URLs. Uses httpx if available, else thread pool."""
    urls = list(urls)
    try:
        import httpx
        limits = httpx.Limits(max_connections=concurrency * 2,
                              max_keepalive_connections=concurrency)
        async with httpx.AsyncClient(follow_redirects=True, timeout=timeout,
                                     limits=limits) as client:
            sem = asyncio.Semaphore(concurrency)

            async def _one(u: str):
                async with sem:
                    return await fetch_async(u, client=client, timeout=timeout,
                                             use_cache=use_cache)

            return await asyncio.gather(*[_one(u) for u in urls])
    except ImportError:
        # Thread-pool fallback
        import concurrent.futures
        loop = asyncio.get_event_loop()
        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
            futs = [
                loop.run_in_executor(pool, lambda u=u: fetch_sync(u, timeout=timeout, use_cache=use_cache))
                for u in urls
            ]
            return await asyncio.gather(*futs)


def fetch_many_sync(urls: Iterable[str], concurrency: int = 8,
                    timeout: int = 20, use_cache: bool = True) -> list[FetchResult]:
    """Synchronous entrypoint to fetch_many — for tools that aren't async."""
    return asyncio.run(fetch_many(urls, concurrency=concurrency,
                                  timeout=timeout, use_cache=use_cache))


# ── Misc helpers ─────────────────────────────────────────────────────────────

def dedup_by_domain(urls: list[str], per_domain: int = 3) -> list[str]:
    seen: dict[str, int] = {}
    out = []
    for u in urls:
        d = domain_of(u)
        if seen.get(d, 0) >= per_domain:
            continue
        seen[d] = seen.get(d, 0) + 1
        out.append(u)
    return out


def now_ms() -> int:
    return int(time.time() * 1000)
