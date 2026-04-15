'use strict';

const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { runAgentLoop } = require('./llm.service');
const { getWsForSession } = require('./websocket');
const logger = require('./logger');

const PROJECT_ROOT = path.join(__dirname, '../..');
const UPLOADS_IMAGES_DIR = path.join(PROJECT_ROOT, 'uploads/images');
fs.mkdirSync(UPLOADS_IMAGES_DIR, { recursive: true });

// ── Persistence ────────────────────────────────────────────────────────────
const SESSIONS_DIR = path.join(__dirname, '../../runtime/sessions');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// In-memory cache for fast access
const sessions = new Map();

// Per-session abort controllers — cancel previous loop when a new message arrives
const sessionAbortControllers = new Map();

function sessionPath(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function saveSession(session) {
  try {
    fs.writeFileSync(sessionPath(session.id), JSON.stringify(session), 'utf-8');
  } catch (err) {
    logger.error('Failed to save session', err);
  }
}

function loadAllSessions() {
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8'));
        if (data && data.id) sessions.set(data.id, data);
      } catch {}
    }
    logger.info(`Loaded ${sessions.size} persisted sessions`);
  } catch {}
}

// Load on startup
loadAllSessions();

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Owner check — when multi_user auth is on, sessions are scoped by user.
 * Returns true if the caller is allowed to access this session.
 *
 * Rules:
 *   - Anonymous caller (open mode): only sessions without owner_id.
 *   - Service identity (internal token / ACCESS_KEY → role='admin'): all sessions.
 *   - Real user: ONLY sessions they own. Legacy untagged sessions are hidden —
 *     they predate the auth system and must not leak across newly-registered
 *     accounts.
 */
function canAccessSession(session, user) {
  if (!session) return false;
  if (!user) return !session.owner_id;           // open mode
  if (user.role === 'admin') return true;        // service/internal callers
  return session.owner_id === user.id;           // strict per-user
}

function generateTitle(message) {
  const text = (message || '').trim().replace(/\s+/g, ' ');
  if (!text) return 'New conversation';
  return text.length <= 60 ? text : text.slice(0, 57) + '…';
}

/**
 * Smart context window management.
 * For long conversations, injects a compact summary of older turns so we
 * don't waste tokens while preserving recent context fully.
 *
 * Strategy:
 *   - ≤ 24 messages   → pass all
 *   - 25–40 messages  → keep last 16 + summary of the rest
 *   - > 40 messages   → keep last 12 + condensed summary
 */
function buildContextMessages(messages) {
  const total = messages.length;

  if (total <= 24) return messages;

  let keepCount = total <= 40 ? 16 : 12;
  const recent = messages.slice(-keepCount);
  const older  = messages.slice(0, -keepCount);

  // Build a lightweight summary from the older user turns
  const userTurns = older
    .filter(m => m.role === 'user')
    .slice(-5)
    .map(m => '• ' + m.content.slice(0, 120).replace(/\n/g, ' '))
    .join('\n');

  const summaryText =
    `[Earlier conversation summary — ${older.length} messages, ${
      Math.round(older.reduce((acc, m) => acc + (m.content || '').length, 0) / 1000)
    }k chars]\n` +
    `Recent user requests:\n${userTurns}\n` +
    `[End of summary — full recent context follows]`;

  return [
    { role: 'user',      content: summaryText },
    { role: 'assistant', content: 'Understood. I have the context from our earlier conversation.' },
    ...recent,
  ];
}

// ── Handlers ───────────────────────────────────────────────────────────────

async function sendMessage(req, res) {
  const { message, session_id, model, attachments } = req.body;

  if (!message && !(attachments && attachments.length)) {
    return res.status(400).json({ error: 'Missing message' });
  }

  const sessionId = session_id || uuidv4();

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      owner_id: req.user ? req.user.id : null,
      title: generateTitle(message),
      messages: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  const session = sessions.get(sessionId);

  // Ownership check — when auth is on, users can't post to each other's sessions
  if (!canAccessSession(session, req.user)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  // Stamp owner if it was missing (legacy session + authed user)
  if (req.user && !session.owner_id) session.owner_id = req.user.id;

  // Auto-title from first user message
  if (session.messages.filter(m => m.role === 'user').length === 0 && message) {
    session.title = generateTitle(message);
  }

  // Build user message — attachments are saved to disk and referenced by path
  // (DeepSeek models do not support image_url content type; vision is handled
  //  via the image_analyze Python tool which calls Anthropic/OpenAI APIs)
  let userContent = message || '';
  const attachmentNotes = [];

  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      if (att.type && att.type.startsWith('image/') && att.data) {
        // Save base64 image to uploads/images/
        try {
          const ext = att.name.split('.').pop() || 'jpg';
          const filename = `${Date.now()}-${uuidv4().slice(0, 8)}.${ext}`;
          // Store in session-specific subdirectory to prevent cross-session discovery
          const sessionImagesDir = path.join(UPLOADS_IMAGES_DIR, sessionId.slice(0, 12));
          fs.mkdirSync(sessionImagesDir, { recursive: true });
          const imgPath = path.join(sessionImagesDir, filename);
          fs.writeFileSync(imgPath, Buffer.from(att.data, 'base64'));
          attachmentNotes.push(
            `[Image attached: "${att.name}" → saved at ${imgPath}]\n` +
            `Use the image_analyze tool with path="${imgPath}" to see and describe this image.`
          );
          logger.info(`Saved image attachment: ${imgPath}`);
        } catch (saveErr) {
          logger.error('Failed to save image attachment', saveErr);
          attachmentNotes.push(`[Image "${att.name}" could not be saved: ${saveErr.message}]`);
        }
      } else if (att.text) {
        // Text file — inline content (truncated to keep tokens reasonable)
        const snippet = att.text.length > 40_000
          ? att.text.slice(0, 40_000) + '\n… [truncated]'
          : att.text;
        attachmentNotes.push(`[Attached file: ${att.name}]\n\`\`\`\n${snippet}\n\`\`\``);
      } else if (att.path) {
        attachmentNotes.push(`[File available at: ${att.path}]`);
      }
    }
  }

  if (attachmentNotes.length > 0) {
    userContent = (userContent ? userContent + '\n\n' : '') + attachmentNotes.join('\n\n');
  }

  session.messages.push({ role: 'user', content: userContent });
  session.updated_at = new Date().toISOString();
  saveSession(session);

  // Abort any previously running loop for this session (e.g. user sent new message)
  const prevController = sessionAbortControllers.get(sessionId);
  if (prevController) {
    prevController.abort();
    sessionAbortControllers.delete(sessionId);
  }
  const abortController = new AbortController();
  sessionAbortControllers.set(sessionId, abortController);

  const ws = getWsForSession(sessionId);
  res.json({ session_id: sessionId, status: 'processing', title: session.title });

  // Run agent loop async — events stream via WebSocket
  setImmediate(async () => {
    try {
      const onEvent = (event) => {
        // Re-resolve WS each event in case it reconnected
        const activeWs = getWsForSession(sessionId);
        if (activeWs && activeWs.readyState === 1) {
          try { activeWs.send(JSON.stringify({ session_id: sessionId, ...event })); } catch {}
        }
        if (event.type === 'tool_call') {
          logger.tool(`[${sessionId}] Tool: ${event.tool}(${JSON.stringify(event.args).slice(0, 100)})`);
        }
      };

      const contextMessages = buildContextMessages(session.messages);

      const result = await runAgentLoop({
        messages: contextMessages,
        agentType: null,
        model: model || null,
        onEvent,
        signal: abortController.signal,
        maxRounds: 50,
        ownerId:    req.user ? req.user.id    : null,
        ownerEmail: req.user ? req.user.email : null,
      });

      // Only persist if we got actual content
      if (result.content) {
        session.messages.push({ role: 'assistant', content: result.content });
        session.updated_at = new Date().toISOString();
        saveSession(session);
      }

      if (ws && ws.readyState === 1) {
        try {
          ws.send(JSON.stringify({
            session_id: sessionId,
            type: 'final',
            content: result.content,
            rounds: result.rounds,
            usage: result.usage,
          }));
        } catch {}
      }

      logger.info(`[${sessionId}] Completed in ${result.rounds} rounds`);
    } catch (err) {
      logger.error(`[${sessionId}] Agent loop failed`, err);
      const activeWs = getWsForSession(sessionId);
      if (activeWs && activeWs.readyState === 1) {
        try {
          activeWs.send(JSON.stringify({
            session_id: sessionId,
            type: 'error',
            error: err.message,
          }));
        } catch {}
      }
    } finally {
      // Clean up abort controller if it's still ours
      if (sessionAbortControllers.get(sessionId) === abortController) {
        sessionAbortControllers.delete(sessionId);
      }
    }
  });
}

function listSessions(req, res) {
  const list = Array.from(sessions.values())
    .filter(s => canAccessSession(s, req.user))
    .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))
    .map(s => ({
      id: s.id,
      title: s.title || 'New conversation',
      created_at: s.created_at,
      updated_at: s.updated_at || s.created_at,
      message_count: s.messages.length,
      pinned: !!s.pinned,
      pinned_at: s.pinned_at || null,
      last_message: s.messages.length > 0
        ? (typeof s.messages[s.messages.length - 1].content === 'string'
            ? s.messages[s.messages.length - 1].content.slice(0, 100)
            : '[attachment]')
        : null,
    }));
  res.json({ sessions: list });
}

function getSession(req, res) {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!canAccessSession(session, req.user)) return res.status(403).json({ error: 'Forbidden' });
  // Return session but strip large base64 attachments from messages
  const sanitized = {
    ...session,
    messages: session.messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content
        : '[multipart content]',
    })),
  };
  res.json(sanitized);
}

// Handles BOTH rename (title) and pin toggle (pinned). The frontend uses
// a single PATCH /api/chat/sessions/:sessionId for both — kept this way so
// we don't need to add a separate route just for a one-bit toggle.
function renameSession(req, res) {
  const { sessionId } = req.params;
  const { title, pinned } = req.body || {};
  if (title === undefined && pinned === undefined) {
    return res.status(400).json({ error: 'Missing title or pinned' });
  }
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!canAccessSession(session, req.user)) return res.status(403).json({ error: 'Forbidden' });

  if (typeof title === 'string') {
    session.title = title.slice(0, 100);
  }
  if (typeof pinned === 'boolean') {
    session.pinned    = pinned;
    session.pinned_at = pinned ? new Date().toISOString() : null;
  }
  saveSession(session);
  res.json({
    id:        sessionId,
    title:     session.title,
    pinned:    !!session.pinned,
    pinned_at: session.pinned_at || null,
  });
}

function deleteSession(req, res) {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!canAccessSession(session, req.user)) return res.status(403).json({ error: 'Forbidden' });
  sessions.delete(sessionId);
  try { fs.unlinkSync(sessionPath(sessionId)); } catch {}
  res.json({ deleted: true });
}

// Non-HTTP helper used by websocket.js to enforce session ownership on
// WebSocket attach. Returns:
//   undefined  → session doesn't exist (caller should allow — it's fresh)
//   null       → session exists but has no owner (legacy / open-mode)
//   string     → owner user id
function peekSessionOwner(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return undefined;
  return s.owner_id || null;
}

module.exports = { sendMessage, listSessions, getSession, renameSession, deleteSession, peekSessionOwner };
