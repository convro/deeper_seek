import os
import time


def execute(path: str, offset: int = 0, limit: int = 500, **kwargs) -> dict:
    start = time.time()
    try:
        path = os.path.abspath(os.path.expanduser(path))
        if not os.path.exists(path):
            return _err(f"File not found: {path}", "fs_read", start)
        if not os.path.isfile(path):
            return _err(f"Path is not a file: {path}", "fs_read", start)

        size_bytes = os.path.getsize(path)
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()

        total_lines = len(lines)
        selected = lines[offset : offset + limit]
        content = "".join(selected)

        return {
            "status": "ok",
            "result": {
                "path": path,
                "content": content,
                "total_lines": total_lines,
                "returned_lines": len(selected),
                "offset": offset,
                "limit": limit,
                "size_bytes": size_bytes,
                "truncated": total_lines > offset + limit,
            },
            "error": None,
            "metadata": {"tool": "fs_read", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "fs_read", start)


def _err(msg, tool, start):
    return {
        "status": "error",
        "result": None,
        "error": msg,
        "metadata": {"tool": tool, "duration_ms": _ms(start)},
    }


def _ms(start):
    return int((time.time() - start) * 1000)
