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
}

export interface AuthConfig {
  mode: 'open' | 'multi_user';
  registration_gated: boolean;
  user_count: number;
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  return fetchJson(`${BASE}/auth/config`);
}

export async function fetchMe(): Promise<{ mode: string; user: AuthUser | null; registration_gated: boolean; user_count: number }> {
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
  username?: string,
  invite_code?: string,
): Promise<{ token: string; user: AuthUser; is_admin_bootstrap: boolean }> {
  return fetchJson(`${BASE}/auth/register`, {
    method: 'POST',
    body: JSON.stringify({ email, password, username, invite_code }),
  });
}

export async function logoutRequest(): Promise<void> {
  try {
    await fetchJson(`${BASE}/auth/logout`, { method: 'POST' });
  } catch {}
  clearAuthToken();
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
