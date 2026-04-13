"""
web_search.py — Multi-engine web search with Google dorking support.

Engines:
  1. Google (via scraping) — supports full dorking syntax
  2. DuckDuckGo HTML — privacy fallback

Google dorking operators (pass directly in the query):
  site:example.com         — search only on this domain
  -site:pinterest.com      — exclude a domain
  filetype:pdf             — find specific file types
  intitle:"exact phrase"   — title must contain phrase
  inurl:keyword            — URL must contain keyword
  intext:"exact words"     — body text must contain phrase
  "exact match"            — exact phrase search
  before:2025-01-01        — results before date
  after:2024-01-01         — results after date
  OR                       — logical OR between terms
  *                        — wildcard (any word)
  related:example.com      — sites similar to domain
"""

import urllib.request
import urllib.parse
import json
import re
import time


HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,*/*",
    "Accept-Language": "en-US,en;q=0.9",
}


def execute(query: str, num_results: int = 8, engine: str = "auto", **kwargs) -> dict:
    """
    Search the web. Supports Google dorking syntax.

    Args:
        query:       Search query — supports Google dork operators
                     (site:, filetype:, intitle:, inurl:, "exact", etc.)
        num_results: How many results to return (1-20)
        engine:      "google", "ddg", or "auto" (tries Google first)
    """
    start = time.time()
    num_results = max(1, min(num_results, 20))

    results = []
    used_engine = None
    errors = []

    if engine in ("auto", "google"):
        try:
            results = _google_search(query, num_results)
            used_engine = "google"
        except Exception as e:
            errors.append(f"Google: {e}")

    if not results and engine in ("auto", "ddg"):
        try:
            results = _ddg_search(query, num_results)
            used_engine = "duckduckgo"
        except Exception as e:
            errors.append(f"DuckDuckGo: {e}")

    if results:
        return {
            "status": "ok",
            "result": {
                "query": query,
                "engine": used_engine,
                "results": results,
                "count": len(results),
                "dork_operators_used": _detect_dorks(query),
            },
            "error": None,
            "metadata": {"tool": "web_search", "duration_ms": _ms(start)},
        }
    else:
        return _err(
            f"No results for '{query}'. Errors: {'; '.join(errors)}",
            "web_search", start,
        )


def _detect_dorks(query: str) -> list:
    """Detect which dork operators are present in the query."""
    ops = []
    patterns = {
        "site:": r"site:\S+",
        "-site:": r"-site:\S+",
        "filetype:": r"filetype:\S+",
        "intitle:": r"intitle:",
        "inurl:": r"inurl:",
        "intext:": r"intext:",
        "exact_phrase": r'"[^"]+"',
        "before:": r"before:\S+",
        "after:": r"after:\S+",
        "related:": r"related:\S+",
        "OR": r"\bOR\b",
        "wildcard": r"\*",
    }
    for name, pat in patterns.items():
        if re.search(pat, query):
            ops.append(name)
    return ops


# ── Google Search ────────────────────────────────────────────────────────────

def _google_search(query: str, num: int) -> list:
    """Scrape Google search results. Full dork syntax support."""
    encoded = urllib.parse.quote_plus(query)
    url = f"https://www.google.com/search?q={encoded}&num={min(num + 5, 30)}&hl=en"

    req = urllib.request.Request(url, headers={
        **HEADERS,
        "Referer": "https://www.google.com/",
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        html = resp.read().decode("utf-8", errors="replace")

    results = []

    # Method 1: Standard result blocks
    # Google wraps results in <div class="g"> blocks
    blocks = re.findall(r'<div class="[^"]*g[^"]*">(.*?)</div>\s*</div>\s*</div>', html, re.DOTALL)

    for block in blocks:
        # Extract URL
        url_match = re.search(r'<a[^>]+href="(https?://[^"]+)"', block)
        if not url_match:
            continue
        result_url = url_match.group(1)

        # Skip Google's own URLs
        if "google.com" in result_url and "/search" in result_url:
            continue

        # Extract title
        title_match = re.search(r'<h3[^>]*>(.*?)</h3>', block, re.DOTALL)
        title = re.sub(r'<[^>]+>', '', title_match.group(1)).strip() if title_match else ""

        # Extract snippet
        snippet_match = re.search(
            r'<div[^>]*(?:class="[^"]*VwiC3b[^"]*"|data-sncf)[^>]*>(.*?)</div>',
            block, re.DOTALL
        )
        snippet = re.sub(r'<[^>]+>', '', snippet_match.group(1)).strip() if snippet_match else ""

        if result_url and title:
            results.append({
                "title": title,
                "url": result_url,
                "snippet": snippet[:300],
            })
            if len(results) >= num:
                break

    # Method 2: Fallback — broader pattern matching
    if not results:
        # Look for any href + h3 pairs
        pairs = re.findall(
            r'<a[^>]+href="(https?://(?!google\.com)[^"]+)"[^>]*>.*?<h3[^>]*>(.*?)</h3>',
            html, re.DOTALL
        )
        for href, raw_title in pairs:
            title = re.sub(r'<[^>]+>', '', raw_title).strip()
            if title and href:
                results.append({"title": title, "url": href, "snippet": ""})
                if len(results) >= num:
                    break

    return results


# ── DuckDuckGo Search ────────────────────────────────────────────────────────

def _ddg_search(query: str, num: int) -> list:
    """Use DuckDuckGo HTML search as fallback."""
    encoded = urllib.parse.quote_plus(query)
    url = f"https://html.duckduckgo.com/html/?q={encoded}"

    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=15) as resp:
        html = resp.read().decode("utf-8", errors="replace")

    results = []

    blocks = re.findall(
        r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?'
        r'<a[^>]+class="result__snippet"[^>]*>(.*?)</a>',
        html, re.DOTALL
    )

    for href, title, snippet in blocks:
        title = re.sub(r"<[^>]+>", "", title).strip()
        snippet = re.sub(r"<[^>]+>", "", snippet).strip()

        url_match = re.search(r"uddg=([^&]+)", href)
        real_url = urllib.parse.unquote(url_match.group(1)) if url_match else href

        if real_url and title:
            results.append({"title": title, "url": real_url, "snippet": snippet})
            if len(results) >= num:
                break

    if not results:
        links = re.findall(r'uddg=([^&"]+)', html)
        titles = re.findall(r'class="result__a"[^>]*>([^<]+)<', html)
        for link, title in zip(links, titles):
            results.append({
                "title": title.strip(),
                "url": urllib.parse.unquote(link),
                "snippet": "",
            })
            if len(results) >= num:
                break

    return results


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
