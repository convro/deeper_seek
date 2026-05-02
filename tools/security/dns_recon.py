"""
dns_recon.py — DNS reconnaissance and subdomain enumeration.

Resolves DNS records (A, AAAA, MX, NS, TXT, CNAME, SOA),
attempts zone transfers, brute-forces subdomains with a built-in
wordlist, and checks certificate transparency logs via crt.sh.
Use only on domains you own or have explicit written authorization to test.
"""

from __future__ import annotations

import json
import socket
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

# fmt: off
SUBDOMAIN_WORDLIST = [
    "www", "mail", "ftp", "smtp", "pop", "imap", "ns1", "ns2", "ns3",
    "mx", "mx1", "mx2", "vpn", "remote", "api", "api2", "apidev",
    "dev", "development", "staging", "stage", "test", "testing", "qa",
    "beta", "alpha", "demo", "sandbox", "preview", "preprod", "uat",
    "prod", "production", "app", "app1", "app2", "web", "web1", "web2",
    "static", "assets", "media", "cdn", "img", "images",
    "admin", "administrator", "manage", "management", "dashboard", "panel",
    "portal", "intranet", "internal", "private", "secure", "login",
    "auth", "sso", "oauth", "id", "identity",
    "blog", "forum", "shop", "store", "pay", "payment", "checkout",
    "mobile", "m", "touch", "wap",
    "docs", "documentation", "help", "support", "status", "monitor",
    "monitoring", "metrics", "analytics", "track", "tracking",
    "db", "database", "mysql", "postgres", "redis", "elastic",
    "git", "gitlab", "github", "repo", "svn", "jira", "confluence",
    "jenkins", "ci", "cd", "build", "deploy", "docker", "k8s",
    "kubernetes", "rancher",
    "smtp2", "relay", "bounce", "email", "newsletter",
    "search", "elastic", "solr",
    "upload", "uploads", "download", "files",
    "old", "legacy", "archive", "backup",
    "proxy", "gateway", "lb", "lb1", "lb2", "load",
    "cloud", "aws", "azure", "gcp",
    "crm", "erp", "hr", "finance",
    "exchange", "owa", "autodiscover", "webmail", "mail2",
    "office", "workspace", "collaborate",
    "video", "stream", "media2", "live",
    "api-dev", "api-staging", "api-test", "api-prod",
    "dev2", "dev3", "test2", "qa2",
]
# fmt: on

RECORD_TYPES = ["A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA", "SRV"]


def execute(
    domain: str,
    record_types: list = None,
    subdomains: bool = True,
    brute_force: bool = True,
    ct_logs: bool = True,
    zone_transfer: bool = True,
    reverse_dns: bool = False,
    custom_wordlist: list = None,
    threads: int = 50,
    timeout: float = 3.0,
    resolvers: list = None,
    **kwargs,
) -> dict:
    """
    Full DNS reconnaissance on a domain.

    record_types: list of DNS record types to query (default: all common types)
    subdomains: run subdomain brute-force
    ct_logs: query crt.sh certificate transparency logs for subdomains
    zone_transfer: attempt AXFR zone transfer
    reverse_dns: reverse-lookup IPs found in A records
    """
    start = time.time()
    domain = domain.strip().lstrip("http://").lstrip("https://").split("/")[0].lower()

    rt = record_types or RECORD_TYPES
    dns_results = _query_records(domain, rt, timeout)
    zone_transfer_result = None
    if zone_transfer:
        zone_transfer_result = _attempt_zone_transfer(domain, dns_results, timeout)

    found_subdomains: list[dict] = []
    if ct_logs:
        ct_subs = _query_crtsh(domain)
        for sub in ct_subs:
            if sub not in [s["subdomain"] for s in found_subdomains]:
                ip = _resolve_quick(sub, timeout)
                found_subdomains.append({
                    "subdomain": sub,
                    "source": "ct_logs",
                    "ip": ip,
                })

    if subdomains and brute_force:
        words = custom_wordlist or SUBDOMAIN_WORDLIST
        bf_results = _brute_force_subdomains(domain, words, threads, timeout)
        existing = {s["subdomain"] for s in found_subdomains}
        for r in bf_results:
            if r["subdomain"] not in existing:
                found_subdomains.append(r)

    reverse_results = {}
    if reverse_dns:
        ips = []
        for rec in dns_results.get("A", []):
            ips.append(rec)
        for sub in found_subdomains:
            if sub.get("ip"):
                ips.append(sub["ip"])
        for ip in set(ips):
            try:
                host, _, _ = socket.gethostbyaddr(ip)
                reverse_results[ip] = host
            except Exception:
                reverse_results[ip] = ""

    found_subdomains.sort(key=lambda x: x["subdomain"])

    return {
        "status": "ok",
        "result": {
            "domain": domain,
            "records": dns_results,
            "zone_transfer": zone_transfer_result,
            "subdomains_found": len(found_subdomains),
            "subdomains": found_subdomains,
            "reverse_dns": reverse_results,
        },
        "error": None,
        "metadata": {"tool": "dns_recon", "duration_ms": _ms(start)},
    }


def _query_records(domain: str, types: list, timeout: float) -> dict:
    results: dict[str, list] = {}
    for rtype in types:
        try:
            records = _dns_query(domain, rtype, timeout)
            if records:
                results[rtype] = records
        except Exception:
            pass
    return results


def _dns_query(domain: str, rtype: str, timeout: float) -> list:
    import subprocess
    try:
        r = subprocess.run(
            ["dig", "+short", f"-t{rtype}", domain],
            capture_output=True, text=True, timeout=timeout + 2,
        )
        lines = [l.strip() for l in r.stdout.strip().splitlines() if l.strip()]
        return lines
    except FileNotFoundError:
        pass

    # Fallback: socket for A records
    if rtype == "A":
        try:
            results = socket.getaddrinfo(domain, None, socket.AF_INET)
            return list({r[4][0] for r in results})
        except Exception:
            return []
    if rtype == "AAAA":
        try:
            results = socket.getaddrinfo(domain, None, socket.AF_INET6)
            return list({r[4][0] for r in results})
        except Exception:
            return []
    return []


def _attempt_zone_transfer(domain: str, dns_results: dict, timeout: float) -> dict:
    ns_servers = dns_results.get("NS", [])
    result = {"attempted": False, "successful": False, "nameservers_tried": [], "records": []}
    if not ns_servers:
        return result

    import subprocess
    result["attempted"] = True
    for ns in ns_servers[:3]:
        ns = ns.rstrip(".")
        result["nameservers_tried"].append(ns)
        try:
            r = subprocess.run(
                ["dig", f"@{ns}", "AXFR", domain],
                capture_output=True, text=True, timeout=timeout + 5,
            )
            if "Transfer failed" not in r.stdout and "XFR size" in r.stdout:
                result["successful"] = True
                lines = [l.strip() for l in r.stdout.splitlines()
                         if l.strip() and not l.startswith(";")]
                result["records"] = lines[:200]
                result["server"] = ns
                break
        except Exception:
            continue
    return result


def _query_crtsh(domain: str) -> list[str]:
    try:
        url = f"https://crt.sh/?q=%.{domain}&output=json"
        req = urllib.request.Request(url, headers={"User-Agent": "DNS-Recon/1.0"})
        with urllib.request.urlopen(req, timeout=12) as r:
            data = json.loads(r.read())
        subs = set()
        for entry in data:
            name = entry.get("name_value", "")
            for n in name.split("\n"):
                n = n.strip().lower().lstrip("*.")
                if n.endswith(f".{domain}") or n == domain:
                    subs.add(n)
        return sorted(subs)
    except Exception:
        return []


def _brute_force_subdomains(
    domain: str, words: list, threads: int, timeout: float
) -> list[dict]:
    found = []

    def check(sub: str):
        fqdn = f"{sub}.{domain}"
        ip = _resolve_quick(fqdn, timeout)
        if ip:
            return {"subdomain": fqdn, "source": "brute_force", "ip": ip}
        return None

    with ThreadPoolExecutor(max_workers=threads) as ex:
        futures = {ex.submit(check, w): w for w in words}
        for fut in as_completed(futures):
            res = fut.result()
            if res:
                found.append(res)

    return found


def _resolve_quick(host: str, timeout: float) -> str:
    try:
        old = socket.getdefaulttimeout()
        socket.setdefaulttimeout(timeout)
        ip = socket.gethostbyname(host)
        socket.setdefaulttimeout(old)
        return ip
    except Exception:
        return ""


def _ms(start):
    return int((time.time() - start) * 1000)
