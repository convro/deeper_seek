"""
memory_vector_search.py — Semantic search across stored memories.

Strategy (each layer is a fallback for the one above):
  1. `sentence-transformers` (all-MiniLM-L6-v2, lazy-installed) —
     real dense embeddings, cosine similarity. Cached per-entry under
     runtime/cache/memory_emb/.
  2. Hashed bag-of-n-grams with TF-IDF weighting — vocabulary-free,
     works without any ML deps, much better than raw token overlap.
  3. Last-ditch: token-overlap (the original behaviour).

All three paths combine with lexical keyword overlap for a final score,
so rare-but-exact keyword matches also surface.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from pathlib import Path

MEMORY_ROOT = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../memory")))
CACHE_DIR = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../runtime/cache/memory_emb")))
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _user_dir() -> Path:
    uid = os.environ.get("DEEPERSEEK_CURRENT_USER_ID")
    if uid:
        return MEMORY_ROOT / f"u_{uid}"
    return MEMORY_ROOT


def execute(query: str, top_k: int = 5, tier: str = "both",
            min_score: float = 0.05, **kwargs) -> dict:
    start = time.time()
    try:
        entries = _load_entries(tier)
        if not entries:
            return _ok({"query": query, "results": [], "count": 0,
                        "method": "none"}, "memory_search", start)

        method, ranked = _rank(query, entries)
        ranked = [r for r in ranked if r["score"] >= min_score][:top_k]

        return _ok({"query": query, "results": ranked, "count": len(ranked),
                    "method": method, "candidates": len(entries)},
                   "memory_search", start)
    except Exception as e:
        return _err(str(e), "memory_search", start)


# ── Entry loading ────────────────────────────────────────────────────────────

def _load_entries(tier: str) -> list:
    out = []
    udir = _user_dir()
    tiers = ["short", "long"] if tier == "both" else [tier]
    for t in tiers:
        p = udir / f"{t}_term.json"
        if not p.exists():
            continue
        try:
            data = json.loads(p.read_text())
        except Exception:
            continue
        for k, v in (data or {}).items():
            out.append({
                "key": k,
                "tier": t,
                "value": v.get("value", ""),
                "tags": v.get("tags", []),
                "timestamp": v.get("timestamp"),
            })
    return out


# ── Ranking entrypoint ───────────────────────────────────────────────────────

def _rank(query: str, entries: list) -> tuple[str, list]:
    texts = [_entry_text(e) for e in entries]
    try:
        return ("embeddings", _rank_embeddings(query, entries, texts))
    except Exception:
        pass
    try:
        return ("tfidf_hashed", _rank_hashed_tfidf(query, entries, texts))
    except Exception:
        pass
    return ("keyword_overlap", _rank_token_overlap(query, entries, texts))


def _entry_text(e: dict) -> str:
    return f"{e.get('key','')} {e.get('value','')} {' '.join(e.get('tags', []))}"


# ── Layer 1: sentence-transformers embeddings ────────────────────────────────

def _rank_embeddings(query: str, entries: list, texts: list) -> list:
    from sentence_transformers import SentenceTransformer  # type: ignore
    import numpy as np  # type: ignore

    model = _get_model()
    q_emb = model.encode([query], normalize_embeddings=True)[0]

    embs = []
    dirty_idx = []
    for i, (e, txt) in enumerate(zip(entries, texts)):
        cached = _load_emb_cache(e, txt)
        if cached is None:
            dirty_idx.append(i)
        embs.append(cached)

    if dirty_idx:
        new_embs = model.encode([texts[i] for i in dirty_idx],
                                normalize_embeddings=True)
        for pos, i in enumerate(dirty_idx):
            embs[i] = new_embs[pos]
            _save_emb_cache(entries[i], texts[i], new_embs[pos])

    embs = np.array(embs)
    sims = embs @ q_emb
    # Combine with lexical boost
    q_terms = set(_tokenize(query))
    out: list = []
    for i, e in enumerate(entries):
        e_terms = set(_tokenize(texts[i]))
        overlap = len(q_terms & e_terms) / max(len(q_terms) + 1, 1)
        score = 0.82 * float(sims[i]) + 0.18 * overlap
        out.append({**_proj(e), "score": round(score, 4),
                    "semantic_similarity": round(float(sims[i]), 4),
                    "keyword_overlap": round(overlap, 4)})
    out.sort(key=lambda x: x["score"], reverse=True)
    return out


_MODEL_CACHE = {}


def _get_model():
    if "m" in _MODEL_CACHE:
        return _MODEL_CACHE["m"]
    from sentence_transformers import SentenceTransformer  # type: ignore
    m = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    _MODEL_CACHE["m"] = m
    return m


def _emb_key(text: str) -> Path:
    h = hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]
    return CACHE_DIR / f"{h}.json"


def _load_emb_cache(entry: dict, text: str):
    p = _emb_key(text)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text())
        import numpy as np  # type: ignore
        return np.array(data["emb"], dtype=np.float32)
    except Exception:
        return None


def _save_emb_cache(entry: dict, text: str, emb):
    try:
        p = _emb_key(text)
        p.write_text(json.dumps({"emb": emb.tolist(),
                                 "key": entry.get("key")},
                                ensure_ascii=False))
    except Exception:
        pass


# ── Layer 2: hashed TF-IDF on character trigrams + tokens ────────────────────

def _rank_hashed_tfidf(query: str, entries: list, texts: list) -> list:
    D = len(entries)
    df = {}
    vecs = []
    q_vec = _hash_vec(query, df=df, count_df=False)
    for t in texts:
        v = _hash_vec(t, df=df, count_df=True)
        vecs.append(v)
    # IDF
    idf = {k: math.log((D + 1) / (v + 1)) + 1 for k, v in df.items()}
    # Dot products
    q_weighted = {k: v * idf.get(k, 1.0) for k, v in q_vec.items()}
    q_norm = math.sqrt(sum(x * x for x in q_weighted.values())) or 1.0

    out = []
    q_terms = set(_tokenize(query))
    for e, v, txt in zip(entries, vecs, texts):
        w = {k: val * idf.get(k, 1.0) for k, val in v.items()}
        norm = math.sqrt(sum(x * x for x in w.values())) or 1.0
        dot = sum(q_weighted.get(k, 0) * val for k, val in w.items())
        sim = dot / (q_norm * norm)
        e_terms = set(_tokenize(txt))
        overlap = len(q_terms & e_terms) / max(len(q_terms) + 1, 1)
        score = 0.75 * sim + 0.25 * overlap
        out.append({**_proj(e), "score": round(score, 4),
                    "tfidf_similarity": round(sim, 4),
                    "keyword_overlap": round(overlap, 4)})
    out.sort(key=lambda x: x["score"], reverse=True)
    return out


def _hash_vec(text: str, df: dict, count_df: bool, dim: int = 2048) -> dict:
    text = text.lower()
    tokens = re.findall(r"[\w]{2,}", text)
    # Character trigrams catch misspellings / languages without good tokenisation
    padded = f" {text} "
    trigrams = [padded[i:i + 3] for i in range(len(padded) - 2)]
    features = tokens + trigrams
    vec: dict[int, float] = {}
    seen_doc: set[int] = set()
    for f in features:
        idx = int(hashlib.md5(f.encode()).hexdigest()[:8], 16) % dim
        vec[idx] = vec.get(idx, 0) + 1
        if count_df:
            seen_doc.add(idx)
    if count_df:
        for idx in seen_doc:
            df[idx] = df.get(idx, 0) + 1
    return vec


# ── Layer 3: token overlap (legacy fallback) ─────────────────────────────────

def _rank_token_overlap(query: str, entries: list, texts: list) -> list:
    q_terms = set(_tokenize(query))
    out = []
    for e, t in zip(entries, texts):
        e_terms = set(_tokenize(t))
        overlap = len(q_terms & e_terms)
        score = overlap / (len(q_terms) + 1) if q_terms else 0
        out.append({**_proj(e), "score": round(score, 4)})
    out.sort(key=lambda x: x["score"], reverse=True)
    return out


def _tokenize(text: str) -> list:
    return re.findall(r"[a-z0-9\u00c0-\u017f]{2,}", (text or "").lower())


# ── Helpers ──────────────────────────────────────────────────────────────────

def _proj(e: dict) -> dict:
    return {"key": e["key"], "value": e.get("value"),
            "tags": e.get("tags", []), "tier": e.get("tier"),
            "timestamp": e.get("timestamp")}


def _ok(result, tool, start):
    return {"status": "ok", "result": result, "error": None,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _err(msg, tool, start):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
