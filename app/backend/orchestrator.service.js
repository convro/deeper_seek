'use strict';

/**
 * orchestrator.service.js
 * - Executes Python tools via subprocess
 * - Builds tool definitions for the DeepSeek API
 * - Manages async agent state
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');

const PROJECT_ROOT = path.join(__dirname, '../..');
const TOOL_EXECUTOR = path.join(PROJECT_ROOT, 'system/tool_executor.py');
const TOOLS_CONFIG = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, 'config/tools.json'), 'utf-8')
);
const AGENTS_CONFIG = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, 'config/agents.json'), 'utf-8')
);

// In-memory agent state (per process — not persisted between restarts)
const agentRegistry = new Map();

/**
 * Execute a single tool via Python subprocess.
 */
async function executeTool(toolName, args = {}, onEvent = null, context = {}) {
  return new Promise((resolve) => {
    const input = JSON.stringify({ tool: toolName, args });
    const timeout = TOOLS_CONFIG.tool_registry[toolName]?.timeout_ms || 60000;

    // Propagate current-user context to Python subprocess so tools like
    // workspace_create can stamp owner_id into job metadata, and internal
    // token so tools like agent_spawn can call back into the authed backend.
    const subEnv = {
      ...process.env,
      DEEPERSEEK_BACKEND_URL: `http://127.0.0.1:${process.env.PORT || 3000}`,
    };
    try {
      const authService = require('./auth.service');
      subEnv.DEEPERSEEK_INTERNAL_TOKEN = authService.getInternalToken();
    } catch {}
    if (context.ownerId)    subEnv.DEEPERSEEK_CURRENT_USER_ID = String(context.ownerId);
    if (context.ownerEmail) subEnv.DEEPERSEEK_CURRENT_USER_EMAIL = String(context.ownerEmail);

    const proc = spawn('python3', [TOOL_EXECUTOR], {
      cwd: PROJECT_ROOT,
      env: subEnv,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeout);

    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    proc.stdin.write(input);
    proc.stdin.end();

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (timedOut) {
        const result = {
          status: 'error',
          result: null,
          error: `Tool '${toolName}' timed out after ${timeout}ms`,
          metadata: { tool: toolName },
        };
        logger.error(`Tool timeout: ${toolName}`);
        return resolve(result);
      }

      if (stderr) {
        logger.debug(`Tool stderr (${toolName}): ${stderr.slice(0, 500)}`);
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch (e) {
        // If JSON parse fails but we have output, wrap it as a text result
        const rawOut = stdout.trim();
        if (rawOut) {
          logger.warn(`Tool ${toolName} returned non-JSON output, wrapping as text`);
          parsed = {
            status: 'ok',
            result: rawOut.slice(0, 8000),
            error: null,
            metadata: { tool: toolName, raw: true },
          };
        } else {
          logger.error(`Tool ${toolName} returned no output. stderr: ${stderr.slice(0, 300)}`);
          parsed = {
            status: 'error',
            result: null,
            error: stderr
              ? `Tool produced no output. stderr: ${stderr.slice(0, 400)}`
              : 'Tool produced no output and no error details.',
            metadata: { tool: toolName },
          };
        }
      }

      // Truncate oversized results to prevent token exhaustion
      const MAX_RESULT_CHARS = 60_000;
      const resultStr = JSON.stringify(parsed.result);
      if (resultStr.length > MAX_RESULT_CHARS) {
        logger.warn(`Tool ${toolName} result truncated from ${resultStr.length} to ${MAX_RESULT_CHARS} chars`);
        parsed = {
          ...parsed,
          result: resultStr.slice(0, MAX_RESULT_CHARS) + '\n… [output truncated to 60k chars]',
          metadata: { ...parsed.metadata, truncated: true, original_length: resultStr.length },
        };
      }

      resolve(parsed);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      logger.error(`Tool process error (${toolName})`, err);
      resolve({
        status: 'error',
        result: null,
        error: `Process error: ${err.message}`,
        metadata: { tool: toolName },
      });
    });
  });
}

/**
 * Spawn a sub-agent asynchronously or synchronously.
 * Called by the /api/agents/spawn endpoint (and by agent_spawn.py tool).
 */
async function spawnAgent({ agentType, task, context = '', asyncMode = false, jobId = null, parentWs = null, ownerId = null, ownerEmail = null }) {
  const agentId = uuidv4();
  const agentConf = AGENTS_CONFIG.agents[agentType];

  if (!agentConf) {
    throw new Error(`Unknown agent type: ${agentType}`);
  }

  const agentRecord = {
    id: agentId,
    type: agentType,
    task,
    status: 'running',
    started_at: new Date().toISOString(),
    completed_at: null,
    result: null,
    error: null,
    events: [],
    owner_id:    ownerId    || null,
    owner_email: ownerEmail || null,
  };

  agentRegistry.set(agentId, agentRecord);
  logger.agent(`Spawned agent ${agentId} (${agentType}): ${task.slice(0, 100)}`);

  // Build agent messages
  const messages = [
    {
      role: 'user',
      content: context
        ? `${task}\n\n---\nContext:\n${context}`
        : task,
    },
  ];

  // Collect events for this agent
  const agentEvents = [];
  const onEvent = (event) => {
    agentRecord.events.push(event);
    agentEvents.push(event);
    // Forward to parent WebSocket if available
    if (parentWs && parentWs.readyState === 1) {
      try {
        parentWs.send(JSON.stringify({ agent_id: agentId, agent_type: agentType, ...event }));
      } catch {}
    }
  };

  const runFn = async () => {
    try {
      const { runAgentLoop } = require('./llm.service');
      const result = await runAgentLoop({
        messages,
        agentType,
        model: agentConf.model,
        onEvent,
        maxRounds: 30,
        ownerId,
        ownerEmail,
      });

      agentRecord.status = 'completed';
      agentRecord.completed_at = new Date().toISOString();
      agentRecord.result = result;
      logger.agent(`Agent ${agentId} completed in ${result.rounds} rounds`);
      return result;
    } catch (err) {
      agentRecord.status = 'failed';
      agentRecord.completed_at = new Date().toISOString();
      agentRecord.error = err.message;
      logger.error(`Agent ${agentId} failed`, err);
      throw err;
    }
  };

  if (asyncMode) {
    // Start in background, return immediately
    setImmediate(runFn);
    return { agent_id: agentId, status: 'running', async_mode: true };
  } else {
    // Wait for result
    const result = await runFn();
    return {
      agent_id: agentId,
      status: 'completed',
      result: result.content,
      rounds: result.rounds,
      usage: result.usage,
    };
  }
}

function canAccessAgent(agent, user) {
  if (!agent) return false;
  if (!user)                  return !agent.owner_id;   // open mode
  if (user.role === 'admin')  return true;
  if (!agent.owner_id)        return true;               // legacy untagged
  return agent.owner_id === user.id;
}

function getAgentStatus(agentId, user = null) {
  const agent = agentRegistry.get(agentId);
  if (!agent) return null;
  if (!canAccessAgent(agent, user)) return null;

  const progress = agent.events.filter(e => e.type === 'tool_call').length;

  return {
    agent_id: agentId,
    type: agent.type,
    status: agent.status,
    started_at: agent.started_at,
    completed_at: agent.completed_at,
    result: agent.result ? agent.result.content : null,
    error: agent.error,
    tool_calls: progress,
    event_count: agent.events.length,
  };
}

function listAgents(user = null) {
  return Array.from(agentRegistry.values())
    .filter(a => canAccessAgent(a, user))
    .map(a => ({
      id: a.id,
      type: a.type,
      status: a.status,
      started_at: a.started_at,
      completed_at: a.completed_at,
      task_preview: a.task.slice(0, 100),
    }));
}

function killAgent(agentId, user = null) {
  const agent = agentRegistry.get(agentId);
  if (!agent) return false;
  if (!canAccessAgent(agent, user)) return false;
  agent.status = 'killed';
  agent.completed_at = new Date().toISOString();
  return true;
}

/**
 * Build OpenAI-compatible tool definitions from tools.json config.
 */
function buildToolDefinitions() {
  const registry = TOOLS_CONFIG.tool_registry;
  return Object.entries(registry).map(([name, conf]) => ({
    type: 'function',
    function: {
      name,
      description: conf.description,
      parameters: {
        type: 'object',
        properties: conf.parameters || {},
        required: conf.required || [],
      },
    },
  }));
}

module.exports = {
  executeTool,
  spawnAgent,
  getAgentStatus,
  listAgents,
  killAgent,
  buildToolDefinitions,
};
