"""
web_audit.py — Comprehensive web security auditor.

Checks a target URL/domain for:
  • Missing/misconfigured security headers (CSP, HSTS, X-Frame-Options, etc.)
  • Cookie security attributes (Secure, HttpOnly, SameSite)
  • CORS misconfiguration (wildcard, credentialed origins)
  • Allowed HTTP methods (PUT, DELETE, TRACE, etc.)
  • Open redirects on common parameters
  • Information leakage (server headers, error pages, stack traces)
  • Technology fingerprinting (CMS, framework, server, WAF detection)
  • robots.txt and sitemap.xml parsing
  • Basic clickjacking vulnerability
  • SSL/TLS info from headers

Use only on systems you own or have explicit written authorization to test.
"""

from __future__ import annotations

import re
import time
import urllib.parse
import urllib.request
import urllib.error
from typing import Any

SECURITY_HEADERS = {
    "strict-transport-security": {
        "desc": "HTTP Strict Transport Security (HSTS)",
        "severity": "high",
        "recommendation": "Add: Strict-Transport-Security: max-age=31536000; includeSubDomains; preload",
    },
    "x-frame-options": {
        "desc": "Clickjacking protection",
        "severity": "medium",
        "recommendation": "Add: X-Frame-Options: DENY or SAMEORIGIN",
    },
    "x-content-type-options": {
        "desc": "MIME type sniffing protection",
        "severity": "low",
        "recommendation": "Add: X-Content-Type-Options: nosniff",
    },
    "content-security-policy": {
        "desc": "Content Security Policy",
        "severity": "high",
        "recommendation": "Define a strict CSP to prevent XSS",
    },
    "x-xss-protection": {
        "desc": "Legacy XSS filter (deprecated but still useful)",
        "severity": "low",
        "recommendation": "Add: X-XSS-Protection: 1; mode=block",
    },
    "referrer-policy": {
        "desc": "Controls referrer information leakage",
        "severity": "low",
        "recommendation": "Add: Referrer-Policy: no-referrer-when-downgrade",
    },
    "permissions-policy": {
        "desc": "Browser features policy (replaces Feature-Policy)",
        "severity": "info",
        "recommendation": "Add Permissions-Policy to restrict browser APIs",
    },
    "cross-origin-embedder-policy": {
        "desc": "Cross-Origin Embedder Policy",
        "severity": "info",
        "recommendation": "",
    },
    "cross-origin-opener-policy": {
        "desc": "Cross-Origin Opener Policy",
        "severity": "info",
        "recommendation": "",
    },
    "cross-origin-resource-policy": {
        "desc": "Cross-Origin Resource Policy",
        "severity": "info",
        "recommendation": "",
    },
}

# Technology fingerprints: {header/body pattern: technology}
TECH_FINGERPRINTS = {
    # Server headers
    "apache": ("server", re.compile(r"Apache/?(\S*)", re.I)),
    "nginx": ("server", re.compile(r"nginx/?(\S*)", re.I)),
    "iis": ("server", re.compile(r"Microsoft-IIS/?(\S*)", re.I)),
    "cloudflare": ("server", re.compile(r"cloudflare", re.I)),
    "litespeed": ("server", re.compile(r"LiteSpeed", re.I)),
    "openresty": ("server", re.compile(r"openresty/?(\S*)", re.I)),
    # Framework cookies / headers
    "php": ("x-powered-by", re.compile(r"PHP/?(\S*)", re.I)),
    "asp.net": ("x-powered-by", re.compile(r"ASP\.NET", re.I)),
    "express": ("x-powered-by", re.compile(r"Express", re.I)),
    # WAF detection
    "cloudflare-waf": ("cf-ray", re.compile(r".+", re.I)),
    "aws-waf": ("x-amzn-requestid", re.compile(r".+", re.I)),
    "sucuri-waf": ("x-sucuri-id", re.compile(r".+", re.I)),
    "akamai": ("x-akamai-transformed", re.compile(r".+", re.I)),
    "incapsula": ("x-iinfo", re.compile(r".+", re.I)),
    # CMS cookies
    "wordpress": ("set-cookie", re.compile(r"wordpress_|wp-settings", re.I)),
    "drupal": ("x-generator", re.compile(r"Drupal", re.I)),
    "joomla": ("set-cookie", re.compile(r"joomla_session", re.I)),
    "magento": ("set-cookie", re.compile(r"frontend", re.I)),
    "shopify": ("x-shopify-stage", re.compile(r".+", re.I)),
}

OPEN_REDIRECT_PARAMS = [
    "url", "redirect", "redirect_url", "next", "return", "returnto",
    "return_url", "goto", "destination", "to", "from", "target",
    "link", "redir", "forward", "back",
]

HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD",
                "TRACE", "CONNECT", "DEBUG"]


def execute(
    url: str,
    check_headers: bool = True,
    check_cors: bool = True,
    check_cookies: bool = True,
    check_methods: bool = True,
    check_redirects: bool = True,
    check_info_leak: bool = True,
    fingerprint: bool = True,
    check_robots: bool = True,
    timeout: int = 10,
    user_agent: str = "",
    custom_headers: dict = None,
    **kwargs,
) -> dict:
    """
    Run a multi-check web security audit on a URL.
    """
    start = time.time()

    if not url.startswith("http"):
        url = "https://" + url

    ua = user_agent or "Mozilla/5.0 (compatible; SecurityAudit/1.0)"
    base_headers = {"User-Agent": ua, "Accept": "*/*"}
    if custom_headers:
        base_headers.update(custom_headers)

    findings: list[dict] = []
    info: dict[str, Any] = {}

    # Fetch the page
    resp_data = _fetch(url, "GET", base_headers, timeout)
    if resp_data is None:
        return _err(f"Could not connect to {url}", start)

    headers = resp_data["headers"]
    status = resp_data["status"]
    body = resp_data["body"]
    final_url = resp_data["url"]

    info["url"] = final_url
    info["status"] = status
    info["content_length"] = len(body)
    info["server"] = headers.get("server", "")

    # Security headers
    if check_headers:
        header_results = _check_security_headers(headers)
        info["security_headers"] = header_results
        for hdr, hinfo in header_results["missing"].items():
            findings.append({
                "category": "missing_header",
                "severity": hinfo["severity"],
                "header": hdr,
                "description": hinfo["desc"],
                "recommendation": hinfo["recommendation"],
            })
        # CSP analysis
        csp = headers.get("content-security-policy", "")
        if csp:
            csp_issues = _analyze_csp(csp)
            for issue in csp_issues:
                findings.append({"category": "csp_weakness", "severity": "medium", **issue})

    # CORS
    if check_cors:
        cors_issues = _check_cors(url, base_headers, timeout)
        info["cors"] = cors_issues
        for issue in cors_issues.get("issues", []):
            findings.append({"category": "cors", "severity": issue.get("severity", "high"), **issue})

    # Cookies
    if check_cookies:
        cookie_issues = _check_cookies(headers)
        info["cookies"] = cookie_issues
        for issue in cookie_issues.get("issues", []):
            findings.append({"category": "cookie", "severity": "medium", **issue})

    # HTTP methods
    if check_methods:
        methods_result = _check_http_methods(url, base_headers, timeout)
        info["allowed_methods"] = methods_result
        for m in methods_result.get("dangerous", []):
            findings.append({
                "category": "dangerous_method",
                "severity": "high",
                "method": m,
                "description": f"Dangerous HTTP method {m} is accepted",
                "recommendation": f"Disable {m} in server configuration",
            })

    # Open redirects
    if check_redirects:
        redirect_results = _check_open_redirect(url, base_headers, timeout)
        info["open_redirect"] = redirect_results
        if redirect_results.get("vulnerable"):
            findings.append({
                "category": "open_redirect",
                "severity": "medium",
                "description": "Open redirect vulnerability detected",
                "details": redirect_results,
            })

    # Information leakage
    if check_info_leak:
        leak_results = _check_info_leak(headers, body, url, base_headers, timeout)
        info["info_leak"] = leak_results
        for leak in leak_results.get("leaks", []):
            findings.append({"category": "info_leak", "severity": "medium", **leak})

    # Fingerprinting
    if fingerprint:
        tech = _fingerprint(headers, body)
        info["technologies"] = tech

    # Robots / Sitemap
    if check_robots:
        robots_info = _fetch_robots_sitemap(url, base_headers, timeout)
        info["robots_sitemap"] = robots_info
        if robots_info.get("sensitive_paths"):
            findings.append({
                "category": "robots_disclosure",
                "severity": "info",
                "description": "robots.txt discloses interesting paths",
                "paths": robots_info["sensitive_paths"],
            })

    # Severity summary
    severity_counts = {"critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0}
    for f in findings:
        sev = f.get("severity", "info")
        severity_counts[sev] = severity_counts.get(sev, 0) + 1

    return {
        "status": "ok",
        "result": {
            "url": final_url,
            "info": info,
            "findings_count": len(findings),
            "severity_summary": severity_counts,
            "findings": findings,
        },
        "error": None,
        "metadata": {"tool": "web_audit", "duration_ms": _ms(start)},
    }


def _check_security_headers(headers: dict) -> dict:
    present = {}
    missing = {}
    for hdr, hinfo in SECURITY_HEADERS.items():
        val = headers.get(hdr.lower()) or headers.get(hdr)
        if val:
            present[hdr] = val
        else:
            missing[hdr] = hinfo
    return {"present": present, "missing": missing}


def _analyze_csp(csp: str) -> list[dict]:
    issues = []
    if "unsafe-inline" in csp:
        issues.append({
            "description": "CSP allows 'unsafe-inline' scripts",
            "detail": "Negates XSS protection",
        })
    if "unsafe-eval" in csp:
        issues.append({
            "description": "CSP allows 'unsafe-eval'",
            "detail": "Allows eval() and similar risky functions",
        })
    if re.search(r"(script-src|default-src)\s[^;]*\*", csp):
        issues.append({
            "description": "CSP uses wildcard (*) in script-src or default-src",
            "detail": "Allows scripts from any origin",
        })
    return issues


def _check_cors(url: str, headers: dict, timeout: int) -> dict:
    origins_to_test = [
        "https://evil.com",
        "null",
        url.replace("https://", "https://evil.").replace("http://", "http://evil."),
    ]
    issues = []
    cors_headers = {}

    for origin in origins_to_test:
        hdrs = {**headers, "Origin": origin}
        resp = _fetch(url, "GET", hdrs, timeout)
        if not resp:
            continue

        acao = resp["headers"].get("access-control-allow-origin", "")
        acac = resp["headers"].get("access-control-allow-credentials", "")

        if acao:
            cors_headers["access-control-allow-origin"] = acao
            cors_headers["access-control-allow-credentials"] = acac

            if acao == "*" and acac.lower() == "true":
                issues.append({
                    "severity": "critical",
                    "description": "CORS wildcard with credentials: allows any origin to make credentialed requests",
                    "origin_tested": origin,
                    "acao": acao,
                })
            elif acao == "*":
                issues.append({
                    "severity": "medium",
                    "description": "CORS wildcard allows any origin to read responses",
                    "origin_tested": origin,
                    "acao": acao,
                })
            elif acao == origin and origin == "null":
                issues.append({
                    "severity": "high",
                    "description": "CORS reflects 'null' origin — sandbox bypass possible",
                    "origin_tested": origin,
                    "acao": acao,
                })
            elif acao == origin and "evil" in origin:
                issues.append({
                    "severity": "high",
                    "description": "CORS reflects arbitrary origin",
                    "origin_tested": origin,
                    "acao": acao,
                })
            break

    return {"headers": cors_headers, "issues": issues}


def _check_cookies(headers: dict) -> dict:
    raw_cookies = []
    for k, v in headers.items():
        if k.lower() == "set-cookie":
            raw_cookies.append(v)

    parsed = []
    issues = []
    for cookie in raw_cookies:
        parts = [p.strip() for p in cookie.split(";")]
        name_val = parts[0].split("=", 1) if "=" in parts[0] else [parts[0], ""]
        name = name_val[0].strip()
        attrs = {p.lower().split("=")[0].strip() for p in parts[1:]}

        info = {
            "name": name,
            "secure": "secure" in attrs,
            "httponly": "httponly" in attrs,
            "samesite": next((p for p in parts[1:] if p.lower().startswith("samesite")), ""),
        }
        parsed.append(info)

        if not info["secure"]:
            issues.append({
                "description": f"Cookie '{name}' missing Secure flag",
                "cookie": name,
            })
        if not info["httponly"] and name.lower() not in ("csrf_token",):
            issues.append({
                "description": f"Cookie '{name}' missing HttpOnly flag",
                "cookie": name,
            })
        if not info["samesite"]:
            issues.append({
                "description": f"Cookie '{name}' missing SameSite attribute",
                "cookie": name,
            })

    return {"cookies": parsed, "issues": issues}


def _check_http_methods(url: str, headers: dict, timeout: int) -> dict:
    allowed = []
    dangerous = []
    dangerous_methods = {"TRACE", "PUT", "DELETE", "DEBUG", "CONNECT"}

    for method in HTTP_METHODS:
        resp = _fetch(url, method, headers, timeout)
        if resp and resp["status"] not in (405, 501, 400):
            allowed.append(method)
            if method in dangerous_methods:
                dangerous.append(method)

    return {"allowed": allowed, "dangerous": dangerous}


def _check_open_redirect(url: str, headers: dict, timeout: int) -> dict:
    parsed = urllib.parse.urlparse(url)
    base = f"{parsed.scheme}://{parsed.netloc}"
    test_url = "https://evil.com"

    for param in OPEN_REDIRECT_PARAMS:
        test = f"{url}?{param}={urllib.parse.quote(test_url)}"
        resp = _fetch(test, "GET", headers, timeout, follow=False)
        if resp and resp["status"] in (301, 302, 303, 307, 308):
            location = resp["headers"].get("location", "")
            if "evil.com" in location:
                return {
                    "vulnerable": True,
                    "param": param,
                    "redirect_location": location,
                    "test_url": test,
                }
    return {"vulnerable": False}


def _check_info_leak(headers: dict, body: str, url: str, req_headers: dict, timeout: int) -> dict:
    leaks = []

    # Server header detail
    server = headers.get("server", "")
    if server and re.search(r"\d+\.\d+", server):
        leaks.append({
            "description": f"Server header reveals version: {server}",
            "header": "server",
        })

    # X-Powered-By
    xpb = headers.get("x-powered-by", "")
    if xpb:
        leaks.append({
            "description": f"X-Powered-By header reveals technology: {xpb}",
            "header": "x-powered-by",
        })

    # Stack traces in body
    stack_patterns = [
        (r"Traceback \(most recent call last\)", "Python stack trace in response"),
        (r"Exception in thread", "Java exception in response"),
        (r"at [A-Za-z]+\.[A-Za-z]+\(", "Java/Kotlin stack trace in response"),
        (r"Microsoft OLE DB|ODBC SQL Server Driver", "SQL server error in response"),
        (r"mysql_fetch_array|pg_query|sqlite_query", "Database error in response"),
        (r"Parse error:.+in .+on line \d+", "PHP error in response"),
        (r"Fatal error:.+in .+on line \d+", "PHP fatal error in response"),
        (r"Warning:.+in .+on line \d+", "PHP warning in response"),
        (r"SyntaxError|ReferenceError|TypeError", "JavaScript error in response"),
    ]
    for pattern, desc in stack_patterns:
        if re.search(pattern, body, re.I):
            leaks.append({"description": desc, "pattern": pattern})

    # Check common sensitive files
    sensitive = [
        ("/.git/config", "Git config exposed"),
        ("/.env", ".env file exposed"),
        ("/phpinfo.php", "phpinfo() page exposed"),
    ]
    for path, desc in sensitive:
        test_url = urllib.parse.urljoin(url, path)
        resp = _fetch(test_url, "GET", req_headers, timeout)
        if resp and resp["status"] == 200 and len(resp["body"]) > 10:
            body_snip = resp["body"][:200]
            if (path == "/.git/config" and "[core]" in body_snip) or \
               (path == "/.env" and ("=" in body_snip or "KEY" in body_snip)) or \
               (path == "/phpinfo.php" and "PHP Version" in body_snip):
                leaks.append({"description": desc, "url": test_url})

    return {"leaks": leaks}


def _fingerprint(headers: dict, body: str) -> dict:
    detected = {}
    for tech, (src, pattern) in TECH_FINGERPRINTS.items():
        val = headers.get(src, "") or headers.get(src.lower(), "")
        m = pattern.search(val)
        if m:
            detected[tech] = m.group(1) if m.lastindex else "detected"

    # Body-based fingerprinting
    body_patterns = [
        (r'wp-content|wp-includes|wordpress', "WordPress"),
        (r'Joomla!|joomla\.org', "Joomla"),
        (r'drupal\.js|drupal\.settings', "Drupal"),
        (r'Magento|mage/', "Magento"),
        (r'__shopify_', "Shopify"),
        (r'squarespace\.com', "Squarespace"),
        (r'wix\.com|_wixCssModules', "Wix"),
        (r'react|__NEXT_DATA__|next\.js', "Next.js/React"),
        (r'ng-version|angular', "Angular"),
        (r'data-vue|vuejs|__vue', "Vue.js"),
        (r'X-CSRF-Token|csrf_token', "CSRF protection"),
        (r'laravel_session', "Laravel"),
        (r'django', "Django"),
        (r'rails|ruby on rails', "Rails"),
        (r'jquery', "jQuery"),
        (r'bootstrap', "Bootstrap"),
        (r'cloudflare', "Cloudflare"),
    ]
    for pattern, name in body_patterns:
        if re.search(pattern, body, re.I) and name.lower() not in detected:
            detected[name.lower().replace(" ", "_").replace(".", "")] = "detected"

    return detected


def _fetch_robots_sitemap(url: str, headers: dict, timeout: int) -> dict:
    parsed = urllib.parse.urlparse(url)
    base = f"{parsed.scheme}://{parsed.netloc}"
    result = {"robots_txt": None, "sitemap_xml": None, "sensitive_paths": []}

    robots_resp = _fetch(f"{base}/robots.txt", "GET", headers, timeout)
    if robots_resp and robots_resp["status"] == 200:
        body = robots_resp["body"][:5000]
        result["robots_txt"] = body
        interesting = []
        for line in body.splitlines():
            if line.lower().startswith("disallow:"):
                path = line.split(":", 1)[1].strip()
                if any(kw in path.lower() for kw in
                       ["admin", "api", "backup", "config", "db", "private", "secret", "login"]):
                    interesting.append(path)
        result["sensitive_paths"] = interesting[:20]

    sitemap_resp = _fetch(f"{base}/sitemap.xml", "GET", headers, timeout)
    if sitemap_resp and sitemap_resp["status"] == 200:
        result["sitemap_xml"] = "found"

    return result


def _fetch(url: str, method: str, headers: dict, timeout: int, follow: bool = True) -> dict | None:
    try:
        req = urllib.request.Request(url, headers=headers, method=method)
        if not follow:
            opener = urllib.request.build_opener(_NoRedirect())
            resp = opener.open(req, timeout=timeout)
        else:
            resp = urllib.request.urlopen(req, timeout=timeout)
        body = resp.read(50000).decode("utf-8", errors="replace")
        hdrs = {k.lower(): v for k, v in resp.headers.items()}
        return {"status": resp.status, "headers": hdrs, "body": body, "url": resp.url}
    except urllib.error.HTTPError as e:
        hdrs = {k.lower(): v for k, v in e.headers.items()} if e.headers else {}
        body = ""
        try:
            body = e.read(5000).decode("utf-8", errors="replace")
        except Exception:
            pass
        return {"status": e.code, "headers": hdrs, "body": body, "url": url}
    except Exception:
        return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

    def http_error_301(self, req, fp, code, msg, hdrs):
        return fp

    def http_error_302(self, req, fp, code, msg, hdrs):
        return fp


def _err(msg, start):
    return {
        "status": "error", "result": None, "error": msg,
        "metadata": {"tool": "web_audit", "duration_ms": _ms(start)},
    }


def _ms(start):
    return int((time.time() - start) * 1000)
