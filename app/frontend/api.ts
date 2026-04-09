// API client for DeeperSeek backend

const BASE = '/api';

export async function sendMessage(message: string, sessionId: string, model?: string) {
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, session_id: sessionId, model }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function listSessions() {
  const res = await fetch(`${BASE}/chat/sessions`);
  return res.json();
}

export async function listJobs() {
  const res = await fetch(`${BASE}/workspace/jobs`);
  return res.json();
}

export async function getJob(jobId: string) {
  const res = await fetch(`${BASE}/workspace/jobs/${jobId}`);
  return res.json();
}

export async function listJobFiles(jobId: string, subdir = '') {
  const res = await fetch(`${BASE}/workspace/jobs/${jobId}/files?subdir=${encodeURIComponent(subdir)}`);
  return res.json();
}

export async function readJobFile(jobId: string, filePath: string) {
  const res = await fetch(`${BASE}/workspace/jobs/${jobId}/file?file_path=${encodeURIComponent(filePath)}`);
  return res.json();
}

export async function listAgents() {
  const res = await fetch(`${BASE}/agents`);
  return res.json();
}

export async function killAgent(agentId: string) {
  const res = await fetch(`${BASE}/agents/${agentId}`, { method: 'DELETE' });
  return res.json();
}

export async function uploadFile(file: File) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}/upload`, { method: 'POST', body: form });
  return res.json();
}

export async function listUploads() {
  const res = await fetch(`${BASE}/upload/list`);
  return res.json();
}
