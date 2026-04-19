"""
git_ops.py — Safe wrapper around common git operations.

Operations (pass as `op`):
  • status       — staged/unstaged/untracked + branch + ahead/behind
  • diff         — working/staged/commit diff (unified, limited)
  • log          — last N commits (short or detailed)
  • branch       — list / create / delete / switch
  • commit       — stage + commit (never --amend unless amend=True)
  • add          — stage specific paths (globs allowed)
  • checkout     — checkout branch / file / ref
  • push / pull  — with retry support
  • clone        — shallow clone (depth=1 default)
  • remote       — list / add / remove / set-url
  • reset        — soft/mixed; hard requires allow_hard=True
  • stash        — save/pop/list/drop
  • blame        — per-line last-modifier
  • show         — show a commit
  • ls_files     — list tracked files (respects .gitignore)

Safety:
  • Destructive flags (--force, --hard, -f, -D) require explicit opt-in.
  • Runs inside `cwd` (defaults to repo at process cwd).
"""

from __future__ import annotations

import os
import shlex
import subprocess
import time
from pathlib import Path

DEFAULT_TIMEOUT = 60
MAX_OUTPUT = 200_000


def execute(op: str, cwd: str = "", timeout: int = DEFAULT_TIMEOUT,
            **kwargs) -> dict:
    start = time.time()
    op = (op or "").lower().strip()
    cwd = _resolve_cwd(cwd)

    if op not in _DISPATCH:
        return _err(f"unknown op '{op}'. "
                    f"Allowed: {sorted(_DISPATCH.keys())}", start, op)
    try:
        result = _DISPATCH[op](cwd=cwd, timeout=timeout, **kwargs)
        if isinstance(result, dict) and result.get("status") in ("ok", "error"):
            result.setdefault("metadata", {})
            result["metadata"].setdefault("tool", "git_ops")
            result["metadata"]["duration_ms"] = _ms(start)
            result["metadata"].setdefault("op", op)
            result["metadata"].setdefault("cwd", cwd)
            return result
        return _ok(result, start, op, cwd=cwd)
    except subprocess.TimeoutExpired:
        return _err(f"git {op} timed out after {timeout}s", start, op, cwd=cwd)
    except FileNotFoundError as e:
        return _err(f"path not found: {e}", start, op, cwd=cwd)
    except RuntimeError as e:
        return _err(str(e), start, op, cwd=cwd)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}", start, op, cwd=cwd)


# ── Ops ─────────────────────────────────────────────────────────────────────

def _op_status(cwd, timeout, **_):
    out = _git(cwd, ["status", "--porcelain=v1", "--branch", "-uall"],
               timeout=timeout)
    branch, remote, ahead, behind = None, None, 0, 0
    staged, unstaged, untracked, conflicted = [], [], [], []
    for line in out.splitlines():
        if line.startswith("## "):
            rest = line[3:]
            if "..." in rest:
                branch, tail = rest.split("...", 1)
                remote_part = tail.split(" ")[0]
                remote = remote_part
                if "ahead" in tail:
                    try: ahead = int(tail.split("ahead ")[1].split(",")[0].split("]")[0])
                    except Exception: pass
                if "behind" in tail:
                    try: behind = int(tail.split("behind ")[1].split("]")[0])
                    except Exception: pass
            else:
                branch = rest.strip()
            continue
        if not line: continue
        x, y, path = line[0], line[1], line[3:]
        if x == "?" and y == "?":
            untracked.append(path)
        elif x == "U" or y == "U" or (x == "A" and y == "A"):
            conflicted.append(path)
        else:
            if x != " " and x != "?":
                staged.append({"status": x, "path": path})
            if y != " " and y != "?":
                unstaged.append({"status": y, "path": path})
    return {"branch": branch, "tracking": remote,
            "ahead": ahead, "behind": behind,
            "staged": staged, "unstaged": unstaged,
            "untracked": untracked, "conflicted": conflicted,
            "clean": not (staged or unstaged or untracked or conflicted)}


def _op_diff(cwd, timeout, target: str = "working",
             path: str | None = None, context: int = 3, **_):
    args = ["diff", f"--unified={max(0, int(context))}"]
    if target == "staged":
        args.append("--cached")
    elif target in ("working", "unstaged", ""):
        pass
    else:
        args.append(target)
    if path:
        args.append("--")
        args.append(path)
    out = _git(cwd, args, timeout=timeout)
    return {"target": target, "path": path,
            "diff": _cap(out), "truncated": len(out) > MAX_OUTPUT,
            "bytes": len(out)}


def _op_log(cwd, timeout, n: int = 20, path: str | None = None,
            since: str | None = None, grep: str | None = None,
            format: str = "short", **_):
    sep = "\x1f"
    rec = "\x1e"
    fmt = sep.join(["%H", "%h", "%an", "%ae", "%at", "%s", "%D"])
    args = ["log", f"-n{int(n)}", f"--pretty=format:{fmt}{rec}"]
    if since: args += [f"--since={since}"]
    if grep: args += [f"--grep={grep}"]
    if format == "detailed": args += ["--stat"]
    if path: args += ["--", path]
    out = _git(cwd, args, timeout=timeout)
    commits = []
    for entry in out.split(rec):
        entry = entry.strip("\n")
        if not entry: continue
        parts = entry.split(sep)
        if len(parts) < 7: continue
        commits.append({
            "hash": parts[0], "short": parts[1],
            "author": parts[2], "email": parts[3],
            "timestamp": int(parts[4]) if parts[4].isdigit() else None,
            "subject": parts[5], "refs": parts[6].strip(),
        })
    return {"commits": commits, "count": len(commits)}


def _op_branch(cwd, timeout, action: str = "list", name: str | None = None,
               base: str | None = None, force: bool = False, **_):
    if action == "list":
        out = _git(cwd, ["branch", "--list", "-a", "-vv"], timeout=timeout)
        branches = []
        for ln in out.splitlines():
            current = ln.startswith("*")
            line = ln[2:].rstrip()
            branches.append({"current": current, "line": line})
        return {"branches": branches}
    if action in ("create", "checkout"):
        if not name: raise RuntimeError("name= is required")
        args = ["checkout", "-b", name] if action == "create" else ["checkout", name]
        if base and action == "create": args.append(base)
        _git(cwd, args, timeout=timeout)
        return {"checked_out": name}
    if action == "switch":
        if not name: raise RuntimeError("name= is required")
        _git(cwd, ["checkout", name], timeout=timeout)
        return {"checked_out": name}
    if action == "delete":
        if not name: raise RuntimeError("name= is required")
        if not force:
            raise RuntimeError("destructive: pass force=True to delete branches")
        _git(cwd, ["branch", "-D", name], timeout=timeout)
        return {"deleted": name}
    raise RuntimeError(f"unknown branch action '{action}'")


def _op_add(cwd, timeout, paths: list | str = "", **_):
    if isinstance(paths, str):
        paths = [paths] if paths else []
    if not paths: raise RuntimeError("paths= is required")
    if any(p in ("-A", "--all", ".", "*") for p in paths):
        raise RuntimeError("refusing bulk add ('-A', '.', '*'); list files")
    _git(cwd, ["add", "--"] + list(paths), timeout=timeout)
    return {"added": paths}


def _op_commit(cwd, timeout, message: str = "", paths: list | None = None,
               amend: bool = False, sign: bool = False,
               allow_empty: bool = False, **_):
    if not message and not amend:
        raise RuntimeError("message= required")
    if paths:
        _git(cwd, ["add", "--"] + list(paths), timeout=timeout)
    args = ["commit"]
    if amend: args.append("--amend")
    if sign: args.append("-S")
    if allow_empty: args.append("--allow-empty")
    args += ["-m", message]
    out = _git(cwd, args, timeout=timeout)
    head = _git(cwd, ["rev-parse", "HEAD"], timeout=timeout).strip()
    return {"commit": head, "amend": amend, "output": _cap(out)}


def _op_checkout(cwd, timeout, target: str = "", paths: list | None = None,
                 force: bool = False, **_):
    if not target and not paths:
        raise RuntimeError("target= or paths= required")
    args = ["checkout"]
    if force: args.append("-f")
    if target: args.append(target)
    if paths: args += ["--"] + list(paths)
    out = _git(cwd, args, timeout=timeout)
    return {"output": _cap(out)}


def _op_push(cwd, timeout, remote: str = "origin", branch: str | None = None,
             force: bool = False, set_upstream: bool = True, tags: bool = False,
             retries: int = 2, **_):
    args = ["push"]
    if set_upstream: args.append("-u")
    if force: args.append("--force-with-lease")
    if tags: args.append("--tags")
    args.append(remote)
    if branch: args.append(branch)
    last = ""
    for attempt in range(max(1, retries + 1)):
        try:
            out = _git(cwd, args, timeout=timeout)
            return {"output": _cap(out), "remote": remote, "branch": branch,
                    "attempts": attempt + 1}
        except RuntimeError as e:
            last = str(e)
            if attempt < retries:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(last)


def _op_pull(cwd, timeout, remote: str = "origin", branch: str | None = None,
             rebase: bool = False, **_):
    args = ["pull"]
    if rebase: args.append("--rebase")
    args.append(remote)
    if branch: args.append(branch)
    out = _git(cwd, args, timeout=timeout)
    return {"output": _cap(out)}


def _op_fetch(cwd, timeout, remote: str = "origin", prune: bool = True,
              tags: bool = False, **_):
    args = ["fetch", remote]
    if prune: args.append("--prune")
    if tags: args.append("--tags")
    out = _git(cwd, args, timeout=timeout)
    return {"output": _cap(out)}


def _op_clone(cwd, timeout, url: str = "", dest: str = ".", depth: int = 1,
              branch: str | None = None, **_):
    if not url: raise RuntimeError("url= required")
    # Inject GITHUB_TOKEN for private repos via https
    token = os.environ.get("GITHUB_TOKEN", "")
    if token and "github.com" in url and url.startswith("https://"):
        # Insert token: https://TOKEN@github.com/...
        url = url.replace("https://", f"https://{token}@", 1)
    args = ["clone"]
    if depth and depth > 0: args += ["--depth", str(depth)]
    if branch: args += ["--branch", branch, "--single-branch"]
    args += [url, dest]
    parent = str(Path(cwd))
    out = _git(parent, args, timeout=max(timeout, 120))
    return {"output": _cap(out), "dest": str(Path(parent) / dest)}


def _op_remote(cwd, timeout, action: str = "list", name: str = "",
               url: str = "", **_):
    if action == "list":
        out = _git(cwd, ["remote", "-v"], timeout=timeout)
        remotes = {}
        for ln in out.splitlines():
            if not ln.strip(): continue
            parts = ln.split()
            if len(parts) >= 2:
                remotes.setdefault(parts[0], {})[
                    "fetch" if "fetch" in ln else "push"] = parts[1]
        return {"remotes": remotes}
    if action == "add":
        if not name or not url: raise RuntimeError("name= and url= required")
        _git(cwd, ["remote", "add", name, url], timeout=timeout)
        return {"added": name, "url": url}
    if action == "remove":
        if not name: raise RuntimeError("name= required")
        _git(cwd, ["remote", "remove", name], timeout=timeout)
        return {"removed": name}
    if action == "set-url":
        if not name or not url: raise RuntimeError("name= and url= required")
        _git(cwd, ["remote", "set-url", name, url], timeout=timeout)
        return {"updated": name, "url": url}
    raise RuntimeError(f"unknown remote action '{action}'")


def _op_reset(cwd, timeout, target: str = "HEAD", mode: str = "mixed",
              allow_hard: bool = False, **_):
    if mode == "hard" and not allow_hard:
        raise RuntimeError("destructive: pass allow_hard=True for --hard reset")
    _git(cwd, ["reset", f"--{mode}", target], timeout=timeout)
    return {"target": target, "mode": mode}


def _op_stash(cwd, timeout, action: str = "save", message: str = "",
              index: int = 0, **_):
    if action == "save":
        args = ["stash", "push"]
        if message: args += ["-m", message]
        out = _git(cwd, args, timeout=timeout)
        return {"output": _cap(out)}
    if action == "pop":
        out = _git(cwd, ["stash", "pop", f"stash@{{{index}}}"], timeout=timeout)
        return {"output": _cap(out)}
    if action == "drop":
        out = _git(cwd, ["stash", "drop", f"stash@{{{index}}}"], timeout=timeout)
        return {"output": _cap(out)}
    if action == "list":
        out = _git(cwd, ["stash", "list"], timeout=timeout)
        return {"stashes": [ln for ln in out.splitlines() if ln.strip()]}
    raise RuntimeError(f"unknown stash action '{action}'")


def _op_blame(cwd, timeout, path: str = "", line_start: int = 1,
              line_end: int | None = None, **_):
    if not path: raise RuntimeError("path= required")
    args = ["blame", "-c", "--date=short"]
    if line_end: args += ["-L", f"{line_start},{line_end}"]
    args += ["--", path]
    out = _git(cwd, args, timeout=timeout)
    return {"path": path, "blame": _cap(out)}


def _op_show(cwd, timeout, ref: str = "HEAD", **_):
    out = _git(cwd, ["show", "--stat", ref], timeout=timeout)
    return {"ref": ref, "output": _cap(out)}


def _op_ls_files(cwd, timeout, path: str = "", **_):
    args = ["ls-files"]
    if path: args.append(path)
    out = _git(cwd, args, timeout=timeout)
    files = [ln for ln in out.splitlines() if ln.strip()]
    return {"files": files, "count": len(files)}


_DISPATCH = {
    "status": _op_status, "diff": _op_diff, "log": _op_log,
    "branch": _op_branch, "commit": _op_commit, "add": _op_add,
    "checkout": _op_checkout, "push": _op_push, "pull": _op_pull,
    "fetch": _op_fetch, "clone": _op_clone, "remote": _op_remote,
    "reset": _op_reset, "stash": _op_stash, "blame": _op_blame,
    "show": _op_show, "ls_files": _op_ls_files, "ls-files": _op_ls_files,
}


# ── Helpers ─────────────────────────────────────────────────────────────────

def _git(cwd: str, args: list, timeout: int) -> str:
    env = os.environ.copy()
    env.setdefault("GIT_TERMINAL_PROMPT", "0")
    env.setdefault("GIT_OPTIONAL_LOCKS", "0")
    # Use GITHUB_TOKEN for HTTPS auth via credential helper when pushing/pulling
    token = env.get("GITHUB_TOKEN", "")
    cmd = ["git"]
    if token:
        # Configure inline credential helper that returns the token
        helper_script = (
            f"!f() {{ echo username=x-token; echo password={token}; }}; f"
        )
        cmd += ["-c", f"credential.helper={helper_script}"]
    cmd += args
    proc = subprocess.run(
        cmd, cwd=cwd, env=env,
        capture_output=True, text=True, timeout=timeout,
    )
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        stdout = (proc.stdout or "").strip()
        raise RuntimeError(stderr or stdout or f"git exited {proc.returncode}")
    return proc.stdout or ""


def _resolve_cwd(cwd: str) -> str:
    if not cwd:
        cwd = os.getcwd()
    p = Path(cwd).expanduser().resolve()
    if not p.exists():
        raise FileNotFoundError(str(p))
    return str(p)


def _cap(s: str) -> str:
    if len(s) <= MAX_OUTPUT:
        return s
    return s[:MAX_OUTPUT] + f"\n…[truncated {len(s) - MAX_OUTPUT} chars]"


def _ok(result, start, op, **extra):
    return {"status": "ok", "result": result, "error": None,
            "metadata": {"tool": "git_ops", "op": op,
                         "duration_ms": _ms(start), **extra}}


def _err(msg, start, op, **extra):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": "git_ops", "op": op,
                         "duration_ms": _ms(start), **extra}}


def _ms(start):
    return int((time.time() - start) * 1000)
