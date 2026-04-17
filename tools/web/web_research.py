"""
web_research.py — End-to-end web research pipeline.

Pipeline:
  1. Expand the topic into multiple sub-queries (caller-provided or auto).
  2. Run web_search across engines in parallel.
  3. Dedup + rank URLs by engine agreement and domain quality.
  4. Fetch top-N pages in parallel (httpx async, or thread pool fallback).
  5. Extract main content (trafilatura), metadata, JSON-LD.
  6. Score & filter pages; keep the most substantive ones.
  7. Return a structured dossier: sources + summaries + fact snippets.

This is the tool to reach for when you need a real answer to a research
question rather than a list of blue links.
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Optional
from urllib.parse import urlparse

from tools.web._common import (
    fetch_many, normalize_url, domain_of, dedup_by_domain,
)
from tools.web._extract import (
    extract_main, extract_metadata, extract_jsonld, summarize_jsonld,
)
from tools.web import web_search as ws_mod


# ── Quality heuristics ───────────────────────────────────────────────────────

LOW_VALUE_HOSTS = (
    "pinterest.com", "quora.com", "reddit.com/r/all", "tiktok.com",
    "facebook.com", "instagram.com", "x.com/i/flow", "twitter.com/i/flow",
    "youtube.com/results", "yahoo.com/search",
)
HIGH_VALUE_HOSTS = (
    "wikipedia.org", "arxiv.org", "nature.com", "sciencedirect.com",
    "nih.gov", "who.int", "cdc.gov", "nasa.gov", "noaa.gov", "europa.eu",
    "un.org", "oecd.org", "stackoverflow.com", "stackexchange.com",
    "github.com", "docs.python.org", "developer.mozilla.org",
    "archive.org", "wsj.com", "nytimes.com", "ft.com", "bbc.co.uk",
    "reuters.com", "apnews.com", "economist.com", "npr.org",
    "theguardian.com", "bloomberg.com",
)


def execute(topic: str, depth: int = 3, pages_per_query: int = 5,
            max_pages: int = 8, subqueries: Optional[list] = None,
            site: str = "", exclude_site: str = "", filetype: str = "",
            before: str = "", after: str = "",
            lang: str = "en", include_markdown: bool = False,
            **kwargs) -> dict:
    """
    End-to-end research. Returns a dossier.

    Args:
      topic:           The research question / topic.
      depth:           1 (shallow: 1 query) | 2 (multi-angle: 3 queries)
                       | 3 (thorough: 5 queries).
      pages_per_query: Search results to consider per query.
      max_pages:       Pages to actually fetch & extract.
      subqueries:      Optional caller-specified sub-queries (overrides depth).
      site/exclude_site/filetype/before/after: dork args applied to all queries.
      lang:            Preferred language filter.
    """
    start = time.time()
    queries = list(subqueries) if subqueries else _expand_queries(topic, depth)

    # 1) Multi-query parallel search
    all_hits: list = []
    search_errors: list = []
    for q in queries:
        try:
            r = ws_mod.execute(q, num_results=pages_per_query, engine="auto",
                               site=site, exclude_site=exclude_site,
                               filetype=filetype, before=before, after=after,
                               lang=lang)
            if r.get("status") == "ok":
                for item in r["result"]["results"]:
                    item["_query"] = q
                    all_hits.append(item)
            else:
                search_errors.append(f"{q}: {r.get('error')}")
        except Exception as e:
            search_errors.append(f"{q}: {e}")

    if not all_hits:
        return _err(f"No search hits. Errors: {'; '.join(search_errors[:3])}",
                    "web_research", start, topic=topic)

    # 2) Rank + dedup candidate URLs
    candidates = _rank_urls(all_hits)
    fetch_urls = [c["url"] for c in dedup_by_domain(
        [c["url"] for c in candidates], per_domain=2
    )[:max_pages]]
    fetch_urls = list(dict.fromkeys(fetch_urls))[:max_pages]

    if not fetch_urls:
        return _err("No URLs survived ranking.", "web_research", start, topic=topic)

    # 3) Parallel fetch
    try:
        fetch_results = asyncio.run(fetch_many(fetch_urls, concurrency=8, timeout=20))
    except RuntimeError:
        # Already in event loop — fall back sequentially
        from tools.web._common import fetch_sync
        fetch_results = [fetch_sync(u, timeout=20) for u in fetch_urls]

    # 4) Extract each page
    sources: list = []
    for fr, url in zip(fetch_results, fetch_urls):
        if not fr.ok or not fr.text:
            continue
        main = extract_main(fr.text, url=fr.final_url or url)
        meta = extract_metadata(fr.text)
        jsonld = extract_jsonld(fr.text)
        text = main.get("text", "") or ""
        if len(text) < 400:
            continue
        source = {
            "url": fr.final_url or url,
            "title": main.get("title") or meta.get("title") or "",
            "description": meta.get("description", ""),
            "site_name": meta.get("site_name", ""),
            "author": meta.get("author", ""),
            "published": meta.get("published", ""),
            "lang": main.get("language") or meta.get("lang", ""),
            "hero_image": meta.get("image", ""),
            "word_count": len(text.split()),
            "domain": domain_of(fr.final_url or url),
            "snippet": _first_n_words(text, 120),
            "excerpt": text[:4000],
            "jsonld_summary": summarize_jsonld(jsonld),
            "query": next((h["_query"] for h in all_hits
                           if normalize_url(h["url"]) == normalize_url(url)), ""),
            "score": 0,
        }
        source["score"] = _score_source(source)
        if include_markdown:
            source["markdown"] = main.get("markdown", "")[:8000]
        sources.append(source)

    sources.sort(key=lambda s: s["score"], reverse=True)

    # 5) Build dossier
    bullets = _bulletize(sources, max_bullets=12)
    key_facts = _extract_key_sentences(sources, topic, max_facts=15)
    domains = sorted({s["domain"] for s in sources})

    return {
        "status": "ok",
        "result": {
            "topic": topic,
            "queries": queries,
            "sources_considered": len(all_hits),
            "sources_fetched": len(sources),
            "domains": domains,
            "sources": sources,
            "key_points": bullets,
            "key_facts": key_facts,
            "search_errors": search_errors[:3] if search_errors else None,
        },
        "error": None,
        "metadata": {"tool": "web_research", "duration_ms": _ms(start)},
    }


# ── Query expansion ──────────────────────────────────────────────────────────

def _expand_queries(topic: str, depth: int) -> list:
    topic = topic.strip()
    if depth <= 1:
        return [topic]
    variants = [
        topic,
        f"{topic} overview",
        f"{topic} explained",
        f"{topic} 2025",
        f"{topic} latest news",
        f"{topic} research paper",
        f"{topic} statistics data",
        f'"{topic}" analysis',
    ]
    if depth == 2:
        return variants[:3]
    return variants[:5]


# ── URL ranking ──────────────────────────────────────────────────────────────

def _rank_urls(hits: list) -> list:
    bucket: dict = {}
    for h in hits:
        u = normalize_url(h.get("url", ""))
        if not u:
            continue
        d = domain_of(u)
        if any(bad in d for bad in LOW_VALUE_HOSTS):
            continue
        b = bucket.setdefault(u, {"url": u, "domain": d, "titles": set(),
                                  "snippets": [], "engines": set(),
                                  "queries": set()})
        if h.get("title"):
            b["titles"].add(h["title"])
        if h.get("snippet"):
            b["snippets"].append(h["snippet"])
        for eng in (h.get("engines") or [h.get("engine")]):
            if eng:
                b["engines"].add(eng)
        b["queries"].add(h.get("_query", ""))

    out = list(bucket.values())
    for b in out:
        score = 0
        score += len(b["engines"]) * 10
        score += len(b["queries"]) * 5
        if any(h in b["domain"] for h in HIGH_VALUE_HOSTS):
            score += 25
        if b["snippets"]:
            score += min(10, int(sum(len(s) for s in b["snippets"]) / 300))
        b["_score"] = score

    out.sort(key=lambda b: b["_score"], reverse=True)
    return out


# ── Source scoring ───────────────────────────────────────────────────────────

def _score_source(s: dict) -> int:
    score = 0
    wc = s.get("word_count", 0)
    score += min(40, wc // 50)
    if any(h in s["domain"] for h in HIGH_VALUE_HOSTS):
        score += 25
    if s.get("published"):
        score += 5
    if s.get("author"):
        score += 3
    if s.get("jsonld_summary"):
        score += 5
    return score


# ── Bulletize + key facts ────────────────────────────────────────────────────

def _bulletize(sources: list, max_bullets: int = 10) -> list:
    out: list = []
    for s in sources[:max_bullets]:
        title = s.get("title") or s.get("domain")
        dom = s.get("domain", "")
        desc = s.get("description") or s.get("snippet") or ""
        bullet = f"• {title} ({dom}) — {desc[:220]}"
        out.append(bullet)
    return out


def _extract_key_sentences(sources: list, topic: str, max_facts: int = 12) -> list:
    """Pick sentences from excerpts that contain topic terms + numbers/dates."""
    terms = [t.lower() for t in re.findall(r"\w+", topic) if len(t) > 3]
    scored: list = []
    for s in sources:
        for sent in _split_sentences(s.get("excerpt", "")):
            low = sent.lower()
            if len(sent) < 40 or len(sent) > 400:
                continue
            hits = sum(1 for t in terms if t in low)
            if hits == 0:
                continue
            score = hits * 5
            if re.search(r"\b\d{2,}(?:\.\d+)?%?\b", sent):
                score += 4
            if re.search(r"\b(19|20)\d{2}\b", sent):
                score += 3
            scored.append((score, sent, s.get("url")))
    scored.sort(key=lambda x: x[0], reverse=True)
    seen: set = set()
    out: list = []
    for sc, sent, url in scored:
        key = sent[:80].lower()
        if key in seen:
            continue
        seen.add(key)
        out.append({"fact": sent.strip(), "source": url})
        if len(out) >= max_facts:
            break
    return out


def _split_sentences(text: str) -> list:
    return re.split(r"(?<=[.!?])\s+", text)


def _first_n_words(text: str, n: int) -> str:
    words = text.split()
    return " ".join(words[:n]) + ("…" if len(words) > n else "")


# ── Err / misc ───────────────────────────────────────────────────────────────

def _err(msg, tool, start, topic=""):
    return {"status": "error", "result": {"topic": topic} if topic else None,
            "error": msg,
            "metadata": {"tool": tool, "duration_ms": _ms(start)}}


def _ms(start):
    return int((time.time() - start) * 1000)
