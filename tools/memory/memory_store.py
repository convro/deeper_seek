import os
import json
import time
from datetime import datetime

MEMORY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../memory"))


def _user_dir():
    """Return per-user memory directory (legacy root when no user)."""
    uid = os.environ.get("DEEPERSEEK_CURRENT_USER_ID")
    if uid:
        return os.path.join(MEMORY_ROOT, f"u_{uid}")
    return MEMORY_ROOT


def execute(key: str, value: str, tier: str = "short", tags: list = None, **kwargs) -> dict:
    start = time.time()
    try:
        tags = tags or []
        file_path = os.path.join(_user_dir(), f"{tier}_term.json")

        data = _load(file_path)
        data[key] = {
            "value": value,
            "tags": tags,
            "updated_at": datetime.utcnow().isoformat(),
            "tier": tier,
        }
        _save(file_path, data)

        return {
            "status": "ok",
            "result": {"key": key, "tier": tier, "stored": True},
            "error": None,
            "metadata": {"tool": "memory_store", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "memory_store", start)


def _load(path):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {}


def _save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
