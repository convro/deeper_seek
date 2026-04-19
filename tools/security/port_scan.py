"""
port_scan.py — TCP port scanner with banner grabbing and service detection.

Performs connect-based TCP scanning with concurrent threads.
Optional banner grabbing sends probes and reads service responses.
Use only on systems you own or have explicit written authorization to test.
"""

from __future__ import annotations

import socket
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

# fmt: off
COMMON_PORTS = [
    21, 22, 23, 25, 53, 80, 110, 111, 119, 135, 139, 143, 161, 194, 389,
    443, 445, 465, 514, 587, 631, 993, 995, 1080, 1194, 1433, 1521, 1723,
    2049, 2082, 2083, 2086, 2087, 2095, 2096, 2375, 2376, 3000, 3001,
    3306, 3389, 3690, 4000, 4443, 4444, 4848, 5000, 5432, 5672, 5900,
    5984, 5985, 6379, 6443, 7001, 7443, 8000, 8001, 8008, 8080, 8081,
    8082, 8086, 8088, 8090, 8161, 8443, 8500, 8888, 9000, 9001, 9090,
    9092, 9200, 9300, 9418, 9443, 10000, 11211, 15672, 27017, 27018,
    27019, 28017, 50000, 50070,
]

WEB_PORTS = [
    80, 443, 8000, 8001, 8008, 8080, 8081, 8082, 8083, 8088, 8090, 8443,
    8888, 3000, 3001, 4000, 4443, 4848, 5000, 9000, 9001, 9090, 10000,
]

SERVICE_MAP = {
    21: "FTP", 22: "SSH", 23: "Telnet", 25: "SMTP", 53: "DNS",
    80: "HTTP", 110: "POP3", 111: "RPC", 119: "NNTP", 135: "MSRPC",
    139: "NetBIOS", 143: "IMAP", 161: "SNMP", 194: "IRC", 389: "LDAP",
    443: "HTTPS", 445: "SMB", 465: "SMTPS", 514: "Syslog", 587: "SMTP-TLS",
    631: "IPP", 993: "IMAPS", 995: "POP3S", 1080: "SOCKS", 1194: "OpenVPN",
    1433: "MSSQL", 1521: "Oracle", 1723: "PPTP", 2049: "NFS",
    2082: "cPanel", 2083: "cPanelSSL", 2086: "WHM", 2087: "WHMSSL",
    2095: "Webmail", 2096: "WebmailSSL", 2375: "Docker", 2376: "DockerTLS",
    3000: "HTTP-dev", 3001: "HTTP-dev", 3306: "MySQL", 3389: "RDP",
    3690: "SVN", 4443: "HTTPS-alt", 4848: "GlassFish", 5000: "HTTP-dev",
    5432: "PostgreSQL", 5672: "AMQP", 5900: "VNC", 5984: "CouchDB",
    5985: "WinRM", 6379: "Redis", 6443: "Kubernetes-API", 7001: "WebLogic",
    8080: "HTTP-proxy", 8081: "HTTP-alt", 8086: "InfluxDB", 8088: "HTTP-alt",
    8161: "ActiveMQ", 8443: "HTTPS-alt", 8500: "Consul", 8888: "Jupyter",
    9000: "PHP-FPM/SonarQube", 9090: "Prometheus", 9092: "Kafka",
    9200: "Elasticsearch", 9300: "Elasticsearch-cluster", 9418: "Git",
    9443: "HTTPS-alt", 10000: "Webmin", 11211: "Memcached",
    15672: "RabbitMQ-mgmt", 27017: "MongoDB", 27018: "MongoDB-shard",
    27019: "MongoDB-config", 28017: "MongoDB-web", 50000: "DB2/Jenkins",
    50070: "Hadoop-NameNode",
}

BANNER_PROBES = {
    22: b"SSH-2.0-OpenSSH_8.0\r\n",
    25: b"EHLO probe\r\n",
    80: b"HEAD / HTTP/1.0\r\nHost: localhost\r\n\r\n",
    443: None,
    110: None,
    143: None,
    21: None,
}
# fmt: on


def execute(
    host: str,
    ports: str = "common",
    timeout: float = 1.0,
    max_threads: int = 150,
    grab_banners: bool = True,
    resolve_host: bool = True,
    **kwargs,
) -> dict:
    """
    Scan TCP ports on a host.

    ports: "common" | "web" | "1-1024" | "1-65535" | "80,443,8080" | "top100"
    Returns open ports with service names, banners, and response times.
    """
    start = time.time()

    try:
        port_list = _parse_ports(ports)
    except Exception as e:
        return _err(str(e), start)

    resolved_ip = ""
    if resolve_host:
        try:
            resolved_ip = socket.gethostbyname(host)
        except socket.gaierror as e:
            return _err(f"Cannot resolve host '{host}': {e}", start)

    open_ports = []
    filtered_ports = []
    scanned = 0

    def probe(port: int):
        nonlocal scanned
        result = _scan_port(host, port, timeout, grab_banners)
        scanned += 1
        return result

    with ThreadPoolExecutor(max_workers=min(max_threads, len(port_list))) as ex:
        futures = {ex.submit(probe, p): p for p in port_list}
        for fut in as_completed(futures):
            res = fut.result()
            if res["state"] == "open":
                open_ports.append(res)
            elif res["state"] == "filtered":
                filtered_ports.append(res["port"])

    open_ports.sort(key=lambda x: x["port"])

    return {
        "status": "ok",
        "result": {
            "host": host,
            "ip": resolved_ip,
            "ports_scanned": scanned,
            "open_count": len(open_ports),
            "open_ports": open_ports,
            "filtered_count": len(filtered_ports),
        },
        "error": None,
        "metadata": {"tool": "port_scan", "duration_ms": _ms(start)},
    }


def _scan_port(host: str, port: int, timeout: float, grab_banners: bool) -> dict:
    t0 = time.time()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        err = s.connect_ex((host, port))
        if err != 0:
            s.close()
            return {"port": port, "state": "closed"}

        latency_ms = int((time.time() - t0) * 1000)
        banner = ""

        if grab_banners:
            banner = _grab_banner(s, port, timeout)
        s.close()

        service = SERVICE_MAP.get(port, "unknown")

        # Try to refine service from banner
        service = _detect_service_from_banner(banner, service, port)

        return {
            "port": port,
            "state": "open",
            "service": service,
            "banner": banner[:300] if banner else "",
            "latency_ms": latency_ms,
        }
    except socket.timeout:
        return {"port": port, "state": "filtered"}
    except ConnectionRefusedError:
        return {"port": port, "state": "closed"}
    except OSError:
        return {"port": port, "state": "filtered"}
    except Exception:
        return {"port": port, "state": "closed"}


def _grab_banner(sock: socket.socket, port: int, timeout: float) -> str:
    sock.settimeout(min(timeout * 2, 3.0))
    try:
        # Read passive banner first (SSH, SMTP, FTP, POP3, IMAP respond on connect)
        passive_banner = ""
        try:
            passive_banner = sock.recv(1024).decode("utf-8", errors="replace").strip()
        except Exception:
            pass

        if passive_banner:
            return passive_banner

        # Send probe for HTTP
        probe = BANNER_PROBES.get(port)
        if probe is not None:
            sock.sendall(probe)
            try:
                resp = sock.recv(2048).decode("utf-8", errors="replace").strip()
                return resp[:500]
            except Exception:
                pass
        elif port in (80, 443, 8080, 8443, 8000, 8001, 8008, 8088):
            # Generic HTTP probe
            sock.sendall(b"HEAD / HTTP/1.0\r\nHost: localhost\r\n\r\n")
            try:
                return sock.recv(2048).decode("utf-8", errors="replace").strip()[:500]
            except Exception:
                pass
    except Exception:
        pass
    return ""


def _detect_service_from_banner(banner: str, default: str, port: int) -> str:
    bl = banner.lower()
    if "ssh-" in bl:
        return "SSH"
    if "220 " in banner and ("ftp" in bl or "smtp" in bl or "mail" in bl):
        if "ftp" in bl:
            return "FTP"
        return "SMTP"
    if "http/" in bl:
        server = ""
        for line in banner.split("\n"):
            if line.lower().startswith("server:"):
                server = line.split(":", 1)[1].strip()
                break
        if server:
            return f"HTTP ({server})"
        return "HTTP"
    if "+ok" in bl:
        return "POP3"
    if "* ok" in bl:
        return "IMAP"
    if "redis_version" in bl:
        return "Redis"
    if "mongodb" in bl:
        return "MongoDB"
    if "mysql" in bl or "mariadb" in bl:
        return "MySQL"
    return default


def _parse_ports(ports: str) -> list[int]:
    ports = ports.strip().lower()
    if ports in ("common", ""):
        return COMMON_PORTS[:]
    if ports == "web":
        return WEB_PORTS[:]
    if ports == "top100":
        return COMMON_PORTS[:100]
    if ports == "all":
        return list(range(1, 65536))

    result = set()
    for part in ports.split(","):
        part = part.strip()
        if "-" in part and not part.startswith("-"):
            lo, hi = part.split("-", 1)
            result.update(range(int(lo), int(hi) + 1))
        else:
            result.add(int(part))
    return sorted(result)


def _err(msg, start):
    return {
        "status": "error", "result": None, "error": msg,
        "metadata": {"tool": "port_scan", "duration_ms": _ms(start)},
    }


def _ms(start):
    return int((time.time() - start) * 1000)
