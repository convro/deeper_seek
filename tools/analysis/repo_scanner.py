"""
repo_scanner.py — Produce a structural overview of a repository.

Reports:
  • Language breakdown (files + lines per language)
  • Top files by size / line count
  • Directory-level heatmap (size + file count)
  • Detected frameworks (package.json, requirements.txt, go.mod, pom.xml, etc.)
  • Entry points (main, index, app, server, cli)
  • Test coverage surface (test dirs and files)
  • Docs surface (README, docs/, *.md)
  • Dependency summary (direct deps from manifests)
  • Likely hot-paths (files imported/required most)
  • Git state (branch, remote, uncommitted, last commit) — best effort
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from collections import Counter, defaultdict
from pathlib import Path

IGNORE_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", ".tox",
    "dist", "build", ".next", ".nuxt", "target", ".cache", ".pytest_cache",
    ".mypy_cache", ".ruff_cache", ".idea", ".vscode", ".DS_Store",
    "coverage", ".nyc_output", "out", ".turbo",
}
BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
    ".mp3", ".mp4", ".mov", ".avi", ".zip", ".tar", ".gz", ".7z", ".rar",
    ".pdf", ".ttf", ".otf", ".woff", ".woff2", ".eot", ".pyc", ".so",
    ".dll", ".exe", ".class", ".jar", ".o", ".a",
}
LANG_EXT = {
    ".py": "Python", ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".jsx": "JSX", ".ts": "TypeScript", ".tsx": "TSX",
    ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
    ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".cpp": "C++",
    ".cc": "C++", ".hpp": "C++", ".c": "C", ".h": "C", ".m": "Objective-C",
    ".swift": "Swift", ".scala": "Scala", ".sh": "Shell", ".bash": "Shell",
    ".zsh": "Shell", ".fish": "Shell", ".ps1": "PowerShell",
    ".html": "HTML", ".htm": "HTML", ".css": "CSS", ".scss": "SCSS",
    ".sass": "Sass", ".less": "Less", ".json": "JSON", ".yaml": "YAML",
    ".yml": "YAML", ".toml": "TOML", ".xml": "XML", ".md": "Markdown",
    ".sql": "SQL", ".lua": "Lua", ".r": "R", ".dart": "Dart",
    ".elm": "Elm", ".ex": "Elixir", ".exs": "Elixir", ".erl": "Erlang",
    ".clj": "Clojure", ".cljs": "Clojure", ".hs": "Haskell",
    ".pl": "Perl", ".vim": "Vim script",
}

FRAMEWORK_MANIFESTS = {
    "package.json":      "Node.js",
    "pnpm-lock.yaml":    "pnpm",
    "yarn.lock":         "Yarn",
    "requirements.txt":  "Python (pip)",
    "pyproject.toml":    "Python (poetry/pep517)",
    "Pipfile":           "Python (pipenv)",
    "setup.py":          "Python (setuptools)",
    "go.mod":            "Go modules",
    "Cargo.toml":        "Rust (Cargo)",
    "pom.xml":           "Java (Maven)",
    "build.gradle":      "Gradle",
    "build.gradle.kts":  "Gradle (Kotlin)",
    "Gemfile":           "Ruby (Bundler)",
    "composer.json":     "PHP (Composer)",
    "mix.exs":           "Elixir (Mix)",
    "rebar.config":      "Erlang",
    "Dockerfile":        "Docker",
    "docker-compose.yml": "Docker Compose",
    "docker-compose.yaml": "Docker Compose",
    ".github/workflows": "GitHub Actions",
    "Makefile":          "Make",
    "Justfile":          "just",
    "CMakeLists.txt":    "CMake",
    "tsconfig.json":     "TypeScript",
    "tailwind.config.js": "Tailwind CSS",
    "tailwind.config.ts": "Tailwind CSS",
    "vite.config.js":    "Vite",
    "vite.config.ts":    "Vite",
    "next.config.js":    "Next.js",
    "next.config.mjs":   "Next.js",
    "svelte.config.js":  "SvelteKit",
    "astro.config.mjs":  "Astro",
    "nuxt.config.ts":    "Nuxt",
    "remix.config.js":   "Remix",
    "angular.json":      "Angular",
    "vue.config.js":     "Vue CLI",
    "jest.config.js":    "Jest",
    "vitest.config.ts":  "Vitest",
    "playwright.config.ts": "Playwright",
    "cypress.config.js": "Cypress",
}

ENTRY_FILENAMES = {
    "main.py", "app.py", "server.py", "manage.py", "cli.py", "run.py",
    "index.js", "index.ts", "main.js", "main.ts", "server.js", "server.ts",
    "app.js", "app.ts", "main.go", "cmd.go", "main.rs", "main.java",
    "Program.cs", "Main.scala", "Application.java",
}


def execute(path: str = ".", include_stats: bool = True,
            max_files_sample: int = 15, **kwargs) -> dict:
    start = time.time()
    try:
        root = Path(os.path.abspath(os.path.expanduser(path)))
        if not root.exists():
            return _err(f"Path does not exist: {root}", "repo_scanner", start)
        if root.is_file():
            return _err(f"Path is a file, not a directory: {root}",
                        "repo_scanner", start)

        lang_files: dict[str, int] = Counter()
        lang_lines: dict[str, int] = Counter()
        dir_sizes: dict[str, dict] = defaultdict(lambda: {"files": 0, "bytes": 0})
        file_info: list = []
        frameworks: list = []
        entry_points: list = []
        tests: list = []
        docs: list = []
        import_counts: dict[str, int] = Counter()
        total_files = 0
        total_bytes = 0

        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS]
            rel_dir = os.path.relpath(dirpath, root)

            for fn in filenames:
                full = os.path.join(dirpath, fn)
                ext = os.path.splitext(fn)[1].lower()
                try:
                    size = os.path.getsize(full)
                except OSError:
                    continue
                total_files += 1
                total_bytes += size
                dir_sizes[rel_dir]["files"] += 1
                dir_sizes[rel_dir]["bytes"] += size

                rel_path = os.path.relpath(full, root)
                is_binary = ext in BINARY_EXT

                # Framework detection
                if fn in FRAMEWORK_MANIFESTS:
                    frameworks.append({"manifest": rel_path,
                                       "framework": FRAMEWORK_MANIFESTS[fn]})
                # Entry points
                if fn in ENTRY_FILENAMES:
                    entry_points.append(rel_path)
                # Tests
                if "test" in fn.lower() or "/test" in rel_path.lower() or \
                        "/tests" in rel_path.lower() or "/__tests__" in rel_path:
                    tests.append(rel_path)
                # Docs
                if fn.lower() in ("readme.md", "readme.rst", "readme.txt") or \
                        ext == ".md" or "docs/" in rel_path:
                    docs.append(rel_path)

                if is_binary:
                    continue

                lang = LANG_EXT.get(ext, "Other" if ext else "Other")
                lang_files[lang] += 1

                if not include_stats:
                    continue

                lines = 0
                try:
                    with open(full, "r", encoding="utf-8", errors="ignore") as f:
                        for line in f:
                            lines += 1
                            # Quick import harvest for hot-path detection
                            if ext in (".py",):
                                m = re.match(r"\s*(?:from\s+([\w\.]+)|import\s+([\w\.]+))", line)
                                if m:
                                    imp = (m.group(1) or m.group(2)).split(".")[0]
                                    import_counts[imp] += 1
                            elif ext in (".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"):
                                m = re.match(r"""\s*(?:import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]|(?:const|let|var)\s+.*?=\s*require\(['"]([^'"]+)['"]\))""", line)
                                if m:
                                    imp = (m.group(1) or m.group(2)).split("/")[0]
                                    if not imp.startswith("."):
                                        import_counts[imp] += 1
                except (OSError, PermissionError):
                    continue

                lang_lines[lang] += lines
                file_info.append({"path": rel_path, "lang": lang,
                                  "bytes": size, "lines": lines})

        # Top files by lines
        file_info.sort(key=lambda f: f["lines"], reverse=True)
        top_files = file_info[:max_files_sample]

        # Directory heatmap — top dirs
        dir_items = sorted(dir_sizes.items(),
                           key=lambda kv: kv[1]["bytes"], reverse=True)[:20]
        heatmap = [{"dir": d, "files": v["files"], "bytes": v["bytes"]}
                   for d, v in dir_items]

        # Parse deps from manifests (best-effort)
        deps = _extract_dependencies(root, frameworks)

        # Git state
        git = _git_state(root)

        # Final summary
        lang_summary = sorted(
            [{"language": l, "files": lang_files[l], "lines": lang_lines[l]}
             for l in lang_files],
            key=lambda x: x["lines"], reverse=True,
        )

        # Deduplicate frameworks
        seen_fw = set()
        uniq_fw = []
        for f in frameworks:
            k = f["framework"]
            if k in seen_fw:
                continue
            seen_fw.add(k)
            uniq_fw.append(f)

        return {
            "status": "ok",
            "result": {
                "root": str(root),
                "total_files": total_files,
                "total_bytes": total_bytes,
                "total_size_mb": round(total_bytes / 1024 / 1024, 2),
                "languages": lang_summary,
                "primary_language": lang_summary[0]["language"] if lang_summary else None,
                "frameworks": uniq_fw,
                "entry_points": entry_points[:20],
                "test_files": len(tests),
                "tests_sample": tests[:10],
                "doc_files": len(docs),
                "docs_sample": docs[:10],
                "top_files_by_lines": top_files,
                "directory_heatmap": heatmap,
                "top_imports": import_counts.most_common(25),
                "dependencies": deps,
                "git": git,
            },
            "error": None,
            "metadata": {"tool": "repo_scanner", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "repo_scanner", start)


def _extract_dependencies(root: Path, frameworks: list) -> dict:
    deps: dict[str, list] = {}
    # package.json
    pkg = root / "package.json"
    if pkg.exists():
        try:
            data = json.loads(pkg.read_text())
            ds = list((data.get("dependencies") or {}).keys())
            dev = list((data.get("devDependencies") or {}).keys())
            deps["npm"] = {"dependencies": ds[:40], "devDependencies": dev[:40],
                           "dep_count": len(ds), "dev_count": len(dev)}
        except Exception:
            pass
    # requirements.txt
    req = root / "requirements.txt"
    if req.exists():
        try:
            lines = [ln.strip() for ln in req.read_text().splitlines()
                     if ln.strip() and not ln.startswith("#")]
            names = [re.split(r"[<>=!~ ]", ln, 1)[0] for ln in lines]
            deps["pip"] = {"packages": names[:60], "count": len(names)}
        except Exception:
            pass
    # pyproject.toml
    pyp = root / "pyproject.toml"
    if pyp.exists():
        try:
            txt = pyp.read_text()
            pkgs = re.findall(r'^\s*"([A-Za-z0-9_\-\[\]]+)"', txt, re.MULTILINE)
            deps["pyproject"] = {"packages": list(dict.fromkeys(pkgs))[:60]}
        except Exception:
            pass
    # Cargo.toml
    cargo = root / "Cargo.toml"
    if cargo.exists():
        try:
            txt = cargo.read_text()
            pkgs = re.findall(r'^\s*([A-Za-z0-9_\-]+)\s*=', txt, re.MULTILINE)
            deps["cargo"] = {"packages": pkgs[:60]}
        except Exception:
            pass
    # go.mod
    gomod = root / "go.mod"
    if gomod.exists():
        try:
            txt = gomod.read_text()
            pkgs = re.findall(r"^\s*([\w\.\-/]+)\s+v[\d]", txt, re.MULTILINE)
            deps["gomod"] = {"packages": pkgs[:60]}
        except Exception:
            pass
    return deps


def _git_state(root: Path) -> dict:
    if not (root / ".git").exists():
        return {"is_git": False}
    out = {"is_git": True}

    def _run(args: list) -> str:
        try:
            r = subprocess.run(["git"] + args, cwd=str(root),
                               capture_output=True, text=True, timeout=5)
            return (r.stdout or "").strip()
        except Exception:
            return ""

    out["branch"] = _run(["rev-parse", "--abbrev-ref", "HEAD"])
    out["remote"] = _run(["config", "--get", "remote.origin.url"])
    out["last_commit"] = _run(["log", "-1", "--pretty=%h %s"])
    out["uncommitted"] = bool(_run(["status", "--porcelain"]))
    out["ahead_behind"] = _run(["rev-list", "--left-right", "--count", "@{u}...HEAD"]) or None
    return out


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
