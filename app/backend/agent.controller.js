'use strict';

const { spawnAgent, getAgentStatus, listAgents, killAgent } = require('./orchestrator.service');
const { getWsForSession } = require('./websocket');
const logger = require('./logger');

async function spawn(req, res) {
  const { agent_type, task, context, async_mode, job_id, session_id } = req.body;

  if (!agent_type || !task) {
    return res.status(400).json({ error: 'Missing agent_type or task' });
  }

  try {
    const ws = session_id ? getWsForSession(session_id) : null;

    const result = await spawnAgent({
      agentType: agent_type,
      task,
      context: context || '',
      asyncMode: async_mode || false,
      jobId: job_id || null,
      parentWs: ws,
    });

    res.json(result);
  } catch (err) {
    logger.error('Agent spawn failed', err);
    res.status(500).json({ error: err.message });
  }
}

function status(req, res) {
  const { agentId } = req.params;
  const agentStatus = getAgentStatus(agentId);
  if (!agentStatus) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  res.json(agentStatus);
}

function list(req, res) {
  res.json({ agents: listAgents() });
}

function kill(req, res) {
  const { agentId } = req.params;
  const killed = killAgent(agentId);
  if (!killed) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  res.json({ killed: true, agent_id: agentId });
}

module.exports = { spawn, status, list, kill };
