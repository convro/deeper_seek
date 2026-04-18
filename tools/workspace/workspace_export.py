"""
workspace_export.py — Export a workspace as a single archive.

Bundles an entire workspace directory (or a subset) into a zip or tar.gz,
optionally excluding large intermediate files. Produces a shareable snapshot.

Args:
  job_id:     workspace to export (required)
  dest:       output path (default /tmp/<job_id>_export_<ts>.zip)
  format:     "zip" | "tar.gz" (auto from extension, default zip)
  include:    globs to include (default: everything)
  exclude:    globs to exclude (defaults skip logs/ and agents/ heavy files)
  max_bytes:  abort if uncompressed bundle would exceed this (default 500 MB)
  include_meta: embed a manifest.json listing file count + sha256s (default True)

Returns: {dest, bytes, files, format, manifest (summary)}
"""

from __future__ import annotations

import fnmatch
import hashlib
import io
import json
import os
import tarfile
import time
import zipfile
from datetime import datetime
from pathlib import Path

WORKSPACE_ROOT = Path(os.path.abspath(os.path.join(
    os.path.dirname(__file__), "../../workspace")))

DEFAULT_EXCLUDE = ["logs/*.log", "logs/*.jsonl", "agents/*/logs/*",
                   "*.pyc", "__pycache__/*", ".DS_Store"]
MAX_DEFAULT = 500_000_000


def execute(job_id: str, dest: str = "", format: str = "",
            include: list | None = None, exclude: list | None = None,
            max_bytes: int = MAX_DEFAULT, include_meta: bool = True,
            **kwargs) -> dict:
    start = time.time()
    if not job_id:
        return _err("job_id required", start)

    ws = WORKSPACE_ROOT / job_id
    if not ws.exists():
        return _err(f"workspace '{job_id}' not found", start)

    _enforce_ownership(ws)

    out = _dest_path(job_id, dest, format)
    fmt = _fmt(format, out)
    excludes = DEFAULT_EXCLUDE + list(exclude or [])

    collected = []
    total = 0
    for fp in _iter_files(ws, include, excludes):
        size = fp.stat().st_size
        total += size
        if total > max_bytes:
            return _err(f"export aborted: exceeds max_bytes={max_bytes}",
                        start)
        collected.append(fp)

    manifest = {
        "job_id": job_id,
        "exported_at": datetime.utcnow().isoformat(),
        "format": fmt,
        "file_count": len(collected),
        "uncompressed_bytes": total,
        "files": [],
    }

    if fmt == "zip":
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for fp in collected:
                rel = fp.relative_to(ws)
                z.write(fp, arcname=f"{job_id}/{rel}")
                manifest["files"].append({
                    "path": str(rel),
                    "bytes": fp.stat().st_size,
                    "sha256": _sha256(fp),
                })
            if include_meta:
                z.writestr(f"{job_id}/manifest.json",
                           json.dumps(manifest, indent=2))
    else:
        with tarfile.open(out, "w:gz", compresslevel=6) as t:
            for fp in collected:
                rel = fp.relative_to(ws)
                t.add(fp, arcname=f"{job_id}/{rel}")
                manifest["files"].append({
                    "path": str(rel),
                    "bytes": fp.stat().st_size,
                    "sha256": _sha256(fp),
                })
            if include_meta:
                data = json.dumps(manifest, indent=2).encode()
                info = tarfile.TarInfo(f"{job_id}/manifest.json")
                info.size = len(data)
                info.mtime = int(time.time())
                t.addfile(info, io.BytesIO(data))

    return {"status": "ok", "result": {
        "job_id": job_id, "dest": str(out), "format": fmt,
        "files": len(collected), "uncompressed_bytes": total,
        "archive_bytes": out.stat().st_size,
        "manifest_summary": {"files": len(collected),
                             "uncompressed_bytes": total},
    }, "error": None,
        "metadata": {"tool": "workspace_export",
                     "duration_ms": int((time.time() - start) * 1000)}}


# ── Helpers ─────────────────────────────────────────────────────────────────

def _enforce_ownership(ws: Path) -> None:
    env_uid = os.environ.get("DEEPERSEEK_CURRENT_USER_ID", "")
    if not env_uid:
        return
    meta_p = ws / "context" / "meta.json"
    if not meta_p.exists():
        return
    try:
        meta = json.loads(meta_p.read_text())
    except Exception:
        return
    owner = meta.get("owner_id")
    if owner and owner != env_uid:
        raise PermissionError(
            f"workspace belongs to {owner}, not {env_uid}")


def _iter_files(root: Path, include, exclude):
    for cur, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in ("__pycache__",)]
        for fn in files:
            fp = Path(cur) / fn
            rel = fp.relative_to(root).as_posix()
            if exclude and any(fnmatch.fnmatch(rel, p)
                               or fnmatch.fnmatch(fn, p) for p in exclude):
                continue
            if include and not any(fnmatch.fnmatch(rel, p)
                                   or fnmatch.fnmatch(fn, p) for p in include):
                continue
            yield fp


def _dest_path(job_id: str, dest: str, fmt: str) -> Path:
    if dest:
        return Path(dest).expanduser().resolve()
    ext = "zip" if fmt in ("", "zip") else ("tar.gz" if fmt == "tar.gz" else "zip")
    return Path("/tmp") / f"{job_id}_export_{int(time.time())}.{ext}"


def _fmt(fmt: str, out: Path) -> str:
    if fmt: return fmt
    name = out.name.lower()
    if name.endswith(".zip"): return "zip"
    if name.endswith((".tar.gz", ".tgz")): return "tar.gz"
    return "zip"


def _sha256(fp: Path, block: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(fp, "rb") as f:
        while True:
            chunk = f.read(block)
            if not chunk: break
            h.update(chunk)
    return h.hexdigest()


def _err(msg, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": "workspace_export",
                         "duration_ms": int((time.time() - start) * 1000)}}
