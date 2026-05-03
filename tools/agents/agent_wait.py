"""
agent_wait.py — Wait for an async agent to complete and return its result.
Polls the backend internally so the LLM doesn't have to loop agent_status.
"""
import json
import time
import urllib.request
import os

BACKEND_URL = os.environ.get("DEEPERSEEK_BACKEND_URL", "http://localhost:3000")
MAX_WAIT_SECONDS = 1200  # 20 minutes max wait
POLL_INTERVAL = 2       # seconds between checks


def _auth_headers():
    h = {}
    tok  = os.environ.get("DEEPERSEEK_INTERNAL_TOKEN")
    user = os.environ.get("DEEPERSEEK_CURRENT_USER_ID")
    if tok:  h["X-Internal-Token"]   = tok
    if user: h["X-Internal-User-Id"] = user
    return h


def execute(agent_id: str, timeout: int = MAX_WAIT_SECONDS, **kwargs) -> dict:
    start = time.time()
    deadline = start + min(timeout, MAX_WAIT_SECONDS)

    while time.time() < deadline:
        try:
            req = urllib.request.Request(
                f"{BACKEND_URL}/api/agents/{agent_id}/status",
                headers=_auth_headers(),
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode("utf-8"))

            status = result.get("status", "unknown")

            if status in ("completed", "failed", "killed"):
                return {
                    "status": "ok",
                    "result": result,
                    "error": None,
                    "metadata": {
                        "tool": "agent_wait",
                        "duration_ms": _ms(start),
                        "final_status": status,
                    },
                }

            # Still running — wait and retry
            time.sleep(POLL_INTERVAL)

        except Exception as e:
            # Transient error — wait and retry
            time.sleep(POLL_INTERVAL)

    # Timed out waiting
    return {
        "status": "ok",
        "result": {
            "agent_id": agent_id,
            "status": "still_running",
            "message": f"Agent still running after {int(time.time() - start)}s. "
                       f"You can check again with agent_status or agent_wait.",
        },
        "error": None,
        "metadata": {"tool": "agent_wait", "duration_ms": _ms(start)},
    }


def _ms(start):
    return int((time.time() - start) * 1000)
