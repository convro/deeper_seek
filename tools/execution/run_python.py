import subprocess
import sys
import os
import time
import tempfile


def execute(code: str, timeout: int = 30, working_dir: str = None, **kwargs) -> dict:
    start = time.time()
    try:
        if working_dir:
            working_dir = os.path.abspath(os.path.expanduser(working_dir))
            os.makedirs(working_dir, exist_ok=True)

        with tempfile.NamedTemporaryFile(mode="w", suffix=".py",
                                         delete=False, encoding="utf-8") as f:
            f.write(code)
            tmp_path = f.name

        try:
            result = subprocess.run(
                [sys.executable, tmp_path],
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=working_dir or os.getcwd(),
                env={**os.environ},
            )

            stdout = result.stdout
            stderr = result.stderr
            returncode = result.returncode

            # Truncate very long output
            max_chars = 50000
            truncated = False
            if len(stdout) > max_chars:
                stdout = stdout[:max_chars] + "\n[OUTPUT TRUNCATED]"
                truncated = True
            if len(stderr) > max_chars:
                stderr = stderr[:max_chars] + "\n[STDERR TRUNCATED]"

            return {
                "status": "ok" if returncode == 0 else "error",
                "result": {
                    "stdout": stdout,
                    "stderr": stderr,
                    "returncode": returncode,
                    "success": returncode == 0,
                    "truncated": truncated,
                },
                "error": stderr if returncode != 0 else None,
                "metadata": {"tool": "run_python", "duration_ms": _ms(start)},
            }

        except subprocess.TimeoutExpired:
            return _err(f"Python execution timed out after {timeout}s", "run_python", start)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    except Exception as e:
        return _err(str(e), "run_python", start)


def _err(msg, tool, start):
    return {"status": "error", "result": {"stdout": "", "stderr": msg, "returncode": -1, "success": False},
            "error": msg, "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
