import os
import shutil
import time


def execute(src: str, dst: str, **kwargs) -> dict:
    start = time.time()
    try:
        src = os.path.abspath(os.path.expanduser(src))
        dst = os.path.abspath(os.path.expanduser(dst))

        if not os.path.exists(src):
            return _err(f"Source not found: {src}", "fs_move", start)

        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(src, dst)

        return {
            "status": "ok",
            "result": {"src": src, "dst": dst, "moved": True},
            "error": None,
            "metadata": {"tool": "fs_move", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "fs_move", start)


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
