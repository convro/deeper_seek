"""
http_request.py — Generic REST client for arbitrary HTTP(S) calls.

Features:
  • Methods: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS
  • Bodies:  json=..., form=..., multipart=..., data=... (raw string/bytes)
  • Auth:    bearer="tok", basic=("user","pass"), or raw headers=
  • Retry:   exponential backoff on 429/5xx (tunable)
  • Output:  auto-detects JSON / text / binary, caps at max_bytes,
             optionally writes the body to a file (save_to="…").
  • Safety:  refuses private/link-local hosts unless allow_private=True.

Returns:
  {status, result: {status_code, url, final_url, headers, body, body_preview,
                    content_type, bytes, elapsed_ms, retries, json (if parsed),
                    saved_to (if save_to used)}, error, metadata}
"""

from __future__ import annotations

import base64
import ipaddress
import json as _json
import os
import socket
import time
from pathlib import Path
from urllib.parse import urlparse


ALLOWED_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
DEFAULT_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) DeeperSeek/1.0")
MAX_BYTES_DEFAULT = 5_000_000   # 5 MiB preview cap
MAX_SAVE_BYTES = 200_000_000    # 200 MiB when saving to disk


def execute(url: str,
            method: str = "GET",
            headers: dict | None = None,
            params: dict | None = None,
            json: dict | list | None = None,
            form: dict | None = None,
            multipart: dict | None = None,
            data: str | bytes | None = None,
            bearer: str | None = None,
            basic: list | tuple | None = None,
            timeout: float = 30.0,
            retries: int = 2,
            retry_on: list | None = None,
            follow_redirects: bool = True,
            max_redirects: int = 5,
            max_bytes: int = MAX_BYTES_DEFAULT,
            save_to: str | None = None,
            allow_private: bool = False,
            verify_ssl: bool = True,
            **kwargs) -> dict:
    start = time.time()
    method = (method or "GET").upper()

    if method not in ALLOWED_METHODS:
        return _err(f"method must be one of {sorted(ALLOWED_METHODS)}",
                    start)

    # SSRF guard
    if not allow_private:
        ok, reason = _ssrf_safe(url)
        if not ok:
            return _err(f"Blocked by SSRF guard: {reason}. "
                        f"Pass allow_private=True to override.", start)

    try:
        import httpx  # type: ignore
    except ImportError:
        return _err("httpx is required for http_request", start)

    hdrs = {"User-Agent": DEFAULT_UA, "Accept": "*/*"}
    if headers:
        hdrs.update({str(k): str(v) for k, v in headers.items()})
    if bearer:
        hdrs["Authorization"] = f"Bearer {bearer}"
    if basic and len(basic) == 2:
        token = base64.b64encode(f"{basic[0]}:{basic[1]}".encode()).decode()
        hdrs["Authorization"] = f"Basic {token}"

    # Build body
    body_kwargs: dict = {}
    if json is not None:
        body_kwargs["json"] = json
    elif form is not None:
        body_kwargs["data"] = form
    elif multipart is not None:
        files, form_fields = _build_multipart(multipart)
        body_kwargs["files"] = files
        if form_fields:
            body_kwargs["data"] = form_fields
    elif data is not None:
        body_kwargs["content"] = data.encode() if isinstance(data, str) else data

    retry_codes = set(retry_on or [408, 425, 429, 500, 502, 503, 504])
    attempts = max(1, int(retries) + 1)
    last_exc = None
    response = None
    retry_used = 0

    for attempt in range(attempts):
        try:
            with httpx.Client(follow_redirects=follow_redirects,
                              max_redirects=max_redirects,
                              timeout=timeout,
                              verify=verify_ssl) as client:
                response = client.request(method, url, headers=hdrs,
                                          params=params, **body_kwargs)
            if response.status_code in retry_codes and attempt < attempts - 1:
                retry_used = attempt + 1
                time.sleep(_backoff(attempt, response.headers.get("Retry-After")))
                continue
            break
        except Exception as e:
            last_exc = e
            if attempt < attempts - 1:
                retry_used = attempt + 1
                time.sleep(_backoff(attempt))
                continue
            return _err(f"Request failed after {attempts} attempts: {e}",
                        start)

    if response is None:
        return _err(f"Request failed: {last_exc}", start)

    # Handle body
    ctype = response.headers.get("content-type", "")
    raw = response.content or b""
    total_bytes = len(raw)
    saved_to = None

    if save_to:
        try:
            p = Path(save_to).expanduser().resolve()
            p.parent.mkdir(parents=True, exist_ok=True)
            if total_bytes > MAX_SAVE_BYTES:
                return _err(f"Response too large to save ({total_bytes}B).",
                            start)
            p.write_bytes(raw)
            saved_to = str(p)
        except Exception as e:
            return _err(f"save_to failed: {e}", start)

    preview_bytes = raw[:max_bytes]
    truncated = total_bytes > max_bytes

    parsed_json = None
    body_preview: str | None = None
    is_binary = _looks_binary(preview_bytes, ctype)

    if "application/json" in ctype or _looks_json(preview_bytes):
        try:
            parsed_json = _json.loads(raw.decode("utf-8", errors="replace"))
            body_preview = _json.dumps(parsed_json, indent=2,
                                       ensure_ascii=False)[:max_bytes]
        except Exception:
            body_preview = raw.decode("utf-8", errors="replace")[:max_bytes]
    elif not is_binary:
        enc = response.encoding or "utf-8"
        try:
            body_preview = raw.decode(enc, errors="replace")[:max_bytes]
        except Exception:
            body_preview = raw.decode("utf-8", errors="replace")[:max_bytes]
    else:
        body_preview = f"<binary {total_bytes}B {ctype or 'application/octet-stream'}>"

    return {
        "status": "ok" if response.status_code < 400 else "error",
        "result": {
            "status_code": response.status_code,
            "ok": response.status_code < 400,
            "url": url,
            "final_url": str(response.url),
            "method": method,
            "headers": dict(response.headers),
            "content_type": ctype,
            "bytes": total_bytes,
            "truncated": truncated,
            "body": body_preview,
            "json": parsed_json,
            "is_binary": is_binary,
            "saved_to": saved_to,
            "retries": retry_used,
            "elapsed_ms": int((time.time() - start) * 1000),
        },
        "error": None if response.status_code < 400
                 else f"HTTP {response.status_code}",
        "metadata": {"tool": "http_request",
                     "duration_ms": int((time.time() - start) * 1000),
                     "attempts": retry_used + 1},
    }


# ── helpers ─────────────────────────────────────────────────────────────────

def _backoff(attempt: int, retry_after: str | None = None) -> float:
    if retry_after:
        try:
            return max(0.1, min(30.0, float(retry_after)))
        except Exception:
            pass
    return min(30.0, (2 ** attempt) + 0.25 * attempt)


def _build_multipart(multipart: dict) -> tuple[dict, dict]:
    files: dict = {}
    form_fields: dict = {}
    for name, val in multipart.items():
        if isinstance(val, dict) and "path" in val:
            p = Path(val["path"]).expanduser()
            if not p.exists():
                raise FileNotFoundError(f"multipart file missing: {p}")
            filename = val.get("filename", p.name)
            ctype = val.get("content_type")
            files[name] = (filename, p.read_bytes(),
                           ctype) if ctype else (filename, p.read_bytes())
        elif isinstance(val, (list, tuple)) and len(val) >= 2:
            files[name] = tuple(val)
        elif isinstance(val, (bytes, bytearray)):
            files[name] = (name, bytes(val))
        else:
            form_fields[name] = str(val)
    return files, form_fields


def _looks_binary(sample: bytes, ctype: str) -> bool:
    ctype = (ctype or "").lower()
    if any(x in ctype for x in ("image/", "audio/", "video/",
                                "application/pdf", "application/zip",
                                "application/octet-stream",
                                "application/x-tar", "application/x-gzip")):
        return True
    if not sample:
        return False
    if b"\x00" in sample[:2048]:
        return True
    try:
        sample.decode("utf-8")
        return False
    except UnicodeDecodeError:
        pass
    nontext = sum(1 for b in sample[:2048]
                  if b < 9 or (13 < b < 32 and b not in (10, 11, 12)))
    return nontext / max(1, len(sample[:2048])) > 0.3


def _looks_json(sample: bytes) -> bool:
    s = sample.lstrip()[:1]
    return s in (b"{", b"[")


def _ssrf_safe(url: str) -> tuple[bool, str]:
    try:
        u = urlparse(url)
    except Exception:
        return False, "invalid URL"
    if u.scheme not in ("http", "https"):
        return False, f"unsupported scheme: {u.scheme}"
    host = u.hostname or ""
    if not host:
        return False, "no host"
    if host.lower() in ("localhost", "metadata.google.internal"):
        return False, f"blocked host: {host}"
    try:
        addrs = {ai[4][0] for ai in socket.getaddrinfo(host, None)}
    except Exception:
        return True, "dns unresolved (allow)"  # let real request fail
    for a in addrs:
        try:
            ip = ipaddress.ip_address(a)
        except ValueError:
            continue
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_reserved):
            return False, f"private/reserved IP: {a}"
    return True, ""


def _err(msg: str, start: float) -> dict:
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": "http_request",
                         "duration_ms": int((time.time() - start) * 1000)}}
