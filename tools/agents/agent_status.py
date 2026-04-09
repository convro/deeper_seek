import json
import time
import urllib.request
import os

BACKEND_URL = os.environ.get("DEEPERSEEK_BACKEND_URL", "http://localhost:3000")


def execute(agent_id: str, **kwargs) -> dict:
    start = time.time()
    try:
        req = urllib.request.Request(f"{BACKEND_URL}/api/agents/{agent_id}/status")
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode("utf-8"))

        return {
            "status": "ok",
            "result": result,
            "error": None,
            "metadata": {"tool": "agent_status", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "agent_status", start)


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
