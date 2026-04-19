'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const PROJECT_ROOT = path.join(__dirname, '../..');
const WORKSPACE_ROOT = path.join(PROJECT_ROOT, 'workspace');

const chatController = require('./chat.controller');
const agentController = require('./agent.controller');
const workspaceController = require('./workspace.controller');
const uploadController = require('./upload.controller');
const authController = require('./auth.controller');
const authMiddleware = require('./auth');
const githubService = require('./github.service');
const soulService = require('./soul.service');

// Multer setup for file uploads — namespaced per user when auth is active
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userSeg = req.user && req.user.id ? `u_${req.user.id}` : '';
    const uploadDir = path.join(__dirname, '../../uploads/raw', userSeg);
    require('fs').mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${file.originalname}`;
    cb(null, unique);
  },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// ── Auth (public, no middleware) ────────────────
// These MUST be registered before the protected middleware chain below.
router.get ('/auth/config',   authController.config);
router.get ('/auth/me',       authController.me);
router.post('/auth/register', authController.register);
router.post('/auth/login',    authController.login);
router.post('/auth/logout',   authController.logout);

// ── Preview — serve workspace HTML/CSS/JS files in iframe ───────────────────
// Public (no auth required): the job-ID in the URL acts as an unguessable token.
router.get('/preview/*', (req, res) => {
  const rawSeg = req.params[0] || '';
  const safeSeg = rawSeg.split('/').filter(p => p !== '..' && p !== '.').join('/');
  const allowedRoot = path.join(PROJECT_ROOT, 'workspace') + path.sep;
  const primaryPath = path.join(PROJECT_ROOT, safeSeg);
  let legacyPath = null;
  if (safeSeg.startsWith('workspace/')) {
    legacyPath = path.join(PROJECT_ROOT, 'workspace', 'jobs', safeSeg.slice('workspace/'.length));
  }
  function isSafe(p) { return p && p.startsWith(allowedRoot); }
  function isFile(p) { try { return p && fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } }
  function isDir(p)  { try { return p && fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; } }
  function resolveCandidate(p) {
    if (isFile(p)) return p;
    if (isDir(p)) { const idx = path.join(p, 'index.html'); if (isFile(idx)) return idx; }
    return null;
  }
  if (!isSafe(primaryPath) && !isSafe(legacyPath)) return res.status(403).send('Forbidden');
  const resolvedPath = resolveCandidate(primaryPath) || resolveCandidate(legacyPath) || null;
  if (!resolvedPath) return res.status(404).send('File not found');
  res.sendFile(resolvedPath);
});

// ── Download — serve workspace files as attachment (zip, pdf, etc.) ─────────
// Public (no auth required): job-ID in URL is the access token.
router.get('/download/*', (req, res) => {
  const rawSeg = req.params[0] || '';
  const safeSeg = rawSeg.split('/').filter(p => p !== '..' && p !== '.').join('/');
  const allowedRoot = path.join(PROJECT_ROOT, 'workspace') + path.sep;
  const filePath = path.join(PROJECT_ROOT, safeSeg);
  if (!filePath.startsWith(allowedRoot)) return res.status(403).send('Forbidden');
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return res.status(404).send('File not found');
    }
  } catch { return res.status(404).send('File not found'); }
  const filename = path.basename(filePath);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.sendFile(filePath);
});

// ── GitHub OAuth callback — PUBLIC (GitHub redirects here, no auth header) ──
// Must be registered BEFORE authMiddleware.
router.get('/github/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  const safeClose = (type, payload) => {
    const data = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
    return res.send(
      `<!doctype html><html><body><script>
        try { window.opener && window.opener.postMessage(${JSON.stringify({ type, ...payload })}, '*'); }
        catch(e){}
        window.close();
      </script></body></html>`
    );
  };

  if (error) return safeClose('github-oauth-error', { error: String(error) });
  if (!code || !state) return safeClose('github-oauth-error', { error: 'Missing code or state' });

  const stateEntry = githubService.consumeState(String(state));
  if (!stateEntry) return safeClose('github-oauth-error', { error: 'Invalid or expired state' });

  try {
    const tokenData = await githubService.exchangeCode(String(code));
    if (!tokenData.access_token) {
      return safeClose('github-oauth-error', { error: 'Token exchange failed' });
    }

    const userInfo = await githubService.validateToken(tokenData.access_token);
    if (!userInfo.ok) {
      return safeClose('github-oauth-error', { error: userInfo.error || 'Token validation failed' });
    }

    // Persist token + username in soul settings
    if (stateEntry.userId) {
      soulService.saveUserSettings(stateEntry.userId, {
        github_pat:      tokenData.access_token,
        github_username: userInfo.login,
      });
    }

    return safeClose('github-oauth-success', {
      login:      userInfo.login,
      avatar_url: userInfo.avatar_url || '',
    });
  } catch (e) {
    return safeClose('github-oauth-error', { error: e.message || 'Unknown error' });
  }
});

// ── Everything below requires auth (when AUTH_MODE=multi_user) ──────────
router.use(authMiddleware);

// ── Auth (protected) — soul / onboarding profile ─────────────
router.get ('/auth/soul',       authController.getSoul);
router.put ('/auth/soul',       authController.saveSoul);
router.post('/auth/soul/skip',  authController.skipSoul);
router.post('/auth/soul/reset', authController.resetSoul);

// ── Auth (protected) — user settings ─────────────────────────
router.get('/auth/settings', authController.getSettings);
router.put('/auth/settings', authController.saveSettings);

// ── Chat ────────────────────────────────────────
// POST /api/chat
router.post('/chat', chatController.sendMessage);

// POST /api/chat/regenerate — silent retry (no visible user bubble)
router.post('/chat/regenerate', chatController.regenerate);

// GET /api/chat/sessions
router.get('/chat/sessions', chatController.listSessions);

// GET /api/chat/sessions/:sessionId
router.get('/chat/sessions/:sessionId', chatController.getSession);

// PATCH /api/chat/sessions/:sessionId  — rename
router.patch('/chat/sessions/:sessionId', chatController.renameSession);

// DELETE /api/chat/sessions/:sessionId
router.delete('/chat/sessions/:sessionId', chatController.deleteSession);

// PATCH /api/chat/sessions/:sessionId/github — link / unlink GitHub repo
router.patch('/chat/sessions/:sessionId/github', chatController.linkGithubRepo);

// ── GitHub integration ───────────────────────────────────────────────────────

// POST /api/github/oauth/begin — start OAuth flow, returns {url} to open in popup
router.post('/github/oauth/begin', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const result = githubService.beginOAuth(req.user.id);
  res.json(result);
});

// GET /api/github/repos — list repos using the PAT stored in user settings
router.get('/github/repos', async (req, res) => {
  const settings = req.user ? soulService.getUserSettings(req.user.id) : {};
  const pat = settings.github_pat || '';
  try {
    const repos = await githubService.listRepos(pat);
    res.json({ repos });
  } catch (e) {
    res.json({ repos: [], error: e.message });
  }
});

// POST /api/github/disconnect — remove GitHub token from user settings
router.post('/github/disconnect', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  soulService.saveUserSettings(req.user.id, { github_pat: '', github_username: '' });
  res.json({ ok: true });
});

// ── Agents ──────────────────────────────────────
// POST /api/agents/spawn
router.post('/agents/spawn', agentController.spawn);

// GET /api/agents/:agentId/status
router.get('/agents/:agentId/status', agentController.status);

// GET /api/agents
router.get('/agents', agentController.list);

// DELETE /api/agents/:agentId
router.delete('/agents/:agentId', agentController.kill);

// ── Workspace ───────────────────────────────────
// GET /api/workspace/jobs
router.get('/workspace/jobs', workspaceController.listJobs);

// GET /api/workspace/jobs/:jobId
router.get('/workspace/jobs/:jobId', workspaceController.getJob);

// GET /api/workspace/jobs/:jobId/files
router.get('/workspace/jobs/:jobId/files', workspaceController.listFiles);

// GET /api/workspace/jobs/:jobId/file
router.get('/workspace/jobs/:jobId/file', workspaceController.readFile);

// ── Uploads ─────────────────────────────────────
// POST /api/upload
router.post('/upload', upload.single('file'), uploadController.handleUpload);

// GET /api/upload/list
router.get('/upload/list', uploadController.listUploads);

// ── Tools (direct call for testing) ─────────────
// POST /api/tools/execute
router.post('/tools/execute', async (req, res) => {
  const { tool, args } = req.body;
  if (!tool) return res.status(400).json({ error: 'Missing tool name' });
  const { executeTool } = require('./orchestrator.service');
  const result = await executeTool(tool, args || {});
  res.json(result);
});


// ── Health ───────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;
