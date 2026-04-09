import os
import time
import re


def execute(path: str, language: str = None, **kwargs) -> dict:
    start = time.time()
    try:
        path = os.path.abspath(os.path.expanduser(path))
        if not os.path.exists(path):
            return _err(f"Path not found: {path}", "code_analyzer", start)

        if os.path.isfile(path):
            result = _analyze_file(path, language)
        elif os.path.isdir(path):
            result = _analyze_dir(path)
        else:
            return _err(f"Not a file or directory: {path}", "code_analyzer", start)

        return {
            "status": "ok",
            "result": result,
            "error": None,
            "metadata": {"tool": "code_analyzer", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "code_analyzer", start)


def _analyze_file(path, language=None):
    ext = os.path.splitext(path)[1].lower()
    lang = language or _detect_lang(ext)

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
        lines = content.splitlines()

    total_lines = len(lines)
    blank_lines = sum(1 for l in lines if not l.strip())
    comment_lines = _count_comments(lines, lang)
    code_lines = total_lines - blank_lines - comment_lines

    functions = _find_functions(content, lang)
    classes = _find_classes(content, lang)
    imports = _find_imports(content, lang)

    return {
        "path": path,
        "language": lang,
        "metrics": {
            "total_lines": total_lines,
            "code_lines": code_lines,
            "comment_lines": comment_lines,
            "blank_lines": blank_lines,
            "function_count": len(functions),
            "class_count": len(classes),
            "import_count": len(imports),
        },
        "functions": functions[:50],
        "classes": classes[:20],
        "imports": imports[:30],
    }


def _analyze_dir(path):
    stats = {"total_files": 0, "total_lines": 0, "by_language": {}}
    file_results = []

    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in
                   ("node_modules", "__pycache__", ".git", "venv", ".venv", "dist", "build")]
        for fname in files:
            ext = os.path.splitext(fname)[1].lower()
            lang = _detect_lang(ext)
            if lang == "unknown":
                continue
            fpath = os.path.join(root, fname)
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    lines = f.readlines()
                count = len(lines)
                stats["total_files"] += 1
                stats["total_lines"] += count
                stats["by_language"][lang] = stats["by_language"].get(lang, 0) + count
                file_results.append({"path": os.path.relpath(fpath, path), "lang": lang, "lines": count})
            except OSError:
                continue

    return {"path": path, "stats": stats, "files": file_results}


def _detect_lang(ext):
    mapping = {
        ".py": "python", ".js": "javascript", ".ts": "typescript",
        ".jsx": "javascript", ".tsx": "typescript", ".java": "java",
        ".go": "go", ".rs": "rust", ".c": "c", ".cpp": "cpp",
        ".h": "c", ".cs": "csharp", ".rb": "ruby", ".php": "php",
        ".swift": "swift", ".kt": "kotlin", ".sh": "bash",
        ".bash": "bash", ".zsh": "bash", ".sql": "sql",
        ".html": "html", ".css": "css", ".json": "json",
        ".yaml": "yaml", ".yml": "yaml", ".md": "markdown",
    }
    return mapping.get(ext, "unknown")


def _count_comments(lines, lang):
    count = 0
    for line in lines:
        stripped = line.strip()
        if lang in ("python", "bash"):
            if stripped.startswith("#"):
                count += 1
        elif lang in ("javascript", "typescript", "java", "go", "c", "cpp", "rust", "csharp"):
            if stripped.startswith("//") or stripped.startswith("/*") or stripped.startswith("*"):
                count += 1
    return count


def _find_functions(content, lang):
    patterns = {
        "python": r"^def\s+(\w+)\s*\(",
        "javascript": r"(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\())",
        "typescript": r"(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\())",
        "go": r"^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(",
        "rust": r"^(?:pub\s+)?fn\s+(\w+)\s*[(<]",
        "java": r"(?:public|private|protected|static|\s)+[\w<>\[\]]+\s+(\w+)\s*\(",
    }
    pattern = patterns.get(lang)
    if not pattern:
        return []
    matches = []
    for m in re.finditer(pattern, content, re.MULTILINE):
        name = next((g for g in m.groups() if g), None)
        if name:
            line_num = content[:m.start()].count("\n") + 1
            matches.append({"name": name, "line": line_num})
    return matches


def _find_classes(content, lang):
    patterns = {
        "python": r"^class\s+(\w+)",
        "javascript": r"^class\s+(\w+)",
        "typescript": r"^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)",
        "java": r"^(?:public\s+)?(?:abstract\s+)?class\s+(\w+)",
        "go": r"^type\s+(\w+)\s+struct",
        "rust": r"^(?:pub\s+)?struct\s+(\w+)",
    }
    pattern = patterns.get(lang)
    if not pattern:
        return []
    matches = []
    for m in re.finditer(pattern, content, re.MULTILINE):
        line_num = content[:m.start()].count("\n") + 1
        matches.append({"name": m.group(1), "line": line_num})
    return matches


def _find_imports(content, lang):
    patterns = {
        "python": r"^(?:import|from)\s+[\w.]+",
        "javascript": r"^import\s+.+from\s+['\"](.+)['\"]",
        "typescript": r"^import\s+.+from\s+['\"](.+)['\"]",
        "go": r"\"([\w./]+)\"",
        "rust": r"^use\s+([\w:]+)",
    }
    pattern = patterns.get(lang)
    if not pattern:
        return []
    return [m.group(0) for m in re.finditer(pattern, content, re.MULTILINE)][:30]


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
