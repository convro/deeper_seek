"""
web_search.py — Multi-engine web search with full Google-dorking support.

Engines (run in parallel when engine='auto'):
  1. Google  — scraping (full dork syntax)
  2. Bing    — scraping (most dork operators supported)
  3. Brave   — HTML search page
  4. DuckDuckGo HTML — privacy-friendly fallback
  5. Yandex  — broad web index, great for images/reverse lookups
  6. Startpage — Google proxy

You can pass structured dork args (site, filetype, intitle, inurl, intext,
before, after, exclude, exact, or_terms) — they get composed into a query
on top of whatever you already wrote in `query`.

Dork operators supported directly in the query string:
  site:example.com           -site:pinterest.com
  filetype:pdf               intitle:"exact phrase"
  inurl:keyword              intext:"exact words"
  "exact match"              before:2025-01-01        after:2024-01-01
  OR                         *                        related:example.com
"""

from __future__ import annotations

import asyncio
import html as html_mod
import re
import time
import urllib.parse
from typing import Optional

from tools.web._common import fetch_sync


# ── Public entrypoint ────────────────────────────────────────────────────────

def execute(query: str, num_results: int = 10, engine: str = "auto",
            # Structured dorking args
            site: str = "", exclude_site: str = "", filetype: str = "",
            intitle: str = "", inurl: str = "", intext: str = "",
            exact: str = "", or_terms: Optional[list] = None,
            before: str = "", after: str = "",
            region: str = "", lang: str = "en",
            parallel: bool = True, **kwargs) -> dict:
    """Search the web with multi-engine parallel dispatch and dork support."""
    start = time.time()
    num_results = max(1, min(num_results, 25))
    q = _compose_query(query, site=site, exclude_site=exclude_site,
                       filetype=filetype, intitle=intitle, inurl=inurl,
                       intext=intext, exact=exact, or_terms=or_terms,
                       before=before, after=after)

    requested = [engine] if engine != "auto" else [
        "google", "bing", "brave", "ddg", "startpage", "yandex",
    ]

    results: list = []
    engines_used: list = []
    errors: list = []

    if parallel and engine == "auto":
        try:
            agg = asyncio.run(_parallel_search(q, num_results, requested, region, lang))
            for eng, items, err in agg:
                if items:
                    results.extend(items)
                    engines_used.append(eng)
                elif err:
                    errors.append(f"{eng}: {err}")
        except Exception as e:
            errors.append(f"parallel: {e}")

    if not results:
        for eng in requested:
            try:
                items = _dispatch(eng, q, num_results, region, lang)
                if items:
                    results.extend(items)
                    engines_used.append(eng)
                    if engine != "auto":
                        break
                    if len(results) >= num_results * 2:
                        break
            except Exception as e:
                errors.append(f"{eng}: {e}")

    merged = _merge_rank(results, num_results)

    if merged:
        return {
            "status": "ok",
            "result": {
                "query": q,
                "original_query": query,
                "engines": engines_used,
                "results": merged,
                "count": len(merged),
                "dork_operators_used": _detect_dorks(q),
                "errors": errors[:3] if errors else None,
            },
            "error": None,
            "metadata": {"tool": "web_search", "duration_ms": _ms(start)},
        }
    return _err(
        f"No results for '{q}'. Errors: {'; '.join(errors[:4])}",
        "web_search", start,
    )


# ── Structured dork composition ──────────────────────────────────────────────

def _compose_query(base: str, site: str = "", exclude_site: str = "",
                   filetype: str = "", intitle: str = "", inurl: str = "",
                   intext: str = "", exact: str = "",
                   or_terms: Optional[list] = None,
                   before: str = "", after: str = "") -> str:
    parts: list[str] = [base.strip()] if base else []
    if site:
        for s in _as_list(site):
            parts.append(f"site:{s}")
    if exclude_site:
        for s in _as_list(exclude_site):
            parts.append(f"-site:{s}")
    if filetype:
        parts.append(f"filetype:{filetype.lstrip('.').lower()}")
    if intitle:
        parts.append(f'intitle:"{intitle}"' if " " in intitle else f"intitle:{intitle}")
    if inurl:
        parts.append(f"inurl:{inurl}")
    if intext:
        parts.append(f'intext:"{intext}"' if " " in intext else f"intext:{intext}")
    if exact:
        parts.append(f'"{exact}"')
    if or_terms:
        parts.append("(" + " OR ".join(or_terms) + ")")
    if before:
        parts.append(f"before:{before}")
    if after:
        parts.append(f"after:{after}")
    return " ".join(p for p in parts if p).strip()


def _as_list(v):
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v if x]
    return [str(v)] if v else []


def _detect_dorks(query: str) -> list:
    ops = []
    patterns = {
        "site:": r"\bsite:\S+",
        "-site:": r"-site:\S+",
        "filetype:": r"\bfiletype:\S+",
        "intitle:": r"\bintitle:",
        "inurl:": r"\binurl:",
        "intext:": r"\bintext:",
        "exact_phrase": r'"[^"]+"',
        "before:": r"\bbefore:\S+",
        "after:": r"\bafter:\S+",
        "related:": r"\brelated:\S+",
        "OR": r"\bOR\b",
        "wildcard": r"\*",
    }
    for name, pat in patterns.items():
        if re.search(pat, query):
            ops.append(name)
    return ops


# ── Parallel dispatch ────────────────────────────────────────────────────────

async def _parallel_search(q: str, num: int, engines: list,
                           region: str, lang: str) -> list:
    loop = asyncio.get_event_loop()
    tasks = [
        loop.run_in_executor(None, _safe_call, eng, q, num, region, lang)
        for eng in engines
    ]
    return await asyncio.gather(*tasks)


def _safe_call(eng: str, q: str, num: int, region: str, lang: str):
    try:
        return (eng, _dispatch(eng, q, num, region, lang), None)
    except Exception as e:
        return (eng, [], str(e))


def _dispatch(engine: str, query: str, num: int, region: str, lang: str) -> list:
    if engine == "google":
        return _google(query, num, region, lang)
    if engine == "bing":
        return _bing(query, num, region, lang)
    if engine == "brave":
        return _brave(query, num, region, lang)
    if engine == "ddg":
        return _ddg(query, num, region, lang)
    if engine == "startpage":
        return _startpage(query, num, region, lang)
    if engine == "yandex":
        return _yandex(query, num, region, lang)
    raise ValueError(f"Unknown engine: {engine}")


# ── Result merging / ranking ─────────────────────────────────────────────────

def _merge_rank(items: list, target: int) -> list:
    """Dedup by URL, combine snippets, boost by engine agreement."""
    bucket: dict = {}
    for i, it in enumerate(items):
        u = it.get("url", "").strip()
        if not u:
            continue
        norm = re.sub(r"[#?].*$", "", u.lower().rstrip("/"))
        if norm not in bucket:
            bucket[norm] = {**it, "_engines": [it.get("engine")],
                            "_best_rank": it.get("rank", i)}
        else:
            b = bucket[norm]
            if it.get("engine") not in b["_engines"]:
                b["_engines"].append(it.get("engine"))
            b["_best_rank"] = min(b["_best_rank"], it.get("rank", i))
            if len(it.get("snippet") or "") > len(b.get("snippet") or ""):
                b["snippet"] = it.get("snippet")
            if not b.get("title") and it.get("title"):
                b["title"] = it["title"]

    merged = list(bucket.values())
    merged.sort(key=lambda r: (len(r["_engines"]) * 100 - r["_best_rank"]), reverse=True)
    out = []
    for r in merged[:target]:
        out.append({
            "title": r.get("title", ""),
            "url": r.get("url", ""),
            "snippet": (r.get("snippet") or "")[:400],
            "engines": r.get("_engines", []),
        })
    return out


# ── Engine: Google ───────────────────────────────────────────────────────────

def _google(query: str, num: int, region: str = "", lang: str = "en") -> list:
    encoded = urllib.parse.quote_plus(query)
    gl = f"&gl={region}" if region else ""
    url = f"https://www.google.com/search?q={encoded}&num={min(num + 5, 30)}&hl={lang}{gl}&pws=0"
    res = fetch_sync(url, timeout=15, referer="https://www.google.com/", use_cache=True)
    if not res.ok:
        raise RuntimeError(res.error or f"HTTP {res.status}")
    html = res.text
    items = []

    for m in re.finditer(
        r'<a[^>]+href="(https?://[^"#]+)"[^>]*>\s*(?:<br>)?\s*<h3[^>]*>(.*?)</h3>',
        html, re.DOTALL,
    ):
        href = m.group(1)
        if "google.com" in href and "/search" in href:
            continue
        title = _clean(m.group(2))
        snippet = _extract_nearby_snippet(html, m.end())
        items.append({"engine": "google", "title": title, "url": _unwrap_google(href),
                      "snippet": snippet, "rank": len(items)})
        if len(items) >= num:
            break

    if not items:
        for m in re.finditer(r'<a[^>]+href="/url\?q=(https?://[^&"]+)', html):
            url_ = urllib.parse.unquote(m.group(1))
            items.append({"engine": "google", "title": url_[:80], "url": url_,
                          "snippet": "", "rank": len(items)})
            if len(items) >= num:
                break
    return items


def _unwrap_google(u: str) -> str:
    if u.startswith("/url?"):
        m = re.search(r"q=([^&]+)", u)
        if m:
            return urllib.parse.unquote(m.group(1))
    return u


def _extract_nearby_snippet(html: str, pos: int) -> str:
    chunk = html[pos:pos + 2000]
    m = re.search(
        r'<div[^>]*(?:class="[^"]*(?:VwiC3b|lEBKkf|yXK7lf|MUxGbd)[^"]*"|data-sncf)[^>]*>(.*?)</div>',
        chunk, re.DOTALL,
    )
    if not m:
        m = re.search(r'<span[^>]*class="[^"]*st[^"]*"[^>]*>(.*?)</span>', chunk, re.DOTALL)
    return _clean(m.group(1)) if m else ""


# ── Engine: Bing ─────────────────────────────────────────────────────────────

def _bing(query: str, num: int, region: str = "", lang: str = "en") -> list:
    encoded = urllib.parse.quote_plus(query)
    url = f"https://www.bing.com/search?q={encoded}&count={min(num + 5, 30)}&setlang={lang}"
    res = fetch_sync(url, timeout=15, referer="https://www.bing.com/", use_cache=True)
    if not res.ok:
        raise RuntimeError(res.error or f"HTTP {res.status}")
    html = res.text
    items = []
    for m in re.finditer(
        r'<li class="b_algo"[^>]*>.*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>(.*?)</a></h2>'
        r'(?:.*?<p[^>]*>(.*?)</p>)?',
        html, re.DOTALL,
    ):
        href = m.group(1)
        title = _clean(m.group(2))
        snippet = _clean(m.group(3) or "")
        items.append({"engine": "bing", "title": title, "url": href,
                      "snippet": snippet, "rank": len(items)})
        if len(items) >= num:
            break
    return items


# ── Engine: Brave ────────────────────────────────────────────────────────────

def _brave(query: str, num: int, region: str = "", lang: str = "en") -> list:
    encoded = urllib.parse.quote_plus(query)
    url = f"https://search.brave.com/search?q={encoded}&source=web"
    res = fetch_sync(url, timeout=15, referer="https://search.brave.com/", use_cache=True)
    if not res.ok:
        raise RuntimeError(res.error or f"HTTP {res.status}")
    html = res.text
    items = []
    for m in re.finditer(
        r'<a[^>]+href="(https?://[^"]+)"[^>]*>.*?<(?:span|div)[^>]+class="[^"]*(?:title|snippet-title)[^"]*"[^>]*>(.*?)</(?:span|div)>',
        html, re.DOTALL,
    ):
        href = m.group(1)
        if "brave.com" in href:
            continue
        items.append({"engine": "brave", "title": _clean(m.group(2)),
                      "url": href, "snippet": "", "rank": len(items)})
        if len(items) >= num:
            break
    return items


# ── Engine: DuckDuckGo HTML ──────────────────────────────────────────────────

def _ddg(query: str, num: int, region: str = "", lang: str = "en") -> list:
    encoded = urllib.parse.quote_plus(query)
    url = f"https://html.duckduckgo.com/html/?q={encoded}"
    res = fetch_sync(url, timeout=15, referer="https://duckduckgo.com/", use_cache=True)
    if not res.ok:
        raise RuntimeError(res.error or f"HTTP {res.status}")
    html = res.text
    items = []
    for m in re.finditer(
        r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?'
        r'<a[^>]+class="result__snippet"[^>]*>(.*?)</a>',
        html, re.DOTALL,
    ):
        href = m.group(1)
        real = _ddg_unwrap(href)
        title = _clean(m.group(2))
        snippet = _clean(m.group(3))
        items.append({"engine": "ddg", "title": title, "url": real,
                      "snippet": snippet, "rank": len(items)})
        if len(items) >= num:
            break
    return items


def _ddg_unwrap(href: str) -> str:
    m = re.search(r"uddg=([^&]+)", href)
    return urllib.parse.unquote(m.group(1)) if m else href


# ── Engine: Startpage ────────────────────────────────────────────────────────

def _startpage(query: str, num: int, region: str = "", lang: str = "en") -> list:
    encoded = urllib.parse.quote_plus(query)
    url = f"https://www.startpage.com/do/search?query={encoded}&cat=web"
    res = fetch_sync(url, timeout=15, referer="https://www.startpage.com/", use_cache=True)
    if not res.ok:
        raise RuntimeError(res.error or f"HTTP {res.status}")
    html = res.text
    items = []
    for m in re.finditer(
        r'<a[^>]+class="[^"]*w-gl__result-url[^"]*"[^>]+href="([^"]+)"[^>]*>.*?'
        r'<h[1-3][^>]*class="[^"]*w-gl__result-title[^"]*"[^>]*>(.*?)</h[1-3]>',
        html, re.DOTALL,
    ):
        items.append({"engine": "startpage", "title": _clean(m.group(2)),
                      "url": m.group(1), "snippet": "", "rank": len(items)})
        if len(items) >= num:
            break
    if not items:
        for m in re.finditer(
            r'<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>(.*?)</a>',
            html, re.DOTALL,
        ):
            items.append({"engine": "startpage", "title": _clean(m.group(2)),
                          "url": m.group(1), "snippet": "", "rank": len(items)})
            if len(items) >= num:
                break
    return items


# ── Engine: Yandex ───────────────────────────────────────────────────────────

def _yandex(query: str, num: int, region: str = "", lang: str = "en") -> list:
    encoded = urllib.parse.quote_plus(query)
    url = f"https://yandex.com/search/?text={encoded}&lr=213"
    res = fetch_sync(url, timeout=15, referer="https://yandex.com/", use_cache=True)
    if not res.ok:
        raise RuntimeError(res.error or f"HTTP {res.status}")
    html = res.text
    items = []
    for m in re.finditer(
        r'<a[^>]+class="[^"]*OrganicTitle-Link[^"]*"[^>]+href="([^"]+)"[^>]*>(.*?)</a>',
        html, re.DOTALL,
    ):
        href = m.group(1)
        if not href.startswith("http"):
            continue
        items.append({"engine": "yandex", "title": _clean(m.group(2)),
                      "url": href, "snippet": "", "rank": len(items)})
        if len(items) >= num:
            break
    return items


# ── Utilities ────────────────────────────────────────────────────────────────

def _clean(fragment: str) -> str:
    fragment = re.sub(r"<[^>]+>", "", fragment)
    fragment = html_mod.unescape(fragment)
    return re.sub(r"\s+", " ", fragment).strip()


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
