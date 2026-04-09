import time
import urllib.request
import urllib.error
import json
import re


def execute(url: str, format: str = "text", timeout: int = 15, **kwargs) -> dict:
    start = time.time()
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/json,*/*",
            "Accept-Language": "en-US,en;q=0.9",
        }

        req = urllib.request.Request(url, headers=headers)

        with urllib.request.urlopen(req, timeout=timeout) as response:
            content_type = response.headers.get("Content-Type", "")
            raw = response.read()

        # Decode
        encoding = "utf-8"
        for enc in ["utf-8", "latin-1", "ascii"]:
            try:
                text = raw.decode(enc)
                encoding = enc
                break
            except UnicodeDecodeError:
                continue
        else:
            text = raw.decode("utf-8", errors="replace")

        if format == "json":
            try:
                parsed = json.loads(text)
                content = json.dumps(parsed, indent=2)[:50000]
            except json.JSONDecodeError:
                content = text[:50000]

        elif format == "html":
            content = text[:50000]

        else:  # text (default) — strip HTML tags
            content = _strip_html(text)
            content = _clean_whitespace(content)
            content = content[:50000]

        truncated = len(content) >= 50000

        return {
            "status": "ok",
            "result": {
                "url": url,
                "content": content,
                "format": format,
                "content_type": content_type,
                "encoding": encoding,
                "length": len(content),
                "truncated": truncated,
            },
            "error": None,
            "metadata": {"tool": "web_fetch", "duration_ms": _ms(start)},
        }

    except urllib.error.HTTPError as e:
        return _err(f"HTTP {e.code}: {e.reason} — {url}", "web_fetch", start)
    except urllib.error.URLError as e:
        return _err(f"URL error: {e.reason} — {url}", "web_fetch", start)
    except Exception as e:
        return _err(str(e), "web_fetch", start)


def _strip_html(html: str) -> str:
    # Remove script and style blocks
    html = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    # Remove HTML tags
    html = re.sub(r"<[^>]+>", " ", html)
    # Decode common HTML entities
    html = html.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<") \
               .replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'")
    return html


def _clean_whitespace(text: str) -> str:
    lines = [line.strip() for line in text.splitlines()]
    # Remove empty consecutive lines
    result = []
    prev_empty = False
    for line in lines:
        is_empty = not line
        if is_empty and prev_empty:
            continue
        result.append(line)
        prev_empty = is_empty
    return "\n".join(result)


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
