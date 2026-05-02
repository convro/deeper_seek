"""
task_split.py — Decompose a complex task into ordered subtasks with dependencies.

Heuristic decomposition (no LLM round-trip). Recognises common task shapes
(research, build, analyse, fix, migrate, compare, document) and emits a
structured plan that the orchestrator can execute.

Returns:
  subtasks:  list of {id, title, description, tool_hint, deps, parallel_group}
  parallel_groups: sets of IDs that may run concurrently
  critical_path:   ordered IDs along the longest dependency chain
"""

from __future__ import annotations

import re
import time
from typing import Optional


def execute(task: str, max_subtasks: int = 10,
            context: str = "", **kwargs) -> dict:
    start = time.time()
    try:
        shape = _classify(task)
        plan = _compose(task, shape, max_subtasks=max_subtasks, context=context)
        subs = plan["subtasks"]
        groups = _parallel_groups(subs)
        critical = _critical_path(subs)
        return {
            "status": "ok",
            "result": {
                "task": task,
                "shape": shape,
                "complexity": plan["complexity"],
                "subtasks": subs,
                "parallel_groups": groups,
                "critical_path": critical,
                "total": len(subs),
                "notes": plan.get("notes", []),
            },
            "error": None,
            "metadata": {"tool": "task_split", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "task_split", start)


# ── Shape classifier ─────────────────────────────────────────────────────────

SHAPE_CUES = {
    "research":   ["research", "find out", "investigate", "survey", "compare",
                   "analyse", "analyze", "dossier", "summarize sources"],
    "build":      ["build", "create", "implement", "develop", "write", "make",
                   "generate", "construct", "scaffold"],
    "fix":        ["fix", "debug", "resolve", "repair", "patch", "error",
                   "bug", "crash", "failing", "not working"],
    "refactor":   ["refactor", "clean up", "restructure", "modernize",
                   "extract", "split", "rename", "reorganize"],
    "migrate":    ["migrate", "port", "upgrade", "switch to", "replace",
                   "move from"],
    "analyze":    ["analyze", "analyse", "audit", "review", "inspect",
                   "profile", "benchmark", "measure"],
    "document":   ["document", "readme", "api docs", "write docs",
                   "comment", "explain", "annotate"],
    "media":      ["images", "photos", "video", "audio", "pictures", "gallery",
                   "illustrations", "screenshots"],
    "data":       ["csv", "excel", "sqlite", "dataset", "parquet", "clean data",
                   "transform data", "etl"],
    "deploy":     ["deploy", "ship", "release", "publish", "push to prod"],
}


def _classify(task: str) -> str:
    t = task.lower()
    scores = {k: 0 for k in SHAPE_CUES}
    for shape, cues in SHAPE_CUES.items():
        for c in cues:
            if c in t:
                scores[shape] += 2 if " " in c else 1
    best = max(scores.items(), key=lambda x: x[1])
    return best[0] if best[1] > 0 else "generic"


# ── Composer ─────────────────────────────────────────────────────────────────

def _compose(task: str, shape: str, max_subtasks: int, context: str) -> dict:
    tpl = TEMPLATES.get(shape, TEMPLATES["generic"])
    subs: list = []
    for i, step in enumerate(tpl["steps"][:max_subtasks], 1):
        subs.append({
            "id": f"s{i}",
            "title": step["title"],
            "description": step["desc"].format(task=task, context=context or ""),
            "tool_hint": step.get("tool", ""),
            "deps": [f"s{d}" for d in step.get("deps", [])],
            "parallel_group": step.get("group", 0),
            "estimated_complexity": step.get("complexity", "medium"),
        })
    return {
        "subtasks": subs,
        "complexity": tpl.get("complexity", "medium"),
        "notes": tpl.get("notes", []),
    }


TEMPLATES = {
    "research": {
        "complexity": "medium",
        "steps": [
            {"title": "Define sub-questions",
             "desc": "Identify 3-5 specific angles for: {task}",
             "tool": "memory_store"},
            {"title": "Parallel multi-source research",
             "desc": "Run web_research(topic, depth=3) to gather a dossier on: {task}",
             "tool": "web_research", "deps": [1]},
            {"title": "Deep-dive on top sources",
             "desc": "For the 2-3 most authoritative sources, fetch full content with web_fetch(format='full') or web_browse if JS-heavy",
             "tool": "web_fetch", "deps": [2]},
            {"title": "Cross-reference and fact-check",
             "desc": "Verify conflicting claims across sources. Note disagreements and confidence.",
             "deps": [3]},
            {"title": "Synthesize final answer",
             "desc": "Produce a structured answer with citations. Store key facts in memory for later reuse.",
             "tool": "memory_store", "deps": [4]},
        ],
    },
    "build": {
        "complexity": "high",
        "steps": [
            {"title": "Create workspace",
             "desc": "Initialize a workspace for: {task}",
             "tool": "workspace_create"},
            {"title": "Outline architecture",
             "desc": "List files to create, their responsibilities and interdependencies. For UI: HTML/CSS/JS layout. For backend: entry point, routes, services, storage.",
             "deps": [1]},
            {"title": "Research required APIs/libs",
             "desc": "Look up API docs and best practices for any third-party components",
             "tool": "web_research", "deps": [2], "group": 1},
            {"title": "Source media assets (if needed)",
             "desc": "Search and download any images/media the project requires",
             "tool": "image_search", "deps": [2], "group": 1},
            {"title": "Write core files",
             "desc": "Create each file with full implementation. Batch sibling files in parallel fs_write calls.",
             "tool": "fs_write", "deps": [3, 4]},
            {"title": "Run & verify",
             "desc": "Execute the project (run_python / run_bash / preview HTML) and fix any runtime errors",
             "tool": "run_python", "deps": [5]},
            {"title": "Polish and finalize",
             "desc": "Tighten edges, add error handling at boundaries, write a brief README",
             "tool": "fs_write", "deps": [6]},
        ],
    },
    "fix": {
        "complexity": "medium",
        "steps": [
            {"title": "Reproduce the bug",
             "desc": "Reproduce: {task}. Capture exact error / symptom.",
             "tool": "run_bash"},
            {"title": "Locate relevant code",
             "desc": "Use fs_search (content + AST mode) to find the symbol / call site",
             "tool": "fs_search", "deps": [1]},
            {"title": "Read and reason",
             "desc": "Read the full context around the bug site; identify root cause (not just symptom)",
             "tool": "fs_read", "deps": [2]},
            {"title": "Apply minimal fix",
             "desc": "Make the smallest correct change. Avoid incidental refactoring.",
             "tool": "fs_write", "deps": [3]},
            {"title": "Re-run & verify",
             "desc": "Reproduce steps; confirm the bug is gone and no regression",
             "tool": "run_bash", "deps": [4]},
        ],
    },
    "refactor": {
        "complexity": "medium",
        "steps": [
            {"title": "Scan structure",
             "desc": "repo_scanner to understand the codebase layout",
             "tool": "repo_scanner"},
            {"title": "Identify change scope",
             "desc": "ast_search + code_analyzer to pin down every call site / dependency",
             "tool": "ast_search", "deps": [1]},
            {"title": "Plan the refactor",
             "desc": "Ordered list of edits; identify risk points",
             "deps": [2]},
            {"title": "Apply changes",
             "desc": "Sequential edits with fs_write patch mode",
             "tool": "fs_write", "deps": [3]},
            {"title": "Run tests / type-check",
             "desc": "Full verification pass",
             "tool": "run_bash", "deps": [4]},
        ],
    },
    "analyze": {
        "complexity": "medium",
        "steps": [
            {"title": "Scan target",
             "desc": "repo_scanner / code_analyzer to get the lay of the land",
             "tool": "repo_scanner"},
            {"title": "Drill into hotspots",
             "desc": "ast_search + fs_read on the top complexity / hot-path files",
             "tool": "ast_search", "deps": [1]},
            {"title": "Quantify",
             "desc": "Run benchmarks or compute metrics as needed",
             "tool": "run_python", "deps": [2]},
            {"title": "Report",
             "desc": "Write structured findings to workspace/output/analysis.md",
             "tool": "fs_write", "deps": [3]},
        ],
    },
    "media": {
        "complexity": "low",
        "steps": [
            {"title": "Gather imagery",
             "desc": "image_search with avoid_stock=true for: {task}",
             "tool": "image_search"},
            {"title": "Curate & edit",
             "desc": "image_edit to resize / crop / normalize as needed",
             "tool": "image_edit", "deps": [1]},
            {"title": "Place into project",
             "desc": "Wire the files into the final project / report",
             "tool": "fs_write", "deps": [2]},
        ],
    },
    "data": {
        "complexity": "medium",
        "steps": [
            {"title": "Inspect dataset",
             "desc": "data_query to preview schema + head rows",
             "tool": "data_query"},
            {"title": "Transform / clean",
             "desc": "python_repl with pandas (persistent state across steps)",
             "tool": "python_repl", "deps": [1]},
            {"title": "Visualize",
             "desc": "chart tool for key summaries",
             "tool": "chart", "deps": [2]},
            {"title": "Export",
             "desc": "Save cleaned data + charts + a short report",
             "tool": "fs_write", "deps": [3]},
        ],
    },
    "document": {
        "complexity": "low",
        "steps": [
            {"title": "Read existing code / artifact",
             "desc": "fs_tree + fs_read to understand what we're documenting",
             "tool": "fs_tree"},
            {"title": "Draft docs",
             "desc": "Write structured markdown with examples",
             "tool": "fs_write", "deps": [1]},
            {"title": "Render to PDF (optional)",
             "desc": "pdf_generate if a printable deliverable is needed",
             "tool": "pdf_generate", "deps": [2]},
        ],
    },
    "migrate": {
        "complexity": "high",
        "steps": [
            {"title": "Research target",
             "desc": "web_research the target framework / version / API surface",
             "tool": "web_research"},
            {"title": "Scan current code",
             "desc": "repo_scanner + ast_search to find all usage sites",
             "tool": "ast_search", "deps": [1]},
            {"title": "Write migration script / patches",
             "desc": "Automate wherever possible",
             "tool": "fs_write", "deps": [2]},
            {"title": "Run migration",
             "desc": "Apply changes, verify each subsystem",
             "tool": "run_bash", "deps": [3]},
            {"title": "Full regression run",
             "desc": "Tests, typecheck, smoke end-to-end",
             "tool": "run_bash", "deps": [4]},
        ],
    },
    "deploy": {
        "complexity": "medium",
        "steps": [
            {"title": "Pre-flight checks",
             "desc": "Tests, lint, build. No failing checks → block deploy.",
             "tool": "run_bash"},
            {"title": "Bump version & commit",
             "desc": "git_ops tag / commit / push",
             "tool": "git_ops", "deps": [1]},
            {"title": "Trigger deployment",
             "desc": "Run deployment command or open a PR via github",
             "tool": "github_ops", "deps": [2]},
            {"title": "Smoke test live",
             "desc": "http_request / web_fetch to the deployed URL",
             "tool": "http_request", "deps": [3]},
        ],
    },
    "generic": {
        "complexity": "medium",
        "steps": [
            {"title": "Understand",
             "desc": "Parse the request, identify concrete deliverable for: {task}"},
            {"title": "Gather context",
             "desc": "fs_tree / web_search / memory_get as needed",
             "deps": [1]},
            {"title": "Execute",
             "desc": "Do the work — code, files, research, whatever the task requires",
             "deps": [2]},
            {"title": "Verify & deliver",
             "desc": "Check the output, then present to the user",
             "deps": [3]},
        ],
    },
}


# ── Parallel groups + critical path ──────────────────────────────────────────

def _parallel_groups(subs: list) -> list:
    groups: dict[int, list] = {}
    for s in subs:
        g = s.get("parallel_group", 0)
        if g:
            groups.setdefault(g, []).append(s["id"])
    return [sorted(ids) for _, ids in sorted(groups.items()) if len(ids) > 1]


def _critical_path(subs: list) -> list:
    by_id = {s["id"]: s for s in subs}
    depth: dict[str, int] = {}

    def d(sid: str) -> int:
        if sid in depth:
            return depth[sid]
        deps = by_id.get(sid, {}).get("deps", [])
        depth[sid] = 1 + max((d(x) for x in deps), default=0)
        return depth[sid]

    for s in subs:
        d(s["id"])
    # Reconstruct one longest chain
    end = max(subs, key=lambda s: depth[s["id"]])["id"]
    chain = [end]
    while by_id[chain[-1]].get("deps"):
        parents = by_id[chain[-1]]["deps"]
        chain.append(max(parents, key=lambda p: depth.get(p, 0)))
    return list(reversed(chain))


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
