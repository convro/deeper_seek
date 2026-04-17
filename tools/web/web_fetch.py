"""
web_fetch.py — Fetch a URL and return rich, structured content.

Formats:
  • text     — readability-cleaned main article text (default)
  • markdown — main content as markdown
  • html     — raw HTML (truncated)
  • json     — parsed JSON (pretty)
  • full     — everything: text + markdown + metadata + JSON-LD + tables + links
  • pdf      — extract text from a PDF

Includes metadata, Open Graph, Twitter cards, JSON-LD, tables, links
and first-page image suggestions on every call (best-effort).
"""

from __future__ import annotations

import json
import time

from tools.web._common import fetch_sync, is_pdf, normalize_url
from tools.web._extract import (
    extract_main, extract_metadata, extract_jsonld, extract_tables,
    extract_links, extract_pdf, summarize_jsonld, html_to_markdown,
    clean_whitespace,
)

MAX_CONTENT_CHARS = 80_000


def execute(url: str, format: str = "text", timeout: int = 20,
            referer: str = "", max_chars: int = MAX_CONTENT_CHARS,
            include_links: bool = True, include_tables: bool = True,
            **kwargs) -> dict:
    start = time.time()
    url = normalize_url(url)
    res = fetch_sync(url, timeout=timeout, referer=referer or None, use_cache=True)

    if not res.ok:
        return _err(res.error or "fetch failed", "web_fetch", start, url=url)

    ctype = (res.content_type or "").lower()
    final_url = res.final_url or url

    # ── PDF path ─────────────────────────────────────────────────────────────
    if format == "pdf" or is_pdf(final_url, ctype):
        raw_res = fetch_sync(url, timeout=timeout, referer=referer or None,
                             use_cache=False, return_bytes=True,
                             max_bytes=30_000_000)
        text = extract_pdf(raw_res.raw or b"") if raw_res.ok else ""
        text = text[:max_chars]
        return {
            "status": "ok" if text else "error",
            "result": {
                "url": final_url, "format": "pdf", "content": text,
                "length": len(text), "truncated": len(text) >= max_chars,
                "content_type": ctype,
            },
            "error": None if text else "PDF extraction returned empty text",
            "metadata": {"tool": "web_fetch", "duration_ms": _ms(start),
                         "from_cache": res.from_cache},
        }

    text = res.text or ""

    # ── JSON path ────────────────────────────────────────────────────────────
    if format == "json" or "application/json" in ctype:
        try:
            parsed = json.loads(text)
            content = json.dumps(parsed, indent=2, ensure_ascii=False)[:max_chars]
            return {
                "status": "ok",
                "result": {"url": final_url, "format": "json", "content": content,
                           "length": len(content), "truncated": len(content) >= max_chars,
                           "content_type": ctype, "parsed_type": type(parsed).__name__},
                "error": None,
                "metadata": {"tool": "web_fetch", "duration_ms": _ms(start),
                             "from_cache": res.from_cache},
            }
        except json.JSONDecodeError:
            if format == "json":
                return _err("Not valid JSON", "web_fetch", start, url=final_url)

    # ── HTML (truncated raw) ─────────────────────────────────────────────────
    if format == "html":
        content = text[:max_chars]
        return {
            "status": "ok",
            "result": {"url": final_url, "format": "html", "content": content,
                       "length": len(content), "truncated": len(content) >= max_chars,
                       "content_type": ctype},
            "error": None,
            "metadata": {"tool": "web_fetch", "duration_ms": _ms(start),
                         "from_cache": res.from_cache},
        }

    # ── Default / text / markdown / full — structured extraction ─────────────
    extracted = extract_main(text, url=final_url)
    meta = extract_metadata(text)
    jsonld = extract_jsonld(text)
    jsonld_summary = summarize_jsonld(jsonld)
    tables = extract_tables(text, max_tables=3) if include_tables else []
    links = extract_links(text, base_url=final_url)[:120] if include_links else []

    body_text = extracted.get("text", "") or clean_whitespace(text)
    body_md = extracted.get("markdown", "") or html_to_markdown(text)

    if format == "markdown":
        primary = body_md[:max_chars]
    elif format == "full":
        primary = body_md[:max_chars]
    else:  # "text" (default)
        primary = body_text[:max_chars]

    result = {
        "url": final_url,
        "format": format,
        "content": primary,
        "length": len(primary),
        "truncated": len(primary) >= max_chars,
        "content_type": ctype,
        "title": meta.get("title"),
        "description": meta.get("description"),
        "site_name": meta.get("site_name"),
        "author": meta.get("author"),
        "published": meta.get("published"),
        "lang": meta.get("lang"),
        "hero_image": meta.get("image"),
        "canonical": meta.get("canonical"),
        "extraction_method": extracted.get("method"),
    }

    if format == "full":
        result.update({
            "text": body_text[:max_chars],
            "markdown": body_md[:max_chars],
            "metadata": meta,
            "jsonld": jsonld,
            "jsonld_summary": jsonld_summary,
            "tables": tables,
            "links": links,
        })
    else:
        if jsonld_summary:
            result["jsonld_summary"] = jsonld_summary
        if tables:
            result["tables"] = tables
        if links:
            result["top_links"] = links[:30]

    return {
        "status": "ok",
        "result": result,
        "error": None,
        "metadata": {"tool": "web_fetch", "duration_ms": _ms(start),
                     "from_cache": res.from_cache, "final_url": final_url},
    }


def _err(msg, tool, start, url=""):
    return {"status": "error", "result": {"url": url} if url else None,
            "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
