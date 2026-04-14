import os
import json
import time
import re

MEMORY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../memory"))


def _user_dir():
    """Return per-user memory directory (legacy root when no user)."""
    uid = os.environ.get("DEEPERSEEK_CURRENT_USER_ID")
    if uid:
        return os.path.join(MEMORY_ROOT, f"u_{uid}")
    return MEMORY_ROOT


def execute(query: str, top_k: int = 5, **kwargs) -> dict:
    """Simple TF-IDF-like keyword search across memory entries.
    Falls back to this when no vector DB is available.
    """
    start = time.time()
    try:
        all_entries = {}
        udir = _user_dir()
        for tier in ["short", "long"]:
            path = os.path.join(udir, f"{tier}_term.json")
            if os.path.exists(path):
                with open(path) as f:
                    data = json.load(f)
                for k, v in data.items():
                    all_entries[k] = {"key": k, "tier": tier, **v}

        if not all_entries:
            return {
                "status": "ok",
                "result": {"query": query, "results": [], "count": 0},
                "error": None,
                "metadata": {"tool": "memory_search", "duration_ms": _ms(start)},
            }

        query_terms = set(_tokenize(query))
        scored = []

        for key, entry in all_entries.items():
            text = f"{key} {entry.get('value', '')} {' '.join(entry.get('tags', []))}"
            entry_terms = set(_tokenize(text))
            overlap = len(query_terms & entry_terms)
            if overlap > 0:
                score = overlap / (len(query_terms) + 1)
                scored.append((score, key, entry))

        scored.sort(key=lambda x: x[0], reverse=True)
        results = [
            {
                "key": key,
                "value": entry.get("value"),
                "tags": entry.get("tags", []),
                "tier": entry.get("tier"),
                "score": round(score, 3),
            }
            for score, key, entry in scored[:top_k]
        ]

        return {
            "status": "ok",
            "result": {"query": query, "results": results, "count": len(results)},
            "error": None,
            "metadata": {"tool": "memory_search", "duration_ms": _ms(start)},
        }
    except Exception as e:
        return _err(str(e), "memory_search", start)


def _tokenize(text: str) -> list:
    text = text.lower()
    return re.findall(r"[a-z0-9]{2,}", text)


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
