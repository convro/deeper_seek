'use strict';

const WebSocket = require('ws');
const logger = require('./logger');
const authService = require('./auth.service');

const wss = { server: null };
// sessionId → WebSocket
const sessionSockets = new Map();
// ws → sessionId
const socketSessions = new Map();

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

    sessionSockets.set(sessionId, ws);
    socketSessions.set(ws, sessionId);

    logger.ws(`WebSocket connected: session=${sessionId}${wsUser ? ` user=${wsUser.email || wsUser.id}` : ''}`);

    ws.send(JSON.stringify({
      type: 'connected',
      session_id: sessionId,
      message: 'DeeperSeek WebSocket ready',
    }));

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

      const onEvent = (event) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ session_id: sessionId, ...event }));
        }
      };

      runAgentLoop({
        messages: [{ role: 'user', content: message }],
        model: model || null,
        onEvent,
        maxRounds: 50,
        ownerId:    ws.user ? ws.user.id    : null,
        ownerEmail: ws.user ? ws.user.email : null,
      }).then(result => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            session_id: sessionId,
            type: 'final',
            content: result.content,
            rounds: result.rounds,
            usage: result.usage,
          }));
        }
      }).catch(err => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ session_id: sessionId, type: 'error', error: err.message }));
        }
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

function broadcastToAll(event) {
  if (!wss.server) return;
  wss.server.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  });
}

module.exports = { initWebSocket, getWsForSession, broadcastToAll };
