"""
workspace_list.py — List all workspaces with summary metadata.

Returns each workspace's: job_id, path, description, status, owner,
created_at, last_modified, file_count, total_bytes (optional).

Args:
  status:    filter — "active" | "complete" | "archived" | "any" (default any)
  owner_id:  only workspaces owned by this user id
  limit:     max count (default 100)
  sort:      "recent" (default) | "name" | "size"
  with_size: include disk usage (default False — can be slow)
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path


WORKSPACE_ROOT = Path(os.path.abspath(os.path.join(
    os.path.dirname(__file__), "../../workspace")))


def execute(status: str = "any", owner_id: str = "",
            limit: int = 100, sort: str = "recent",
            with_size: bool = False, **kwargs) -> dict:
    start = time.time()
    if not WORKSPACE_ROOT.exists():
        return _ok({"workspaces": [], "count": 0,
                    "root": str(WORKSPACE_ROOT)}, start)

    # Enforce per-user scope when auth is on, unless caller overrides
    env_uid = os.environ.get("DEEPERSEEK_CURRENT_USER_ID", "")
    if env_uid and not owner_id:
        owner_id = env_uid

    entries = []
    for d in sorted(WORKSPACE_ROOT.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        meta = _read_meta(d)
        own = meta.get("owner_id")
        if owner_id and own and own != owner_id:
            continue
        st = meta.get("status", "active")
        if status != "any" and st != status:
            continue
        stat = d.stat()
        entry = {
            "job_id": meta.get("job_id") or d.name,
            "path": str(d),
            "description": meta.get("description", ""),
            "status": st,
            "owner_id": own,
            "owner_email": meta.get("owner_email"),
            "created_at": meta.get("created_at"),
            "last_modified": datetime.utcfromtimestamp(
                stat.st_mtime).isoformat(),
        }
        if with_size:
            fc, tb = _dir_stats(d)
            entry["file_count"] = fc
            entry["total_bytes"] = tb
        entries.append(entry)

    if sort == "name":
        entries.sort(key=lambda x: x["job_id"])
    elif sort == "size" and with_size:
        entries.sort(key=lambda x: x.get("total_bytes", 0), reverse=True)
    else:  # recent
        entries.sort(key=lambda x: x.get("last_modified", ""), reverse=True)

    return _ok({"workspaces": entries[:limit],
                "count": min(len(entries), limit),
                "total": len(entries),
                "root": str(WORKSPACE_ROOT)}, start)


def _read_meta(d: Path) -> dict:
    p = d / "context" / "meta.json"
    if p.exists():
        try: return json.loads(p.read_text())
        except Exception: return {}
    return {}


def _dir_stats(d: Path) -> tuple[int, int]:
    count, total = 0, 0
    for root, _dirs, files in os.walk(d):
        for f in files:
            fp = Path(root) / f
            try:
                count += 1; total += fp.stat().st_size
            except Exception:
                continue
    return count, total


def _ok(result, start):
    return {"status": "ok", "result": result, "error": None,
            "metadata": {"tool": "workspace_list",
                         "duration_ms": int((time.time() - start) * 1000)}}
