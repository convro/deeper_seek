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

// ── Everything below requires auth (when AUTH_MODE=multi_user) ──────────
router.use(authMiddleware);

// ── Auth (protected) — soul / onboarding profile ─────────────
router.get ('/auth/soul',       authController.getSoul);
router.put ('/auth/soul',       authController.saveSoul);
router.post('/auth/soul/skip',  authController.skipSoul);
router.post('/auth/soul/reset', authController.resetSoul);

// ── Chat ────────────────────────────────────────
// POST /api/chat
router.post('/chat', chatController.sendMessage);

// GET /api/chat/sessions
router.get('/chat/sessions', chatController.listSessions);

// GET /api/chat/sessions/:sessionId
router.get('/chat/sessions/:sessionId', chatController.getSession);

// PATCH /api/chat/sessions/:sessionId  — rename
router.patch('/chat/sessions/:sessionId', chatController.renameSession);

// DELETE /api/chat/sessions/:sessionId
router.delete('/chat/sessions/:sessionId', chatController.deleteSession);

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

// ── Preview — serve workspace HTML/CSS/JS files in iframe ───────────────────
// URL pattern: GET /api/preview/workspace/{jobId}/output/index.html
// The path after /api/preview/ is resolved relative to PROJECT_ROOT,
// then restricted to PROJECT_ROOT/workspace/ for security.
router.get('/preview/*', (req, res) => {
  const rawSeg = req.params[0] || '';

  // Strip any path-traversal segments
  const safeSeg = rawSeg
    .split('/')
    .filter(p => p !== '..' && p !== '.')
    .join('/');

  const allowedRoot = path.join(PROJECT_ROOT, 'workspace') + path.sep;

  // Primary path: PROJECT_ROOT/{safeSeg} (e.g. workspace/{jobId}/output/...)
  const primaryPath = path.join(PROJECT_ROOT, safeSeg);

  // Fallback path: workspace/jobs/{jobId}/... for legacy workspaces.
  // URL segment "workspace/{jobId}/..." → legacy "workspace/jobs/{jobId}/..."
  let legacyPath = null;
  const workspacePrefix = 'workspace/';
  if (safeSeg.startsWith(workspacePrefix)) {
    legacyPath = path.join(PROJECT_ROOT, 'workspace', 'jobs', safeSeg.slice(workspacePrefix.length));
  }

  // Security: candidate must be inside workspace/
  function isSafe(p) {
    return p && p.startsWith(allowedRoot);
  }

  function isFile(p) {
    try { return p && fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
  }

  if (!isSafe(primaryPath) && !isSafe(legacyPath)) {
    return res.status(403).send('Forbidden');
  }

  const resolvedPath = isFile(primaryPath) ? primaryPath
    : isFile(legacyPath)                   ? legacyPath
    : null;

  if (!resolvedPath) {
    return res.status(404).send('File not found');
  }

  // Ownership check: infer jobId from the resolved path segment, read meta,
  // compare owner_id to req.user.
  try {
    const rel = path.relative(path.join(PROJECT_ROOT, 'workspace'), resolvedPath);
    const firstSeg = rel.split(path.sep)[0];
    // Legacy format: jobs/<jobId>/... — skip the 'jobs' prefix
    const jobId = (firstSeg === 'jobs') ? rel.split(path.sep)[1] : firstSeg;
    if (jobId) {
      const metaPath = path.join(PROJECT_ROOT, 'workspace', firstSeg === 'jobs' ? 'jobs' : '', jobId, 'context', 'meta.json');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
      const user = req.user;
      const allowed = !user
        ? !meta.owner_id                                       // open mode
        : (user.role === 'admin' || meta.owner_id === user.id); // strict per-user
      if (!allowed) return res.status(403).send('Forbidden');
    }
  } catch {}

  res.sendFile(resolvedPath);
});

// ── Health ───────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;
