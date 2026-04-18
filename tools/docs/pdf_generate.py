"""
pdf_generate.py — Generate PDFs from markdown, HTML, or plain text.

Backends (chosen automatically):
  • weasyprint  — HTML/CSS → PDF (best for styled docs)
  • reportlab   — programmatic PDF (fallback, no system deps)

Inputs (provide exactly one of):
  markdown: str          — markdown source
  html:     str          — HTML source
  text:     str          — plain text
  source_path: str       — path to a .md/.html/.txt file

Output: dest (default: /tmp/deeperseek_out_<ts>.pdf)

Extras:
  title, author, page_size ("A4" | "Letter"), margin_mm (default 20),
  css (extra CSS string appended when using weasyprint),
  base_url (for resolving images/links when using weasyprint).
"""

from __future__ import annotations

import os
import time
from pathlib import Path


DEFAULT_CSS = """
@page { size: A4; margin: 20mm; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
       "Helvetica Neue", Arial, sans-serif; font-size: 11pt; line-height: 1.45;
       color: #222; }
h1 { font-size: 22pt; margin: 0 0 12pt 0; }
h2 { font-size: 16pt; margin: 18pt 0 8pt 0; color: #1a3a6b; }
h3 { font-size: 13pt; margin: 12pt 0 6pt 0; }
p  { margin: 0 0 8pt 0; }
a  { color: #1a73e8; text-decoration: none; }
code { font-family: Menlo, Consolas, monospace; font-size: 9.5pt;
       background: #f4f4f8; padding: 1px 4px; border-radius: 3px; }
pre  { background: #f6f6f9; padding: 10px 12px; border-radius: 4px;
       overflow: auto; font-size: 9.5pt; }
pre code { padding: 0; background: transparent; }
blockquote { margin: 8pt 0; padding: 4pt 12pt; border-left: 3px solid #1a73e8;
             color: #555; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
th, td { border: 1px solid #ddd; padding: 4pt 8pt; text-align: left;
         font-size: 10pt; }
th { background: #f0f3f9; }
img { max-width: 100%; height: auto; }
"""


def execute(markdown: str = "", html: str = "", text: str = "",
            source_path: str = "", dest: str = "",
            title: str = "", author: str = "",
            page_size: str = "A4", margin_mm: int = 20,
            css: str = "", base_url: str = "",
            backend: str = "auto", **kwargs) -> dict:
    start = time.time()

    given = sum(bool(x) for x in (markdown, html, text, source_path))
    if given != 1:
        return _err("provide exactly one of: markdown, html, text, source_path",
                    start)

    try:
        markdown, html, text = _load_source(markdown, html, text, source_path)
    except Exception as e:
        return _err(f"source load failed: {e}", start)

    dest = _dest_path(dest)

    body_html = _build_html(markdown, html, text, title)

    chosen = backend if backend != "auto" else _pick_backend()
    try:
        if chosen == "weasyprint":
            _render_weasy(body_html, dest, css, page_size,
                          margin_mm, base_url, title, author)
        elif chosen == "reportlab":
            _render_reportlab(markdown or text or _strip_html(html),
                              dest, title, author, page_size, margin_mm)
        else:
            return _err(f"unknown backend '{chosen}'", start)
    except Exception as e:
        # Try fallback
        if chosen == "weasyprint":
            try:
                _render_reportlab(markdown or text or _strip_html(html),
                                  dest, title, author, page_size, margin_mm)
                chosen = "reportlab"
            except Exception as e2:
                return _err(f"weasyprint failed ({e}); "
                            f"reportlab fallback failed ({e2})", start)
        else:
            return _err(f"{chosen} failed: {e}", start)

    return {"status": "ok", "result": {
        "dest": str(dest), "backend": chosen,
        "bytes": dest.stat().st_size, "title": title, "author": author,
    }, "error": None,
        "metadata": {"tool": "pdf_generate",
                     "duration_ms": int((time.time() - start) * 1000)}}


# ── Sources ─────────────────────────────────────────────────────────────────

def _load_source(md, html, txt, path):
    if path:
        p = Path(path).expanduser().resolve()
        data = p.read_text(encoding="utf-8", errors="replace")
        ext = p.suffix.lower()
        if ext in (".md", ".markdown"): return data, "", ""
        if ext in (".html", ".htm"): return "", data, ""
        return "", "", data
    return md, html, txt


def _build_html(markdown: str, html: str, text: str, title: str) -> str:
    head = f"<head><meta charset='utf-8'><title>{_esc(title or 'Document')}</title></head>"
    if html:
        if "<html" in html.lower() or "<body" in html.lower():
            return html
        return f"<!doctype html><html>{head}<body>{html}</body></html>"
    if markdown:
        body = _md_to_html(markdown)
    else:
        body = "<pre>" + _esc(text) + "</pre>"
    title_html = f"<h1>{_esc(title)}</h1>" if title else ""
    return (f"<!doctype html><html>{head}<body>"
            f"{title_html}{body}</body></html>")


def _md_to_html(md: str) -> str:
    try:
        import markdown as _md  # type: ignore
        return _md.markdown(md, extensions=["fenced_code", "tables",
                                            "sane_lists", "toc"])
    except Exception:
        return _simple_md(md)


def _simple_md(text: str) -> str:
    # Minimal fallback: headings, paragraphs, code fences, bullets
    lines = text.split("\n")
    out = []
    in_code = False
    in_list = False
    para: list = []

    def flush_para():
        nonlocal para
        if para:
            out.append("<p>" + " ".join(_esc(p) for p in para) + "</p>")
            para = []

    for ln in lines:
        if ln.startswith("```"):
            flush_para()
            if in_code:
                out.append("</code></pre>"); in_code = False
            else:
                out.append("<pre><code>"); in_code = True
            continue
        if in_code:
            out.append(_esc(ln)); continue
        if ln.startswith("# "):
            flush_para(); out.append(f"<h1>{_esc(ln[2:])}</h1>"); continue
        if ln.startswith("## "):
            flush_para(); out.append(f"<h2>{_esc(ln[3:])}</h2>"); continue
        if ln.startswith("### "):
            flush_para(); out.append(f"<h3>{_esc(ln[4:])}</h3>"); continue
        if ln.startswith(("- ", "* ")):
            if not in_list:
                flush_para(); out.append("<ul>"); in_list = True
            out.append(f"<li>{_esc(ln[2:])}</li>"); continue
        if in_list and not ln.strip():
            out.append("</ul>"); in_list = False; continue
        if not ln.strip():
            flush_para(); continue
        para.append(ln)

    if in_list: out.append("</ul>")
    flush_para()
    if in_code: out.append("</code></pre>")
    return "\n".join(out)


def _esc(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace('"', "&quot;"))


def _strip_html(html: str) -> str:
    import re as _re
    return _re.sub(r"<[^>]+>", "", html)


# ── Backends ────────────────────────────────────────────────────────────────

def _pick_backend() -> str:
    try:
        import weasyprint  # noqa: F401
        return "weasyprint"
    except Exception:
        pass
    try:
        import reportlab  # noqa: F401
        return "reportlab"
    except Exception:
        pass
    return "reportlab"  # will attempt install via executor


def _render_weasy(html: str, dest: Path, css: str, page_size: str,
                  margin_mm: int, base_url: str,
                  title: str, author: str) -> None:
    from weasyprint import HTML, CSS  # type: ignore
    sheet = DEFAULT_CSS.replace("size: A4;", f"size: {page_size};") \
                       .replace("margin: 20mm;", f"margin: {margin_mm}mm;")
    if css:
        sheet += "\n" + css
    HTML(string=html, base_url=base_url or None).write_pdf(
        target=str(dest),
        stylesheets=[CSS(string=sheet)],
    )


def _render_reportlab(text: str, dest: Path, title: str, author: str,
                      page_size: str, margin_mm: int) -> None:
    from reportlab.lib.pagesizes import A4, LETTER  # type: ignore
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle  # type: ignore
    from reportlab.lib.units import mm  # type: ignore
    from reportlab.platypus import (SimpleDocTemplate, Paragraph,  # type: ignore
                                    Spacer, Preformatted)
    size = LETTER if page_size.lower() == "letter" else A4
    doc = SimpleDocTemplate(str(dest), pagesize=size,
                            leftMargin=margin_mm * mm,
                            rightMargin=margin_mm * mm,
                            topMargin=margin_mm * mm,
                            bottomMargin=margin_mm * mm,
                            title=title or "Document", author=author or "")
    styles = getSampleStyleSheet()
    story = []
    if title:
        story.append(Paragraph(_esc(title), styles["Title"]))
        story.append(Spacer(1, 8))
    for block in text.split("\n\n"):
        block = block.strip()
        if not block: continue
        if block.startswith("# "):
            story.append(Paragraph(_esc(block[2:]), styles["Heading1"]))
        elif block.startswith("## "):
            story.append(Paragraph(_esc(block[3:]), styles["Heading2"]))
        elif block.startswith("### "):
            story.append(Paragraph(_esc(block[4:]), styles["Heading3"]))
        elif block.startswith("```"):
            code = block.strip("`").lstrip()
            story.append(Preformatted(code, styles["Code"]))
        else:
            story.append(Paragraph(_esc(block).replace("\n", "<br/>"),
                                   styles["BodyText"]))
        story.append(Spacer(1, 4))
    doc.build(story)


# ── Output path ─────────────────────────────────────────────────────────────

def _dest_path(dest: str) -> Path:
    if dest:
        p = Path(dest).expanduser().resolve()
    else:
        p = Path("/tmp") / f"deeperseek_out_{int(time.time())}.pdf"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _err(msg, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": "pdf_generate",
                         "duration_ms": int((time.time() - start) * 1000)}}
