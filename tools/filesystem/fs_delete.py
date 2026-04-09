import os
import shutil
import time


def execute(path: str, recursive: bool = False, **kwargs) -> dict:
    start = time.time()
    try:
        path = os.path.abspath(os.path.expanduser(path))

        if not os.path.exists(path):
            return _err(f"Path not found: {path}", "fs_delete", start)

        if os.path.isdir(path):
            if not recursive:
                return _err(
                    f"Path is a directory. Set recursive=true to delete directories.",
                    "fs_delete", start
                )
            shutil.rmtree(path)
            deleted_type = "directory"
        else:
            os.remove(path)
            deleted_type = "file"

        return {
            "status": "ok",
            "result": {"path": path, "deleted": True, "type": deleted_type},
            "error": None,
            "metadata": {"tool": "fs_delete", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "fs_delete", start)


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
