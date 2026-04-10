'use strict';

/**
 * llm.service.js — DeepSeek API integration via OpenAI-compatible client.
 * Handles streaming, tool calling, and the full agentic loop.
 */

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { executeTool, buildToolDefinitions } = require('./orchestrator.service');

const BASE_URL = 'https://api.deepseek.com';

// Timeout budgets
const LOOP_TIMEOUT_MS    = 8 * 60 * 1000;  // 8 min overall budget per loop
const API_CALL_TIMEOUT_MS = 3 * 60 * 1000; // 3 min per single API call
const LOOP_DETECTION_WINDOW = 8;            // check last N tool calls for repeats
const LOOP_DETECTION_MAX    = 3;            // abort if same signature seen ≥ this many times

function createClient() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set in environment');
  return new OpenAI({ apiKey, baseURL: BASE_URL });
}

/**
 * Load the assembled system prompt.
 * Combines base_prompt.txt with any agent-specific identity file.
 */
function loadSystemPrompt(agentType = null) {
  const projectRoot = path.join(__dirname, '../..');

  const basePath = path.join(projectRoot, 'runtime/base_prompt.txt');
  let systemPrompt = fs.readFileSync(basePath, 'utf-8');

  if (agentType) {
    const identityPath = path.join(projectRoot, `ai/agents/${agentType}/identity.txt`);
    if (fs.existsSync(identityPath)) {
      const identity = fs.readFileSync(identityPath, 'utf-8');
      systemPrompt = `${identity}\n\n---\n\n${systemPrompt}`;
    }
  }

  return systemPrompt;
}

/**
 * Main agentic loop: send messages to DeepSeek, handle tool calls, stream events.
 * Includes per-call timeout, overall loop timeout, and loop detection.
 *
 * @param {Object} params
 * @param {Array}  params.messages      - Conversation history [{role, content}]
 * @param {string} params.agentType     - Agent type (null = orchestrator)
 * @param {string} params.model         - Model override
 * @param {Function} params.onEvent     - Callback for streaming events
 * @param {AbortSignal} params.signal   - Optional abort signal
 * @param {number} params.maxRounds     - Max tool call rounds
 * @returns {Object} { content, usage, rounds }
 */
async function runAgentLoop({
  messages,
  agentType = null,
  model = null,
  onEvent = null,
  signal = null,
  maxRounds = 50,
}) {
  const client = createClient();
  const systemPrompt = loadSystemPrompt(agentType);
  const toolDefs = buildToolDefinitions();
  const sysConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../config/system.json'), 'utf-8')
  );

  // Determine model
  const agentConfig = agentType
    ? JSON.parse(fs.readFileSync(path.join(__dirname, '../../config/agents.json'), 'utf-8'))
        .agents[agentType]
    : null;

  const selectedModel = model
    || agentConfig?.model
    || sysConfig.llm.models.orchestrator;

  const temperature = agentConfig?.temperature ?? sysConfig.llm.defaults.temperature;
  const maxTokens = agentConfig?.max_tokens ?? sysConfig.llm.defaults.max_tokens;

  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };
  let rounds = 0;
  let finalContent = '';

  // Overall loop deadline
  const loopDeadline = Date.now() + LOOP_TIMEOUT_MS;

  // Loop-detection: track recent tool call signatures
  const recentToolSignatures = [];

  emit(onEvent, { type: 'llm_start', model: selectedModel, agent: agentType });

  while (rounds < maxRounds) {

    // ── Overall timeout guard ───────────────────────────────────────────
    if (Date.now() > loopDeadline) {
      logger.warn(`Agent loop overall timeout after ${rounds} rounds`);
      emit(onEvent, {
        type: 'error',
        error: 'Agent timeout: exceeded 8-minute time budget. Task may need to be broken into smaller steps.',
      });
      if (!finalContent) {
        finalContent = 'The task timed out. Please try breaking it into smaller, more focused steps.';
      }
      emit(onEvent, { type: 'done', content: finalContent, rounds, usage: totalUsage });
      break;
    }

    // ── Check external abort signal ─────────────────────────────────────
    if (signal?.aborted) {
      emit(onEvent, { type: 'error', error: 'Aborted by caller' });
      break;
    }

    rounds++;
    logger.debug(`Agent loop round ${rounds}/${maxRounds} — model: ${selectedModel}`);

    // ── API call with per-call timeout ──────────────────────────────────
    const callController = new AbortController();
    const callTimer = setTimeout(() => {
      callController.abort();
    }, API_CALL_TIMEOUT_MS);

    // Also respect the parent abort signal
    if (signal) {
      signal.addEventListener('abort', () => callController.abort(), { once: true });
    }

    let response;
    try {
      response = await client.chat.completions.create({
        model: selectedModel,
        messages: fullMessages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        tool_choice: toolDefs.length > 0 ? 'auto' : undefined,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }, { signal: callController.signal });
    } catch (err) {
      clearTimeout(callTimer);
      if (err.name === 'AbortError' || err.code === 'ERR_CANCELED' || callController.signal.aborted) {
        const timeoutMsg = 'DeepSeek API call timed out after 3 minutes';
        logger.error(timeoutMsg);
        emit(onEvent, { type: 'error', error: timeoutMsg });
        finalContent = finalContent || 'The request timed out while waiting for the AI. Please try again.';
        emit(onEvent, { type: 'done', content: finalContent, rounds, usage: totalUsage });
        break;
      }
      logger.error('DeepSeek API error', err);
      emit(onEvent, { type: 'error', error: err.message });
      throw err;
    } finally {
      clearTimeout(callTimer);
    }

    const choice = response.choices[0];
    const message = choice.message;

    if (response.usage) {
      totalUsage.prompt_tokens += response.usage.prompt_tokens || 0;
      totalUsage.completion_tokens += response.usage.completion_tokens || 0;
    }

    // Emit text content if present
    if (message.content) {
      finalContent = message.content;
      emit(onEvent, { type: 'content', content: message.content });
    }

    // Check for reasoning content (DeepSeek-R1)
    if (message.reasoning_content) {
      emit(onEvent, { type: 'reasoning', content: message.reasoning_content });
    }

    // If no tool calls → we're done
    if (!message.tool_calls || message.tool_calls.length === 0) {
      emit(onEvent, { type: 'done', content: finalContent, rounds, usage: totalUsage });
      break;
    }

    // Add assistant message with tool calls to history
    fullMessages.push(message);

    // Process each tool call
    const toolResults = [];
    let loopDetected = false;

    for (const toolCall of message.tool_calls) {
      const toolName = toolCall.function.name;
      let toolArgs = {};
      try {
        toolArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        toolArgs = {};
      }

      // ── Loop detection ────────────────────────────────────────────────
      const sig = `${toolName}:${JSON.stringify(toolArgs)}`;
      recentToolSignatures.push(sig);
      if (recentToolSignatures.length > LOOP_DETECTION_WINDOW * 2) {
        recentToolSignatures.splice(0, recentToolSignatures.length - LOOP_DETECTION_WINDOW * 2);
      }
      const window = recentToolSignatures.slice(-LOOP_DETECTION_WINDOW);
      const repeatCount = window.filter(s => s === sig).length;
      if (repeatCount >= LOOP_DETECTION_MAX) {
        logger.warn(`Loop detected: ${toolName} called ${repeatCount}x with identical args`);
        emit(onEvent, {
          type: 'error',
          error: `Execution loop detected: ${toolName} has been called ${repeatCount} times with the same arguments. Stopping to prevent runaway execution.`,
        });
        // Inject a stop message
        if (!finalContent) finalContent = 'A loop was detected in the execution. The task has been stopped.';
        emit(onEvent, { type: 'done', content: finalContent, rounds, usage: totalUsage });
        loopDetected = true;
        break;
      }
      // ──────────────────────────────────────────────────────────────────

      emit(onEvent, {
        type: 'tool_call',
        tool: toolName,
        args: toolArgs,
        call_id: toolCall.id,
      });
      logger.tool(`Calling tool: ${toolName}(${JSON.stringify(toolArgs).slice(0, 200)})`);

      const toolResult = await executeTool(toolName, toolArgs, onEvent);

      emit(onEvent, {
        type: 'tool_result',
        tool: toolName,
        call_id: toolCall.id,
        status: toolResult.status,
        result: toolResult.result,
        error: toolResult.error,
        duration_ms: toolResult.metadata?.duration_ms,
      });
      logger.tool(`Tool result: ${toolName} → ${toolResult.status}`);

      toolResults.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult, null, 2),
      });
    }

    if (loopDetected) break;

    // Add all tool results to message history
    fullMessages.push(...toolResults);

    // Check stop condition
    if (choice.finish_reason === 'stop' && (!message.tool_calls || message.tool_calls.length === 0)) {
      break;
    }
  }

  if (rounds >= maxRounds) {
    emit(onEvent, { type: 'max_rounds_reached', rounds });
    logger.warn(`Max rounds reached: ${maxRounds}`);
    if (!finalContent) finalContent = `Reached maximum tool call rounds (${maxRounds}). Please try a more focused task.`;
    emit(onEvent, { type: 'done', content: finalContent, rounds, usage: totalUsage });
  }

  return { content: finalContent, usage: totalUsage, rounds };
}

/**
 * Stream version — delegates to runAgentLoop (events emitted in real time via onEvent).
 */
async function runAgentLoopStreaming({
  messages,
  agentType = null,
  model = null,
  onEvent = null,
  signal = null,
  maxRounds = 50,
}) {
  return runAgentLoop({ messages, agentType, model, onEvent, signal, maxRounds });
}

function emit(onEvent, event) {
  if (typeof onEvent === 'function') {
    try {
      onEvent(event);
    } catch (e) {
      logger.error('Event emit error', e);
    }
  }
}

module.exports = { runAgentLoop, runAgentLoopStreaming, loadSystemPrompt };
