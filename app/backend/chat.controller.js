'use strict';

const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { runAgentLoop } = require('./llm.service');
const { sendEvent } = require('./websocket');
const logger = require('./logger');
const soulService = require('./soul.service');
const githubService = require('./github.service');

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

  res.json({ session_id: sessionId, status: 'processing', title: session.title });

  // Run agent loop async — events stream via WebSocket (buffered across
  // drops via sendEvent).
  setImmediate(async () => {
    try {
      const onEvent = (event) => {
        sendEvent(sessionId, event);
        if (event.type === 'tool_call') {
          logger.tool(`[${sessionId}] Tool: ${event.tool}(${JSON.stringify(event.args).slice(0, 100)})`);
        }
      };

      const contextMessages = buildContextMessages(session.messages);
      const userSettings = soulService.getUserSettings(req.user?.id);

      // Build GitHub context block if this session has a linked repo
      let githubContext = null;
      if (session.github_repo) {
        const username = req.user?.id ? soulService.getUserSettings(req.user.id).github_username : '';
        githubContext = githubService.buildContextBlock({
          repo:          session.github_repo,
          branch:        session.github_branch || 'main',
          workspacePath: session.github_workspace || null,
          username:      username || '',
        });
      }

      const result = await runAgentLoop({
        messages: contextMessages,
        agentType: null,
        model: model || null,
        onEvent,
        signal: abortController.signal,
        maxRounds: 50,
        ownerId:    req.user ? req.user.id    : null,
        ownerEmail: req.user ? req.user.email : null,
        userSettings,
        githubContext,
      });

      // Only persist if we got actual content
      if (result.content) {
        session.messages.push({ role: 'assistant', content: result.content });
        session.updated_at = new Date().toISOString();
        saveSession(session);
      }

      sendEvent(sessionId, {
        type: 'final',
        content: result.content,
        rounds: result.rounds,
        usage: result.usage,
      });

      logger.info(`[${sessionId}] Completed in ${result.rounds} rounds`);
    } catch (err) {
      logger.error(`[${sessionId}] Agent loop failed`, err);
      sendEvent(sessionId, { type: 'error', error: err.message });
    } finally {
      // Clean up abort controller if it's still ours
      if (sessionAbortControllers.get(sessionId) === abortController) {
        sessionAbortControllers.delete(sessionId);
      }
    }
  });
}

/**
 * Silent regenerate — re-runs the agent loop for the most recent user turn
 * WITHOUT adding a new visible user bubble (ChatGPT / Claude-style retry).
 *
 * Behavior:
 *   - Pops trailing assistant messages from session history.
 *   - If feedback is provided, it is appended to the context as an ephemeral
 *     user note (NOT persisted to session.messages) so the model sees the
 *     correction but nothing new shows up in the transcript.
 *   - Streams events on the same per-session WebSocket as sendMessage.
 */
async function regenerate(req, res) {
  const { session_id, feedback, model } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  const session = sessions.get(session_id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!canAccessSession(session, req.user)) return res.status(403).json({ error: 'Forbidden' });

  // Need at least one user turn to regenerate from.
  const hasUser = session.messages.some(m => m.role === 'user');
  if (!hasUser) return res.status(400).json({ error: 'Nothing to regenerate — no prior user turn' });

  // Pop trailing assistant message(s) — we want the model to re-answer the
  // last user turn, not append to an existing assistant turn.
  while (session.messages.length > 0 &&
         session.messages[session.messages.length - 1].role === 'assistant') {
    session.messages.pop();
  }
  session.updated_at = new Date().toISOString();
  saveSession(session);

  // Abort any previously running loop for this session
  const prevController = sessionAbortControllers.get(session_id);
  if (prevController) {
    prevController.abort();
    sessionAbortControllers.delete(session_id);
  }
  const abortController = new AbortController();
  sessionAbortControllers.set(session_id, abortController);

  res.json({ session_id, status: 'regenerating' });

  setImmediate(async () => {
    try {
      const onEvent = (event) => { sendEvent(session_id, event); };

      // Build context from persisted history, then append ephemeral feedback
      // as an untracked user note so the regenerate has guidance without
      // polluting the visible transcript.
      let contextMessages = buildContextMessages(session.messages);
      const fb = typeof feedback === 'string' ? feedback.trim() : '';
      if (fb) {
        contextMessages = [
          ...contextMessages,
          {
            role: 'user',
            content:
              '[system / silent-retry] Użytkownik prosi o ponowne wygenerowanie poprzedniej odpowiedzi. ' +
              'Ta wiadomość nie jest widoczna w interfejsie — traktuj ją jako wewnętrzną wskazówkę.\n' +
              'Co ma być lepsze tym razem:\n' + fb,
          },
        ];
      } else {
        contextMessages = [
          ...contextMessages,
          {
            role: 'user',
            content:
              '[system / silent-retry] Wygeneruj ponownie odpowiedź na ostatnie pytanie użytkownika. ' +
              'Ta wiadomość nie jest widoczna w UI — traktuj ją jako wewnętrzny sygnał do retry. ' +
              'Odpowiedz świeżo, bez kopiowania poprzedniej próby.',
          },
        ];
      }

      const regenUserSettings = soulService.getUserSettings(req.user?.id);
      let regenGithubContext = null;
      if (session.github_repo) {
        const uname = req.user?.id ? soulService.getUserSettings(req.user.id).github_username : '';
        regenGithubContext = githubService.buildContextBlock({
          repo:          session.github_repo,
          branch:        session.github_branch || 'main',
          workspacePath: session.github_workspace || null,
          username:      uname || '',
        });
      }
      const result = await runAgentLoop({
        messages: contextMessages,
        agentType: null,
        model: model || null,
        onEvent,
        signal: abortController.signal,
        maxRounds: 50,
        ownerId:    req.user ? req.user.id    : null,
        ownerEmail: req.user ? req.user.email : null,
        userSettings: regenUserSettings,
        githubContext: regenGithubContext,
      });

      if (result.content) {
        session.messages.push({ role: 'assistant', content: result.content });
        session.updated_at = new Date().toISOString();
        saveSession(session);
      }

      sendEvent(session_id, {
        type: 'final',
        content: result.content,
        rounds: result.rounds,
        usage: result.usage,
      });
      logger.info(`[${session_id}] Regenerate completed in ${result.rounds} rounds`);
    } catch (err) {
      logger.error(`[${session_id}] Regenerate failed`, err);
      sendEvent(session_id, { type: 'error', error: err.message });
    } finally {
      if (sessionAbortControllers.get(session_id) === abortController) {
        sessionAbortControllers.delete(session_id);
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
      github_repo:   s.github_repo   || null,
      github_branch: s.github_branch || null,
      last_message: s.messages.length > 0
        ? (typeof s.messages[s.messages.length - 1].content === 'string'
            ? s.messages[s.messages.length - 1].content.slice(0, 100)
            : '[attachment]')
        : null,
    }));
  res.json({ sessions: list });
}

/**
 * Link or unlink a GitHub repo+branch to this session.
 * PATCH /api/chat/sessions/:sessionId/github
 * Body: { repo: "owner/name", branch: "main" } to link
 *       { repo: null }                          to unlink
 */
function linkGithubRepo(req, res) {
  const { sessionId } = req.params;
  const { repo, branch } = req.body || {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!canAccessSession(session, req.user)) return res.status(403).json({ error: 'Forbidden' });

  if (repo) {
    session.github_repo   = String(repo).trim();
    session.github_branch = String(branch || 'main').trim();
  } else {
    delete session.github_repo;
    delete session.github_branch;
    delete session.github_workspace;
  }
  session.updated_at = new Date().toISOString();
  saveSession(session);

  res.json({
    id:            sessionId,
    github_repo:   session.github_repo   || null,
    github_branch: session.github_branch || null,
  });
}

function getSession(req, res) {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!canAccessSession(session, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const sanitized = {
    ...session,
    messages: session.messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content
        : '[multipart content]',
    })),
    github_repo:   session.github_repo   || null,
    github_branch: session.github_branch || null,
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

module.exports = { sendMessage, regenerate, listSessions, getSession, renameSession, deleteSession, peekSessionOwner, linkGithubRepo };
