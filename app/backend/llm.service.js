'use strict';

/**
 * llm.service.js — DeepSeek API integration via OpenAI-compatible client.
 *
 * Uses streaming (stream: true) so text appears word-by-word in the UI.
 * Tool call chunks are accumulated across deltas and processed after the
 * stream ends. Reasoning (DeepSeek-R1) is also streamed in real-time.
 */

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { executeTool, buildToolDefinitions } = require('./orchestrator.service');

const BASE_URL = 'https://api.deepseek.com';

// Timeout budgets
const LOOP_TIMEOUT_MS     = 20 * 60 * 1000; // 20 min overall budget per loop
const API_CALL_TIMEOUT_MS =  5 * 60 * 1000; // 5 min per single API call (streaming)
const LOOP_DETECTION_WINDOW = 8;
const LOOP_DETECTION_MAX    = 3;

function createClient() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set in environment');
  return new OpenAI({ apiKey, baseURL: BASE_URL });
}

/**
 * Load the assembled system prompt.
 */
function loadSystemPrompt(agentType = null) {
  const projectRoot = path.join(__dirname, '../..');
  const basePath = path.join(projectRoot, 'runtime/base_prompt.txt');
  let systemPrompt = fs.readFileSync(basePath, 'utf-8');

  if (agentType) {
    const identityPath = path.join(projectRoot, `ai/agents/${agentType}/identity.txt`);
    if (fs.existsSync(identityPath)) {
      systemPrompt = `${fs.readFileSync(identityPath, 'utf-8')}\n\n---\n\n${systemPrompt}`;
    }
  }

  return systemPrompt;
}

/**
 * Main agentic loop — streaming edition.
 *
 * Each API call uses stream: true so text reaches the frontend word-by-word
 * via `content_delta` / `reasoning_delta` WebSocket events.
 * Tool-call chunks are accumulated across the stream and executed after the
 * response stream closes.
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

  const agentConfig = agentType
    ? JSON.parse(fs.readFileSync(path.join(__dirname, '../../config/agents.json'), 'utf-8'))
        .agents[agentType]
    : null;

  const selectedModel = model || agentConfig?.model || sysConfig.llm.models.orchestrator;
  const temperature   = agentConfig?.temperature ?? sysConfig.llm.defaults.temperature;
  const maxTokens     = agentConfig?.max_tokens   ?? sysConfig.llm.defaults.max_tokens;

  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };
  let rounds = 0;
  let finalContent = '';
  const loopDeadline = Date.now() + LOOP_TIMEOUT_MS;
  const recentToolSignatures = [];

  emit(onEvent, { type: 'llm_start', model: selectedModel, agent: agentType });

  while (rounds < maxRounds) {

    // ── Overall timeout guard ───────────────────────────────────────────
    if (Date.now() > loopDeadline) {
      logger.warn(`Agent loop overall timeout after ${rounds} rounds`);
      emit(onEvent, {
        type: 'error',
        error: 'Agent timeout: exceeded 20-minute time budget. Try breaking the task into smaller steps.',
      });
      finalContent = finalContent || 'The task timed out. Please try a more focused request.';
      emit(onEvent, { type: 'done', content: finalContent, rounds, usage: totalUsage });
      break;
    }

    // ── External abort check ────────────────────────────────────────────
    if (signal?.aborted) {
      emit(onEvent, { type: 'error', error: 'Aborted by caller' });
      break;
    }

    rounds++;
    logger.debug(`Agent loop round ${rounds}/${maxRounds} — model: ${selectedModel}`);

    // ── Streaming accumulators ──────────────────────────────────────────
    let msgContent      = '';
    let msgReasoning    = '';
    const tcAccum       = {};   // index → { id, name, arguments }
    let finishReason    = null;

    // ── API call with retry on transient network errors ─────────────────
    const RETRYABLE = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
    const MAX_RETRIES = 3;
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      attempt++;

      // Fresh accumulators on each retry
      msgContent   = '';
      msgReasoning = '';
      Object.keys(tcAccum).forEach(k => delete tcAccum[k]);
      finishReason = null;

      const callController = new AbortController();
      const callTimer = setTimeout(() => callController.abort(), API_CALL_TIMEOUT_MS);
      if (signal) signal.addEventListener('abort', () => callController.abort(), { once: true });

      let retryThis = false;

      try {
        const stream = await client.chat.completions.create({
          model:          selectedModel,
          messages:       fullMessages,
          tools:          toolDefs.length > 0 ? toolDefs : undefined,
          tool_choice:    toolDefs.length > 0 ? 'auto'  : undefined,
          temperature,
          max_tokens:     maxTokens,
          stream:         true,
          stream_options: { include_usage: true },
        }, { signal: callController.signal });

        for await (const chunk of stream) {
          if (callController.signal.aborted || signal?.aborted) break;

          if (chunk.usage) {
            totalUsage.prompt_tokens     += chunk.usage.prompt_tokens     || 0;
            totalUsage.completion_tokens += chunk.usage.completion_tokens || 0;
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          finishReason = choice.finish_reason || finishReason;
          const delta = choice.delta || {};

          if (delta.content) {
            msgContent  += delta.content;
            finalContent = msgContent;
            emit(onEvent, { type: 'content_delta', delta: delta.content });
          }

          if (delta.reasoning_content) {
            msgReasoning += delta.reasoning_content;
            emit(onEvent, { type: 'reasoning_delta', delta: delta.reasoning_content });
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!tcAccum[idx]) tcAccum[idx] = { id: '', name: '', arguments: '' };
              if (tc.id)                   tcAccum[idx].id        = tc.id;
              if (tc.function?.name)       tcAccum[idx].name     += tc.function.name;
              if (tc.function?.arguments)  tcAccum[idx].arguments += tc.function.arguments;
            }
          }
        }

      } catch (err) {
        clearTimeout(callTimer);

        // Abort / timeout
        if (err.name === 'AbortError' || err.code === 'ERR_CANCELED' || callController.signal.aborted) {
          const msg = `DeepSeek API call timed out after ${API_CALL_TIMEOUT_MS / 60000} minutes`;
          logger.error(msg);
          emit(onEvent, { type: 'error', error: msg });
          finalContent = finalContent || 'Request timed out. Please try again or break the task into smaller steps.';
          emit(onEvent, { type: 'done', content: finalContent, rounds, usage: totalUsage });
          return { content: finalContent, usage: totalUsage, rounds }; // exit loop entirely
        }

        // Transient network error — retry silently with backoff
        if (RETRYABLE.has(err.code) && attempt < MAX_RETRIES) {
          const delay = attempt * 1000;
          logger.warn(`Network error (${err.code}), retry ${attempt}/${MAX_RETRIES - 1} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          retryThis = true;
        } else {
          // Non-retryable or exhausted retries
          logger.error('DeepSeek API error', err);
          const friendlyMsg = RETRYABLE.has(err.code)
            ? `Connection to DeepSeek was reset (${err.code}). Please try again.`
            : err.message;
          emit(onEvent, { type: 'error', error: friendlyMsg });
          finalContent = finalContent || '';
          emit(onEvent, { type: 'done', content: finalContent, rounds, usage: totalUsage });
          return { content: finalContent, usage: totalUsage, rounds }; // exit loop entirely
        }
      } finally {
        clearTimeout(callTimer);
      }

      if (!retryThis) break; // success — exit retry loop
    }

    // ── Build tool_calls array from accumulated deltas ──────────────────
    const toolCalls = Object.keys(tcAccum).length > 0
      ? Object.values(tcAccum).map(tc => ({
          id:   tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }))
      : null;

    // ── Emit full content snapshot for backward compat (sub-agents etc.) ─
    if (msgContent)   emit(onEvent, { type: 'content',   content:  msgContent   });
    if (msgReasoning) emit(onEvent, { type: 'reasoning', content:  msgReasoning });

    // ── No tool calls → generation complete ────────────────────────────
    if (!toolCalls || toolCalls.length === 0) {
      emit(onEvent, { type: 'done', content: finalContent, rounds, usage: totalUsage });
      break;
    }

    // ── Add assistant turn to history ───────────────────────────────────
    fullMessages.push({
      role:       'assistant',
      content:    msgContent || null,
      tool_calls: toolCalls,
    });

    // ── Execute each tool call ──────────────────────────────────────────
    const toolResults  = [];
    let loopDetected   = false;

    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      let toolArgs = {};
      try { toolArgs = JSON.parse(toolCall.function.arguments); } catch {}

      // ── Loop detection ──────────────────────────────────────────────
      const sig = `${toolName}:${JSON.stringify(toolArgs)}`;
      recentToolSignatures.push(sig);
      if (recentToolSignatures.length > LOOP_DETECTION_WINDOW * 2) {
        recentToolSignatures.splice(0, recentToolSignatures.length - LOOP_DETECTION_WINDOW * 2);
      }
      const window     = recentToolSignatures.slice(-LOOP_DETECTION_WINDOW);
      const repeatCount = window.filter(s => s === sig).length;
      if (repeatCount >= LOOP_DETECTION_MAX) {
        logger.warn(`Loop detected: ${toolName} called ${repeatCount}× with identical args`);
        emit(onEvent, {
          type:  'error',
          error: `Loop detected: ${toolName} was called ${repeatCount}× with the same arguments. Stopping to prevent runaway execution.`,
        });
        finalContent = finalContent || 'Execution loop detected. The task has been stopped.';
        emit(onEvent, { type: 'done', content: finalContent, rounds, usage: totalUsage });
        loopDetected = true;
        break;
      }
      // ──────────────────────────────────────────────────────────────────

      emit(onEvent, { type: 'tool_call', tool: toolName, args: toolArgs, call_id: toolCall.id });
      logger.tool(`Calling tool: ${toolName}(${JSON.stringify(toolArgs).slice(0, 200)})`);

      const toolResult = await executeTool(toolName, toolArgs, onEvent);

      emit(onEvent, {
        type:        'tool_result',
        tool:        toolName,
        call_id:     toolCall.id,
        status:      toolResult.status,
        result:      toolResult.result,
        error:       toolResult.error,
        duration_ms: toolResult.metadata?.duration_ms,
      });
      logger.tool(`Tool result: ${toolName} → ${toolResult.status}`);

      toolResults.push({
        role:         'tool',
        tool_call_id: toolCall.id,
        content:      JSON.stringify(toolResult, null, 2),
      });
    }

    if (loopDetected) break;

    fullMessages.push(...toolResults);

    // Standard stop condition (finish_reason=stop with no tool calls already handled above)
    if (finishReason === 'stop' && (!toolCalls || toolCalls.length === 0)) {
      break;
    }
  }

  if (rounds >= maxRounds) {
    logger.warn(`Max rounds reached: ${maxRounds}`);
    finalContent = finalContent || `Reached maximum tool-call rounds (${maxRounds}). Try a more focused task.`;
    emit(onEvent, { type: 'done', content: finalContent, rounds, usage: totalUsage });
  }

  return { content: finalContent, usage: totalUsage, rounds };
}

function runAgentLoopStreaming(params) {
  return runAgentLoop(params);
}

function emit(onEvent, event) {
  if (typeof onEvent === 'function') {
    try { onEvent(event); } catch (e) { logger.error('Event emit error', e); }
  }
}

module.exports = { runAgentLoop, runAgentLoopStreaming, loadSystemPrompt };
