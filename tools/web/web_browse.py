"""
web_browse.py — JS-rendered page browsing via Playwright (Chromium headless).

When a page is heavily JS-rendered (SPAs, client-side content, infinite scroll,
lazy-loaded imagery, JS-protected text) the static `web_fetch` tool cannot see
the real content. This tool drives a real browser to:

  • wait for the DOM / network to settle
  • optionally scroll to force lazy-load of content and images
  • click through cookie banners when possible
  • screenshot the page
  • return: rendered HTML, main text, metadata, all visible links and images

Playwright is lazily installed on first use if unavailable.
"""

from __future__ import annotations

import asyncio
import os
import sys
import subprocess
import time
from pathlib import Path

from tools.web._extract import (
    extract_main, extract_metadata, extract_jsonld, summarize_jsonld,
    extract_links,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
SHOT_DIR = PROJECT_ROOT / "runtime" / "cache" / "browse_shots"
SHOT_DIR.mkdir(parents=True, exist_ok=True)


def execute(url: str, wait_until: str = "networkidle", timeout_ms: int = 25000,
            scroll: bool = True, scroll_steps: int = 8, screenshot: bool = True,
            click_cookie: bool = True, user_agent: str = "",
            viewport_width: int = 1440, viewport_height: int = 900,
            extract: bool = True, return_html: bool = False,
            **kwargs) -> dict:
    start = time.time()
    try:
        _ensure_playwright()
    except Exception as e:
        return _err(f"Playwright not available: {e}", "web_browse", start, url=url)

    try:
        data = asyncio.run(_browse(
            url=url, wait_until=wait_until, timeout_ms=timeout_ms,
            scroll=scroll, scroll_steps=scroll_steps,
            screenshot=screenshot, click_cookie=click_cookie,
            user_agent=user_agent, viewport=(viewport_width, viewport_height),
            extract=extract, return_html=return_html,
        ))
    except Exception as e:
        return _err(str(e), "web_browse", start, url=url)

    return {
        "status": "ok",
        "result": data,
        "error": None,
        "metadata": {"tool": "web_browse", "duration_ms": _ms(start)},
    }


async def _browse(url, wait_until, timeout_ms, scroll, scroll_steps,
                  screenshot, click_cookie, user_agent, viewport,
                  extract, return_html):
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled",
                  "--disable-dev-shm-usage"],
        )
        ctx = await browser.new_context(
            user_agent=user_agent or (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
            viewport={"width": viewport[0], "height": viewport[1]},
            locale="en-US",
            extra_http_headers={
                "Accept-Language": "en-US,en;q=0.9",
                "DNT": "1",
            },
        )
        page = await ctx.new_page()
        try:
            await page.goto(url, wait_until=wait_until, timeout=timeout_ms)
        except Exception:
            # Retry with a softer wait condition
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            except Exception as e:
                await browser.close()
                raise

        if click_cookie:
            await _accept_cookies(page)

        if scroll:
            await _scroll_to_bottom(page, steps=scroll_steps)

        final_url = page.url
        title = await page.title()
        html = await page.content()

        # Visible images (after lazy-load)
        images = await page.evaluate("""() => {
            const out = new Map();
            function add(u, w, h, alt) {
              if (!u) return;
              if (!u.startsWith('http')) return;
              const prev = out.get(u);
              if (!prev || (w*h > prev.w*prev.h)) out.set(u, {url:u, w:w||0, h:h||0, alt:alt||''});
            }
            for (const img of document.querySelectorAll('img')) {
              add(img.currentSrc || img.src, img.naturalWidth, img.naturalHeight, img.alt);
              if (img.srcset) {
                for (const part of img.srcset.split(',')) {
                  const u = part.trim().split(/\\s+/)[0];
                  add(u, 0, 0, img.alt);
                }
              }
            }
            for (const el of document.querySelectorAll('*')) {
              const bg = getComputedStyle(el).backgroundImage;
              if (bg && bg !== 'none') {
                const m = bg.match(/url\\(["']?(https?:[^"')]+)["']?\\)/);
                if (m) add(m[1], 0, 0, '');
              }
            }
            for (const s of document.querySelectorAll('source[srcset]')) {
              for (const part of s.srcset.split(',')) {
                const u = part.trim().split(/\\s+/)[0];
                add(u, 0, 0, '');
              }
            }
            return [...out.values()];
        }""")

        shot_path = ""
        if screenshot:
            try:
                import hashlib
                name = "browse_" + hashlib.sha1(final_url.encode()).hexdigest()[:14] + ".png"
                shot_path = str(SHOT_DIR / name)
                await page.screenshot(path=shot_path, full_page=False)
            except Exception:
                shot_path = ""

        await browser.close()

    out: dict = {
        "url": final_url,
        "title": title,
        "screenshot": shot_path or None,
        "images": images[:200],
    }
    if return_html:
        out["html"] = html[:300_000]

    if extract:
        main = extract_main(html, url=final_url)
        meta = extract_metadata(html)
        jsonld = extract_jsonld(html)
        out.update({
            "text": main.get("text", "")[:80_000],
            "markdown": main.get("markdown", "")[:80_000],
            "metadata": meta,
            "jsonld_summary": summarize_jsonld(jsonld),
            "links": extract_links(html, base_url=final_url)[:150],
            "extraction_method": main.get("method"),
            "word_count": len(main.get("text", "").split()),
        })
    return out


async def _scroll_to_bottom(page, steps: int = 8):
    for i in range(steps):
        try:
            await page.evaluate("window.scrollBy(0, window.innerHeight * 0.9)")
            await page.wait_for_timeout(550)
        except Exception:
            break
    try:
        await page.evaluate("window.scrollTo(0, 0)")
    except Exception:
        pass


async def _accept_cookies(page):
    selectors = [
        'button:has-text("Accept all")',
        'button:has-text("Accept All")',
        'button:has-text("I agree")',
        'button:has-text("Agree")',
        'button:has-text("Allow all")',
        'button:has-text("Zaakceptuj")',
        'button:has-text("Akceptuj")',
        'button:has-text("Zgadzam się")',
        'button:has-text("OK")',
        '[id*="accept"][id*="cookie"]',
        '[class*="accept"][class*="cookie"]',
        '[data-testid*="accept"]',
    ]
    for sel in selectors:
        try:
            el = await page.query_selector(sel)
            if el:
                await el.click(timeout=1500)
                await page.wait_for_timeout(300)
                return
        except Exception:
            continue


def _ensure_playwright():
    try:
        import playwright  # noqa: F401
    except ImportError:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--quiet", "playwright"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    try:
        from playwright.async_api import async_playwright  # noqa: F401
    except ImportError as e:
        raise RuntimeError(f"playwright install failed: {e}")

    # Ensure browsers are installed (idempotent; fast if already present)
    marker = Path.home() / ".cache" / "ms-playwright" / ".installed-chromium"
    if not marker.exists():
        try:
            subprocess.check_call(
                [sys.executable, "-m", "playwright", "install", "--with-deps", "chromium"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except subprocess.CalledProcessError:
            # Retry without --with-deps (no sudo)
            subprocess.check_call(
                [sys.executable, "-m", "playwright", "install", "chromium"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        marker.parent.mkdir(parents=True, exist_ok=True)
        try:
            marker.touch()
        except OSError:
            pass


def _err(msg, tool, start, url=""):
    return {"status": "error", "result": {"url": url} if url else None,
            "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
