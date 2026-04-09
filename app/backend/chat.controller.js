'use strict';

const { v4: uuidv4 } = require('uuid');
const { runAgentLoop } = require('./llm.service');
const { getWsForSession } = require('./websocket');
const logger = require('./logger');

// In-memory session store
const sessions = new Map();

async function sendMessage(req, res) {
  const { message, session_id, model } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Missing message' });
  }

  const sessionId = session_id || uuidv4();

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { id: sessionId, messages: [], created_at: new Date().toISOString() });
  }

  const session = sessions.get(sessionId);
  session.messages.push({ role: 'user', content: message });

  // Get WebSocket for this session (for streaming events)
  const ws = getWsForSession(sessionId);

  // Send immediate ack
  res.json({ session_id: sessionId, status: 'processing' });

  // Run agent loop asynchronously (events stream via WebSocket)
  setImmediate(async () => {
    try {
      const onEvent = (event) => {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ session_id: sessionId, ...event }));
        }
        // Log to system
        if (event.type === 'tool_call') {
          logger.tool(`[${sessionId}] Tool: ${event.tool}(${JSON.stringify(event.args).slice(0, 100)})`);
        }
      };

      const result = await runAgentLoop({
        messages: session.messages,
        agentType: null, // orchestrator
        model: model || null,
        onEvent,
        maxRounds: 50,
      });

      // Save assistant response to session
      session.messages.push({ role: 'assistant', content: result.content });

      // Send final message via WebSocket
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          session_id: sessionId,
          type: 'final',
          content: result.content,
          rounds: result.rounds,
          usage: result.usage,
        }));
      }

      logger.info(`[${sessionId}] Completed in ${result.rounds} rounds`);

    } catch (err) {
      logger.error(`[${sessionId}] Agent loop failed`, err);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          session_id: sessionId,
          type: 'error',
          error: err.message,
        }));
      }
    }
  });
}

function listSessions(req, res) {
  const list = Array.from(sessions.values()).map(s => ({
    id: s.id,
    created_at: s.created_at,
    message_count: s.messages.length,
    last_message: s.messages.length > 0
      ? s.messages[s.messages.length - 1].content.slice(0, 100)
      : null,
  }));
  res.json({ sessions: list });
}

function deleteSession(req, res) {
  const { sessionId } = req.params;
  if (sessions.has(sessionId)) {
    sessions.delete(sessionId);
    res.json({ deleted: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
}

module.exports = { sendMessage, listSessions, deleteSession };
