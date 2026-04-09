import urllib.request
import urllib.parse
import json
import re
import time


def execute(query: str, num_results: int = 8, **kwargs) -> dict:
    start = time.time()
    try:
        results = _ddg_search(query, num_results)
        return {
            "status": "ok",
            "result": {
                "query": query,
                "results": results,
                "count": len(results),
            },
            "error": None,
            "metadata": {"tool": "web_search", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "web_search", start)


def _ddg_search(query: str, num: int) -> list:
    """Use DuckDuckGo HTML search."""
    encoded = urllib.parse.quote_plus(query)
    url = f"https://html.duckduckgo.com/html/?q={encoded}"

    headers = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    }

    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        html = resp.read().decode("utf-8", errors="replace")

    results = []

    # Parse result blocks from DuckDuckGo HTML
    blocks = re.findall(
        r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?'
        r'<a[^>]+class="result__snippet"[^>]*>(.*?)</a>',
        html, re.DOTALL
    )

    for href, title, snippet in blocks:
        title = re.sub(r"<[^>]+>", "", title).strip()
        snippet = re.sub(r"<[^>]+>", "", snippet).strip()

        # DuckDuckGo wraps URLs — try to extract the real URL
        url_match = re.search(r"uddg=([^&]+)", href)
        if url_match:
            real_url = urllib.parse.unquote(url_match.group(1))
        else:
            real_url = href

        if real_url and title:
            results.append({
                "title": title,
                "url": real_url,
                "snippet": snippet,
            })
            if len(results) >= num:
                break

    # Fallback: extract any links if the above didn't work
    if not results:
        links = re.findall(r'uddg=([^&"]+)', html)
        titles = re.findall(r'class="result__a"[^>]*>([^<]+)<', html)
        for i, (link, title) in enumerate(zip(links, titles)):
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
