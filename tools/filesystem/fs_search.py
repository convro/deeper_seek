import os
import re
import glob
import time


def execute(pattern: str, path: str = ".", mode: str = "glob",
            case_sensitive: bool = False, **kwargs) -> dict:
    start = time.time()
    try:
        path = os.path.abspath(os.path.expanduser(path))

        if mode == "glob":
            results = _glob_search(pattern, path)
        elif mode == "content":
            results = _content_search(pattern, path, case_sensitive)
        else:
            return _err(f"Unknown mode: {mode}. Use glob|content", "fs_search", start)

        return {
            "status": "ok",
            "result": {
                "pattern": pattern,
                "path": path,
                "mode": mode,
                "count": len(results),
                "results": results[:200],
                "truncated": len(results) > 200,
            },
            "error": None,
            "metadata": {"tool": "fs_search", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "fs_search", start)


def _glob_search(pattern, root):
    matches = []
    full_pattern = os.path.join(root, pattern) if not os.path.isabs(pattern) else pattern
    for match in glob.glob(full_pattern, recursive=True):
        matches.append({"path": match, "type": "dir" if os.path.isdir(match) else "file"})
    return matches


def _content_search(pattern, root, case_sensitive):
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        regex = re.compile(pattern, flags)
    except re.error as e:
        raise ValueError(f"Invalid regex pattern: {e}")

    matches = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Skip hidden directories and common noise
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in
                       ("node_modules", "__pycache__", ".git", "venv", ".venv", "dist", "build")]
        for fname in filenames:
            fpath = os.path.join(dirpath, fname)
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    for lineno, line in enumerate(f, 1):
                        if regex.search(line):
                            matches.append({
                                "path": fpath,
                                "line": lineno,
                                "content": line.rstrip(),
                            })
                            if len(matches) >= 500:
                                return matches
            except (PermissionError, OSError):
                continue
    return matches


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
