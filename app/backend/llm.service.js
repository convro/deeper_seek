'use strict';

/**
 * llm.service.js — DeepSeek API integration via OpenAI-compatible client.
 *
 * Uses streaming (stream: true) so text appears word-by-word in the UI.
 * Tool-call chunks are accumulated across deltas and processed after the
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
 *   ---
 *   [tool usage history for the session]
 *
 * The soul goes first so the model reads "who am I talking to" before
 * "who am I being" — tone/vocabulary calibration happens up-front rather
 * than as an afterthought.
 */
function loadSystemPrompt(agentType = null, ownerId = null, githubContext = null, toolHistoryText = null) {
  const projectRoot = path.join(__dirname, '../..');
  const basePath = path.join(projectRoot, 'runtime/base_prompt.txt');
  let systemPrompt = fs.readFileSync(basePath, 'utf-8');

  // Append GitHub workspace context when a repo is linked to the session
  if (githubContext) {
    systemPrompt = `${systemPrompt}\n\n---\n\n${githubContext}`;
  }

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

  // Append tool usage history if provided
  if (toolHistoryText) {
    systemPrompt = `${systemPrompt}\n\n---\n\n## 🛠️ ACTUAL TOOL USAGE (THIS SESSION - LIVE TRACKER):\n${toolHistoryText}\n\n## 🚨 CRITICAL RULE - NEVER HALLUCINATE TOOL USAGE:\n- You can ONLY reference tools that appear in the tracker above\n- If tracker is empty for a tool, you CANNOT claim you used it\n- If user questions your tool usage, CHECK THE TRACKER - it's the source of truth\n- Your credibility depends on matching claims with actual tool records\n- When you use a tool, it will be automatically added to this tracker\n- This tracker is updated in real-time - you can trust it completely`;
  }

  return systemPrompt;
}

/**
 * Extract final answer from reasoning content when model puts final output
 * into reasoning stream instead of content stream.
 * 
 * NEW IMPROVED HEURISTIC:
 * 1. If reasoning is short (≤ 3 lines) → use whole reasoning as final answer
 * 2. Look for conclusion markers (Therefore, So, Podsumowując, etc.)
 * 3. If marker found → take from marker to end
 * 4. If no marker → check if reasoning ends with what looks like a final answer
 *    (no step-by-step markers, ends with punctuation, looks complete)
 * 5. Default: use whole reasoning (better than empty)
 */
function extractFinalFromReasoning(reasoning) {
  if (!reasoning || reasoning.trim() === '') return reasoning;
  
  const markers = [
    // English
    'Therefore', 'So', 'Thus', 'Hence', 'In conclusion', 'To summarize',
    'Summary:', 'Answer:', 'Final answer:', 'The answer is', 'Here is',
    'Here\'s', 'Here are', 'Here we have', 'As a result',
    // Polish
    'Zatem', 'Więc', 'Dlatego', 'Podsumowując', 'Reasumując', 'Stąd',
    'Odpowiedź:', 'Podsumowanie:', 'Końcowa odpowiedź:', 'Wynik:',
    'Oto', 'Oto co', 'Tak więc', 'Z tego wynika'
  ];
  
  // Find last occurrence of any marker (case-insensitive)
  let lastPos = -1;
  let lastMarker = '';
  const reasoningLower = reasoning.toLowerCase();
  
  for (const marker of markers) {
    const pos = reasoningLower.lastIndexOf(marker.toLowerCase());
    if (pos > lastPos) {
      lastPos = pos;
      lastMarker = marker;
    }
  }
  
  if (lastPos >= 0) {
    // Take from the marker position (include marker)
    const from = lastPos;
    return reasoning.substring(from).trim();
  }
  
  // No marker found, maybe the whole reasoning is the final answer
  // Check if reasoning looks like a direct answer (short, no step-by-step)
  const lines = reasoning.split('\n').filter(l => l.trim().length > 0);
  if (lines.length <= 3) {
    // Short reasoning likely is the answer
    return reasoning.trim();
  }
  
  // Check if reasoning ends with what looks like a final conclusion
  const lastParagraph = lines[lines.length - 1];
  const looksLikeConclusion = 
    lastParagraph.endsWith('.') || 
    lastParagraph.endsWith('!') || 
    lastParagraph.endsWith('?') ||
    lastParagraph.includes('✅') ||
    lastParagraph.includes('🚀') ||
    lastParagraph.includes('🎯');
  
  if (looksLikeConclusion && lines.length <= 10) {
    // Last few paragraphs might be the final answer
    const fromIndex = Math.max(0, lines.length - 3);
    return lines.slice(fromIndex).join('\n').trim();
  }
  
  // Default: return reasoning as fallback (better than empty)
  return reasoning.trim();
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
  userSettings = {},
  githubContext = null,
  sessionId = null,
}) {
  const client = createClient();
  
  // Get tool history for this session if sessionId is provided
  let toolHistoryText = null;
  if (sessionId) {
    try {
      const { formatToolHistoryForPrompt } = require('./chat.controller');
      toolHistoryText = formatToolHistoryForPrompt(sessionId);
    } catch (err) {
      logger.error(`Failed to get tool history for session ${sessionId}:`, err);
    }
  }
  
  const systemPrompt = loadSystemPrompt(agentType, ownerId, githubContext, toolHistoryText);
  const toolDefs = buildToolDefinitions();
  const sysConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../config/system.json'), 'utf-8')
  );

  const agentConfig = agentType
    ? JSON.parse(fs.readFileSync(path.join(__dirname, '../../config/agents.json'), 'utf-8'))
        .agents[agentType]
    : null;

  // Model: Flash (default) or Pro depending on user setting.
  // Agents always use Flash for cost efficiency.
  // Thinking mode (chain-of-thought) is separate from model choice — controlled via API param.
  let selectedModel = model;
  if (!selectedModel) {
    if (agentType) {
      selectedModel = sysConfig.llm.models.worker; // always Flash for agents
    } else {
      selectedModel = userSettings.use_pro_model
        ? sysConfig.llm.models.pro   // deepseek-v4-pro
        : sysConfig.llm.models.worker; // deepseek-v4-flash
    }
  }

  // Thinking mode: V4 models support thinking/non-thinking via API parameter.
  // Extended thinking ON → thinking enabled (chain-of-thought before response)
  // Extended thinking OFF → thinking disabled (fast direct response)
  const thinkingEnabled = agentType
    ? (userSettings.agent_extended_thinking !== false)
    : (userSettings.extended_thinking !== false);

  const temperature   = agentConfig?.temperature ?? sysConfig.llm.defaults.temperature;
  const maxTokens     = agentConfig?.max_tokens   ?? sysConfig.llm.defaults.max_tokens;

  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, model: selectedModel };
  let rounds = 0;
  const loopDeadline = Date.now() + LOOP_TIMEOUT_MS;
  const recentToolSignatures = [];
  // Thinking mode needs fewer nudges (model is more decisive); direct mode needs more.
  const MAX_TEXT_ONLY_CONTINUATIONS = thinkingEnabled ? 2 : 5;
  let consecutiveTextOnly = 0;

  emit(onEvent, { type: 'llm_start', model: selectedModel, agent: agentType });

  let finalContent = '';

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
          thinking:       { type: thinkingEnabled ? 'enabled' : 'disabled' },
        }, { signal: callController.signal });

        for await (const chunk of stream) {
          if (callController.signal.aborted || signal?.aborted) break;

          if (chunk.usage) {
            totalUsage.prompt_tokens     += chunk.usage.prompt_tokens     || 0;
            totalUsage.completion_tokens += chunk.usage.completion_tokens || 0;
            totalUsage.cache_hit_tokens  += chunk.usage.prompt_cache_hit_tokens || 0;
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          finishReason = choice.finish_reason || finishReason;
          const delta = choice.delta || {};

          if (delta.content) {
            msgContent  += delta.content;
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

    // Accumulate this round's text into finalContent so the done event
    // always carries ALL text from ALL rounds, not just the last one.
    if (msgContent) finalContent += msgContent;

    // ── Build tool_calls array from accumulated deltas ──────────────────
    const toolCalls = Object.keys(tcAccum).length > 0
      ? Object.values(tcAccum).map(tc => ({
          id:   tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }))
      : null;

    // ── Emit full content snapshot for backward compat (sub-agents etc.) ─
    // Must use finalContent (cumulative across all rounds) not msgContent
    // (current round only) — the frontend handler replaces, so sending only
    // the current round's text would erase previous rounds from the bubble.

    // Emit content and reasoning as strictly separate streams.
    // reasoning_content is NEVER promoted to content — the two streams
    // are always kept apart regardless of length or content.
    const contentToEmit = finalContent;
    if (contentToEmit) emit(onEvent, { type: 'content', content: contentToEmit });
    if (msgReasoning) emit(onEvent, { type: 'reasoning', content: msgReasoning });

    // ── No tool calls → either real completion, or a "promised next step"
    //    that the model failed to actually execute. We try to detect the
    //    second case and nudge the model to continue (without polluting
    //    the user-visible stream). The nudge is internal — the assistant
    //    bubble keeps streaming, no separator message appears in the UI. ─
    if (!toolCalls || toolCalls.length === 0) {
      const tail = (msgContent || '').trim();
      const tailLower = tail.slice(-400).toLowerCase();

      // Heuristics for "I will do X next" without doing it.
      // Kept INTENTIONALLY narrow: the marker MUST pair an intention word
      // with a concrete tool-invocation verb. This avoids false positives
      // on benign phrases like "please let me know" or "I'll summarize".
      //
      // Tool-invocation verbs (EN): check, search, run, read, write, try,
      //   fix, verify, test, inspect, examine, investigate, look, see,
      //   fetch, query, grep, find, scan, build, compile, install, debug,
      //   call, spawn, execute, explore, probe, open, edit, patch, create,
      //   deploy, print, list
      // Tool-invocation verbs (PL): sprawdz, wywoła, odpal, uruchom,
      //   przetestuj, napisz, popraw, zbuduj, skompiluj, wyszuk, przeanali,
      //   przejrz, spróbuj, zrobi, wywołam, odpalę, uruchomię, wyślę,
      //   wykonam, deplo, zapisz, stwórz, utworz, otworz, otwórz
      const TOOL_VERB_EN =
        '(?:check|search|run|read|write|try|fix|verify|test|inspect|examine|' +
        'investigate|look|see|fetch|query|grep|find|scan|build|compile|install|' +
        'debug|call|spawn|execute|explore|probe|open|edit|patch|create|deploy|' +
        'print|list|pull|push|clone|commit|browse|crawl|parse|analy[sz]e|load|start)';
      // \w in JS regex (no `u` flag) matches only [A-Za-z0-9_] — it does
      // NOT match Polish diacritics (ą ć ę ł ń ó ś ź ż). We build an
      // explicit word-char class to cover verb suffixes like "sprawdzę".
      const PLW = '[a-zA-Z\\u00f3\\u0105\\u0107\\u0119\\u0142\\u0144\\u015B\\u017A\\u017C]';
      const TOOL_VERB_PL =
        `(?:sprawdz${PLW}*|wywoła${PLW}*|odpal${PLW}*|uruchom${PLW}*|przetestuj${PLW}*|napisz${PLW}*|` +
        `popraw${PLW}*|zbuduj${PLW}*|skompiluj${PLW}*|wyszuk${PLW}*|przeanaliz${PLW}*|przejrz${PLW}*|` +
        `spr[óo]buj${PLW}*|zrobi${PLW}*|wykonam|wykonaj${PLW}*|deploy${PLW}*|zapisz${PLW}*|` +
        `stw[óo]rz${PLW}*|utworz${PLW}*|otw[óo]rz${PLW}*|wy[śs]l[ęe]|pobierz${PLW}*|poka[żz]${PLW}*|` +
        `skanuj${PLW}*|przeszuk${PLW}*|dopisz${PLW}*|zaktualizuj${PLW}*|przeanalizuj${PLW}*)`;

      const continuationMarkers = new RegExp(
        '\\b(?:' +
          // English patterns — intent + tool verb in the SAME clause
          `(?:let me|let's|i['\\u2019]?ll|i will|i'?m going to|i am going to|i need to|` +
          `going to|now i['\\u2019]?ll|now i will|next[, ]+i['\\u2019]?ll|next[, ]+i will|` +
          `then i['\\u2019]?ll|then i will|first[, ]+i['\\u2019]?ll|i['\\u2019]?ll just|` +
          `i['\\u2019]?ll now|i['\\u2019]?ll go|i['\\u2019]?ll start|starting to)` +
          `\\s+(?:\\w+\\s+){0,3}${TOOL_VERB_EN}` +
        '|' +
          // Polish patterns — intent + tool verb
          `(?:teraz|zaraz|ju[żz]|w tej chwili|za chwil[ęe]|momencik|w nast[ęe]pnym kroku|` +
          `nast[ęe]pnie|w takim razie|okej[,]?|dobra[,]?|dobrze[,]?|musz[ęe]|powinienem|` +
          `zamierzam|id[ęe] zaraz|wi[ęe]c teraz|poczekaj[,]?)` +
          `\\s+(?:\\w+\\s+){0,3}${TOOL_VERB_PL}` +
        '|' +
          // Standalone first-person future verbs (PL) are strong signals alone
          `${TOOL_VERB_PL}\\s*(?:to|najpierw|teraz|zaraz|wszystko|plik|kod|repo)` +
        ')',
        'i'
      );

      // Trailing hooks — colon, ellipsis, arrow — indicate a promised step.
      // These are strong enough on their own without a marker.
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
        fullMessages.push({
          role: 'assistant',
          content: msgContent,
          ...(thinkingEnabled && msgReasoning ? { reasoning_content: msgReasoning } : {}),
        });
        fullMessages.push({
          role: 'user',
          content:
            '[system / continuation-guard] Twoja poprzednia odpowiedź zapowiadała kolejny krok ' +
            '(np. „zrobię…”, „sprawdzę…”, „teraz…”, "next…", "let me…"), ale nie wywołałeś żadnego ' +
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
      ...(thinkingEnabled && msgReasoning ? { reasoning_content: msgReasoning } : {}),
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

      const toolResult = await executeTool(toolName, toolArgs, onEvent, { ownerId, ownerEmail, sessionId });

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

      // Record tool usage in session history
      if (sessionId) {
        try {
          const { addToolToHistory } = require('./chat.controller');
          const resultSummary = toolResult.result 
            ? (typeof toolResult.result === 'string' 
                ? toolResult.result.slice(0, 200) 
                : JSON.stringify(toolResult.result).slice(0, 200))
            : '';
          addToolToHistory(sessionId, toolName, toolArgs, resultSummary, toolResult.status);
        } catch (err) {
          logger.error(`Failed to record tool usage for session ${sessionId}:`, err);
        }
      }

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