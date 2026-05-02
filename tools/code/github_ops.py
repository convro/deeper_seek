"""
github_ops.py — GitHub REST v3 API client for PRs, issues, repos, files.

Works without a token (public, rate-limited 60/hr) or with a token from
GITHUB_TOKEN env (authenticated, 5000/hr, write access).

Operations (pass as `op`):
  • repo_get, repo_search, user_get
  • list_issues, get_issue, create_issue, comment_issue, close_issue
  • list_prs, get_pr, create_pr, merge_pr, review_pr
  • get_file, list_dir, list_commits, get_commit
  • list_branches, list_tags, list_releases, get_release
  • workflow_runs, rate_limit

All responses are normalized to flat dicts with commonly needed fields.
"""

from __future__ import annotations

import base64
import os
import time
from urllib.parse import quote


API = "https://api.github.com"
DEFAULT_TIMEOUT = 30
MAX_BODY = 200_000


def execute(op: str, token: str | None = None, timeout: int = DEFAULT_TIMEOUT,
            **kwargs) -> dict:
    start = time.time()
    op = (op or "").lower().strip()
    if op not in _DISPATCH:
        return _err(f"unknown op '{op}'. Allowed: {sorted(_DISPATCH.keys())}",
                    start, op)
    try:
        import httpx  # type: ignore
    except ImportError:
        return _err("httpx required for github_ops", start, op)

    tok = token or os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "DeeperSeek/1.0",
    }
    if tok:
        headers["Authorization"] = f"Bearer {tok}"

    try:
        result = _DISPATCH[op](headers=headers, timeout=timeout,
                               authed=bool(tok), **kwargs)
    except _HTTPError as e:
        return _err(str(e), start, op,
                    status_code=getattr(e, "status_code", None))
    except KeyError as e:
        return _err(f"missing required arg: {e}", start, op)
    except Exception as e:
        return _err(f"{type(e).__name__}: {e}", start, op)

    return _ok(result, start, op, authed=bool(tok))


# ── HTTP primitives ─────────────────────────────────────────────────────────

class _HTTPError(Exception):
    def __init__(self, msg, status_code=None):
        super().__init__(msg)
        self.status_code = status_code


def _request(method: str, path: str, headers: dict, timeout: int,
             json_body: dict | None = None,
             params: dict | None = None) -> dict | list:
    import httpx  # type: ignore
    url = path if path.startswith("http") else f"{API}{path}"
    with httpx.Client(timeout=timeout, follow_redirects=True) as c:
        r = c.request(method, url, headers=headers,
                      json=json_body, params=params)
    if r.status_code >= 400:
        try:
            detail = r.json().get("message", r.text[:400])
        except Exception:
            detail = r.text[:400]
        raise _HTTPError(f"GitHub {r.status_code}: {detail}",
                         status_code=r.status_code)
    if not r.content:
        return {}
    try:
        return r.json()
    except Exception:
        return {"_raw": r.text[:MAX_BODY]}


def _paginate(path: str, headers: dict, timeout: int, params: dict | None,
              max_pages: int = 5) -> list:
    params = dict(params or {})
    params.setdefault("per_page", 100)
    out = []
    page = 1
    while page <= max_pages:
        params["page"] = page
        chunk = _request("GET", path, headers, timeout, params=params)
        if not isinstance(chunk, list) or not chunk:
            break
        out.extend(chunk)
        if len(chunk) < params["per_page"]:
            break
        page += 1
    return out


# ── Ops: repos / users ──────────────────────────────────────────────────────

def _op_repo_get(headers, timeout, owner, repo, **_):
    data = _request("GET", f"/repos/{owner}/{repo}", headers, timeout)
    return {
        "full_name": data.get("full_name"),
        "description": data.get("description"),
        "stars": data.get("stargazers_count"),
        "forks": data.get("forks_count"),
        "watchers": data.get("subscribers_count"),
        "open_issues": data.get("open_issues_count"),
        "default_branch": data.get("default_branch"),
        "language": data.get("language"),
        "topics": data.get("topics", []),
        "license": (data.get("license") or {}).get("spdx_id"),
        "url": data.get("html_url"),
        "clone_url": data.get("clone_url"),
        "pushed_at": data.get("pushed_at"),
        "archived": data.get("archived"),
        "private": data.get("private"),
    }


def _op_repo_search(headers, timeout, query, sort: str = "stars",
                    order: str = "desc", per_page: int = 20, **_):
    data = _request("GET", "/search/repositories", headers, timeout,
                    params={"q": query, "sort": sort, "order": order,
                            "per_page": min(100, per_page)})
    items = [{"full_name": r["full_name"], "description": r.get("description"),
              "stars": r["stargazers_count"], "language": r.get("language"),
              "url": r["html_url"], "pushed_at": r.get("pushed_at")}
             for r in data.get("items", [])]
    return {"total": data.get("total_count", 0), "items": items}


def _op_user_get(headers, timeout, username, **_):
    data = _request("GET", f"/users/{username}", headers, timeout)
    return {"login": data.get("login"), "name": data.get("name"),
            "bio": data.get("bio"), "company": data.get("company"),
            "location": data.get("location"), "blog": data.get("blog"),
            "public_repos": data.get("public_repos"),
            "followers": data.get("followers"),
            "following": data.get("following"),
            "url": data.get("html_url")}


# ── Ops: issues ─────────────────────────────────────────────────────────────

def _op_list_issues(headers, timeout, owner, repo, state: str = "open",
                    labels: str | None = None, limit: int = 30, **_):
    params = {"state": state, "per_page": min(100, limit)}
    if labels: params["labels"] = labels
    data = _paginate(f"/repos/{owner}/{repo}/issues", headers, timeout,
                     params=params, max_pages=1)
    issues = [i for i in data if "pull_request" not in i][:limit]
    return {"count": len(issues),
            "issues": [_norm_issue(i) for i in issues]}


def _op_get_issue(headers, timeout, owner, repo, number, **_):
    data = _request("GET", f"/repos/{owner}/{repo}/issues/{number}",
                    headers, timeout)
    return _norm_issue(data, full=True)


def _op_create_issue(headers, timeout, owner, repo, title, body: str = "",
                     labels: list | None = None,
                     assignees: list | None = None, **_):
    payload = {"title": title, "body": body}
    if labels: payload["labels"] = labels
    if assignees: payload["assignees"] = assignees
    data = _request("POST", f"/repos/{owner}/{repo}/issues",
                    headers, timeout, json_body=payload)
    return _norm_issue(data, full=True)


def _op_comment_issue(headers, timeout, owner, repo, number, body, **_):
    data = _request("POST",
                    f"/repos/{owner}/{repo}/issues/{number}/comments",
                    headers, timeout, json_body={"body": body})
    return {"id": data.get("id"), "url": data.get("html_url"),
            "created_at": data.get("created_at")}


def _op_close_issue(headers, timeout, owner, repo, number,
                    reason: str = "completed", **_):
    data = _request("PATCH", f"/repos/{owner}/{repo}/issues/{number}",
                    headers, timeout,
                    json_body={"state": "closed", "state_reason": reason})
    return _norm_issue(data, full=True)


# ── Ops: pull requests ──────────────────────────────────────────────────────

def _op_list_prs(headers, timeout, owner, repo, state: str = "open",
                 limit: int = 30, **_):
    data = _paginate(f"/repos/{owner}/{repo}/pulls", headers, timeout,
                     params={"state": state, "per_page": min(100, limit)},
                     max_pages=1)
    prs = data[:limit]
    return {"count": len(prs),
            "pulls": [_norm_pr(p) for p in prs]}


def _op_get_pr(headers, timeout, owner, repo, number, **_):
    data = _request("GET", f"/repos/{owner}/{repo}/pulls/{number}",
                    headers, timeout)
    return _norm_pr(data, full=True)


def _op_create_pr(headers, timeout, owner, repo, title, head, base,
                  body: str = "", draft: bool = False, **_):
    payload = {"title": title, "head": head, "base": base,
               "body": body, "draft": draft}
    data = _request("POST", f"/repos/{owner}/{repo}/pulls",
                    headers, timeout, json_body=payload)
    return _norm_pr(data, full=True)


def _op_merge_pr(headers, timeout, owner, repo, number,
                 method: str = "merge", commit_title: str | None = None,
                 commit_message: str | None = None, **_):
    if method not in ("merge", "squash", "rebase"):
        raise ValueError("method must be merge|squash|rebase")
    payload = {"merge_method": method}
    if commit_title: payload["commit_title"] = commit_title
    if commit_message: payload["commit_message"] = commit_message
    data = _request("PUT", f"/repos/{owner}/{repo}/pulls/{number}/merge",
                    headers, timeout, json_body=payload)
    return {"merged": data.get("merged"), "sha": data.get("sha"),
            "message": data.get("message")}


def _op_review_pr(headers, timeout, owner, repo, number, body: str = "",
                  event: str = "COMMENT", **_):
    if event not in ("APPROVE", "REQUEST_CHANGES", "COMMENT"):
        raise ValueError("event must be APPROVE|REQUEST_CHANGES|COMMENT")
    data = _request("POST", f"/repos/{owner}/{repo}/pulls/{number}/reviews",
                    headers, timeout,
                    json_body={"body": body, "event": event})
    return {"id": data.get("id"), "state": data.get("state"),
            "url": data.get("html_url")}


# ── Ops: files / commits / branches ─────────────────────────────────────────

def _op_get_file(headers, timeout, owner, repo, path, ref: str | None = None,
                 **_):
    params = {"ref": ref} if ref else None
    data = _request("GET",
                    f"/repos/{owner}/{repo}/contents/{quote(path)}",
                    headers, timeout, params=params)
    if isinstance(data, list):
        return {"type": "directory", "entries":
                [{"name": d["name"], "type": d["type"],
                  "size": d.get("size"), "path": d["path"]} for d in data]}
    content = data.get("content", "")
    encoding = data.get("encoding", "")
    text = ""
    if encoding == "base64" and content:
        try:
            text = base64.b64decode(content).decode("utf-8", errors="replace")
        except Exception:
            text = "<binary>"
    return {
        "type": "file", "path": data.get("path"), "name": data.get("name"),
        "size": data.get("size"), "sha": data.get("sha"),
        "url": data.get("html_url"),
        "content": text[:MAX_BODY],
        "truncated": len(text) > MAX_BODY,
    }


def _op_list_dir(headers, timeout, owner, repo, path: str = "",
                 ref: str | None = None, **_):
    params = {"ref": ref} if ref else None
    data = _request("GET",
                    f"/repos/{owner}/{repo}/contents/{quote(path)}",
                    headers, timeout, params=params)
    if not isinstance(data, list):
        raise _HTTPError(f"{path} is not a directory")
    return {"path": path,
            "entries": [{"name": d["name"], "type": d["type"],
                         "size": d.get("size"), "path": d["path"]}
                        for d in data]}


def _op_list_commits(headers, timeout, owner, repo, branch: str | None = None,
                     path: str | None = None, limit: int = 30, **_):
    params = {"per_page": min(100, limit)}
    if branch: params["sha"] = branch
    if path: params["path"] = path
    data = _paginate(f"/repos/{owner}/{repo}/commits", headers, timeout,
                     params=params, max_pages=1)
    return {"count": len(data),
            "commits": [{"sha": c["sha"], "short": c["sha"][:7],
                         "author": (c.get("commit") or {}).get("author", {}).get("name"),
                         "date": (c.get("commit") or {}).get("author", {}).get("date"),
                         "message": (c.get("commit") or {}).get("message", "").split("\n")[0],
                         "url": c.get("html_url")} for c in data[:limit]]}


def _op_get_commit(headers, timeout, owner, repo, sha, **_):
    data = _request("GET", f"/repos/{owner}/{repo}/commits/{sha}",
                    headers, timeout)
    commit = data.get("commit", {})
    return {
        "sha": data.get("sha"),
        "author": commit.get("author"),
        "committer": commit.get("committer"),
        "message": commit.get("message"),
        "url": data.get("html_url"),
        "stats": data.get("stats"),
        "files": [{"filename": f.get("filename"),
                   "status": f.get("status"),
                   "additions": f.get("additions"),
                   "deletions": f.get("deletions")}
                  for f in data.get("files", [])[:50]],
    }


def _op_list_branches(headers, timeout, owner, repo, **_):
    data = _paginate(f"/repos/{owner}/{repo}/branches", headers, timeout,
                     params={}, max_pages=2)
    return {"count": len(data),
            "branches": [{"name": b["name"],
                          "sha": (b.get("commit") or {}).get("sha"),
                          "protected": b.get("protected")} for b in data]}


def _op_list_tags(headers, timeout, owner, repo, **_):
    data = _paginate(f"/repos/{owner}/{repo}/tags", headers, timeout,
                     params={}, max_pages=2)
    return {"count": len(data),
            "tags": [{"name": t["name"],
                      "sha": (t.get("commit") or {}).get("sha")} for t in data]}


def _op_list_releases(headers, timeout, owner, repo, limit: int = 10, **_):
    data = _request("GET", f"/repos/{owner}/{repo}/releases",
                    headers, timeout, params={"per_page": min(100, limit)})
    return {"count": len(data),
            "releases": [{"tag": r.get("tag_name"), "name": r.get("name"),
                          "published_at": r.get("published_at"),
                          "prerelease": r.get("prerelease"),
                          "url": r.get("html_url")} for r in data]}


def _op_get_release(headers, timeout, owner, repo,
                    tag: str | None = None, id: int | None = None, **_):
    if tag:
        path = f"/repos/{owner}/{repo}/releases/tags/{tag}"
    elif id:
        path = f"/repos/{owner}/{repo}/releases/{id}"
    else:
        path = f"/repos/{owner}/{repo}/releases/latest"
    data = _request("GET", path, headers, timeout)
    return {"tag": data.get("tag_name"), "name": data.get("name"),
            "body": data.get("body"),
            "published_at": data.get("published_at"),
            "assets": [{"name": a["name"], "size": a["size"],
                        "download_url": a["browser_download_url"]}
                       for a in data.get("assets", [])],
            "url": data.get("html_url")}


def _op_workflow_runs(headers, timeout, owner, repo, branch: str | None = None,
                      status: str | None = None, limit: int = 20, **_):
    params = {"per_page": min(100, limit)}
    if branch: params["branch"] = branch
    if status: params["status"] = status
    data = _request("GET", f"/repos/{owner}/{repo}/actions/runs",
                    headers, timeout, params=params)
    runs = data.get("workflow_runs", [])[:limit]
    return {"count": len(runs),
            "runs": [{"id": r["id"], "name": r.get("name"),
                      "status": r.get("status"),
                      "conclusion": r.get("conclusion"),
                      "branch": r.get("head_branch"),
                      "commit": (r.get("head_sha") or "")[:7],
                      "created_at": r.get("created_at"),
                      "url": r.get("html_url")} for r in runs]}


def _op_rate_limit(headers, timeout, **_):
    data = _request("GET", "/rate_limit", headers, timeout)
    return data.get("resources", data)


_DISPATCH = {
    "repo_get": _op_repo_get, "repo_search": _op_repo_search,
    "user_get": _op_user_get,
    "list_issues": _op_list_issues, "get_issue": _op_get_issue,
    "create_issue": _op_create_issue, "comment_issue": _op_comment_issue,
    "close_issue": _op_close_issue,
    "list_prs": _op_list_prs, "get_pr": _op_get_pr,
    "create_pr": _op_create_pr, "merge_pr": _op_merge_pr,
    "review_pr": _op_review_pr,
    "get_file": _op_get_file, "list_dir": _op_list_dir,
    "list_commits": _op_list_commits, "get_commit": _op_get_commit,
    "list_branches": _op_list_branches, "list_tags": _op_list_tags,
    "list_releases": _op_list_releases, "get_release": _op_get_release,
    "workflow_runs": _op_workflow_runs, "rate_limit": _op_rate_limit,
}


# ── Normalizers ─────────────────────────────────────────────────────────────

def _norm_issue(data: dict, full: bool = False) -> dict:
    out = {
        "number": data.get("number"), "title": data.get("title"),
        "state": data.get("state"),
        "author": (data.get("user") or {}).get("login"),
        "labels": [l["name"] for l in data.get("labels", []) if isinstance(l, dict)],
        "comments": data.get("comments"),
        "created_at": data.get("created_at"),
        "updated_at": data.get("updated_at"),
        "closed_at": data.get("closed_at"),
        "url": data.get("html_url"),
    }
    if full:
        out["body"] = (data.get("body") or "")[:MAX_BODY]
        out["assignees"] = [a["login"] for a in data.get("assignees", [])]
        out["milestone"] = (data.get("milestone") or {}).get("title")
    return out


def _norm_pr(data: dict, full: bool = False) -> dict:
    base = data.get("base", {}) or {}
    head = data.get("head", {}) or {}
    out = {
        "number": data.get("number"), "title": data.get("title"),
        "state": data.get("state"), "draft": data.get("draft"),
        "merged": data.get("merged"),
        "author": (data.get("user") or {}).get("login"),
        "base": base.get("ref"), "head": head.get("ref"),
        "head_repo": (head.get("repo") or {}).get("full_name"),
        "mergeable": data.get("mergeable"),
        "mergeable_state": data.get("mergeable_state"),
        "comments": data.get("comments"),
        "review_comments": data.get("review_comments"),
        "commits": data.get("commits"),
        "additions": data.get("additions"),
        "deletions": data.get("deletions"),
        "changed_files": data.get("changed_files"),
        "created_at": data.get("created_at"),
        "url": data.get("html_url"),
    }
    if full:
        out["body"] = (data.get("body") or "")[:MAX_BODY]
        out["labels"] = [l["name"] for l in data.get("labels", [])]
        out["assignees"] = [a["login"] for a in data.get("assignees", [])]
    return out


# ── Envelopes ───────────────────────────────────────────────────────────────

def _ok(result, start, op, **extra):
    return {"status": "ok", "result": result, "error": None,
            "metadata": {"tool": "github_ops", "op": op,
                         "duration_ms": int((time.time() - start) * 1000),
                         **extra}}


def _err(msg, start, op, **extra):
    return {"status": "error", "result": None, "error": msg,
            "metadata": {"tool": "github_ops", "op": op,
                         "duration_ms": int((time.time() - start) * 1000),
                         **extra}}
