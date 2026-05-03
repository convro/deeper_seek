"""
agent_spawn.py — spawns a sub-agent via HTTP call to the backend.
The backend runs the actual LLM call and manages agent state.
"""
import json
import time
import urllib.request
import urllib.error
import os

BACKEND_URL = os.environ.get("DEEPERSEEK_BACKEND_URL", "http://localhost:3000")


def execute(agent_type: str, task: str, context: str = "",
            async_mode: bool = False, job_id: str = None, **kwargs) -> dict:
    start = time.time()
    try:
        payload = json.dumps({
            "agent_type": agent_type,
            "task": task,
            "context": context,
            "async_mode": async_mode,
            "job_id": job_id,
        }).encode("utf-8")

        headers = {"Content-Type": "application/json"}
        internal_token = os.environ.get("DEEPERSEEK_INTERNAL_TOKEN")
        current_user   = os.environ.get("DEEPERSEEK_CURRENT_USER_ID")
        if internal_token:
            headers["X-Internal-Token"] = internal_token
        if current_user:
            headers["X-Internal-User-Id"] = current_user

        req = urllib.request.Request(
            f"{BACKEND_URL}/api/agents/spawn",
            data=payload,
            headers=headers,
            method="POST",
        )

        with urllib.request.urlopen(req, timeout=1200) as resp:
            result = json.loads(resp.read().decode("utf-8"))

        return {
            "status": "ok",
            "result": result,
            "error": None,
            "metadata": {"tool": "agent_spawn", "duration_ms": _ms(start)},
        }
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return _err(f"HTTP {e.code}: {body}", "agent_spawn", start)
    except Exception as e:
        return _err(str(e), "agent_spawn", start)


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
