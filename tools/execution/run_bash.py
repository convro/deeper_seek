import subprocess
import os
import time


def execute(command: str, timeout: int = 30, working_dir: str = None, **kwargs) -> dict:
    start = time.time()
    try:
        if working_dir:
            working_dir = os.path.abspath(os.path.expanduser(working_dir))
            os.makedirs(working_dir, exist_ok=True)

        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=working_dir or os.getcwd(),
            env={**os.environ},
        )

        stdout = result.stdout
        stderr = result.stderr
        returncode = result.returncode

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
                "command": command,
                "truncated": truncated,
            },
            "error": stderr if returncode != 0 else None,
            "metadata": {"tool": "run_bash", "duration_ms": _ms(start)},
        }

    except subprocess.TimeoutExpired:
        return _err(f"Command timed out after {timeout}s: {command}", "run_bash", start)
    except Exception as e:
        return _err(str(e), "run_bash", start)


def _err(msg, tool, start):
    return {"status": "error", "result": {"stdout": "", "stderr": msg, "returncode": -1, "success": False},
            "error": msg, "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
