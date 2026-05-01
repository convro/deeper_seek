// API client for DeeperSeek backend

import type { Attachment } from './state';

const BASE = '/api';

// ── Auth token storage ─────────────────────────────────────────────────────
const TOKEN_KEY = 'deeperseek_auth_token';

export function getAuthToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setAuthToken(token: string) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch {}
}
export function clearAuthToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
}

function authHeaders(): Record<string, string> {
  const t = getAuthToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function fetchJson(url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...authHeaders(),
      ...(init.headers || {}),
    },
  });
  if (res.status === 401) {
    // Token expired or missing — force re-login
    clearAuthToken();
    window.dispatchEvent(new CustomEvent('deeperseek-auth-required'));
    throw new Error('Authentication required');
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// ── Auth endpoints ─────────────────────────────────────────────────────────
export interface AuthUser {
  id: string;
  email: string;
  username: string | null;
  role: 'admin' | 'user';
  createdAt: string;
  lastLoginAt: string | null;
  /** True once the user has either completed or skipped the soul onboarding. */
  soul_complete?: boolean;
}

export interface SoulRecord {
  user_id: string;
  version: number;
  updated_at: string;
  complete: boolean;
  skipped: boolean;
  answers: Record<string, unknown>;
}

export interface AuthConfig {
  mode: 'open' | 'multi_user';
  user_count: number;
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  return fetchJson(`${BASE}/auth/config`);
}

export async function fetchMe(): Promise<{ mode: string; user: AuthUser | null; user_count: number }> {
  return fetchJson(`${BASE}/auth/me`);
}

export async function loginRequest(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
  return fetchJson(`${BASE}/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function registerRequest(
  email: string,
  password: string,
  license_key: string,
  username?: string,
): Promise<{ token: string; user: AuthUser }> {
  return fetchJson(`${BASE}/auth/register`, {
    method: 'POST',
    body: JSON.stringify({ email, password, username, license_key }),
  });
}

export async function logoutRequest(): Promise<void> {
  try {
    await fetchJson(`${BASE}/auth/logout`, { method: 'POST' });
  } catch {}
  clearAuthToken();
}

// ── User Settings ──────────────────────────────────────────────────────────

export interface UserSettings {
  extended_thinking: boolean;
  agent_extended_thinking: boolean;
  use_pro_model: boolean;
  github_pat?: string;
  github_username?: string;
  discord_token?: string;
  discord_user_id?: string;
  discord_username?: string;
  discord_global_name?: string;
  discord_avatar?: string;
}

export async function fetchUserSettings(): Promise<{ settings: UserSettings }> {
  return fetchJson(`${BASE}/auth/settings`);
}

export async function saveUserSettings(settings: UserSettings): Promise<{ settings: UserSettings }> {
  return fetchJson(`${BASE}/auth/settings`, {
    method: 'PUT',
    body: JSON.stringify({ settings }),
  });
}

// ── Soul (onboarding profile) ──────────────────────────────────────────────

export async function fetchSoul(): Promise<{ soul: SoulRecord | null }> {
  return fetchJson(`${BASE}/auth/soul`);
}

export async function saveSoul(answers: Record<string, unknown>, complete = true): Promise<{ soul: SoulRecord }> {
  return fetchJson(`${BASE}/auth/soul`, {
    method: 'PUT',
    body: JSON.stringify({ answers, complete }),
  });
}

export async function skipSoul(): Promise<{ soul: SoulRecord }> {
  return fetchJson(`${BASE}/auth/soul/skip`, { method: 'POST' });
}

export async function resetSoul(): Promise<{ soul: SoulRecord | null }> {
  return fetchJson(`${BASE}/auth/soul/reset`, { method: 'POST' });
}

export async function sendMessage(
  message: string,
  sessionId: string,
  model?: string,
  attachments?: Attachment[],
) {
  // Build attachment payload — strip blob URLs (not serializable)
  const attPayload = attachments && attachments.length > 0
    ? attachments.map(a => ({
        name: a.name,
        type: a.type,
        data: a.data,
        text: a.text,
        path: a.path,
      }))
    : undefined;

  return fetchJson(`${BASE}/chat`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      session_id: sessionId,
      model,
      attachments: attPayload,
    }),
  });
}

/**
 * Silent retry — asks the backend to re-run the agent loop for the most
 * recent user turn WITHOUT adding a visible user bubble. Optional `feedback`
 * is passed as an ephemeral (non-persisted) nudge so the model knows what to
 * improve. Mirrors ChatGPT/Claude "regenerate" UX.
 */
export async function regenerateMessage(sessionId: string, feedback?: string) {
  return fetchJson(`${BASE}/chat/regenerate`, {
    method: 'POST',
    body: JSON.stringify({
      session_id: sessionId,
      feedback: feedback && feedback.trim() ? feedback.trim() : undefined,
    }),
  });
}

// ── Conversations ──────────────────────────────────────────────────────────

export async function listConversations() {
  return fetchJson(`${BASE}/chat/sessions`) as Promise<{ sessions: import('./state').Conversation[] }>;
}

export async function getConversation(sessionId: string) {
  return fetchJson(`${BASE}/chat/sessions/${encodeURIComponent(sessionId)}`);
}

export async function renameConversation(sessionId: string, title: string) {
  return fetchJson(`${BASE}/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

export async function togglePinConversation(sessionId: string, pinned: boolean) {
  return fetchJson(`${BASE}/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned }),
  });
}

export async function deleteConversation(sessionId: string) {
  return fetchJson(`${BASE}/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

// ── Legacy alias (used by older code) ────────────────────────────────────
export const listSessions = listConversations;

// ── Workspace ──────────────────────────────────────────────────────────────

export async function listJobs() {
  return fetchJson(`${BASE}/workspace/jobs`);
}

export async function getJob(jobId: string) {
  return fetchJson(`${BASE}/workspace/jobs/${jobId}`);
}

export async function listJobFiles(jobId: string, subdir = '') {
  return fetchJson(`${BASE}/workspace/jobs/${jobId}/files?subdir=${encodeURIComponent(subdir)}`);
}

export async function readJobFile(jobId: string, filePath: string) {
  return fetchJson(`${BASE}/workspace/jobs/${jobId}/file?file_path=${encodeURIComponent(filePath)}`);
}

// ── Agents ──────────────────────────────────────────────────────────────────

export async function listAgents() {
  return fetchJson(`${BASE}/agents`);
}

export async function killAgent(agentId: string) {
  return fetchJson(`${BASE}/agents/${agentId}`, { method: 'DELETE' });
}

// ── GitHub integration ─────────────────────────────────────────────────────

export interface GithubRepo {
  full_name: string;
  name: string;
  private: boolean;
  default_branch: string;
  description: string;
  updated_at: string;
}

export interface GithubOAuthResult {
  ok: boolean;
  login?: string;
  avatar_url?: string;
  error?: string;
}

/**
 * Open a GitHub OAuth popup. Returns a promise that resolves when the user
 * completes (or cancels) the authorization flow.
 */
export function connectGithubOAuth(): Promise<GithubOAuthResult> {
  return new Promise(async (resolve) => {
    // 1. Get the GitHub authorize URL from backend (includes state token)
    let url: string;
    try {
      const data = await fetchJson(`${BASE}/github/oauth/begin`, { method: 'POST' });
      url = data.url;
    } catch (e: any) {
      return resolve({ ok: false, error: e.message });
    }

    // 2. Open popup
    const popup = window.open(url, 'github-oauth',
      'width=600,height=700,left=200,top=100,scrollbars=yes');

    if (!popup) {
      return resolve({ ok: false, error: 'Popup blocked — please allow popups for this site.' });
    }

    // 3. Listen for postMessage from the callback page
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'github-oauth-success') {
        window.removeEventListener('message', handler);
        clearInterval(poll);
        resolve({ ok: true, login: event.data.login, avatar_url: event.data.avatar_url });
      } else if (event.data?.type === 'github-oauth-error') {
        window.removeEventListener('message', handler);
        clearInterval(poll);
        resolve({ ok: false, error: event.data.error || 'Authorization failed' });
      }
    };
    window.addEventListener('message', handler);

    // 4. Detect if popup was manually closed
    const poll = setInterval(() => {
      if (popup.closed) {
        clearInterval(poll);
        window.removeEventListener('message', handler);
        resolve({ ok: false, error: 'Window closed' });
      }
    }, 500);
  });
}

export async function disconnectGithub(): Promise<void> {
  await fetchJson(`${BASE}/github/disconnect`, { method: 'POST' });
}

// ── Discord integration ────────────────────────────────────────────────────

export interface DiscordStatus {
  connected: boolean;
  username?: string;
  global_name?: string;
  user_id?: string;
  avatar?: string;
}

/**
 * Returns the bookmarklet javascript: URI. The bookmarklet copies the
 * extracted token to the clipboard for the user to paste back here.
 */
export async function getDiscordBookmarklet(): Promise<{ script: string; expires_at: number }> {
  return fetchJson(`${BASE}/discord/bookmarklet/begin`, { method: 'POST' });
}

/**
 * Submit the pasted Discord token. Backend verifies via Discord API and stores it.
 */
export async function connectDiscordWithToken(token: string): Promise<{
  ok: boolean; username?: string; global_name?: string; user_id?: string; avatar?: string; error?: string;
}> {
  return fetchJson(`${BASE}/discord/connect`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ token }),
  });
}

/**
 * Read current connection state from stored settings (no network call to Discord).
 */
export async function getDiscordStatus(): Promise<DiscordStatus> {
  return fetchJson(`${BASE}/discord/status`);
}

/**
 * Actively pings Discord with the stored token to verify it's still valid.
 * Use when the user opens settings to detect silently-rotated tokens.
 * Also refreshes username/avatar in stored settings if they changed on Discord.
 */
export async function verifyDiscord(): Promise<{ valid: boolean; connected: boolean; error?: string; username?: string; global_name?: string; avatar?: string }> {
  return fetchJson(`${BASE}/discord/verify`);
}

export async function disconnectDiscord(): Promise<void> {
  await fetchJson(`${BASE}/discord/disconnect`, { method: 'POST' });
}

export async function listGithubRepos(): Promise<{ repos: GithubRepo[] }> {
  return fetchJson(`${BASE}/github/repos`);
}

export async function autoTitleConversation(sessionId: string): Promise<{ title: string } | null> {
  try {
    return await fetchJson(`${BASE}/chat/sessions/${encodeURIComponent(sessionId)}/auto-title`, {
      method: 'POST',
    });
  } catch { return null; }
}

export async function linkGithubRepo(
  sessionId: string,
  repo: string | null,
  branch?: string,
): Promise<{ id: string; github_repo: string | null; github_branch: string | null }> {
  return fetchJson(`${BASE}/chat/sessions/${encodeURIComponent(sessionId)}/github`, {
    method: 'PATCH',
    body: JSON.stringify({ repo, branch: branch || 'main' }),
  });
}

// ── Uploads ──────────────────────────────────────────────────────────────────

export async function uploadFile(file: File) {
  const form = new FormData();
  form.append('file', file);
  return fetchJson(`${BASE}/upload`, { method: 'POST', body: form });
}

export async function listUploads() {
  return fetchJson(`${BASE}/upload/list`);
}
