"""
dir_fuzz.py — HTTP directory and endpoint fuzzer.

Concurrent HTTP path brute-forcing with built-in wordlists:
  • common: general-purpose paths (admin, api, config, backups, etc.)
  • api: REST/GraphQL endpoints
  • php: PHP-specific paths
  • asp: ASP.NET-specific paths
  • custom: path to your own wordlist file

Extension fuzzing, response filtering, and recursive scanning supported.
Use only on systems you own or have explicit written authorization to test.
"""

from __future__ import annotations

import time
import urllib.parse
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# fmt: off
WORDLISTS: dict[str, list[str]] = {
    "common": [
        # Admin / Auth
        "admin", "admin/", "administrator", "administrator/", "admin-panel",
        "admin_panel", "admincp", "adminarea", "backend", "back-end",
        "login", "logon", "signin", "sign-in", "sign_in", "logout", "signout",
        "dashboard", "panel", "control", "manage", "management", "manager",
        "cp", "user", "users", "account", "accounts", "profile", "register",
        "signup", "sign-up", "forgot-password", "reset-password", "auth", "oauth",
        # API
        "api", "api/", "api/v1", "api/v1/", "api/v2", "api/v2/", "api/v3",
        "graphql", "gql", "rest", "v1", "v2", "v3",
        "swagger", "swagger-ui", "swagger-ui.html", "swagger-ui/index.html",
        "api-docs", "api/docs", "openapi.json", "openapi.yaml",
        "docs", "documentation",
        # Config / Secrets
        ".env", ".env.local", ".env.development", ".env.production", ".env.staging",
        ".env.example", ".env.sample", ".env.bak", ".env.old",
        "config", "config/", "configuration", "settings", "conf", "conf/",
        "config.php", "config.js", "config.json", "config.yml", "config.yaml",
        "settings.py", "settings.php", "settings.json",
        "database.yml", "database.json", "db.json",
        ".htaccess", ".htpasswd", "web.config", "app.config",
        # Git / VCS
        ".git", ".git/", ".git/config", ".git/HEAD", ".git/index",
        ".git/COMMIT_EDITMSG", ".git/logs/HEAD",
        ".gitignore", ".gitattributes", ".svn", ".hg",
        # Files
        "robots.txt", "sitemap.xml", "sitemap.xml.gz", "sitemap_index.xml",
        "crossdomain.xml", "clientaccesspolicy.xml",
        "security.txt", ".well-known/security.txt",
        "humans.txt", "license.txt", "LICENSE", "LICENSE.txt",
        "readme.txt", "README.md", "CHANGELOG.md", "CHANGELOG.txt",
        "package.json", "composer.json", "yarn.lock", "package-lock.json",
        "Gemfile", "requirements.txt", "Pipfile",
        "Dockerfile", "docker-compose.yml", "docker-compose.yaml", ".dockerignore",
        ".DS_Store", "Thumbs.db",
        # Backup / Old
        "backup", "backup/", "backups", "backups/",
        "bak", "bak/", "old", "old/", "archive", "archives",
        "tmp", "tmp/", "temp", "temp/", "cache", "cache/",
        "db.sql", "backup.sql", "dump.sql", "database.sql", "data.sql",
        "backup.zip", "backup.tar.gz", "site.zip",
        # Static / Media
        "static", "static/", "assets", "assets/", "public", "public/",
        "media", "media/", "files", "files/", "downloads", "downloads/",
        "uploads", "uploads/", "upload", "images", "images/", "img",
        "css", "js", "fonts", "dist", "build", "src",
        # CMS
        "wp-admin", "wp-admin/", "wp-login.php", "wp-config.php",
        "wp-content/", "wp-includes/", "wp-json", "wp-json/wp/v2/users",
        "xmlrpc.php", "wp-cron.php",
        "phpmyadmin", "phpmyadmin/", "pma", "pma/", "dbadmin",
        "joomla", "administrator/",
        "drupal", "user/login", "user/register",
        "magento", "admin", "downloader",
        # PHP
        "index.php", "info.php", "phpinfo.php", "test.php",
        "shell.php", "cmd.php", "webshell.php", "upload.php",
        "admin.php", "login.php", "register.php", "setup.php",
        "install.php", "update.php", "migrate.php",
        # ASP/ASP.NET
        "default.asp", "default.aspx", "index.asp", "index.aspx",
        "login.aspx", "admin.aspx", "web.config", "global.asax",
        "elmah.axd", "trace.axd", "scriptresource.axd",
        # DevOps / Monitoring
        "metrics", "health", "healthcheck", "health/", "health-check",
        "status", "ping", "heartbeat", "ready", "live", "liveness",
        "actuator", "actuator/", "actuator/health", "actuator/env",
        "actuator/beans", "actuator/mappings", "actuator/info",
        "debug", "test", "testing", "dev", "development",
        "console", "shell", "terminal",
        # Infrastructure
        ".well-known/", ".well-known/acme-challenge/",
        "server-status", "server-info",
        "nginx_status", "nginx-status",
        "phpstatus", "fpm-status",
        # Cloud / DevOps
        ".aws", "credentials", "terraform", "Makefile",
        # Common includes
        "includes", "include", "lib", "libs", "library",
        "modules", "plugins", "extensions", "addons",
        "templates", "themes", "views", "layouts",
        "logs", "log", "error_log", "access.log",
        "cgi-bin", "cgi-bin/",
        "app", "application", "apps",
        # Service endpoints
        "soap", "wsdl", "service", "services",
        "rpc", "jsonrpc", "xmlrpc",
        "webhook", "webhooks", "callback",
        "feed", "feeds", "rss", "atom",
        # Search / Data
        "search", "query", "data", "export", "import",
        "report", "reports", "analytics",
    ],
    "api": [
        "api", "api/v1", "api/v2", "api/v3", "api/v4",
        "api/users", "api/user", "api/auth", "api/login",
        "api/register", "api/logout", "api/token", "api/refresh",
        "api/admin", "api/config", "api/settings",
        "api/health", "api/status", "api/ping",
        "api/search", "api/query",
        "api/upload", "api/file", "api/files",
        "api/product", "api/products", "api/order", "api/orders",
        "api/payment", "api/payments", "api/invoice",
        "api/webhook", "api/events",
        "api/me", "api/profile", "api/account",
        "api/reset-password", "api/forgot-password",
        "api/verify", "api/confirm",
        "graphql", "graphiql",
        "swagger.json", "swagger.yaml",
        "openapi.json", "openapi.yaml",
        "api-docs", "docs/api",
        ".well-known/openid-configuration",
        "oauth/token", "oauth/authorize",
        "auth/token", "auth/login", "auth/logout",
        "v1", "v1/", "v2", "v2/", "v3", "v3/",
    ],
    "php": [
        "index.php", "info.php", "phpinfo.php", "test.php",
        "admin.php", "login.php", "config.php", "db.php",
        "database.php", "connect.php", "connection.php",
        "upload.php", "uploader.php", "file.php", "files.php",
        "shell.php", "cmd.php", "eval.php", "backdoor.php",
        "webshell.php", "r57.php", "c99.php",
        "install.php", "setup.php", "update.php",
        "register.php", "signup.php",
        "forgot.php", "reset.php", "change_password.php",
        "search.php", "query.php",
        "error.php", "404.php", "500.php",
        "cron.php", "cron_job.php", "scheduler.php",
        "api.php", "ajax.php", "request.php",
        "export.php", "import.php", "download.php",
        "wp-config.php", "wp-login.php", "xmlrpc.php",
        "phpmyadmin/index.php", "pma/index.php",
    ],
    "asp": [
        "default.aspx", "index.aspx", "default.asp",
        "login.aspx", "admin.aspx", "register.aspx",
        "web.config", "global.asax", "global.asax.cs",
        "elmah.axd", "trace.axd", "scriptresource.axd",
        "webresource.axd", "ashx", "asmx",
        "upload.aspx", "download.aspx",
        "api.aspx", "service.asmx",
        "error.aspx", "404.aspx",
    ],
}
# fmt: on


def execute(
    url: str,
    wordlist: str = "common",
    extensions: list = None,
    threads: int = 25,
    timeout: int = 8,
    status_codes: list = None,
    follow_redirects: bool = False,
    user_agent: str = "",
    headers: dict = None,
    cookies: str = "",
    recursive: bool = False,
    recursive_dirs: list = None,
    max_results: int = 500,
    **kwargs,
) -> dict:
    """
    Fuzz HTTP paths on a target URL.

    wordlist: "common" | "api" | "php" | "asp" | path-to-file
    extensions: e.g. ["php", "html", "bak", "txt"] — appended to each word
    status_codes: response codes to report (default: [200,201,204,301,302,307,401,403,405])
    """
    start = time.time()

    # Normalize base URL
    base = url.rstrip("/")
    if not base.startswith("http"):
        base = "http://" + base

    # Resolve wordlist
    words = _resolve_wordlist(wordlist)
    if not words:
        return _err(f"Wordlist '{wordlist}' is empty or not found", start)

    # Build path list including extensions
    extensions = extensions or []
    paths = []
    for w in words:
        paths.append(w)
        for ext in extensions:
            ext = ext.lstrip(".")
            if not w.endswith(f".{ext}"):
                paths.append(f"{w}.{ext}")

    allowed_codes = status_codes or [200, 201, 204, 301, 302, 307, 308, 401, 403, 405, 500]

    ua = user_agent or "Mozilla/5.0 (compatible; SecurityScanner/1.0)"
    hdrs = {"User-Agent": ua}
    if cookies:
        hdrs["Cookie"] = cookies
    if headers:
        hdrs.update(headers)

    found: list[dict] = []
    scanned = 0
    errors = 0

    def check(path: str) -> Optional[dict]:
        target = f"{base}/{path}"
        try:
            req = urllib.request.Request(target, headers=hdrs, method="GET")
            if not follow_redirects:
                opener = urllib.request.build_opener(NoRedirect())
                resp = opener.open(req, timeout=timeout)
            else:
                resp = urllib.request.urlopen(req, timeout=timeout)
            code = resp.status
            content_length = int(resp.headers.get("Content-Length", 0) or 0)
            content_type = resp.headers.get("Content-Type", "")
            server = resp.headers.get("Server", "")
            resp.close()
            if code in allowed_codes:
                return {
                    "path": path,
                    "url": target,
                    "status": code,
                    "content_length": content_length,
                    "content_type": content_type.split(";")[0].strip(),
                    "server": server,
                }
        except urllib.error.HTTPError as e:
            if e.code in allowed_codes:
                return {
                    "path": path,
                    "url": target,
                    "status": e.code,
                    "content_length": 0,
                    "content_type": "",
                    "server": "",
                }
        except Exception:
            pass
        return None

    with ThreadPoolExecutor(max_workers=threads) as ex:
        futures = {ex.submit(check, p): p for p in paths}
        for fut in as_completed(futures):
            scanned += 1
            res = fut.result()
            if res:
                found.append(res)
                if len(found) >= max_results:
                    ex.shutdown(wait=False, cancel_futures=True)
                    break

    # Recursive: follow 200/301 dirs
    if recursive and recursive_dirs is None:
        dirs = [r["path"].rstrip("/") for r in found
                if r["status"] in (200, 301) and not "." in r["path"].split("/")[-1]]
        for d in dirs[:5]:
            sub = execute(
                url=f"{base}/{d}",
                wordlist=wordlist,
                extensions=extensions,
                threads=threads,
                timeout=timeout,
                status_codes=status_codes,
                follow_redirects=follow_redirects,
                recursive=False,
                max_results=100,
            )
            if sub.get("status") == "ok":
                for r in sub["result"].get("found", []):
                    r["path"] = f"{d}/{r['path']}"
                    found.append(r)

    found.sort(key=lambda x: x["status"])

    return {
        "status": "ok",
        "result": {
            "base_url": base,
            "paths_tested": scanned,
            "found_count": len(found),
            "found": found,
            "wordlist": wordlist,
        },
        "error": None,
        "metadata": {"tool": "dir_fuzz", "duration_ms": _ms(start)},
    }


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _resolve_wordlist(name: str) -> list[str]:
    if name in WORDLISTS:
        return WORDLISTS[name]
    p = Path(name)
    if p.exists():
        lines = p.read_text(errors="replace").splitlines()
        return [ln.strip() for ln in lines if ln.strip() and not ln.startswith("#")]
    return WORDLISTS["common"]


def _err(msg, start):
    return {
        "status": "error", "result": None, "error": msg,
        "metadata": {"tool": "dir_fuzz", "duration_ms": _ms(start)},
    }


def _ms(start):
    return int((time.time() - start) * 1000)


Optional = None  # noqa — used as type hint placeholder above
