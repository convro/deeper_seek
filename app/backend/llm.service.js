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

  emit(onEvent, { type: 'llm_start', model: selectedModel, agent: agentType });

  while (rounds < maxRounds) {
    rounds++;
    logger.debug(`Agent loop round ${rounds}/${maxRounds} — model: ${selectedModel}`);

    // Call DeepSeek API
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
      });
    } catch (err) {
      logger.error('DeepSeek API error', err);
      emit(onEvent, { type: 'error', error: err.message });
      throw err;
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
    for (const toolCall of message.tool_calls) {
      const toolName = toolCall.function.name;
      let toolArgs = {};
      try {
        toolArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        toolArgs = {};
      }

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
  }

  return { content: finalContent, usage: totalUsage, rounds };
}

/**
 * Stream version — sends token-by-token via SSE-style callbacks.
 * Uses streaming API but still handles tool calls.
 */
async function runAgentLoopStreaming({
  messages,
  agentType = null,
  model = null,
  onEvent = null,
  signal = null,
  maxRounds = 50,
}) {
  // For simplicity, use non-streaming internally but emit events as chunks arrive
  // Full streaming with tool calls is complex — this gives real-time events via onEvent
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
