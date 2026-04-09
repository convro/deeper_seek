import subprocess
import os
import time
import tempfile
import shutil


def execute(code: str, timeout: int = 30, **kwargs) -> dict:
    start = time.time()

    node_bin = shutil.which("node") or shutil.which("nodejs")
    if not node_bin:
        return _err("Node.js not found in PATH. Install Node.js.", "run_node", start)

    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".js",
                                         delete=False, encoding="utf-8") as f:
            f.write(code)
            tmp_path = f.name

        try:
            result = subprocess.run(
                [node_bin, tmp_path],
                capture_output=True,
                text=True,
                timeout=timeout,
                env={**os.environ},
            )

            stdout = result.stdout[:50000]
            stderr = result.stderr[:50000]

            return {
                "status": "ok" if result.returncode == 0 else "error",
                "result": {
                    "stdout": stdout,
                    "stderr": stderr,
                    "returncode": result.returncode,
                    "success": result.returncode == 0,
                },
                "error": stderr if result.returncode != 0 else None,
                "metadata": {"tool": "run_node", "duration_ms": _ms(start)},
            }
        except subprocess.TimeoutExpired:
            return _err(f"Node.js execution timed out after {timeout}s", "run_node", start)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    except Exception as e:
        return _err(str(e), "run_node", start)


def _err(msg, tool, start):
    return {"status": "error", "result": {"stdout": "", "stderr": msg, "returncode": -1, "success": False},
            "error": msg, "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
