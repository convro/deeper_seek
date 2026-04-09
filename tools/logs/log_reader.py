import os
import time
import re


LEVEL_ORDER = {"debug": 0, "info": 1, "warn": 2, "error": 3}


def execute(log_file: str, level: str = None, tail: int = 100, grep: str = None, **kwargs) -> dict:
    start = time.time()
    try:
        log_file = os.path.abspath(os.path.expanduser(log_file))
        if not os.path.exists(log_file):
            return _err(f"Log file not found: {log_file}", "log_reader", start)

        with open(log_file, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()

        # Apply tail first
        if tail:
            lines = lines[-tail:]

        # Filter by grep
        if grep:
            pattern = re.compile(grep, re.IGNORECASE)
            lines = [l for l in lines if pattern.search(l)]

        # Filter by level
        if level and level in LEVEL_ORDER:
            min_level = LEVEL_ORDER[level]
            filtered = []
            for line in lines:
                line_lower = line.lower()
                for lname, lval in LEVEL_ORDER.items():
                    if lname in line_lower and lval >= min_level:
                        filtered.append(line)
                        break
                else:
                    filtered.append(line)
            lines = filtered

        content = "".join(lines)
        return {
            "status": "ok",
            "result": {
                "path": log_file,
                "content": content,
                "line_count": len(lines),
                "filters": {"level": level, "tail": tail, "grep": grep},
            },
            "error": None,
            "metadata": {"tool": "log_reader", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "log_reader", start)


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
