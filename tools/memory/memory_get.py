import os
import json
import time

MEMORY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../memory"))


def execute(key: str, tier: str = "both", **kwargs) -> dict:
    start = time.time()
    try:
        tiers = ["short", "long"] if tier == "both" else [tier]
        found = None
        found_tier = None

        for t in tiers:
            file_path = os.path.join(MEMORY_ROOT, f"{t}_term.json")
            data = _load(file_path)
            if key in data:
                found = data[key]
                found_tier = t
                break

        if found is None:
            return {
                "status": "ok",
                "result": {"key": key, "found": False, "value": None},
                "error": None,
                "metadata": {"tool": "memory_get", "duration_ms": _ms(start)},
            }

        return {
            "status": "ok",
            "result": {
                "key": key,
                "found": True,
                "value": found["value"],
                "tags": found.get("tags", []),
                "updated_at": found.get("updated_at"),
                "tier": found_tier,
            },
            "error": None,
            "metadata": {"tool": "memory_get", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "memory_get", start)


def _load(path):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {}


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
