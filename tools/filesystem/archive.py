"""
archive.py — Create, inspect, and extract zip / tar / tar.gz / tar.bz2 / tar.xz.

Operations (pass as `op`):
  • list      — list entries with size + mtime
  • create    — create an archive from files/dirs
  • extract   — extract to a destination directory (with safe-path guard)
  • read      — read a single file from inside the archive (text or base64)

Args vary per op. Key defaults:
  • format     — "auto" (from extension) or "zip"|"tar"|"tar.gz"|"tar.bz2"|"tar.xz"
  • paths      — list of source paths when creating
  • dest       — output path (create) or extraction dir (extract)
  • member     — archive-relative path for `read`
  • max_bytes  — caps decompression to guard zip bombs
"""

from __future__ import annotations

import base64
import io
import os
import tarfile
import time
import zipfile
from datetime import datetime
from pathlib import Path

MAX_LIST = 5000
MAX_EXTRACT_BYTES = 2_000_000_000  # 2 GB total
MAX_READ_BYTES = 20_000_000


def execute(op: str, **kwargs) -> dict:
    start = time.time()
    op = (op or "").lower().strip()
    if op not in _DISPATCH:
        return _err(f"unknown op '{op}'. Allowed: {sorted(_DISPATCH.keys())}",
                    start, op)
    try:
        return _DISPATCH[op](start=start, **kwargs)
    except FileNotFoundError as e:
        return _err(f"not found: {e}", start, op)
    except PermissionError as e:
        return _err(f"permission: {e}", start, op)
    except ValueError as e:
        return _err(str(e), start, op)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}", start, op)


# ── Ops ─────────────────────────────────────────────────────────────────────

def _op_list(start, path: str, format: str = "auto",
             max_entries: int = MAX_LIST, **_):
    p = _resolve(path, must_exist=True)
    fmt = _fmt(format, p)
    entries = []
    if fmt == "zip":
        with zipfile.ZipFile(p) as z:
            for info in z.infolist()[:max_entries]:
                entries.append({
                    "name": info.filename,
                    "size": info.file_size,
                    "compressed": info.compress_size,
                    "is_dir": info.is_dir(),
                    "modified": _dt_tuple_to_iso(info.date_time),
                })
    else:
        with tarfile.open(p, _tar_mode_read(fmt)) as t:
            for m in t.getmembers()[:max_entries]:
                entries.append({
                    "name": m.name,
                    "size": m.size,
                    "is_dir": m.isdir(),
                    "is_symlink": m.issym() or m.islnk(),
                    "mode": oct(m.mode),
                    "modified": datetime.utcfromtimestamp(m.mtime).isoformat()
                                if m.mtime else None,
                })
    return _ok({"path": str(p), "format": fmt,
                "entries": entries, "count": len(entries)},
               start, "list")


def _op_create(start, paths: list | str, dest: str, format: str = "auto",
               base_dir: str = "", compression: str = "default", **_):
    if isinstance(paths, str): paths = [paths]
    if not paths: raise ValueError("paths= required")
    src_paths = [_resolve(p, must_exist=True) for p in paths]
    out = Path(dest).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    fmt = _fmt(format, out)
    base = Path(base_dir).expanduser().resolve() if base_dir else None

    total_bytes = 0
    count = 0
    if fmt == "zip":
        comp = zipfile.ZIP_DEFLATED if compression != "stored" \
               else zipfile.ZIP_STORED
        with zipfile.ZipFile(out, "w", compression=comp,
                             compresslevel=6 if comp == zipfile.ZIP_DEFLATED
                                                else None) as z:
            for sp in src_paths:
                count_bytes = _zip_add(z, sp, base)
                count += count_bytes[0]; total_bytes += count_bytes[1]
    else:
        with tarfile.open(out, _tar_mode_write(fmt)) as t:
            for sp in src_paths:
                def _filter(ti):
                    nonlocal count, total_bytes
                    count += 1
                    total_bytes += ti.size
                    return ti
                arcname = sp.relative_to(base) if base else sp.name
                t.add(sp, arcname=str(arcname), filter=_filter)

    return _ok({"dest": str(out), "format": fmt, "entries": count,
                "uncompressed_bytes": total_bytes,
                "archive_bytes": out.stat().st_size}, start, "create")


def _op_extract(start, path: str, dest: str, format: str = "auto",
                members: list | None = None,
                max_bytes: int = MAX_EXTRACT_BYTES,
                overwrite: bool = False, **_):
    p = _resolve(path, must_exist=True)
    out = Path(dest).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    fmt = _fmt(format, p)
    extracted = []
    total = 0
    if fmt == "zip":
        with zipfile.ZipFile(p) as z:
            for info in z.infolist():
                if members and info.filename not in members:
                    continue
                if info.file_size + total > max_bytes:
                    raise ValueError(
                        f"extract aborted: exceeds max_bytes={max_bytes}")
                target = _safe_join(out, info.filename)
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True); continue
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists() and not overwrite:
                    continue
                with z.open(info) as src, open(target, "wb") as dst:
                    while True:
                        chunk = src.read(1 << 16)
                        if not chunk: break
                        dst.write(chunk)
                        total += len(chunk)
                        if total > max_bytes:
                            raise ValueError(
                                "extract aborted: size cap hit")
                extracted.append(info.filename)
    else:
        with tarfile.open(p, _tar_mode_read(fmt)) as t:
            for m in t.getmembers():
                if members and m.name not in members:
                    continue
                if m.issym() or m.islnk():
                    continue  # skip links for safety
                target = _safe_join(out, m.name)
                if m.size + total > max_bytes:
                    raise ValueError(
                        f"extract aborted: exceeds max_bytes={max_bytes}")
                if m.isdir():
                    target.mkdir(parents=True, exist_ok=True); continue
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists() and not overwrite:
                    continue
                with t.extractfile(m) as src:
                    if src is None: continue
                    with open(target, "wb") as dst:
                        while True:
                            chunk = src.read(1 << 16)
                            if not chunk: break
                            dst.write(chunk); total += len(chunk)
                extracted.append(m.name)
    return _ok({"dest": str(out), "format": fmt,
                "extracted": extracted[:500], "count": len(extracted),
                "bytes": total}, start, "extract")


def _op_read(start, path: str, member: str, format: str = "auto",
             encoding: str = "utf-8", max_bytes: int = MAX_READ_BYTES, **_):
    p = _resolve(path, must_exist=True)
    fmt = _fmt(format, p)
    if fmt == "zip":
        with zipfile.ZipFile(p) as z:
            info = z.getinfo(member)
            if info.file_size > max_bytes:
                raise ValueError(
                    f"member {member} > max_bytes ({info.file_size})")
            data = z.read(member)
    else:
        with tarfile.open(p, _tar_mode_read(fmt)) as t:
            m = t.getmember(member)
            if m.size > max_bytes:
                raise ValueError(
                    f"member {member} > max_bytes ({m.size})")
            f = t.extractfile(m)
            data = f.read() if f else b""
    is_binary = b"\x00" in data[:2048]
    content = (base64.b64encode(data).decode() if is_binary
               else data.decode(encoding, errors="replace"))
    return _ok({"path": str(p), "member": member, "format": fmt,
                "bytes": len(data), "is_binary": is_binary,
                "encoding": "base64" if is_binary else encoding,
                "content": content}, start, "read")


_DISPATCH = {"list": _op_list, "create": _op_create,
             "extract": _op_extract, "read": _op_read}


# ── Helpers ─────────────────────────────────────────────────────────────────

def _fmt(fmt: str, path: Path) -> str:
    if fmt and fmt != "auto":
        return fmt
    name = path.name.lower()
    if name.endswith(".zip"): return "zip"
    if name.endswith(".tar.gz") or name.endswith(".tgz"): return "tar.gz"
    if name.endswith(".tar.bz2") or name.endswith(".tbz2"): return "tar.bz2"
    if name.endswith(".tar.xz") or name.endswith(".txz"): return "tar.xz"
    if name.endswith(".tar"): return "tar"
    return "zip"


def _tar_mode_read(fmt: str) -> str:
    return {"tar": "r:", "tar.gz": "r:gz", "tar.bz2": "r:bz2",
            "tar.xz": "r:xz"}[fmt]


def _tar_mode_write(fmt: str) -> str:
    return {"tar": "w:", "tar.gz": "w:gz", "tar.bz2": "w:bz2",
            "tar.xz": "w:xz"}[fmt]


def _dt_tuple_to_iso(dt: tuple) -> str | None:
    try:
        return datetime(*dt).isoformat()
    except Exception:
        return None


def _safe_join(base: Path, name: str) -> Path:
    # Guard against path traversal & absolute paths inside archives
    name = name.replace("\\", "/")
    if name.startswith("/") or ".." in name.split("/"):
        raise ValueError(f"unsafe archive path: {name}")
    target = (base / name).resolve()
    if not str(target).startswith(str(base.resolve())):
        raise ValueError(f"path escapes extract dir: {name}")
    return target


def _resolve(path: str, must_exist: bool = False) -> Path:
    p = Path(path).expanduser().resolve()
    if must_exist and not p.exists():
        raise FileNotFoundError(str(p))
    return p


def _zip_add(z: zipfile.ZipFile, src: Path, base: Path | None) -> tuple[int, int]:
    count = 0; total = 0
    def _arc(p: Path) -> str:
        if base and str(p).startswith(str(base)):
            return str(p.relative_to(base))
        return p.name if p == src else str(p.relative_to(src.parent))
    if src.is_file():
        z.write(src, arcname=_arc(src))
        return (1, src.stat().st_size)
    for root, _dirs, files in os.walk(src):
        for f in files:
            fp = Path(root) / f
            z.write(fp, arcname=_arc(fp))
            count += 1
            try: total += fp.stat().st_size
            except Exception: pass
    return (count, total)


def _ok(result, start, op):
    return {"status": "ok", "result": result, "error": None,
            "metadata": {"tool": "archive", "op": op,
                         "duration_ms": int((time.time() - start) * 1000)}}


def _err(msg, start, op):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": "archive", "op": op,
                         "duration_ms": int((time.time() - start) * 1000)}}
