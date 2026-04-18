"""
ast_search.py — Structural code search that understands syntax.

Finds symbols (functions, classes, methods, imports, call sites, assignments)
by inspecting the AST/structure of source files, not plain text.

Per-language strategy:
  • Python        — stdlib `ast` (always available, fast, precise)
  • JS/TS         — structural regex patterns tuned for real code
  • Other langs   — optional tree-sitter fallback (if installed)

Args:
  root:        str  — directory to scan (default ".")
  kind:        str  — "function" | "class" | "method" | "import"
                      | "call" | "assign" | "any" (default "any")
  name:        str  — symbol name (exact or glob; case-sensitive)
  regex:       str  — alternative to name; Python re pattern
  languages:   list — ["python","js","ts","jsx","tsx"] (default: all)
  include:     list — file globs to include
  exclude:     list — file globs to exclude (adds to defaults)
  max_results: int  — cap (default 500)
  context:     int  — lines of surrounding source in each hit (default 2)
"""

from __future__ import annotations

import ast
import fnmatch
import os
import re
import time
from pathlib import Path

DEFAULT_EXCLUDE = [
    ".git/*", "node_modules/*", "dist/*", "build/*", "__pycache__/*",
    ".venv/*", "venv/*", ".pytest_cache/*", ".next/*", ".turbo/*",
    "coverage/*", "*.min.js", "*.min.css", "vendor/*", ".mypy_cache/*",
]

LANG_EXT = {
    "python": [".py", ".pyi"],
    "js":     [".js", ".mjs", ".cjs"],
    "ts":     [".ts"],
    "jsx":    [".jsx"],
    "tsx":    [".tsx"],
}


def execute(root: str = ".", kind: str = "any", name: str = "",
            regex: str = "", languages: list | None = None,
            include: list | None = None, exclude: list | None = None,
            max_results: int = 500, context: int = 2,
            **kwargs) -> dict:
    start = time.time()
    root_p = Path(root).expanduser().resolve()
    if not root_p.exists():
        return _err(f"root does not exist: {root_p}", start)

    langs = [l.lower() for l in (languages or list(LANG_EXT.keys()))]
    exts = {e for l in langs for e in LANG_EXT.get(l, [])}
    excl = DEFAULT_EXCLUDE + list(exclude or [])

    matcher = _compile_matcher(name, regex)
    kind = (kind or "any").lower()

    hits: list = []
    files_scanned = 0

    for fp in _iter_files(root_p, exts, include, excl):
        files_scanned += 1
        try:
            text = fp.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        lang = _lang_for(fp)
        try:
            if lang == "python":
                file_hits = _py_search(text, kind, matcher)
            else:
                file_hits = _js_search(text, kind, matcher)
        except Exception:
            continue
        for h in file_hits:
            h["file"] = str(fp.relative_to(root_p))
            h["language"] = lang
            h["context"] = _context(text, h["line"], context)
            hits.append(h)
            if len(hits) >= max_results:
                break
        if len(hits) >= max_results:
            break

    return {
        "status": "ok",
        "result": {
            "root": str(root_p), "kind": kind,
            "query": name or regex,
            "count": len(hits), "files_scanned": files_scanned,
            "hits": hits,
        },
        "error": None,
        "metadata": {"tool": "ast_search",
                     "duration_ms": int((time.time() - start) * 1000)},
    }


# ── Python AST ──────────────────────────────────────────────────────────────

def _py_search(text: str, kind: str, matcher) -> list:
    out = []
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return out

    parents: dict = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node

    def _is_method(node):
        parent = parents.get(node)
        return isinstance(parent, ast.ClassDef)

    for node in ast.walk(tree):
        entry = None
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            k = "method" if _is_method(node) else "function"
            if kind in ("any", k, "function"):
                if matcher(node.name):
                    entry = {"kind": k, "name": node.name,
                             "line": node.lineno,
                             "col": node.col_offset,
                             "end_line": getattr(node, "end_lineno", node.lineno),
                             "args": [a.arg for a in node.args.args],
                             "async": isinstance(node, ast.AsyncFunctionDef)}
                    if k == "method":
                        p = parents.get(node)
                        if p is not None:
                            entry["class"] = getattr(p, "name", None)
        elif isinstance(node, ast.ClassDef):
            if kind in ("any", "class") and matcher(node.name):
                entry = {"kind": "class", "name": node.name,
                         "line": node.lineno, "col": node.col_offset,
                         "end_line": getattr(node, "end_lineno", node.lineno),
                         "bases": [_dump(b) for b in node.bases]}
        elif isinstance(node, (ast.Import, ast.ImportFrom)) and kind in ("any", "import"):
            mod = getattr(node, "module", None) if isinstance(node, ast.ImportFrom) else None
            for alias in node.names:
                nm = alias.asname or alias.name
                if matcher(nm) or (mod and matcher(mod)):
                    entry = {"kind": "import",
                             "name": nm, "module": mod,
                             "line": node.lineno, "col": node.col_offset}
                    out.append(entry)
            entry = None
        elif isinstance(node, ast.Call) and kind in ("any", "call"):
            nm = _callname(node.func)
            if nm and matcher(nm):
                entry = {"kind": "call", "name": nm,
                         "line": node.lineno, "col": node.col_offset,
                         "argc": len(node.args)}
        elif isinstance(node, ast.Assign) and kind in ("any", "assign"):
            for t in node.targets:
                if isinstance(t, ast.Name) and matcher(t.id):
                    out.append({"kind": "assign", "name": t.id,
                                "line": node.lineno, "col": node.col_offset})
            entry = None

        if entry is not None:
            out.append(entry)
    return out


def _callname(node) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _callname(node.value)
        return f"{base}.{node.attr}" if base else node.attr
    return ""


def _dump(node) -> str:
    try:
        return ast.unparse(node)
    except Exception:
        return node.__class__.__name__


# ── JS/TS structural regex ──────────────────────────────────────────────────

_JS_PATTERNS = {
    # function decl / export function / async function
    "function": [
        re.compile(r"(?m)^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\("),
        re.compile(r"(?m)^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\("),
        re.compile(r"(?m)^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?[\w_]*\s*=>"),
    ],
    "class": [
        re.compile(r"(?m)^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)"),
    ],
    "method": [
        re.compile(r"(?m)^\s*(?:public|private|protected|static|async|\*)?\s*"
                   r"([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{"),
    ],
    "import": [
        re.compile(r"(?m)^\s*import\s+(?:\{([^}]+)\}|(\w+)|\*\s+as\s+(\w+))\s+from\s+['\"]([^'\"]+)['\"]"),
        re.compile(r"(?m)^\s*(?:const|let|var)\s+(\w+)\s*=\s*require\(['\"]([^'\"]+)['\"]\)"),
    ],
    "call": [
        re.compile(r"(?<![\w.])(\w+(?:\.\w+)*)\s*\("),
    ],
    "assign": [
        re.compile(r"(?m)^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*="),
    ],
}


def _js_search(text: str, kind: str, matcher) -> list:
    out = []
    kinds = list(_JS_PATTERNS.keys()) if kind == "any" else [kind]
    for k in kinds:
        for pat in _JS_PATTERNS.get(k, []):
            for m in pat.finditer(text):
                if k == "import":
                    members = m.group(1)
                    default_imp = m.group(2) if m.lastindex and m.lastindex >= 2 else None
                    ns = m.group(3) if pat.groups >= 3 else None
                    src = m.group(pat.groups)
                    for nm in _import_names(members, default_imp, ns):
                        if matcher(nm) or (src and matcher(src)):
                            line, col = _pos(text, m.start())
                            out.append({"kind": "import", "name": nm,
                                        "module": src,
                                        "line": line, "col": col})
                    continue
                name = m.group(1)
                if not name or not matcher(name):
                    continue
                # For "method" pattern, filter out obvious language keywords
                if k == "method" and name in ("if", "for", "while", "switch",
                                              "catch", "function", "return",
                                              "typeof", "new"):
                    continue
                line, col = _pos(text, m.start(1))
                out.append({"kind": k, "name": name,
                            "line": line, "col": col})
    return out


def _import_names(members, default_imp, ns):
    names = []
    if default_imp: names.append(default_imp)
    if ns: names.append(ns)
    if members:
        for part in members.split(","):
            n = part.strip().split(" as ")[-1].strip()
            if n: names.append(n)
    return names


def _pos(text: str, idx: int) -> tuple[int, int]:
    prefix = text[:idx]
    line = prefix.count("\n") + 1
    last_nl = prefix.rfind("\n")
    col = idx - (last_nl + 1 if last_nl >= 0 else 0)
    return line, col


# ── File walk ───────────────────────────────────────────────────────────────

def _iter_files(root: Path, exts: set, include: list | None, exclude: list):
    for cur, dirs, files in os.walk(root):
        rel_cur = os.path.relpath(cur, root)
        dirs[:] = [d for d in dirs if not _match_any(
            os.path.join(rel_cur, d) if rel_cur != "." else d, exclude)]
        for fn in files:
            ext = os.path.splitext(fn)[1].lower()
            if exts and ext not in exts:
                continue
            rel = os.path.join(rel_cur, fn) if rel_cur != "." else fn
            if _match_any(rel, exclude):
                continue
            if include and not _match_any(rel, include):
                continue
            yield Path(cur) / fn


def _match_any(path: str, patterns: list) -> bool:
    path = path.replace("\\", "/")
    for pat in patterns:
        if fnmatch.fnmatch(path, pat) or fnmatch.fnmatch(
                os.path.basename(path), pat):
            return True
    return False


def _lang_for(p: Path) -> str:
    ext = p.suffix.lower()
    for lang, exts in LANG_EXT.items():
        if ext in exts:
            return lang
    return "unknown"


def _compile_matcher(name: str, regex: str):
    if regex:
        pat = re.compile(regex)
        return lambda s: bool(pat.search(s or ""))
    if name:
        if any(c in name for c in "*?[]"):
            return lambda s: fnmatch.fnmatchcase(s or "", name)
        return lambda s: (s or "") == name
    return lambda s: bool(s)


def _context(text: str, line: int, n: int) -> str:
    if n <= 0: return ""
    lines = text.splitlines()
    lo = max(0, line - 1 - n)
    hi = min(len(lines), line + n)
    return "\n".join(lines[lo:hi])


def _err(msg: str, start: float) -> dict:
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": "ast_search",
                         "duration_ms": int((time.time() - start) * 1000)}}
