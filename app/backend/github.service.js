'use strict';

/**
 * github.service.js — GitHub OAuth + API integration.
 *
 * OAuth 2.0 Authorization Code flow:
 *   1. Frontend POSTs /api/github/oauth/begin → gets {url} (GitHub authorize URL)
 *   2. Frontend opens url in popup window
 *   3. User authorizes → GitHub redirects to /api/github/oauth/callback?code=...&state=...
 *   4. Backend exchanges code for token, stores in user soul settings
 *   5. Callback page sends postMessage to opener and closes
 */

const https = require('https');
const querystring = require('querystring');
const crypto = require('crypto');

const GH_API  = 'api.github.com';
const GH_AUTH = 'github.com';
const UA      = 'DeeperSeek/1.0';

const OAUTH_CLIENT_ID     = process.env.GITHUB_OAUTH_CLIENT_ID     || 'Ov23lidM7lfRh4bgPsUB';
const OAUTH_CALLBACK_URL  = 'https://dslab.club/api/github/oauth/callback';

// In-memory state map for CSRF protection. Entries expire after 10 min.
const oauthStates = new Map();

function pruneStates() {
  const now = Date.now();
  for (const [k, v] of oauthStates) {
    if (now - v.ts > 10 * 60 * 1000) oauthStates.delete(k);
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function ghRequest(method, hostname, path, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname,
      path,
      method,
      headers: {
        'User-Agent': UA,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('GitHub API timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function ghGet(path, token)       { return ghRequest('GET',  GH_API, path, token, null); }
function ghPost(host, path, body) { return ghRequest('POST', host, path, null, body); }

// ── OAuth ─────────────────────────────────────────────────────────────────────

/**
 * Generate a state token, store it with the userId, return the GitHub authorize URL.
 */
function beginOAuth(userId) {
  pruneStates();
  const state = crypto.randomBytes(20).toString('hex');
  oauthStates.set(state, { userId, ts: Date.now() });

  const params = new URLSearchParams({
    client_id:    OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_CALLBACK_URL,
    scope:        'repo',
    state,
  });
  return {
    state,
    url: `https://github.com/login/oauth/authorize?${params}`,
  };
}

/**
 * Exchange an authorization code for an access token.
 * Returns { access_token, scope, token_type } or throws.
 */
async function exchangeCode(code) {
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientSecret) throw new Error('GITHUB_OAUTH_CLIENT_SECRET not set');

  // GitHub token endpoint returns application/x-www-form-urlencoded by default,
  // but we request JSON via Accept header.
  const params = new URLSearchParams({
    client_id:     OAUTH_CLIENT_ID,
    client_secret: clientSecret,
    code,
    redirect_uri:  OAUTH_CALLBACK_URL,
  });

  return new Promise((resolve, reject) => {
    const body = params.toString();
    const opts = {
      hostname: GH_AUTH,
      path:     '/login/oauth/access_token',
      method:   'POST',
      headers: {
        'User-Agent':     UA,
        Accept:           'application/json',
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error_description || parsed.error));
          else resolve(parsed);
        } catch {
          reject(new Error(`Token exchange failed: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('GitHub token exchange timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Look up the stored state entry and return it (null if missing/expired).
 */
function consumeState(state) {
  const entry = oauthStates.get(state);
  if (entry) oauthStates.delete(state);
  return entry || null;
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function validateToken(token) {
  if (!token || typeof token !== 'string' || !token.trim()) {
    return { ok: false, error: 'Token is empty' };
  }
  try {
    const { status, data } = await ghGet('/user', token.trim());
    if (status === 200 && data.login) {
      return {
        ok:         true,
        login:      data.login,
        id:         data.id,
        name:       data.name || data.login,
        avatar_url: data.avatar_url || '',
      };
    }
    if (status === 401) return { ok: false, error: 'Invalid token (401 Unauthorized)' };
    if (status === 403) return { ok: false, error: 'Token lacks required scopes (need repo)' };
    return { ok: false, error: `GitHub returned status ${status}` };
  } catch (e) {
    return { ok: false, error: `Connection error: ${e.message}` };
  }
}

async function listRepos(token) {
  if (!token) return [];
  try {
    const { status, data } = await ghGet('/user/repos?sort=pushed&per_page=100&type=all', token);
    if (status !== 200 || !Array.isArray(data)) return [];
    return data.map((r) => ({
      full_name:      r.full_name,
      name:           r.name,
      private:        r.private,
      default_branch: r.default_branch,
      description:    r.description || '',
      updated_at:     r.pushed_at,
    }));
  } catch {
    return [];
  }
}

function buildContextBlock({ repo, branch, workspacePath, username }) {
  const lines = [
    '━━━ GITHUB WORKSPACE ━━━',
    `Repository : ${repo}`,
    `Branch     : ${branch}`,
    `Local path : ${workspacePath || 'workspace/{job_id}/'}`,
    '',
    'RULES FOR GITHUB-LINKED SESSIONS:',
    '1. Clone the repo into workspace at task start: git_ops(op=clone, url="https://github.com/' + repo + '.git", dest=".", cwd="workspace/{job_id}/")',
    '2. Always create a feature branch — NEVER commit directly to main/master.',
    '3. Commit after every logical unit: git_ops(op=commit, message="...")',
    '4. Push after every commit: git_ops(op=push) — GITHUB_TOKEN handles auth automatically.',
    '5. Use github_ops for PR creation, issue management, and file browsing via API.',
    '━━━ END GITHUB WORKSPACE ━━━',
  ];
  return lines.join('\n');
}

module.exports = {
  beginOAuth,
  exchangeCode,
  consumeState,
  validateToken,
  listRepos,
  buildContextBlock,
};
