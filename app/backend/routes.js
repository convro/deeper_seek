'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();

const chatController = require('./chat.controller');
const agentController = require('./agent.controller');
const workspaceController = require('./workspace.controller');
const uploadController = require('./upload.controller');

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads/raw');
    require('fs').mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${file.originalname}`;
    cb(null, unique);
  },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

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

// ── Health ───────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;
