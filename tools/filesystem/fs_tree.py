import os
import time

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv",
             "dist", "build", ".next", ".nuxt", "coverage"}


def execute(path: str, depth: int = 3, include_hidden: bool = False, **kwargs) -> dict:
    start = time.time()
    try:
        path = os.path.abspath(os.path.expanduser(path))
        if not os.path.exists(path):
            return _err(f"Path not found: {path}", "fs_tree", start)

        tree_lines = []
        _build_tree(path, depth, include_hidden, "", tree_lines, 0)
        tree_str = "\n".join(tree_lines)

        return {
            "status": "ok",
            "result": {
                "path": path,
                "depth": depth,
                "tree": tree_str,
                "line_count": len(tree_lines),
            },
            "error": None,
            "metadata": {"tool": "fs_tree", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "fs_tree", start)


def _build_tree(path, max_depth, include_hidden, prefix, lines, current_depth):
    if current_depth >= max_depth:
        return

    try:
        entries = sorted(os.listdir(path))
    except PermissionError:
        lines.append(f"{prefix}[permission denied]")
        return

    if not include_hidden:
        entries = [e for e in entries if not e.startswith(".")]

    dirs = [e for e in entries if os.path.isdir(os.path.join(path, e))]
    files = [e for e in entries if os.path.isfile(os.path.join(path, e))]
    entries_sorted = dirs + files

    for i, entry in enumerate(entries_sorted):
        is_last = i == len(entries_sorted) - 1
        connector = "└── " if is_last else "├── "
        child_path = os.path.join(path, entry)

        if os.path.isdir(child_path):
            if entry in SKIP_DIRS:
                lines.append(f"{prefix}{connector}{entry}/ [skipped]")
                continue
            lines.append(f"{prefix}{connector}{entry}/")
            extension = "    " if is_last else "│   "
            _build_tree(child_path, max_depth, include_hidden,
                        prefix + extension, lines, current_depth + 1)
        else:
            size = _fmt_size(os.path.getsize(child_path))
            lines.append(f"{prefix}{connector}{entry} ({size})")


def _fmt_size(size_bytes):
    if size_bytes < 1024:
        return f"{size_bytes}B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes // 1024}KB"
    else:
        return f"{size_bytes // (1024 * 1024)}MB"


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
