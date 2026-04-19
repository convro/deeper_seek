'use strict';

/**
 * github.service.js — GitHub PAT management and integration helpers.
 *
 * Provides:
 *  • validateToken(token)   — hit /user, return {login, name, avatar_url}
 *  • listRepos(token)       — list repos the token has access to
 *  • buildContextBlock(repo, branch, workspacePath) — system-prompt snippet
 */

const https = require('https');

const GH_API = 'api.github.com';
const UA = 'DeeperSeek/1.0';

/** Make a GET request to the GitHub API. */
function ghGet(path, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: GH_API,
      path,
      method: 'GET',
      headers: {
        'User-Agent': UA,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('GitHub API timeout')); });
    req.end();
  });
}

/**
 * Validate a GitHub PAT and return the authenticated user info.
 * Returns { ok: true, login, name, avatar_url } or { ok: false, error }.
 */
async function validateToken(token) {
  if (!token || typeof token !== 'string' || !token.trim()) {
    return { ok: false, error: 'Token is empty' };
  }
  try {
    const { status, data } = await ghGet('/user', token.trim());
    if (status === 200 && data.login) {
      return {
        ok: true,
        login: data.login,
        name: data.name || data.login,
        avatar_url: data.avatar_url || '',
        scopes_ok: true,
      };
    }
    if (status === 401) return { ok: false, error: 'Invalid token (401 Unauthorized)' };
    if (status === 403) return { ok: false, error: 'Token lacks required scopes (need repo)' };
    return { ok: false, error: `GitHub returned status ${status}` };
  } catch (e) {
    return { ok: false, error: `Connection error: ${e.message}` };
  }
}

/**
 * List repositories accessible to the token (first 100, sorted by push time).
 */
async function listRepos(token) {
  if (!token) return [];
  try {
    const { status, data } = await ghGet(
      '/user/repos?sort=pushed&per_page=100&type=all',
      token,
    );
    if (status !== 200 || !Array.isArray(data)) return [];
    return data.map((r) => ({
      full_name: r.full_name,
      name: r.name,
      private: r.private,
      default_branch: r.default_branch,
      description: r.description || '',
      updated_at: r.pushed_at,
    }));
  } catch {
    return [];
  }
}

/**
 * Build a system-prompt context block for a GitHub-linked session.
 */
function buildContextBlock({ repo, branch, workspacePath, username }) {
  const lines = [
    '━━━ GITHUB WORKSPACE ━━━',
    `Repository : ${repo}`,
    `Branch     : ${branch}`,
    `Local path : ${workspacePath || `workspace/{job_id}/`}`,
    '',
    'RULES FOR GITHUB-LINKED SESSIONS:',
    '1. The repository is cloned (or will be cloned) into the workspace.',
    '   Use fs_tree / fs_read to explore it. Use run_bash / git_ops to work with git.',
    '2. Always work on the designated branch — never push directly to main/master unless asked.',
    '3. After making changes, commit with a clear message: git_ops(op=commit, message="...")',
    '4. Push after every commit: git_ops(op=push)',
    '5. Use github_ops for PR creation, issue management, file browsing via API.',
    '6. GITHUB_TOKEN is available as an env var — git push will authenticate automatically.',
    '7. For cloning: run_bash("git clone https://github.com/' + repo + '.git .")',
    '   Git credentials are pre-configured — no manual token injection needed.',
    '━━━ END GITHUB WORKSPACE ━━━',
  ];
  return lines.join('\n');
}

module.exports = { validateToken, listRepos, buildContextBlock };
