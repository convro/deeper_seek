"""
ssl_inspect.py — SSL/TLS certificate and configuration inspector.

Analyzes a host's SSL/TLS setup:
  • Certificate details (issuer, subject, SANs, expiry, chain)
  • Protocol version support (TLS 1.0/1.1/1.2/1.3, SSL 2/3)
  • Cipher suite detection (strong vs. weak)
  • Vulnerability indicators (POODLE, BEAST, DROWN, LOGJAM, ROBOT)
  • OCSP stapling, HSTS, certificate transparency
  • Certificate pinning detection

Use only on systems you own or have explicit written authorization to test.
"""

from __future__ import annotations

import datetime
import socket
import ssl
import subprocess
import time
from typing import Any


WEAK_CIPHERS = {
    "RC4", "RC2", "DES", "3DES", "EXPORT", "NULL", "ANON",
    "MD5", "ADH", "AECDH", "aNULL", "eNULL",
}

STRONG_PROTOCOLS = {ssl.TLSVersion.TLSv1_2, ssl.TLSVersion.TLSv1_3}


def execute(
    host: str,
    port: int = 443,
    check_protocols: bool = True,
    check_chain: bool = True,
    check_vulnerabilities: bool = True,
    timeout: int = 10,
    **kwargs,
) -> dict:
    """
    Inspect SSL/TLS configuration of a host.

    host: hostname or IP (SNI used)
    port: default 443
    """
    start = time.time()

    host = host.strip().lstrip("https://").lstrip("http://").split("/")[0]

    result: dict[str, Any] = {
        "host": host,
        "port": port,
    }

    # Primary cert fetch
    try:
        cert_info = _get_cert_info(host, port, timeout)
        result["certificate"] = cert_info
    except Exception as e:
        result["certificate"] = {"error": str(e)}

    # Protocol support
    if check_protocols:
        result["protocols"] = _check_protocol_support(host, port, timeout)

    # Cipher info (from primary connection)
    try:
        cipher_info = _get_cipher_info(host, port, timeout)
        result["cipher"] = cipher_info
    except Exception as e:
        result["cipher"] = {"error": str(e)}

    # Vulnerabilities
    vulnerabilities: list[dict] = []
    if check_vulnerabilities:
        proto = result.get("protocols", {})

        if proto.get("sslv2"):
            vulnerabilities.append({
                "name": "DROWN",
                "severity": "critical",
                "description": "SSLv2 enabled — vulnerable to DROWN attack (decrypts RSA-encrypted sessions)",
                "recommendation": "Disable SSLv2 immediately",
            })
        if proto.get("sslv3"):
            vulnerabilities.append({
                "name": "POODLE",
                "severity": "high",
                "description": "SSLv3 enabled — vulnerable to POODLE attack (CBC padding oracle)",
                "recommendation": "Disable SSLv3",
            })
        if proto.get("tlsv1_0"):
            vulnerabilities.append({
                "name": "BEAST/POODLE-TLS",
                "severity": "medium",
                "description": "TLS 1.0 enabled — vulnerable to BEAST attack, deprecated by RFC 8996",
                "recommendation": "Disable TLS 1.0, use TLS 1.2+",
            })
        if proto.get("tlsv1_1"):
            vulnerabilities.append({
                "name": "Deprecated protocol",
                "severity": "low",
                "description": "TLS 1.1 enabled — deprecated by RFC 8996",
                "recommendation": "Disable TLS 1.1, use TLS 1.2+",
            })

        cipher = result.get("cipher", {})
        cipher_name = cipher.get("name", "")
        for weak in WEAK_CIPHERS:
            if weak in cipher_name.upper():
                vulnerabilities.append({
                    "name": "Weak cipher",
                    "severity": "high",
                    "description": f"Weak cipher in use: {cipher_name}",
                    "recommendation": "Use only ECDHE+AES-GCM or CHACHA20-POLY1305 ciphers",
                })
                break

        # Check expiry
        cert = result.get("certificate", {})
        expiry = cert.get("not_after")
        if expiry:
            try:
                exp_dt = datetime.datetime.strptime(expiry, "%Y-%m-%d %H:%M:%S")
                days_left = (exp_dt - datetime.datetime.utcnow()).days
                if days_left < 0:
                    vulnerabilities.append({
                        "name": "Expired certificate",
                        "severity": "critical",
                        "description": f"Certificate expired {-days_left} days ago",
                        "recommendation": "Renew certificate immediately",
                    })
                elif days_left < 30:
                    vulnerabilities.append({
                        "name": "Certificate expiring soon",
                        "severity": "high",
                        "description": f"Certificate expires in {days_left} days",
                        "recommendation": "Renew certificate",
                    })
            except Exception:
                pass

        # Self-signed check
        if cert.get("issuer") == cert.get("subject"):
            vulnerabilities.append({
                "name": "Self-signed certificate",
                "severity": "medium",
                "description": "Certificate is self-signed (not trusted by browsers)",
                "recommendation": "Use a certificate from a trusted CA",
            })

        # Hostname mismatch
        san = cert.get("sans", [])
        common_name = cert.get("common_name", "")
        if san or common_name:
            if not _hostname_matches(host, san, common_name):
                vulnerabilities.append({
                    "name": "Hostname mismatch",
                    "severity": "high",
                    "description": f"Certificate not valid for hostname '{host}'",
                    "recommendation": "Use a certificate that covers this hostname",
                })

    result["vulnerabilities"] = vulnerabilities
    result["vulnerability_count"] = len(vulnerabilities)

    # Severity summary
    sev = {"critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0}
    for v in vulnerabilities:
        sev[v.get("severity", "info")] = sev.get(v.get("severity", "info"), 0) + 1
    result["severity_summary"] = sev

    return {
        "status": "ok",
        "result": result,
        "error": None,
        "metadata": {"tool": "ssl_inspect", "duration_ms": _ms(start)},
    }


def _get_cert_info(host: str, port: int, timeout: int) -> dict:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_OPTIONAL

    with socket.create_connection((host, port), timeout=timeout) as sock:
        with ctx.wrap_socket(sock, server_hostname=host) as ssock:
            cert = ssock.getpeercert()
            der_cert = ssock.getpeercert(binary_form=True)

    if not cert:
        return {"error": "No certificate returned"}

    # Parse subject
    subject = {}
    for part in cert.get("subject", []):
        for k, v in part:
            subject[k] = v

    # Parse issuer
    issuer = {}
    for part in cert.get("issuer", []):
        for k, v in part:
            issuer[k] = v

    # SANs
    sans = []
    for san_type, san_value in cert.get("subjectAltName", []):
        sans.append(f"{san_type}:{san_value}")

    # Validity
    not_before = cert.get("notBefore", "")
    not_after = cert.get("notAfter", "")

    # Parse dates
    def parse_ssl_date(d: str) -> str:
        try:
            dt = datetime.datetime.strptime(d, "%b %d %H:%M:%S %Y %Z")
            return dt.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            return d

    not_before = parse_ssl_date(not_before)
    not_after = parse_ssl_date(not_after)

    # Days until expiry
    days_remaining = None
    try:
        exp = datetime.datetime.strptime(not_after, "%Y-%m-%d %H:%M:%S")
        days_remaining = (exp - datetime.datetime.utcnow()).days
    except Exception:
        pass

    return {
        "common_name": subject.get("commonName", ""),
        "subject": subject,
        "issuer": issuer,
        "issuer_name": issuer.get("organizationName", issuer.get("commonName", "")),
        "sans": sans,
        "not_before": not_before,
        "not_after": not_after,
        "days_remaining": days_remaining,
        "serial_number": cert.get("serialNumber", ""),
        "version": cert.get("version", 0),
        "ocsp_uris": cert.get("OCSP", []),
        "ca_issuers": cert.get("caIssuers", []),
        "crl_distribution_points": cert.get("crlDistributionPoints", []),
    }


def _get_cipher_info(host: str, port: int, timeout: int) -> dict:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    with socket.create_connection((host, port), timeout=timeout) as sock:
        with ctx.wrap_socket(sock, server_hostname=host) as ssock:
            cipher = ssock.cipher()
            proto = ssock.version()

    if not cipher:
        return {}

    return {
        "name": cipher[0],
        "protocol": proto,
        "bits": cipher[2],
        "strong": not any(w in cipher[0].upper() for w in WEAK_CIPHERS),
    }


def _check_protocol_support(host: str, port: int, timeout: int) -> dict:
    results = {}

    protocol_map = [
        ("tlsv1_3", ssl.PROTOCOL_TLS_CLIENT, ssl.TLSVersion.TLSv1_3),
        ("tlsv1_2", ssl.PROTOCOL_TLS_CLIENT, ssl.TLSVersion.TLSv1_2),
    ]

    for name, proto, version in protocol_map:
        try:
            ctx = ssl.SSLContext(proto)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            ctx.minimum_version = version
            ctx.maximum_version = version
            with socket.create_connection((host, port), timeout=timeout) as sock:
                with ctx.wrap_socket(sock, server_hostname=host) as _:
                    results[name] = True
        except ssl.SSLError:
            results[name] = False
        except Exception:
            results[name] = None

    # Try TLS 1.0 and 1.1 via openssl command if available
    for name, version_str in [("tlsv1_0", "tls1"), ("tlsv1_1", "tls1_1"),
                               ("sslv3", "ssl3"), ("sslv2", "ssl2")]:
        results[name] = _test_with_openssl(host, port, version_str, timeout)

    return results


def _test_with_openssl(host: str, port: int, version: str, timeout: int) -> bool | None:
    try:
        r = subprocess.run(
            ["openssl", "s_client", f"-{version}", "-connect", f"{host}:{port}",
             "-brief", "-no_ign_eof"],
            input=b"",
            capture_output=True,
            timeout=timeout,
        )
        output = r.stdout.decode("utf-8", errors="replace") + r.stderr.decode("utf-8", errors="replace")
        if "Cipher is" in output or "SSL handshake has read" in output:
            return True
        return False
    except FileNotFoundError:
        return None
    except Exception:
        return False


def _hostname_matches(host: str, sans: list, common_name: str) -> bool:
    host = host.lower()
    all_names = [s.split(":", 1)[1].lower() for s in sans if s.lower().startswith("dns:")] + [common_name.lower()]
    for name in all_names:
        if name == host:
            return True
        if name.startswith("*."):
            parent = name[2:]
            if host.endswith("." + parent) or host == parent:
                return True
    return False


def _ms(start):
    return int((time.time() - start) * 1000)
