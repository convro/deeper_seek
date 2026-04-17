'use strict';

const WebSocket = require('ws');
const logger = require('./logger');
const authService = require('./auth.service');

const wss = { server: null };
// sessionId → WebSocket
const sessionSockets = new Map();
// ws → sessionId
const socketSessions = new Map();

// ── Per-session event replay buffer ─────────────────────────────────────
// When a WebSocket drops mid-turn (flaky network, browser tab backgrounded,
// mobile suspension) and reconnects, the agent loop keeps streaming events
// on the server — but those events fired into a dead socket with no listener
// to catch them. The buffer caches the last N events per session so the
// reconnecting client can catch up on missed activity.
//
// Buffer bounds:
//   - Up to REPLAY_BUFFER_MAX entries per session
//   - Entries older than REPLAY_BUFFER_TTL_MS are discarded on read
//   - We DON'T cache heartbeats / pings / raw streaming deltas (too noisy,
//     and the UI can tolerate missing word-by-word frames — final content
//     arrives in the 'done'/'final' event)
const REPLAY_BUFFER_MAX    = 200;
const REPLAY_BUFFER_TTL_MS = 2 * 60 * 1000;
const REPLAY_SKIP = new Set([
  'pong', 'ping', 'connected', 'disconnected',
  'content_delta', 'reasoning_delta',
]);
const sessionEventBuffer = new Map(); // sessionId → Array<{ ts, payload }>

function bufferEvent(sessionId, payloadStr) {
  let parsed;
  try { parsed = JSON.parse(payloadStr); } catch { return; }
  const t = parsed && parsed.type;
  if (!t || REPLAY_SKIP.has(t)) return;
  const arr = sessionEventBuffer.get(sessionId) || [];
  arr.push({ ts: Date.now(), payload: payloadStr });
  if (arr.length > REPLAY_BUFFER_MAX) arr.splice(0, arr.length - REPLAY_BUFFER_MAX);
  sessionEventBuffer.set(sessionId, arr);
}

function replayBuffered(sessionId, ws) {
  const arr = sessionEventBuffer.get(sessionId);
  if (!arr || arr.length === 0) return;
  const cutoff = Date.now() - REPLAY_BUFFER_TTL_MS;
  const fresh = arr.filter(e => e.ts >= cutoff);
  if (fresh.length !== arr.length) sessionEventBuffer.set(sessionId, fresh);
  if (fresh.length === 0) return;
  try {
    ws.send(JSON.stringify({ type: 'replay_start', count: fresh.length }));
    for (const e of fresh) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(e.payload);
    }
    ws.send(JSON.stringify({ type: 'replay_end' }));
    logger.ws(`Replayed ${fresh.length} buffered events for session=${sessionId}`);
  } catch {}
}

// Periodic cleanup — drops entire session buffers that are entirely stale.
setInterval(() => {
  const cutoff = Date.now() - REPLAY_BUFFER_TTL_MS;
  for (const [sid, arr] of sessionEventBuffer) {
    const fresh = arr.filter(e => e.ts >= cutoff);
    if (fresh.length === 0) sessionEventBuffer.delete(sid);
    else if (fresh.length !== arr.length) sessionEventBuffer.set(sid, fresh);
  }
}, 60_000).unref?.();

function initWebSocket(httpServer) {
  wss.server = new WebSocket.Server({
    server: httpServer,
    path: '/ws',
    // Disable built-in per-message compression to reduce overhead
    perMessageDeflate: false,
  });

  // Server-side heartbeat: ping all clients every 30s.
  // Terminate any client that hasn't responded to the previous ping.
  const heartbeatInterval = setInterval(() => {
    wss.server.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  wss.server.on('close', () => clearInterval(heartbeatInterval));

  wss.server.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const url = new URL(req.url, `http://localhost`);
    const sessionId = url.searchParams.get('session_id') || `anon-${Date.now()}`;
    const tokenParam = url.searchParams.get('token');

    // Auth: in multi_user mode, a valid bearer token is required.
    // In 'open' mode, any connection is accepted (legacy behavior).
    const mode = authService.getAuthMode();
    let wsUser = null;
    if (mode === 'multi_user') {
      const accessKey = process.env.ACCESS_KEY;
      if (accessKey && url.searchParams.get('key') === accessKey) {
        wsUser = { id: '__api_key__', role: 'admin', via: 'api_key' };
      } else if (tokenParam) {
        const u = authService.verifyToken(tokenParam);
        if (u) wsUser = { ...authService.publicUser(u), via: 'token' };
      }
      if (!wsUser) {
        try {
          ws.send(JSON.stringify({ type: 'error', error: 'Authentication required', code: 'AUTH_REQUIRED' }));
        } catch {}
        ws.close(4401, 'Unauthorized');
        return;
      }

      // Session ownership check: if the client requested to attach to an
      // existing session_id, verify they own it. This prevents a user from
      // spying on another account's live event stream by guessing a uuid.
      if (url.searchParams.get('session_id')) {
        try {
          const { peekSessionOwner } = require('./chat.controller');
          const ownerId = peekSessionOwner(sessionId);
          // ownerId === undefined → session doesn't exist yet (new WS connect
          // for a fresh session the user is about to create — allow it)
          if (ownerId !== undefined && ownerId !== null &&
              wsUser.role !== 'admin' && ownerId !== wsUser.id) {
            try {
              ws.send(JSON.stringify({ type: 'error', error: 'Forbidden', code: 'FORBIDDEN' }));
            } catch {}
            ws.close(4403, 'Forbidden');
            return;
          }
        } catch {}
      }
    } else if (process.env.ACCESS_KEY) {
      // 'open' mode but legacy ACCESS_KEY is set → still enforce it
      if (url.searchParams.get('key') !== process.env.ACCESS_KEY) {
        try {
          ws.send(JSON.stringify({ type: 'error', error: 'Unauthorized' }));
        } catch {}
        ws.close(4401, 'Unauthorized');
        return;
      }
    }
    ws.user = wsUser;

    // If another socket was attached to this session (reconnect), close it
    // cleanly before we replace it. Avoids double-delivery of events.
    const prior = sessionSockets.get(sessionId);
    if (prior && prior !== ws && prior.readyState === WebSocket.OPEN) {
      try { prior.close(4000, 'Replaced by new connection'); } catch {}
    }

    sessionSockets.set(sessionId, ws);
    socketSessions.set(ws, sessionId);

    logger.ws(`WebSocket connected: session=${sessionId}${wsUser ? ` user=${wsUser.email || wsUser.id}` : ''}`);

    ws.send(JSON.stringify({
      type: 'connected',
      session_id: sessionId,
      message: 'DeeperSeek WebSocket ready',
    }));

    // Replay any events that were emitted while the client was disconnected.
    replayBuffered(sessionId, ws);

    ws.on('message', (raw) => {
      ws.isAlive = true; // any message = connection alive
      try {
        const msg = JSON.parse(raw.toString());
        handleClientMessage(ws, sessionId, msg);
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
      sessionSockets.delete(sessionId);
      socketSessions.delete(ws);
      logger.ws(`WebSocket disconnected: session=${sessionId}`);
    });

    ws.on('error', (err) => {
      logger.error(`WebSocket error (${sessionId})`, err);
    });
  });

  logger.info('WebSocket server initialized');
}

function handleClientMessage(ws, sessionId, msg) {
  switch (msg.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', session_id: sessionId }));
      break;

    case 'chat': {
      // Handle chat message directly via WebSocket (alternative to HTTP)
      const { message, model } = msg;
      if (!message) return;

      const { runAgentLoop } = require('./llm.service');
      const { v4: uuidv4 } = require('uuid');

      const onEvent = (event) => { sendEvent(sessionId, event); };

      runAgentLoop({
        messages: [{ role: 'user', content: message }],
        model: model || null,
        onEvent,
        maxRounds: 50,
        ownerId:    ws.user ? ws.user.id    : null,
        ownerEmail: ws.user ? ws.user.email : null,
      }).then(result => {
        sendEvent(sessionId, {
          type: 'final',
          content: result.content,
          rounds: result.rounds,
          usage: result.usage,
        });
      }).catch(err => {
        sendEvent(sessionId, { type: 'error', error: err.message });
      });
      break;
    }

    default:
      logger.ws(`Unknown message type: ${msg.type}`);
  }
}

function getWsForSession(sessionId) {
  return sessionSockets.get(sessionId) || null;
}

/**
 * Buffer-aware event send for a session.
 *
 * Always records the event into the per-session replay buffer (except the
 * noisy types in REPLAY_SKIP), then forwards to the currently-attached
 * socket if it is open. If no socket is attached — e.g. client dropped
 * mid-turn — the event still survives in the buffer and is replayed to
 * the next connection for up to REPLAY_BUFFER_TTL_MS.
 *
 * Returns true if the event was delivered to a live socket, false if it
 * was only buffered.
 */
function sendEvent(sessionId, eventObj) {
  const payload = JSON.stringify({ session_id: sessionId, ...eventObj });
  bufferEvent(sessionId, payload);
  const ws = sessionSockets.get(sessionId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(payload);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function broadcastToAll(event) {
  if (!wss.server) return;
  wss.server.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  });
}

module.exports = { initWebSocket, getWsForSession, sendEvent, broadcastToAll };
