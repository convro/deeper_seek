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

// ── Uploads ──────────────────────────────────────────────────────────────────

export async function uploadFile(file: File) {
  const form = new FormData();
  form.append('file', file);
  return fetchJson(`${BASE}/upload`, { method: 'POST', body: form });
}

export async function listUploads() {
  return fetchJson(`${BASE}/upload/list`);
}
