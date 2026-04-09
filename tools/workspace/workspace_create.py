import os
import uuid
import json
import time
from datetime import datetime


WORKSPACE_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../../workspace/jobs")
)

SUBDIRS = ["input", "files", "analysis", "output", "logs", "agents", "context", "snapshots"]


def execute(job_id: str = None, description: str = "", **kwargs) -> dict:
    start = time.time()
    try:
        if not job_id:
            job_id = str(uuid.uuid4())[:8]

        job_path = os.path.join(WORKSPACE_ROOT, job_id)

        if os.path.exists(job_path):
            return {
                "status": "ok",
                "result": {
                    "job_id": job_id,
                    "path": job_path,
                    "created": False,
                    "message": "Workspace already exists — loaded existing",
                },
                "error": None,
                "metadata": {"tool": "workspace_create", "duration_ms": _ms(start)},
            }

        os.makedirs(job_path, exist_ok=True)
        for subdir in SUBDIRS:
            os.makedirs(os.path.join(job_path, subdir), exist_ok=True)

        # Write metadata
        meta = {
            "job_id": job_id,
            "description": description,
            "created_at": datetime.utcnow().isoformat(),
            "status": "active",
        }
        with open(os.path.join(job_path, "context", "meta.json"), "w") as f:
            json.dump(meta, f, indent=2)

        # Write initial plan file
        plan_content = f"""# Task Plan
Job ID: {job_id}
Created: {datetime.utcnow().isoformat()}
Description: {description}
Status: IN PROGRESS

## Steps
<!-- Fill in your plan steps here -->

## Decisions
<!-- Record key decisions here -->

## Issues
<!-- Log issues encountered here -->
"""
        with open(os.path.join(job_path, "context", "plan.md"), "w") as f:
            f.write(plan_content)

        return {
            "status": "ok",
            "result": {
                "job_id": job_id,
                "path": job_path,
                "created": True,
                "subdirs": SUBDIRS,
                "description": description,
            },
            "error": None,
            "metadata": {"tool": "workspace_create", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "workspace_create", start)


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
