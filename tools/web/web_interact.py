"""
web_interact.py — Full interactive Playwright browser control.

Drives a real Chromium browser for multi-step automation:
  • form filling, clicking, typing, selecting options
  • waiting for elements / URL changes / text to appear
  • session persistence (save/restore cookies across calls)
  • CAPTCHA detection + optional 2captcha/anticaptcha API bypass
  • JavaScript evaluation, file upload, key presses
  • sequential action chains for complex registration/login flows

Authorized security testing and automation use only.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
SESSION_DIR = PROJECT_ROOT / "runtime" / "cache" / "browser_sessions"
SHOT_DIR = PROJECT_ROOT / "runtime" / "cache" / "browse_shots"
SESSION_DIR.mkdir(parents=True, exist_ok=True)
SHOT_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

CAPTCHA_SELECTORS = [
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    ".g-recaptcha",
    ".h-captcha",
    "#recaptcha",
    "[data-sitekey]",
    "iframe[title*='captcha']",
    "iframe[title*='CAPTCHA']",
]


def execute(
    url: str = "",
    actions: list = None,
    session_id: str = "default",
    save_session: bool = False,
    load_session: bool = False,
    timeout_ms: int = 30000,
    user_agent: str = "",
    viewport_width: int = 1440,
    viewport_height: int = 900,
    captcha_api_key: str = "",
    click_cookie: bool = True,
    proxy: str = "",
    **kwargs,
) -> dict:
    """
    Execute a sequence of browser actions.

    actions: list of action dicts, each with a "type" field:
      navigate      url
      click         selector [, button, count, force]
      type          selector, text [, delay_ms]
      fill          selector, value  (clears first)
      fill_form     fields: {selector: value, ...}
      select        selector, value OR label
      hover         selector
      focus         selector
      press         key  (e.g. "Enter", "Tab", "Escape")
      wait_selector selector [, state: visible|hidden|attached|detached, timeout_ms]
      wait_url      url_contains [, timeout_ms]
      wait_text     text [, selector, timeout_ms]
      wait_ms       ms
      scroll_to     selector OR {x, y}
      scroll_page   direction: up|down|top|bottom
      screenshot    [path] [, full_page]
      evaluate      expression  -> returns result
      get_text      selector -> returns text
      get_html      [selector] -> returns html
      get_url       -> returns current url
      get_cookies   -> returns cookie list
      set_cookies   cookies: list of {name, value, domain, ...}
      clear_cookies
      upload_file   selector, file_path
      check_captcha -> returns captcha info if detected
      solve_captcha api_key [, sitekey, page_url]  -> 2captcha integration
      go_back
      go_forward
      reload
      new_tab       [url]
    """
    start = time.time()
    actions = actions or []

    try:
        _ensure_playwright()
    except Exception as e:
        return _err(f"Playwright not available: {e}", start)

    try:
        result = asyncio.run(
            _run_session(
                url=url,
                actions=actions,
                session_id=session_id,
                save_session=save_session,
                load_session=load_session,
                timeout_ms=timeout_ms,
                user_agent=user_agent or DEFAULT_UA,
                viewport=(viewport_width, viewport_height),
                captcha_api_key=captcha_api_key,
                click_cookie=click_cookie,
                proxy=proxy,
            )
        )
    except Exception as e:
        return _err(str(e), start)

    return {
        "status": "ok",
        "result": result,
        "error": None,
        "metadata": {"tool": "web_interact", "duration_ms": _ms(start)},
    }


async def _run_session(
    url, actions, session_id, save_session, load_session,
    timeout_ms, user_agent, viewport, captcha_api_key, click_cookie, proxy,
):
    from playwright.async_api import async_playwright

    session_file = SESSION_DIR / f"{session_id}.json"

    async with async_playwright() as p:
        launch_args = {
            "headless": True,
            "args": [
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--disable-web-security",
            ],
        }
        if proxy:
            launch_args["proxy"] = {"server": proxy}

        browser = await p.chromium.launch(**launch_args)

        ctx_args: dict[str, Any] = {
            "user_agent": user_agent,
            "viewport": {"width": viewport[0], "height": viewport[1]},
            "locale": "en-US",
            "extra_http_headers": {"Accept-Language": "en-US,en;q=0.9", "DNT": "1"},
        }

        # Stealth: hide automation markers
        ctx_args["java_script_enabled"] = True

        ctx = await browser.new_context(**ctx_args)

        # Stealth patches
        await ctx.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
            Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
            window.chrome = {runtime: {}};
        """)

        # Restore saved session
        if load_session and session_file.exists():
            try:
                state = json.loads(session_file.read_text())
                if state.get("cookies"):
                    await ctx.add_cookies(state["cookies"])
            except Exception:
                pass

        page = await ctx.new_page()

        action_log: list[dict] = []
        final_url = url
        page_title = ""

        if url:
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                final_url = page.url
                page_title = await page.title()
                if click_cookie:
                    await _accept_cookies(page)
            except Exception as e:
                action_log.append({"type": "navigate", "url": url, "error": str(e)})

        for action in actions:
            atype = action.get("type", "")
            result_entry: dict = {"type": atype}
            try:
                if atype == "navigate":
                    nav_url = action["url"]
                    await page.goto(nav_url, wait_until="domcontentloaded", timeout=timeout_ms)
                    if click_cookie:
                        await _accept_cookies(page)
                    final_url = page.url
                    result_entry["url"] = final_url

                elif atype == "click":
                    sel = action["selector"]
                    btn = action.get("button", "left")
                    cnt = action.get("count", 1)
                    force = action.get("force", False)
                    el = await page.wait_for_selector(sel, timeout=action.get("timeout_ms", 8000))
                    await el.click(button=btn, click_count=cnt, force=force)
                    result_entry["clicked"] = sel

                elif atype == "type":
                    sel = action["selector"]
                    text = action["text"]
                    delay = action.get("delay_ms", 30)
                    el = await page.wait_for_selector(sel, timeout=8000)
                    await el.type(text, delay=delay)
                    result_entry["typed"] = len(text)

                elif atype == "fill":
                    sel = action["selector"]
                    val = action["value"]
                    el = await page.wait_for_selector(sel, timeout=8000)
                    await el.fill(val)
                    result_entry["filled"] = sel

                elif atype == "fill_form":
                    fields = action.get("fields", {})
                    filled = []
                    for sel, val in fields.items():
                        try:
                            el = await page.wait_for_selector(sel, timeout=5000)
                            tag = await el.evaluate("e => e.tagName.toLowerCase()")
                            if tag == "select":
                                await el.select_option(value=val)
                            else:
                                await el.fill(str(val))
                            filled.append(sel)
                        except Exception as fe:
                            filled.append(f"{sel}:FAILED:{fe}")
                    result_entry["filled_fields"] = filled

                elif atype == "select":
                    sel = action["selector"]
                    el = await page.wait_for_selector(sel, timeout=8000)
                    if "value" in action:
                        await el.select_option(value=action["value"])
                    elif "label" in action:
                        await el.select_option(label=action["label"])
                    elif "index" in action:
                        await el.select_option(index=action["index"])
                    result_entry["selected"] = sel

                elif atype == "hover":
                    el = await page.wait_for_selector(action["selector"], timeout=8000)
                    await el.hover()

                elif atype == "focus":
                    el = await page.wait_for_selector(action["selector"], timeout=8000)
                    await el.focus()

                elif atype == "press":
                    key = action["key"]
                    sel = action.get("selector")
                    if sel:
                        el = await page.wait_for_selector(sel, timeout=8000)
                        await el.press(key)
                    else:
                        await page.keyboard.press(key)
                    result_entry["key"] = key

                elif atype == "wait_selector":
                    sel = action["selector"]
                    state = action.get("state", "visible")
                    t = action.get("timeout_ms", timeout_ms)
                    await page.wait_for_selector(sel, state=state, timeout=t)
                    result_entry["found"] = sel

                elif atype == "wait_url":
                    pattern = action["url_contains"]
                    t = action.get("timeout_ms", timeout_ms)
                    await page.wait_for_url(f"**{pattern}**", timeout=t)
                    result_entry["url"] = page.url

                elif atype == "wait_text":
                    text = action["text"]
                    sel = action.get("selector", "body")
                    t = action.get("timeout_ms", timeout_ms)
                    await page.wait_for_selector(
                        f"{sel}:has-text('{text}')", timeout=t
                    )
                    result_entry["text_found"] = True

                elif atype == "wait_ms":
                    await page.wait_for_timeout(action.get("ms", 1000))

                elif atype == "scroll_to":
                    if "selector" in action:
                        el = await page.query_selector(action["selector"])
                        if el:
                            await el.scroll_into_view_if_needed()
                    elif "x" in action or "y" in action:
                        x = action.get("x", 0)
                        y = action.get("y", 0)
                        await page.evaluate(f"window.scrollTo({x}, {y})")

                elif atype == "scroll_page":
                    direction = action.get("direction", "down")
                    if direction == "top":
                        await page.evaluate("window.scrollTo(0, 0)")
                    elif direction == "bottom":
                        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    elif direction == "down":
                        await page.evaluate("window.scrollBy(0, window.innerHeight * 0.8)")
                    elif direction == "up":
                        await page.evaluate("window.scrollBy(0, -window.innerHeight * 0.8)")

                elif atype == "screenshot":
                    fname = action.get("path") or f"interact_{int(time.time())}.png"
                    if not os.path.isabs(fname):
                        fname = str(SHOT_DIR / fname)
                    full = action.get("full_page", False)
                    await page.screenshot(path=fname, full_page=full)
                    result_entry["path"] = fname

                elif atype == "evaluate":
                    expr = action["expression"]
                    val = await page.evaluate(expr)
                    result_entry["value"] = val

                elif atype == "get_text":
                    sel = action.get("selector", "body")
                    el = await page.query_selector(sel)
                    result_entry["text"] = (await el.inner_text()) if el else ""

                elif atype == "get_html":
                    sel = action.get("selector")
                    if sel:
                        el = await page.query_selector(sel)
                        result_entry["html"] = (await el.inner_html()) if el else ""
                    else:
                        result_entry["html"] = await page.content()

                elif atype == "get_url":
                    result_entry["url"] = page.url

                elif atype == "get_cookies":
                    cookies = await ctx.cookies()
                    result_entry["cookies"] = cookies

                elif atype == "set_cookies":
                    await ctx.add_cookies(action["cookies"])
                    result_entry["set"] = len(action["cookies"])

                elif atype == "clear_cookies":
                    await ctx.clear_cookies()

                elif atype == "upload_file":
                    sel = action["selector"]
                    fpath = action["file_path"]
                    el = await page.wait_for_selector(sel, timeout=8000)
                    await el.set_input_files(fpath)
                    result_entry["uploaded"] = fpath

                elif atype == "check_captcha":
                    captcha_info = await _detect_captcha(page)
                    result_entry.update(captcha_info)

                elif atype == "solve_captcha":
                    api_key = action.get("api_key") or captcha_api_key
                    sitekey = action.get("sitekey", "")
                    page_url = action.get("page_url", page.url)
                    captcha_type = action.get("captcha_type", "recaptcha")
                    if not api_key:
                        result_entry["error"] = "No 2captcha API key provided"
                    else:
                        token = await _solve_captcha_2captcha(
                            api_key, sitekey, page_url, captcha_type
                        )
                        if token:
                            # Inject token into page
                            await page.evaluate(f"""
                                (function() {{
                                    var ta = document.getElementById('g-recaptcha-response');
                                    if (!ta) {{
                                        ta = document.createElement('textarea');
                                        ta.id = 'g-recaptcha-response';
                                        ta.name = 'g-recaptcha-response';
                                        document.body.appendChild(ta);
                                    }}
                                    ta.style.display = 'block';
                                    ta.value = '{token}';
                                    if (typeof ___grecaptcha_cfg !== 'undefined') {{
                                        var id = Object.keys(___grecaptcha_cfg.clients)[0];
                                        ___grecaptcha_cfg.clients[id].aa.aa.callback('{token}');
                                    }}
                                }})();
                            """)
                            result_entry["token"] = token[:20] + "..."
                            result_entry["injected"] = True
                        else:
                            result_entry["error"] = "CAPTCHA solving failed"

                elif atype == "go_back":
                    await page.go_back(timeout=timeout_ms)

                elif atype == "go_forward":
                    await page.go_forward(timeout=timeout_ms)

                elif atype == "reload":
                    await page.reload(timeout=timeout_ms)

                else:
                    result_entry["error"] = f"Unknown action type: {atype}"

                result_entry["ok"] = True

            except Exception as e:
                result_entry["ok"] = False
                result_entry["error"] = str(e)

            action_log.append(result_entry)

        final_url = page.url
        try:
            page_title = await page.title()
        except Exception:
            pass

        # Screenshot of final state
        final_shot = ""
        try:
            name = f"interact_final_{int(time.time())}.png"
            final_shot = str(SHOT_DIR / name)
            await page.screenshot(path=final_shot, full_page=False)
        except Exception:
            final_shot = ""

        # Save session if requested
        if save_session:
            try:
                cookies = await ctx.cookies()
                session_file.write_text(json.dumps({"cookies": cookies}))
            except Exception:
                pass

        await browser.close()

    return {
        "url": final_url,
        "title": page_title,
        "screenshot": final_shot or None,
        "actions": action_log,
        "session_id": session_id,
        "session_saved": save_session,
    }


async def _detect_captcha(page) -> dict:
    for sel in CAPTCHA_SELECTORS:
        try:
            el = await page.query_selector(sel)
            if el:
                # Try to get sitekey
                sitekey = ""
                try:
                    sitekey = await page.evaluate(
                        f"document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') || ''"
                    )
                except Exception:
                    pass
                captcha_type = "hcaptcha" if "hcaptcha" in sel else "recaptcha"
                return {
                    "captcha_detected": True,
                    "captcha_type": captcha_type,
                    "sitekey": sitekey,
                    "selector": sel,
                }
        except Exception:
            continue
    return {"captcha_detected": False}


async def _solve_captcha_2captcha(api_key: str, sitekey: str, page_url: str, captcha_type: str) -> str:
    import urllib.request
    import urllib.parse

    try:
        # Submit task
        if captcha_type == "hcaptcha":
            in_url = (
                f"https://2captcha.com/in.php?key={api_key}&method=hcaptcha"
                f"&sitekey={urllib.parse.quote(sitekey)}&pageurl={urllib.parse.quote(page_url)}"
            )
        else:
            in_url = (
                f"https://2captcha.com/in.php?key={api_key}&method=userrecaptcha"
                f"&googlekey={urllib.parse.quote(sitekey)}&pageurl={urllib.parse.quote(page_url)}"
            )

        with urllib.request.urlopen(in_url, timeout=15) as r:
            resp = r.read().decode()
        if not resp.startswith("OK|"):
            return ""
        task_id = resp.split("|", 1)[1]

        # Poll for result
        for _ in range(24):
            await asyncio.sleep(5)
            res_url = f"https://2captcha.com/res.php?key={api_key}&action=get&id={task_id}"
            with urllib.request.urlopen(res_url, timeout=10) as r:
                result = r.read().decode()
            if result.startswith("OK|"):
                return result.split("|", 1)[1]
            if result == "ERROR_CAPTCHA_UNSOLVABLE":
                return ""
        return ""
    except Exception:
        return ""


async def _accept_cookies(page):
    selectors = [
        'button:has-text("Accept all")',
        'button:has-text("Accept All")',
        'button:has-text("Accept")',
        'button:has-text("I agree")',
        'button:has-text("Agree")',
        'button:has-text("Allow all")',
        'button:has-text("Zaakceptuj")',
        'button:has-text("Akceptuj")',
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
    marker = Path.home() / ".cache" / "ms-playwright" / ".installed-chromium"
    if not marker.exists():
        try:
            subprocess.check_call(
                [sys.executable, "-m", "playwright", "install", "--with-deps", "chromium"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except subprocess.CalledProcessError:
            subprocess.check_call(
                [sys.executable, "-m", "playwright", "install", "chromium"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        marker.parent.mkdir(parents=True, exist_ok=True)
        try:
            marker.touch()
        except OSError:
            pass


def _err(msg, start):
    return {
        "status": "error", "result": None, "error": msg,
        "metadata": {"tool": "web_interact", "duration_ms": _ms(start)},
    }


def _ms(start):
    return int((time.time() - start) * 1000)
