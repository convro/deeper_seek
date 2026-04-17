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
const soulService = require('./soul.service');

const BASE_URL = 'https://api.deepseek.com';

// Timeout budgets
const LOOP_TIMEOUT_MS     = 20 * 60 * 1000; // 20 min overall budget per loop
const API_CALL_TIMEOUT_MS =  5 * 60 * 1000; // 5 min per single API call (streaming)
const LOOP_DETECTION_WINDOW = 12;
const LOOP_DETECTION_MAX    = 6;
// Polling tools (e.g. agent_status) are inherently repetitive — higher threshold
const POLLING_TOOLS = new Set(['agent_status']);
const POLLING_LOOP_MAX = 15;

function createClient() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set in environment');
  return new OpenAI({ apiKey, baseURL: BASE_URL });
}

/**
 * Load the assembled system prompt.
 *
 * Composition order (outer → inner):
 *   [user's soul profile, if any]
 *   ---
 *   [agent identity, if agentType was passed]
 *   ---
 *   [runtime/base_prompt.txt — the default persona + tool rules]
 *
 * The soul goes first so the model reads "who am I talking to" before
 * "who am I being" — tone/vocabulary calibration happens up-front rather
 * than as an afterthought.
 */
function loadSystemPrompt(agentType = null, ownerId = null) {
  const projectRoot = path.join(__dirname, '../..');
  const basePath = path.join(projectRoot, 'runtime/base_prompt.txt');
  let systemPrompt = fs.readFileSync(basePath, 'utf-8');

  if (agentType) {
    const identityPath = path.join(projectRoot, `ai/agents/${agentType}/identity.txt`);
    if (fs.existsSync(identityPath)) {
      systemPrompt = `${fs.readFileSync(identityPath, 'utf-8')}\n\n---\n\n${systemPrompt}`;
    }
  }

  if (ownerId) {
    const soul = soulService.renderSoulPrompt(ownerId);
    if (soul) {
      systemPrompt = `${soul}\n\n---\n\n${systemPrompt}`;
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
  ownerId = null,
  ownerEmail = null,
}) {
  const client = createClient();
  const systemPrompt = loadSystemPrompt(agentType, ownerId);
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
  // Cap on how many times we silently nudge the model to continue after a
  // text-only round. Prevents an infinite "I'll do X… ok, doing it…" loop.
  const MAX_TEXT_ONLY_CONTINUATIONS = 2;
  let consecutiveTextOnly = 0;

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

    // ── No tool calls → either real completion, or a "promised next step"
    //    that the model failed to actually execute. We try to detect the
    //    second case and nudge the model to continue (without polluting
    //    the user-visible stream). The nudge is internal — the assistant
    //    bubble keeps streaming, no separator message appears in the UI. ─
    if (!toolCalls || toolCalls.length === 0) {
      const tail = (msgContent || '').trim();
      const tailLower = tail.slice(-400).toLowerCase();

      // Heuristics for "I will do X next" without doing it. PL + EN markers,
      // colon/ellipsis endings, and "next step" phrasing.
      const continuationMarkers = /(\b(let me|i'?ll (now|then|next|go|just|first|start)|now i (will|need|should|am)|next[, ]+(i|let|step)|then i (will|need)|i am going to|i'?m going to|next step|first[, ]+i|kontynuuj|teraz (zrobi|sprawdz|wywoła|wywołam|odpal|odpalę|spr[óo]buj|przygotow|napisz)|sprawdz[ęe]|zaraz (zrobi|sprawdz|spr[óo]buj|odpal)|chwil[ae]|moment[, ]+|ok[ae]j[, ]+(sprawdz|zr[óo]b|teraz|zaraz)|w nast[ęe]pnym kroku|nast[ęe]pny krok|robi[ęe] to (teraz|zaraz)|przechodz[ęe] do|przejd[źz]my do)\b)/i;
      const trailingHook = /[…:]\s*$|\.{3}\s*$|→\s*$/;
      const looksLikeContinuation =
        tail.length > 0 &&
        consecutiveTextOnly < MAX_TEXT_ONLY_CONTINUATIONS &&
        rounds < maxRounds &&
        finishReason !== 'length' &&
        (continuationMarkers.test(tailLower) || trailingHook.test(tail));

      if (looksLikeContinuation) {
        consecutiveTextOnly++;
        logger.debug(`Text-only round ${rounds} looks like a continuation (${consecutiveTextOnly}/${MAX_TEXT_ONLY_CONTINUATIONS}); nudging model to actually call the tools.`);
        // Push the assistant text as-is so the model sees what it just said,
        // then add a system-style nudge as a synthetic user turn telling it
        // to follow through. This stays out of the user's chat history —
        // the assistant bubble is unchanged on the frontend, and the
        // synthetic turn lives only in fullMessages.
        fullMessages.push({ role: 'assistant', content: msgContent });
        fullMessages.push({
          role: 'user',
          content:
            '[system / continuation-guard] Twoja poprzednia odpowiedź zapowiadała kolejny krok ' +
            '(np. „zrobię…", „sprawdzę…", „teraz…", "next…", "let me…"), ale nie wywołałeś żadnego ' +
            'tool calla. Kontynuuj NATYCHMIAST: wywołaj zapowiedziane narzędzia w TEJ odpowiedzi. ' +
            'Możesz krótko (1 linijka) powiedzieć co robisz i od razu wywołać tool. Nie kończ tury ' +
            'samym tekstem. Jeśli nie ma już nic do zrobienia — napisz krótkie podsumowanie, bez zapowiedzi.',
        });
        continue; // re-enter loop; same pendingMsgId on the frontend → keeps streaming into the same bubble
      }

      // Genuine completion (or we exhausted continuation nudges)
      emit(onEvent, { type: 'done', content: finalContent, rounds, usage: totalUsage });
      break;
    }

    // Real tool-call round — reset the text-only continuation counter
    consecutiveTextOnly = 0;

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
      const sigWindow   = recentToolSignatures.slice(-LOOP_DETECTION_WINDOW);
      const repeatCount = sigWindow.filter(s => s === sig).length;
      const maxAllowed  = POLLING_TOOLS.has(toolName) ? POLLING_LOOP_MAX : LOOP_DETECTION_MAX;
      if (repeatCount >= maxAllowed) {
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

      const toolResult = await executeTool(toolName, toolArgs, onEvent, { ownerId, ownerEmail });

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
