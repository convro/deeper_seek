"""
fs_search.py — File-path and content search.

Modes:
  • glob     — shell glob matching (recursive via **)
  • content  — regex search across file contents (with context lines)
  • ast      — delegates to ast_search for structural code queries

Flags:
  mode:           "glob" | "content" | "ast"
  pattern:        pattern (glob / regex / symbol name)
  path:           directory root (default ".")
  case_sensitive: for content mode
  context:        N lines around match (default 0)
  max_results:    default 200 (glob) / 500 (content)
  include/exclude: extra file-glob filters (content + ast)
  kind:           only for ast mode — any|function|class|method|import|call|assign
  regex_name:     only for ast mode — Python regex for names
  languages:      only for ast mode — list of language codes
"""

from __future__ import annotations

import fnmatch
import glob
import os
import re
import time

DEFAULT_SKIP = {"node_modules", "__pycache__", ".git", "venv", ".venv",
                "dist", "build", ".next", ".turbo", ".pytest_cache",
                "coverage", ".mypy_cache", "vendor"}


def execute(pattern: str = "", path: str = ".", mode: str = "glob",
            case_sensitive: bool = False, context: int = 0,
            max_results: int = 200, include: list | None = None,
            exclude: list | None = None,
            kind: str = "any", regex_name: str = "",
            languages: list | None = None,
            **kwargs) -> dict:
    start = time.time()
    try:
        path = os.path.abspath(os.path.expanduser(path))
        if mode == "glob":
            results = _glob_search(pattern, path, max_results)
            cap = max_results
        elif mode == "content":
            results = _content_search(pattern, path, case_sensitive,
                                      context, include, exclude,
                                      max_results=max(max_results, 500))
            cap = max(max_results, 500)
        elif mode == "ast":
            return _ast_delegate(pattern, regex_name, kind, path,
                                 languages, include, exclude,
                                 max_results, context, start)
        else:
            return _err(f"Unknown mode: {mode}. Use glob|content|ast",
                        start)

        return {
            "status": "ok",
            "result": {
                "pattern": pattern, "path": path, "mode": mode,
                "count": len(results),
                "results": results[:cap],
                "truncated": len(results) >= cap,
            },
            "error": None,
            "metadata": {"tool": "fs_search", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), start)


# ── Glob ────────────────────────────────────────────────────────────────────

def _glob_search(pattern, root, cap):
    matches = []
    full = os.path.join(root, pattern) if not os.path.isabs(pattern) else pattern
    for m in glob.glob(full, recursive=True):
        matches.append({"path": m,
                        "type": "dir" if os.path.isdir(m) else "file"})
        if len(matches) >= cap * 2:
            break
    return matches


# ── Content ─────────────────────────────────────────────────────────────────

def _content_search(pattern, root, case_sensitive, ctx,
                    include, exclude, max_results):
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        regex = re.compile(pattern, flags)
    except re.error as e:
        raise ValueError(f"Invalid regex: {e}")

    matches = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames
                       if d not in DEFAULT_SKIP and not d.startswith(".")]
        for fname in filenames:
            fpath = os.path.join(dirpath, fname)
            rel = os.path.relpath(fpath, root)
            if include and not _any_fn(rel, include): continue
            if exclude and _any_fn(rel, exclude): continue
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    lines = f.readlines()
            except (PermissionError, OSError):
                continue
            for lineno, line in enumerate(lines, 1):
                if regex.search(line):
                    entry = {"path": fpath, "line": lineno,
                             "content": line.rstrip()}
                    if ctx > 0:
                        lo = max(0, lineno - 1 - ctx)
                        hi = min(len(lines), lineno + ctx)
                        entry["context"] = "".join(lines[lo:hi]).rstrip()
                    matches.append(entry)
                    if len(matches) >= max_results:
                        return matches
    return matches


def _any_fn(path, patterns):
    path = path.replace("\\", "/")
    return any(fnmatch.fnmatch(path, p) or
               fnmatch.fnmatch(os.path.basename(path), p) for p in patterns)


# ── AST delegate ────────────────────────────────────────────────────────────

def _ast_delegate(name, regex_name, kind, path, languages,
                  include, exclude, max_results, context, start):
    import importlib.util, sys
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, "..", ".."))
    target = os.path.join(root, "tools", "analysis", "ast_search.py")
    if not os.path.exists(target):
        return _err("ast_search not installed", start)
    spec = importlib.util.spec_from_file_location("_ast_search", target)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_ast_search"] = mod
    spec.loader.exec_module(mod)
    res = mod.execute(root=path, name=name or "", regex=regex_name or "",
                      kind=kind, languages=languages,
                      include=include, exclude=exclude,
                      max_results=max_results, context=context)
    if isinstance(res, dict):
        res.setdefault("metadata", {})["tool"] = "fs_search"
        res["metadata"]["mode"] = "ast"
        res["metadata"]["duration_ms"] = _ms(start)
    return res


def _err(msg, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": "fs_search", "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
