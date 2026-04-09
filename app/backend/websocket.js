'use strict';

const WebSocket = require('ws');
const logger = require('./logger');

const wss = { server: null };
// sessionId → WebSocket
const sessionSockets = new Map();
// ws → sessionId
const socketSessions = new Map();

function initWebSocket(httpServer) {
  wss.server = new WebSocket.Server({ server: httpServer, path: '/ws' });

  wss.server.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://localhost`);
    const sessionId = url.searchParams.get('session_id') || `anon-${Date.now()}`;

    sessionSockets.set(sessionId, ws);
    socketSessions.set(ws, sessionId);

    logger.ws(`WebSocket connected: session=${sessionId}`);

    ws.send(JSON.stringify({
      type: 'connected',
      session_id: sessionId,
      message: 'DeeperSeek WebSocket ready',
    }));

    ws.on('message', (raw) => {
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
