import os
import json
import time


WORKSPACE_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../../workspace")
)


def execute(job_id: str, **kwargs) -> dict:
    start = time.time()
    try:
        job_path = os.path.join(WORKSPACE_ROOT, job_id)

        if not os.path.exists(job_path):
            return _err(f"Workspace not found: {job_id}", "workspace_load", start)

        # Load metadata
        meta_path = os.path.join(job_path, "context", "meta.json")
        meta = {}
        if os.path.exists(meta_path):
            with open(meta_path) as f:
                meta = json.load(f)

        # Load plan
        plan_path = os.path.join(job_path, "context", "plan.md")
        plan = ""
        if os.path.exists(plan_path):
            with open(plan_path) as f:
                plan = f.read()

        # Inventory files
        inventory = {}
        for subdir in ["input", "files", "analysis", "output"]:
            dir_path = os.path.join(job_path, subdir)
            if os.path.exists(dir_path):
                files = []
                for root, _, fnames in os.walk(dir_path):
                    for fname in fnames:
                        fp = os.path.join(root, fname)
                        rel = os.path.relpath(fp, job_path)
                        size = os.path.getsize(fp)
                        files.append({"path": rel, "size_bytes": size})
                inventory[subdir] = files

        return {
            "status": "ok",
            "result": {
                "job_id": job_id,
                "path": job_path,
                "meta": meta,
                "plan": plan,
                "inventory": inventory,
            },
            "error": None,
            "metadata": {"tool": "workspace_load", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "workspace_load", start)


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
