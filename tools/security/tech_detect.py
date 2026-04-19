"""
tech_detect.py — Technology fingerprinting and OSINT for web targets.

Identifies the tech stack behind a URL:
  • CMS (WordPress, Drupal, Joomla, Magento, Shopify …)
  • Frameworks (Laravel, Django, Rails, Express, Next.js, Angular, Vue …)
  • Web servers (Apache, Nginx, IIS, Cloudflare, Caddy …)
  • CDN / WAF (Cloudflare, Akamai, Fastly, AWS, Sucuri, Incapsula …)
  • JavaScript libraries (jQuery, React, Bootstrap, etc.)
  • Analytics / Trackers (GA, GTM, Facebook Pixel, etc.)
  • APIs & third-party services

Also fetches WHOIS-style IP info, ASN, geolocation via ipinfo.io.
Use only on systems you own or have explicit written authorization to check.
"""

from __future__ import annotations

import json
import re
import socket
import time
import urllib.parse
import urllib.request
import urllib.error
from typing import Any

# Each fingerprint: (category, name, source, pattern)
# source: "header:<name>" | "body" | "cookie" | "url"
FINGERPRINTS = [
    # ── Web servers ──────────────────────────────────────────────────────────
    ("server", "Apache", "header:server", re.compile(r"Apache/?(\S+)?", re.I)),
    ("server", "Nginx", "header:server", re.compile(r"nginx/?(\S+)?", re.I)),
    ("server", "IIS", "header:server", re.compile(r"Microsoft-IIS/?(\S+)?", re.I)),
    ("server", "LiteSpeed", "header:server", re.compile(r"LiteSpeed", re.I)),
    ("server", "Caddy", "header:server", re.compile(r"Caddy", re.I)),
    ("server", "OpenResty", "header:server", re.compile(r"openresty/?(\S+)?", re.I)),
    ("server", "Gunicorn", "header:server", re.compile(r"gunicorn/?(\S+)?", re.I)),
    ("server", "Werkzeug", "header:server", re.compile(r"Werkzeug/?(\S+)?", re.I)),
    ("server", "Tomcat", "header:server", re.compile(r"Apache-Coyote|Tomcat/?(\S+)?", re.I)),
    # ── CDN / WAF ────────────────────────────────────────────────────────────
    ("cdn_waf", "Cloudflare", "header:cf-ray", re.compile(r".+")),
    ("cdn_waf", "Cloudflare", "header:server", re.compile(r"cloudflare", re.I)),
    ("cdn_waf", "AWS CloudFront", "header:x-amz-cf-id", re.compile(r".+")),
    ("cdn_waf", "AWS ALB", "header:x-amzn-requestid", re.compile(r".+")),
    ("cdn_waf", "Fastly", "header:x-served-by", re.compile(r"cache-", re.I)),
    ("cdn_waf", "Varnish", "header:x-varnish", re.compile(r".+")),
    ("cdn_waf", "Sucuri WAF", "header:x-sucuri-id", re.compile(r".+")),
    ("cdn_waf", "Incapsula", "header:x-iinfo", re.compile(r".+")),
    ("cdn_waf", "Akamai", "header:x-akamai-transformed", re.compile(r".+")),
    ("cdn_waf", "Imperva", "header:x-cdn", re.compile(r"imperva", re.I)),
    ("cdn_waf", "Azure Front Door", "header:x-azure-ref", re.compile(r".+")),
    # ── Language / Runtime ───────────────────────────────────────────────────
    ("language", "PHP", "header:x-powered-by", re.compile(r"PHP/?(\S+)?", re.I)),
    ("language", "ASP.NET", "header:x-powered-by", re.compile(r"ASP\.NET", re.I)),
    ("language", "ASP.NET MVC", "header:x-aspnetmvc-version", re.compile(r"(\S+)")),
    ("language", "ASP.NET", "header:x-aspnet-version", re.compile(r"(\S+)")),
    ("language", "Express.js", "header:x-powered-by", re.compile(r"Express", re.I)),
    ("language", "Java", "header:x-powered-by", re.compile(r"Servlet|JSP|JBoss|WebLogic", re.I)),
    # ── CMS ──────────────────────────────────────────────────────────────────
    ("cms", "WordPress", "body", re.compile(r'wp-content|wp-includes|wordpress', re.I)),
    ("cms", "WordPress", "cookie", re.compile(r'wordpress_|wp-settings')),
    ("cms", "Drupal", "header:x-generator", re.compile(r'Drupal', re.I)),
    ("cms", "Drupal", "body", re.compile(r'drupal\.settings|/sites/default/files', re.I)),
    ("cms", "Joomla", "body", re.compile(r'joomla!|com_content|joomla\.org', re.I)),
    ("cms", "Joomla", "cookie", re.compile(r'joomla_session')),
    ("cms", "Magento", "body", re.compile(r'Mage\.Cookies|/skin/frontend|mage/', re.I)),
    ("cms", "Magento", "cookie", re.compile(r'frontend')),
    ("cms", "PrestaShop", "body", re.compile(r'prestashop|presta-shop', re.I)),
    ("cms", "TYPO3", "body", re.compile(r'typo3|TYPO3', re.I)),
    ("cms", "Ghost", "body", re.compile(r'ghost-url|ghost\.io', re.I)),
    ("cms", "Craft CMS", "body", re.compile(r'craft-csrf-token', re.I)),
    ("cms", "Contentful", "body", re.compile(r'contentful\.com', re.I)),
    # ── E-commerce ───────────────────────────────────────────────────────────
    ("ecommerce", "Shopify", "header:x-shopify-stage", re.compile(r".+")),
    ("ecommerce", "Shopify", "body", re.compile(r'shopify\.com|Shopify\.theme', re.I)),
    ("ecommerce", "WooCommerce", "body", re.compile(r'woocommerce', re.I)),
    ("ecommerce", "BigCommerce", "body", re.compile(r'bigcommerce', re.I)),
    ("ecommerce", "OpenCart", "body", re.compile(r'opencart', re.I)),
    # ── Frontend frameworks ───────────────────────────────────────────────────
    ("frontend", "React", "body", re.compile(r'react\.js|react-dom|__REACT_|data-reactroot', re.I)),
    ("frontend", "Next.js", "body", re.compile(r'__NEXT_DATA__|_next/static', re.I)),
    ("frontend", "Angular", "body", re.compile(r'ng-version=|angular\.min\.js|@angular', re.I)),
    ("frontend", "Vue.js", "body", re.compile(r'vue\.js|vue\.min\.js|data-v-|__vue', re.I)),
    ("frontend", "Nuxt.js", "body", re.compile(r'__nuxt|_nuxt/', re.I)),
    ("frontend", "Svelte", "body", re.compile(r'svelte|__svelte', re.I)),
    ("frontend", "Ember.js", "body", re.compile(r'ember\.js|ember-cli', re.I)),
    ("frontend", "Backbone.js", "body", re.compile(r'backbone\.js|backbone\.min\.js', re.I)),
    # ── Backend frameworks ───────────────────────────────────────────────────
    ("backend", "Laravel", "cookie", re.compile(r'laravel_session')),
    ("backend", "Laravel", "body", re.compile(r'laravel', re.I)),
    ("backend", "Django", "body", re.compile(r'csrfmiddlewaretoken|django', re.I)),
    ("backend", "Django", "cookie", re.compile(r'csrftoken|sessionid')),
    ("backend", "Ruby on Rails", "header:x-powered-by", re.compile(r'Phusion Passenger', re.I)),
    ("backend", "Ruby on Rails", "body", re.compile(r'rails\.js|authenticity_token', re.I)),
    ("backend", "Spring Boot", "body", re.compile(r'spring', re.I)),
    ("backend", "FastAPI", "body", re.compile(r'FastAPI|fastapi', re.I)),
    ("backend", "Flask", "body", re.compile(r'flask', re.I)),
    ("backend", "Strapi", "header:x-powered-by", re.compile(r'Strapi', re.I)),
    # ── JS libraries ─────────────────────────────────────────────────────────
    ("library", "jQuery", "body", re.compile(r'jquery[.-](\d+\.\d+\.\d+)?', re.I)),
    ("library", "Bootstrap", "body", re.compile(r'bootstrap[.-](\d+\.\d+\.\d+)?', re.I)),
    ("library", "Tailwind CSS", "body", re.compile(r'tailwindcss|tailwind\.css', re.I)),
    ("library", "Lodash", "body", re.compile(r'lodash[.-](\d+)?', re.I)),
    ("library", "Axios", "body", re.compile(r'axios\.min\.js|axios@(\S+)?', re.I)),
    ("library", "Socket.io", "body", re.compile(r'socket\.io', re.I)),
    # ── Analytics ────────────────────────────────────────────────────────────
    ("analytics", "Google Analytics", "body", re.compile(r'google-analytics\.com/analytics|gtag\(|UA-\d+-\d+', re.I)),
    ("analytics", "Google Tag Manager", "body", re.compile(r'googletagmanager\.com', re.I)),
    ("analytics", "Facebook Pixel", "body", re.compile(r'connect\.facebook\.net/.*fbevents', re.I)),
    ("analytics", "HotJar", "body", re.compile(r'hotjar\.com', re.I)),
    ("analytics", "Mixpanel", "body", re.compile(r'mixpanel\.com', re.I)),
    ("analytics", "Segment", "body", re.compile(r'segment\.com|analytics\.js', re.I)),
    ("analytics", "Amplitude", "body", re.compile(r'amplitude\.com', re.I)),
    ("analytics", "Intercom", "body", re.compile(r'intercom\.io', re.I)),
    ("analytics", "Zendesk", "body", re.compile(r'zendesk\.com', re.I)),
    ("analytics", "Crisp", "body", re.compile(r'crisp\.chat', re.I)),
    # ── Payment ──────────────────────────────────────────────────────────────
    ("payment", "Stripe", "body", re.compile(r'stripe\.com/v\d+', re.I)),
    ("payment", "PayPal", "body", re.compile(r'paypal\.com', re.I)),
    ("payment", "Braintree", "body", re.compile(r'braintreepayments\.com', re.I)),
    # ── Security ─────────────────────────────────────────────────────────────
    ("security", "hCaptcha", "body", re.compile(r'hcaptcha\.com', re.I)),
    ("security", "reCAPTCHA", "body", re.compile(r'google\.com/recaptcha', re.I)),
    ("security", "Turnstile (CF)", "body", re.compile(r'challenges\.cloudflare\.com', re.I)),
]


def execute(
    url: str,
    include_ip_info: bool = True,
    timeout: int = 12,
    user_agent: str = "",
    **kwargs,
) -> dict:
    """
    Fingerprint the tech stack of a web target.

    Returns detected technologies grouped by category + IP/ASN/geo info.
    """
    start = time.time()

    if not url.startswith("http"):
        url = "https://" + url

    ua = user_agent or "Mozilla/5.0 (compatible; TechDetect/1.0)"
    headers = {"User-Agent": ua, "Accept": "text/html,*/*"}

    # Fetch page
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(200_000).decode("utf-8", errors="replace")
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            final_url = resp.url
            status = resp.status
    except urllib.error.HTTPError as e:
        resp_headers = {k.lower(): v for k, v in e.headers.items()} if e.headers else {}
        body = ""
        try:
            body = e.read(50000).decode("utf-8", errors="replace")
        except Exception:
            pass
        final_url = url
        status = e.code
    except Exception as e:
        return _err(str(e), start)

    # Cookie header
    cookie_str = resp_headers.get("set-cookie", "")

    detected: dict[str, dict] = {}

    for category, name, source, pattern in FINGERPRINTS:
        if source.startswith("header:"):
            hdr_name = source[7:]
            val = resp_headers.get(hdr_name, "")
            m = pattern.search(val)
        elif source == "body":
            m = pattern.search(body)
        elif source == "cookie":
            m = pattern.search(cookie_str)
        else:
            m = None

        if m:
            key = f"{category}:{name}"
            if key not in detected:
                version = ""
                if m.lastindex:
                    version = m.group(1) or ""
                detected[key] = {"category": category, "name": name, "version": version}

    # Group by category
    by_category: dict[str, list] = {}
    for item in detected.values():
        cat = item["category"]
        by_category.setdefault(cat, [])
        entry = {"name": item["name"]}
        if item["version"]:
            entry["version"] = item["version"]
        by_category[cat].append(entry)

    # Deduplicate within each category
    for cat in by_category:
        seen = set()
        unique = []
        for e in by_category[cat]:
            if e["name"] not in seen:
                seen.add(e["name"])
                unique.append(e)
        by_category[cat] = unique

    # IP info
    ip_info = {}
    if include_ip_info:
        parsed = urllib.parse.urlparse(final_url)
        hostname = parsed.hostname or ""
        try:
            ip = socket.gethostbyname(hostname)
            ip_info["ip"] = ip
            ip_info.update(_get_ip_info(ip, timeout))
        except Exception:
            pass

    return {
        "status": "ok",
        "result": {
            "url": final_url,
            "status": status,
            "technologies": by_category,
            "technology_count": len(detected),
            "ip_info": ip_info,
        },
        "error": None,
        "metadata": {"tool": "tech_detect", "duration_ms": _ms(start)},
    }


def _get_ip_info(ip: str, timeout: int) -> dict:
    try:
        url = f"https://ipinfo.io/{ip}/json"
        req = urllib.request.Request(url, headers={"User-Agent": "TechDetect/1.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
        return {
            "hostname": data.get("hostname", ""),
            "org": data.get("org", ""),
            "asn": data.get("org", "").split(" ")[0] if data.get("org") else "",
            "city": data.get("city", ""),
            "country": data.get("country", ""),
            "region": data.get("region", ""),
        }
    except Exception:
        return {}


def _err(msg, start):
    return {
        "status": "error", "result": None, "error": msg,
        "metadata": {"tool": "tech_detect", "duration_ms": _ms(start)},
    }


def _ms(start):
    return int((time.time() - start) * 1000)
