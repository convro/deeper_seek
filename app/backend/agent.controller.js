'use strict';

const { spawnAgent, getAgentStatus, listAgents, killAgent } = require('./orchestrator.service');
const logger = require('./logger');

async function spawn(req, res) {
  const { agent_type, task, context, async_mode, job_id, session_id, no_limits } = req.body;

  if (!agent_type || !task) {
    return res.status(400).json({ error: 'Missing agent_type or task' });
  }

  try {
    const result = await spawnAgent({
      agentType: agent_type,
      task,
      context: context || '',
      asyncMode: async_mode || false,
      jobId: job_id || null,
      // Passing sessionId (instead of a raw WS handle) lets the orchestrator
      // route events through sendEvent, which survives the client's WS drops.
      parentSessionId: session_id || null,
      ownerId:    req.user ? req.user.id    : null,
      ownerEmail: req.user ? req.user.email : null,
      noLimits:   no_limits === true,
    });

    res.json(result);
  } catch (err) {
    logger.error('Agent spawn failed', err);
    res.status(500).json({ error: err.message });
  }
}

function status(req, res) {
  const { agentId } = req.params;
  const agentStatus = getAgentStatus(agentId, req.user);
  if (!agentStatus) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  res.json(agentStatus);
}

function list(req, res) {
  res.json({ agents: listAgents(req.user) });
}

function kill(req, res) {
  const { agentId } = req.params;
  const killed = killAgent(agentId, req.user);
  if (!killed) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  res.json({ killed: true, agent_id: agentId });
}

module.exports = { spawn, status, list, kill };
