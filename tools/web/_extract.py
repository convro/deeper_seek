"""
_extract.py — Content extraction helpers.

  • extract_main(html, url)  → readable text + markdown
  • extract_metadata(html)   → title, description, lang, og, twitter, author, date
  • extract_jsonld(html)     → list of parsed JSON-LD blocks
  • extract_tables(html)     → list of row-lists (most relevant tables)
  • extract_links(html, base) → list of {url, text, rel}
  • extract_pdf(raw)         → plain text via pdfminer.six
  • html_to_markdown(html)   → markdownify wrapper
"""

from __future__ import annotations

import html as html_mod
import json
import re
from typing import Optional
from urllib.parse import urljoin


# ── Metadata (<title>, <meta>, og:, twitter:) ────────────────────────────────

_META_RX = re.compile(
    r"""<meta\s+[^>]*?(?:name|property|itemprop)\s*=\s*["']([^"']+)["'][^>]*?content\s*=\s*["']([^"']*)["']""",
    re.IGNORECASE | re.DOTALL,
)
_META_RX2 = re.compile(
    r"""<meta\s+[^>]*?content\s*=\s*["']([^"']*)["'][^>]*?(?:name|property|itemprop)\s*=\s*["']([^"']+)["']""",
    re.IGNORECASE | re.DOTALL,
)
_TITLE_RX = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_HTML_LANG_RX = re.compile(r"<html\s+[^>]*lang\s*=\s*['\"]([a-zA-Z0-9_-]+)['\"]", re.IGNORECASE)


def extract_metadata(html: str) -> dict:
    meta: dict[str, str] = {}
    for rx, flip in ((_META_RX, False), (_META_RX2, True)):
        for m in rx.finditer(html):
            k, v = (m.group(2), m.group(1)) if flip else (m.group(1), m.group(2))
            k = k.strip().lower()
            v = html_mod.unescape(v.strip())
            if k and v and k not in meta:
                meta[k] = v

    title_m = _TITLE_RX.search(html)
    title = html_mod.unescape(re.sub(r"\s+", " ", title_m.group(1)).strip()) if title_m else ""

    lang_m = _HTML_LANG_RX.search(html)
    lang = lang_m.group(1) if lang_m else meta.get("og:locale", "")

    def pick(*keys: str) -> str:
        for k in keys:
            if meta.get(k):
                return meta[k]
        return ""

    return {
        "title": pick("og:title", "twitter:title") or title,
        "description": pick("description", "og:description", "twitter:description"),
        "site_name": pick("og:site_name", "application-name"),
        "image": pick("og:image", "og:image:secure_url", "twitter:image", "image"),
        "author": pick("author", "article:author", "twitter:creator"),
        "published": pick("article:published_time", "datePublished", "date", "pubdate"),
        "modified": pick("article:modified_time", "dateModified"),
        "keywords": pick("keywords", "news_keywords"),
        "canonical": pick("og:url"),
        "type": pick("og:type"),
        "lang": lang,
        "all": meta,
    }


# ── JSON-LD ──────────────────────────────────────────────────────────────────

_JSONLD_RX = re.compile(
    r'<script[^>]*type\s*=\s*["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.IGNORECASE | re.DOTALL,
)


def extract_jsonld(html: str) -> list:
    blocks = []
    for m in _JSONLD_RX.finditer(html):
        txt = m.group(1).strip()
        txt = re.sub(r"<!--.*?-->", "", txt, flags=re.DOTALL)
        for attempt in (txt, txt.replace("\n", " "), _strip_trailing_comma(txt)):
            try:
                parsed = json.loads(attempt)
                if isinstance(parsed, list):
                    blocks.extend(parsed)
                else:
                    blocks.append(parsed)
                break
            except Exception:
                continue
    return blocks


def _strip_trailing_comma(s: str) -> str:
    return re.sub(r",\s*([}\]])", r"\1", s)


# ── Tables (simple rowified extraction) ──────────────────────────────────────

_TABLE_RX = re.compile(r"<table[^>]*>(.*?)</table>", re.IGNORECASE | re.DOTALL)
_TR_RX = re.compile(r"<tr[^>]*>(.*?)</tr>", re.IGNORECASE | re.DOTALL)
_CELL_RX = re.compile(r"<(?:td|th)[^>]*>(.*?)</(?:td|th)>", re.IGNORECASE | re.DOTALL)


def extract_tables(html: str, max_tables: int = 5) -> list:
    out = []
    for tbl in _TABLE_RX.findall(html):
        rows = []
        for tr in _TR_RX.findall(tbl):
            cells = [_strip_tags(c) for c in _CELL_RX.findall(tr)]
            cells = [c for c in cells if c]
            if cells:
                rows.append(cells)
        if len(rows) >= 2:
            out.append(rows)
            if len(out) >= max_tables:
                break
    return out


# ── Links ────────────────────────────────────────────────────────────────────

_LINK_RX = re.compile(r"""<a\s+[^>]*?href\s*=\s*["']([^"']+)["'][^>]*?>(.*?)</a>""",
                      re.IGNORECASE | re.DOTALL)


def extract_links(html: str, base_url: str = "") -> list:
    out = []
    seen = set()
    for m in _LINK_RX.finditer(html):
        href = html_mod.unescape(m.group(1).strip())
        text = _strip_tags(m.group(2))[:200]
        if not href or href.startswith(("javascript:", "mailto:", "tel:", "#")):
            continue
        full = urljoin(base_url, href) if base_url else href
        if full in seen:
            continue
        seen.add(full)
        out.append({"url": full, "text": text})
    return out


# ── Strip tags / whitespace ──────────────────────────────────────────────────

_TAG_RX = re.compile(r"<[^>]+>")
_SCRIPT_STYLE_RX = re.compile(r"<(script|style|noscript|template)\b[^>]*>.*?</\1>",
                              re.IGNORECASE | re.DOTALL)


def _strip_tags(fragment: str) -> str:
    fragment = _SCRIPT_STYLE_RX.sub(" ", fragment)
    fragment = _TAG_RX.sub(" ", fragment)
    fragment = html_mod.unescape(fragment)
    return re.sub(r"\s+", " ", fragment).strip()


def clean_whitespace(text: str) -> str:
    lines = [ln.strip() for ln in text.splitlines()]
    out: list[str] = []
    blank = False
    for ln in lines:
        is_blank = not ln
        if is_blank and blank:
            continue
        out.append(ln)
        blank = is_blank
    return "\n".join(out).strip()


# ── Main content extraction (trafilatura preferred) ──────────────────────────

def extract_main(html: str, url: str = "", favor: str = "recall") -> dict:
    """
    Extract main article text + markdown.

    favor: "recall" (default, trafilatura defaults) or "precision".
    Returns {text, markdown, method, title, language}.
    """
    try:
        import trafilatura
        cfg = trafilatura.settings.use_config()
        cfg.set("DEFAULT", "EXTRACTION_TIMEOUT", "0")

        downloaded = html
        text = trafilatura.extract(
            downloaded, url=url, include_comments=False, include_tables=True,
            include_images=False, include_formatting=False,
            favor_precision=(favor == "precision"),
            favor_recall=(favor == "recall"),
            config=cfg,
        ) or ""

        md = trafilatura.extract(
            downloaded, url=url, include_comments=False, include_tables=True,
            include_images=True, include_formatting=True, include_links=True,
            output_format="markdown",
            favor_precision=(favor == "precision"),
            favor_recall=(favor == "recall"),
            config=cfg,
        ) or ""

        meta = None
        try:
            meta = trafilatura.extract_metadata(downloaded)
        except Exception:
            pass

        return {
            "text": text.strip(),
            "markdown": md.strip(),
            "method": "trafilatura",
            "title": (meta.title if meta else "") or "",
            "language": (meta.language if meta else "") or "",
        }
    except ImportError:
        pass
    except Exception:
        pass

    # Fallback: readability-style heuristic via BeautifulSoup + markdownify
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, "lxml" if _has_lxml() else "html.parser")
        for tag in soup(["script", "style", "noscript", "template", "header",
                         "footer", "nav", "aside", "form"]):
            tag.decompose()

        candidates = soup.find_all(["article", "main"])
        if not candidates:
            # Score blocks by text length density
            blocks = soup.find_all(["div", "section"])
            blocks.sort(key=lambda b: len(b.get_text(strip=True)), reverse=True)
            candidates = blocks[:1]

        container = candidates[0] if candidates else soup.body or soup
        raw_html = str(container)
        text = clean_whitespace(container.get_text("\n", strip=True))

        md = raw_html
        try:
            import markdownify
            md = markdownify.markdownify(raw_html, heading_style="ATX")
            md = clean_whitespace(md)
        except ImportError:
            md = text

        title = ""
        if soup.title and soup.title.string:
            title = soup.title.string.strip()

        return {"text": text, "markdown": md, "method": "bs4", "title": title, "language": ""}
    except ImportError:
        pass
    except Exception:
        pass

    # Last resort: regex-only
    no_script = _SCRIPT_STYLE_RX.sub(" ", html)
    text = _strip_tags(no_script)
    return {"text": clean_whitespace(text), "markdown": clean_whitespace(text),
            "method": "regex", "title": "", "language": ""}


def _has_lxml() -> bool:
    try:
        import lxml  # noqa: F401
        return True
    except ImportError:
        return False


# ── HTML → Markdown (whole page) ─────────────────────────────────────────────

def html_to_markdown(html: str) -> str:
    try:
        import markdownify
        return clean_whitespace(markdownify.markdownify(html, heading_style="ATX"))
    except ImportError:
        return clean_whitespace(_strip_tags(_SCRIPT_STYLE_RX.sub(" ", html)))


# ── PDF extraction ───────────────────────────────────────────────────────────

def extract_pdf(raw: bytes) -> str:
    try:
        from pdfminer.high_level import extract_text
        from io import BytesIO
        return clean_whitespace(extract_text(BytesIO(raw)) or "")
    except ImportError:
        return ""
    except Exception as e:
        return f"[pdf_error: {e}]"


# ── Article summary of structured data ───────────────────────────────────────

def summarize_jsonld(blocks: list) -> dict:
    """Pick out the most useful bits from JSON-LD blocks (article, product, etc.)."""
    summary = {}
    for b in blocks:
        if not isinstance(b, dict):
            continue
        at = b.get("@type")
        if isinstance(at, list):
            at = at[0] if at else None
        if not at:
            continue
        key = str(at).lower()
        if key in ("article", "newsarticle", "blogposting") and "article" not in summary:
            summary["article"] = {
                "headline": b.get("headline"),
                "author": _flat(b.get("author")),
                "date": b.get("datePublished"),
                "description": b.get("description"),
                "image": _flat(b.get("image")),
            }
        elif key == "product" and "product" not in summary:
            summary["product"] = {
                "name": b.get("name"),
                "brand": _flat(b.get("brand")),
                "description": b.get("description"),
                "image": _flat(b.get("image")),
                "offers": _flat(b.get("offers")),
                "rating": _flat(b.get("aggregateRating")),
            }
        elif key in ("recipe",) and "recipe" not in summary:
            summary["recipe"] = {
                "name": b.get("name"),
                "ingredients": b.get("recipeIngredient"),
                "instructions": b.get("recipeInstructions"),
            }
        elif key in ("breadcrumblist",) and "breadcrumbs" not in summary:
            items = b.get("itemListElement") or []
            summary["breadcrumbs"] = [
                (i.get("name") or (i.get("item") or {}).get("name") if isinstance(i.get("item"), dict) else i.get("item"))
                for i in items if isinstance(i, dict)
            ]
    return summary


def _flat(v):
    if isinstance(v, dict):
        return v.get("name") or v.get("url") or v
    if isinstance(v, list) and v:
        return _flat(v[0])
    return v
