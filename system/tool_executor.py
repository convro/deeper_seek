#!/usr/bin/env python3
"""
tool_executor.py — Central dispatcher for all tool calls.

Called by Node.js backend via subprocess:
  echo '{"tool": "fs_read", "args": {"path": "/some/file"}}' | python3 tool_executor.py

Returns JSON to stdout.
"""

import sys
import json
import os
import time
import traceback
import importlib.util

# Add project root to path
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, PROJECT_ROOT)

# Tool → module path mapping
TOOL_MAP = {
    # Filesystem
    "fs_read":          "tools/filesystem/fs_read.py",
    "fs_write":         "tools/filesystem/fs_write.py",
    "fs_search":        "tools/filesystem/fs_search.py",
    "fs_tree":          "tools/filesystem/fs_tree.py",
    "fs_move":          "tools/filesystem/fs_move.py",
    "fs_delete":        "tools/filesystem/fs_delete.py",
    "archive":          "tools/filesystem/archive.py",
    # Execution
    "run_python":       "tools/execution/run_python.py",
    "run_bash":         "tools/execution/run_bash.py",
    "run_node":         "tools/execution/run_node.py",
    "python_repl":      "tools/execution/python_repl.py",
    # Web
    "web_fetch":        "tools/web/web_fetch.py",
    "web_search":       "tools/web/web_search.py",
    "web_research":     "tools/web/web_research.py",
    "web_browse":       "tools/web/web_browse.py",
    "http_request":     "tools/web/http_request.py",
    "video_info":       "tools/web/video_info.py",
    # Workspace
    "workspace_create":   "tools/workspace/workspace_create.py",
    "workspace_load":     "tools/workspace/workspace_load.py",
    "workspace_snapshot": "tools/workspace/workspace_snapshot.py",
    "workspace_list":     "tools/workspace/workspace_list.py",
    "workspace_export":   "tools/workspace/workspace_export.py",
    # Memory
    "memory_store":       "tools/memory/memory_store.py",
    "memory_get":         "tools/memory/memory_get.py",
    "memory_search":      "tools/memory/memory_vector_search.py",
    # Web — images
    "image_search":       "tools/web/image_search.py",
    "page_images":        "tools/web/page_images.py",
    "image_reverse":      "tools/web/image_reverse.py",
    # Agents
    "agent_spawn":        "tools/agents/agent_spawn.py",
    "agent_status":       "tools/agents/agent_status.py",
    "agent_wait":         "tools/agents/agent_wait.py",
    # Analysis
    "code_analyzer":      "tools/analysis/code_analyzer.py",
    "repo_scanner":       "tools/analysis/repo_scanner.py",
    "ast_search":         "tools/analysis/ast_search.py",
    "task_split":         "tools/orchestration/task_split.py",
    # Code / version control
    "git_ops":            "tools/code/git_ops.py",
    "github_ops":         "tools/code/github_ops.py",
    # Logs
    "log_reader":         "tools/logs/log_reader.py",
    # Vision
    "image_analyze":      "tools/vision/image_analyze.py",
    "image_edit":         "tools/vision/image_edit.py",
    # Documents / viz / audio / data
    "pdf_generate":       "tools/docs/pdf_generate.py",
    "chart":              "tools/viz/chart.py",
    "audio_transcribe":   "tools/audio/audio_transcribe.py",
    "data_query":         "tools/data/data_query.py",
    # Web — interactive browser
    "web_interact":       "tools/web/web_interact.py",
    # Security / pentesting
    "port_scan":          "tools/security/port_scan.py",
    "dir_fuzz":           "tools/security/dir_fuzz.py",
    "dns_recon":          "tools/security/dns_recon.py",
    "web_audit":          "tools/security/web_audit.py",
    "sqli_test":          "tools/security/sqli_test.py",
    "ssl_inspect":        "tools/security/ssl_inspect.py",
    "tech_detect":        "tools/security/tech_detect.py",
    # Discord (user-token / self-bot integration)
    "discord_tool":       "tools/discord/discord_tool.py",
    # Scheduler — start long-running autonomous background tasks
    "scheduler_tool":     "tools/scheduler/scheduler_tool.py",
}


# Common module→pip mappings for auto-install
_PKG_MAP = {
    "PIL": "Pillow", "cv2": "opencv-python-headless", "skimage": "scikit-image",
    "sklearn": "scikit-learn", "yaml": "pyyaml", "bs4": "beautifulsoup4",
    "pytesseract": "pytesseract", "easyocr": "easyocr", "numpy": "numpy",
    "scipy": "scipy", "requests": "requests", "pandas": "pandas",
    "matplotlib": "matplotlib", "lxml": "lxml", "chardet": "chardet",
    "httpx": "httpx", "trafilatura": "trafilatura",
    "pdfminer": "pdfminer.six", "imagehash": "imagehash",
    "markdownify": "markdownify", "playwright": "playwright",
    "brotli": "brotli",
    # New tools
    "sentence_transformers": "sentence-transformers",
    "weasyprint": "weasyprint",
    "reportlab": "reportlab",
    "markdown": "markdown",
    "faster_whisper": "faster-whisper",
    "whisper": "openai-whisper",
    "duckdb": "duckdb",
    "openpyxl": "openpyxl",
    "pyarrow": "pyarrow",
}


def _guess_package(error_msg: str) -> str:
    """Guess pip package name from ImportError message."""
    import re
    match = re.search(r"No module named ['\"]?([a-zA-Z0-9_]+)", error_msg)
    if match:
        mod = match.group(1)
        return _PKG_MAP.get(mod, mod)
    return None


def load_module(module_path: str):
    """Dynamically load a Python module from a file path."""
    abs_path = os.path.join(PROJECT_ROOT, module_path)
    spec = importlib.util.spec_from_file_location("tool_module", abs_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def execute_tool(tool_name: str, args: dict) -> dict:
    start = time.time()

    if tool_name not in TOOL_MAP:
        return {
            "status": "error",
            "result": None,
            "error": f"Unknown tool: '{tool_name}'. Available: {sorted(TOOL_MAP.keys())}",
            "metadata": {"tool": tool_name, "duration_ms": 0},
        }

    module_path = TOOL_MAP[tool_name]
    abs_path = os.path.join(PROJECT_ROOT, module_path)

    if not os.path.exists(abs_path):
        return {
            "status": "error",
            "result": None,
            "error": f"Tool module not found: {abs_path}",
            "metadata": {"tool": tool_name, "duration_ms": 0},
        }

    try:
        module = load_module(module_path)
        result = module.execute(**args)
        # Inject duration_ms if metadata is present but missing it
        if isinstance(result, dict) and 'metadata' in result:
            if 'duration_ms' not in (result['metadata'] or {}):
                result.setdefault('metadata', {})['duration_ms'] = int((time.time() - start) * 1000)
        elif isinstance(result, dict):
            result['metadata'] = {
                'tool': tool_name,
                'duration_ms': int((time.time() - start) * 1000),
            }
        return result
    except ImportError as e:
        # Auto-install missing package and retry once
        pkg = _guess_package(str(e))
        if pkg:
            try:
                import subprocess
                subprocess.check_call(
                    [sys.executable, "-m", "pip", "install", "--quiet", pkg],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                # Retry after install
                module = load_module(module_path)
                result = module.execute(**args)
                if isinstance(result, dict):
                    result.setdefault('metadata', {})['auto_installed'] = pkg
                    result['metadata']['duration_ms'] = int((time.time() - start) * 1000)
                return result
            except Exception:
                pass
        return {
            "status": "error",
            "result": None,
            "error": f"Missing Python package for {tool_name}: {e}. Auto-install failed.",
            "metadata": {"tool": tool_name, "duration_ms": int((time.time() - start) * 1000)},
        }
    except TypeError as e:
        # Wrong arguments — helpful message
        import inspect
        sig = str(inspect.signature(module.execute)) if 'module' in dir() else '(unknown)'
        return {
            "status": "error",
            "result": None,
            "error": f"Bad arguments for {tool_name}{sig}: {e}",
            "metadata": {"tool": tool_name, "duration_ms": int((time.time() - start) * 1000)},
        }
    except Exception as e:
        tb = traceback.format_exc()
        return {
            "status": "error",
            "result": None,
            "error": f"Tool execution error ({tool_name}): {str(e)}\n{tb[-1000:]}",
            "metadata": {"tool": tool_name, "duration_ms": int((time.time() - start) * 1000)},
        }


def main():
    try:
        raw = sys.stdin.read().strip()
        if not raw:
            print(json.dumps({"status": "error", "error": "Empty input", "result": None}))
            return

        request = json.loads(raw)
        tool_name = request.get("tool")
        args = request.get("args", {})

        if not tool_name:
            print(json.dumps({"status": "error", "error": "Missing 'tool' field", "result": None}))
            return

        result = execute_tool(tool_name, args)
        print(json.dumps(result, ensure_ascii=False, default=str))

    except json.JSONDecodeError as e:
        print(json.dumps({"status": "error", "error": f"Invalid JSON input: {e}", "result": None}))
    except Exception as e:
        print(json.dumps({
            "status": "error",
            "error": f"Executor error: {str(e)}\n{traceback.format_exc()}",
            "result": None
        }))


if __name__ == "__main__":
    main()
