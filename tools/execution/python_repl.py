"""
python_repl.py — Stateful Python REPL with persistent globals.

Unlike `run_python` (which spawns a fresh subprocess every call),
this tool keeps a long-lived Python interpreter per session, so
variables / imports / dataframes survive across calls.

Sessions live in /tmp so they persist across tool_executor invocations.
Each session is a real Python process communicated with via pipes.
Stdout/stderr are captured per call; expressions are auto-printed.

Args:
  code:       str — Python code to run
  session:    str — session id (default: "default")
  timeout:    int — seconds (default 30)
  reset:      bool — drop and recreate the session before running
  list_sessions: bool — just list active sessions and exit
  kill:       bool — kill the session

Returns:
  {status, result: {stdout, stderr, value, error, session,
                    variables, display_value}, ...}
"""

from __future__ import annotations

import json
import os
import pickle
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
from pathlib import Path

SESS_DIR = Path(tempfile.gettempdir()) / "deeper_seek_repl"
SESS_DIR.mkdir(parents=True, exist_ok=True)
DEFAULT_TIMEOUT = 30

# The worker script runs inside the REPL subprocess.
# It reads JSON requests from stdin, executes them, writes JSON to stdout.
_WORKER = textwrap.dedent("""
    import sys, os, json, io, traceback, contextlib, ast
    GLOBALS = {"__name__": "__repl__", "__builtins__": __builtins__}

    def _truncate(s, n=20000):
        if s is None: return ""
        s = str(s)
        return s if len(s) <= n else s[:n] + f"\\n…[truncated {len(s)-n} chars]"

    def _describe_vars():
        out = []
        for k, v in sorted(GLOBALS.items()):
            if k.startswith("__") or k in ("GLOBALS",):
                continue
            try:
                t = type(v).__name__
                r = repr(v)
                if len(r) > 120: r = r[:120] + "…"
                out.append({"name": k, "type": t, "repr": r})
            except Exception:
                out.append({"name": k, "type": "?", "repr": "<unreprable>"})
            if len(out) >= 100: break
        return out

    def handle(code):
        stdout, stderr = io.StringIO(), io.StringIO()
        value = None
        err = None
        try:
            try:
                tree = ast.parse(code, mode="exec")
            except SyntaxError as e:
                return {"stdout": "", "stderr": "",
                        "error": f"SyntaxError: {e}", "value": None}
            last_is_expr = (len(tree.body) > 0
                            and isinstance(tree.body[-1], ast.Expr))
            if last_is_expr:
                exec_part = ast.Module(body=tree.body[:-1], type_ignores=[])
                eval_part = ast.Expression(body=tree.body[-1].value)
                with contextlib.redirect_stdout(stdout), \\
                     contextlib.redirect_stderr(stderr):
                    exec(compile(exec_part, "<repl>", "exec"), GLOBALS)
                    value = eval(compile(eval_part, "<repl>", "eval"), GLOBALS)
                    if value is not None:
                        print(repr(value))
            else:
                with contextlib.redirect_stdout(stdout), \\
                     contextlib.redirect_stderr(stderr):
                    exec(compile(tree, "<repl>", "exec"), GLOBALS)
        except SystemExit as e:
            err = f"SystemExit: {e.code}"
        except KeyboardInterrupt:
            err = "KeyboardInterrupt"
        except BaseException:
            err = traceback.format_exc()
        return {"stdout": _truncate(stdout.getvalue()),
                "stderr": _truncate(stderr.getvalue()),
                "error": err,
                "value": _truncate(repr(value)) if value is not None else None}

    # Drain loop: one JSON request per line
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            sys.stdout.write(json.dumps({"error": f"bad request: {e}"}) + "\\n")
            sys.stdout.flush()
            continue
        if req.get("op") == "exec":
            r = handle(req.get("code", ""))
            r["variables"] = _describe_vars()
        elif req.get("op") == "vars":
            r = {"variables": _describe_vars()}
        elif req.get("op") == "quit":
            sys.stdout.write(json.dumps({"bye": True}) + "\\n")
            sys.stdout.flush()
            break
        else:
            r = {"error": f"unknown op: {req.get('op')}"}
        sys.stdout.write(json.dumps(r, default=str) + "\\n")
        sys.stdout.flush()
""").strip()


def _worker_path() -> Path:
    p = SESS_DIR / "_worker.py"
    if not p.exists() or p.read_text() != _WORKER:
        p.write_text(_WORKER)
    return p


def _meta_path(session: str) -> Path:
    return SESS_DIR / f"{session}.meta.json"


def _load_meta(session: str) -> dict | None:
    p = _meta_path(session)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def _save_meta(session: str, meta: dict) -> None:
    _meta_path(session).write_text(json.dumps(meta))


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False
    except Exception:
        return False


def _spawn(session: str) -> dict:
    stdin_fifo = SESS_DIR / f"{session}.in"
    stdout_fifo = SESS_DIR / f"{session}.out"
    for f in (stdin_fifo, stdout_fifo):
        if f.exists():
            f.unlink()
        os.mkfifo(f)
    # Launch worker detached
    proc = subprocess.Popen(
        [sys.executable, "-u", str(_worker_path())],
        stdin=open(stdin_fifo, "rb", buffering=0),
        stdout=open(stdout_fifo, "wb", buffering=0),
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    meta = {"pid": proc.pid, "session": session,
            "stdin": str(stdin_fifo), "stdout": str(stdout_fifo),
            "started": time.time()}
    _save_meta(session, meta)
    # Detach — we'll talk via FIFOs next call
    proc.stdin.close()
    proc.stdout.close()
    return meta


def _kill(session: str) -> bool:
    meta = _load_meta(session)
    if not meta:
        return False
    try:
        os.kill(meta["pid"], signal.SIGTERM)
        time.sleep(0.2)
        if _alive(meta["pid"]):
            os.kill(meta["pid"], signal.SIGKILL)
    except Exception:
        pass
    for k in ("stdin", "stdout"):
        p = Path(meta.get(k, ""))
        if p.exists():
            try: p.unlink()
            except Exception: pass
    try: _meta_path(session).unlink()
    except Exception: pass
    return True


def _talk(session: str, payload: dict, timeout: float) -> dict:
    meta = _load_meta(session)
    if not meta or not _alive(meta["pid"]):
        meta = _spawn(session)
    # Write request
    with open(meta["stdin"], "w", buffering=1) as f:
        f.write(json.dumps(payload) + "\n")
    # Read response with timeout
    import select
    out_fd = os.open(meta["stdout"], os.O_RDONLY | os.O_NONBLOCK)
    try:
        buf = b""
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise TimeoutError("REPL call timed out")
            r, _, _ = select.select([out_fd], [], [], min(remaining, 0.5))
            if out_fd in r:
                chunk = os.read(out_fd, 65536)
                if not chunk:
                    time.sleep(0.01)
                    continue
                buf += chunk
                if b"\n" in buf:
                    line, _, _ = buf.partition(b"\n")
                    return json.loads(line.decode("utf-8", errors="replace"))
    finally:
        os.close(out_fd)


def _list_sessions() -> list:
    out = []
    for meta_file in SESS_DIR.glob("*.meta.json"):
        try:
            m = json.loads(meta_file.read_text())
            if _alive(m["pid"]):
                out.append({
                    "session": m["session"], "pid": m["pid"],
                    "age_s": int(time.time() - m.get("started", time.time())),
                })
            else:
                meta_file.unlink(missing_ok=True)
        except Exception:
            continue
    return out


def execute(code: str = "", session: str = "default",
            timeout: int = DEFAULT_TIMEOUT, reset: bool = False,
            list_sessions: bool = False, kill: bool = False,
            **kwargs) -> dict:
    start = time.time()

    if list_sessions:
        return _ok({"sessions": _list_sessions()}, start)

    if kill:
        return _ok({"killed": _kill(session), "session": session}, start)

    if reset:
        _kill(session)

    if not code.strip():
        return _ok({"variables": _talk(session, {"op": "vars"},
                                       timeout=max(5, timeout))["variables"],
                    "session": session}, start)

    try:
        resp = _talk(session, {"op": "exec", "code": code},
                     timeout=max(1, timeout))
    except TimeoutError as e:
        # Kill hung session so the next call starts clean
        _kill(session)
        return _err(f"{e}. Session '{session}' was killed.", start)
    except Exception as e:
        return _err(f"REPL communication failed: {e}", start)

    err = resp.get("error")
    return {
        "status": "error" if err else "ok",
        "result": {
            "session": session,
            "stdout": resp.get("stdout", ""),
            "stderr": resp.get("stderr", ""),
            "value": resp.get("value"),
            "display_value": resp.get("value"),
            "variables": resp.get("variables", []),
        },
        "error": err,
        "metadata": {"tool": "python_repl",
                     "duration_ms": int((time.time() - start) * 1000)},
    }


def _ok(result, start):
    return {"status": "ok", "result": result, "error": None,
            "metadata": {"tool": "python_repl",
                         "duration_ms": int((time.time() - start) * 1000)}}


def _err(msg, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": "python_repl",
                         "duration_ms": int((time.time() - start) * 1000)}}
