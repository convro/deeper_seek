import os
import json
import shutil
import time
from datetime import datetime


WORKSPACE_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../../workspace/jobs")
)


def execute(job_id: str, label: str = "", **kwargs) -> dict:
    start = time.time()
    try:
        job_path = os.path.join(WORKSPACE_ROOT, job_id)
        if not os.path.exists(job_path):
            return _err(f"Workspace not found: {job_id}", "workspace_snapshot", start)

        ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        snapshot_name = f"{ts}_{label}" if label else ts
        snapshot_path = os.path.join(job_path, "snapshots", snapshot_name)

        # Copy files, analysis, and output to snapshot
        for subdir in ["files", "analysis", "output", "context"]:
            src = os.path.join(job_path, subdir)
            dst = os.path.join(snapshot_path, subdir)
            if os.path.exists(src):
                shutil.copytree(src, dst)

        meta = {
            "snapshot_name": snapshot_name,
            "job_id": job_id,
            "created_at": datetime.utcnow().isoformat(),
            "label": label,
        }
        with open(os.path.join(snapshot_path, "snapshot_meta.json"), "w") as f:
            json.dump(meta, f, indent=2)

        return {
            "status": "ok",
            "result": {
                "job_id": job_id,
                "snapshot_name": snapshot_name,
                "snapshot_path": snapshot_path,
            },
            "error": None,
            "metadata": {"tool": "workspace_snapshot", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "workspace_snapshot", start)


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
