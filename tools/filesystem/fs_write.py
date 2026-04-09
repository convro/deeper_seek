import os
import time


def execute(path: str, content: str, mode: str = "write",
            old_string: str = None, new_string: str = None, **kwargs) -> dict:
    start = time.time()
    try:
        path = os.path.abspath(os.path.expanduser(path))
        os.makedirs(os.path.dirname(path), exist_ok=True)

        if mode == "write":
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            action = "written"

        elif mode == "append":
            with open(path, "a", encoding="utf-8") as f:
                f.write(content)
            action = "appended"

        elif mode == "patch":
            if old_string is None or new_string is None:
                return _err("patch mode requires old_string and new_string", "fs_write", start)
            if not os.path.exists(path):
                return _err(f"Cannot patch non-existent file: {path}", "fs_write", start)
            with open(path, "r", encoding="utf-8") as f:
                existing = f.read()
            if old_string not in existing:
                return _err(
                    f"old_string not found in file. Cannot patch.\nLooking for: {old_string[:100]}",
                    "fs_write", start
                )
            patched = existing.replace(old_string, new_string, 1)
            with open(path, "w", encoding="utf-8") as f:
                f.write(patched)
            action = "patched"

        else:
            return _err(f"Unknown mode: {mode}. Use write|append|patch", "fs_write", start)

        size_bytes = os.path.getsize(path)
        return {
            "status": "ok",
            "result": {
                "path": path,
                "action": action,
                "mode": mode,
                "size_bytes": size_bytes,
                "lines_written": content.count("\n") + 1 if content else 0,
            },
            "error": None,
            "metadata": {"tool": "fs_write", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "fs_write", start)


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
