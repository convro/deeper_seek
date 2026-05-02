import { useState, useRef, useEffect, useMemo } from 'react';
import type { ChatMessage, ToolCallRecord, Attachment, LiveAgent } from './state';
import { generateLocalId } from './state';
import { Spinner, TypingDots, ThinkingBlock, ToolCallBadge } from './components';
import { Markdown, PreviewModal } from './markdown';

const OUTPUT_DIRS = '(?:output|dist|build|public|www|site|src)';
const JOB_ID      = '[a-zA-Z0-9_-]{4,}';

/** Extract workspace HTML file paths from AI response text. */
function extractHtmlPaths(content: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;

  // 1. Full: workspace/jobid/output/... (file or dir)
  const re1 = new RegExp(`workspace\\/(${JOB_ID})\\/(${OUTPUT_DIRS}\\/[^\\s\"')\\]\\`]*)`, 'g');
  while ((m = re1.exec(content)) !== null) {
    const seg = m[2].endsWith('.html') ? m[2] : m[2].replace(/\\/$/, '') + '/index.html';
    found.add(`workspace/${m[1]}/${seg}`);
  }

  // 2. workspace/jobid/ with no subdir — treat root as the output dir
  const re2 = new RegExp(`workspace\\/(${JOB_ID})\\/(?=[^a-zA-Z]|$)`, 'g');
  while ((m = re2.exec(content)) !== null) {
    found.add(`workspace/${m[1]}/output/index.html`);
  }

  // 3. Backtick: `jobid/output/...`
  const re3 = new RegExp(`\`(${JOB_ID})\\/(${OUTPUT_DIRS}\\/[^\`]*)\``, 'g');
  while ((m = re3.exec(content)) !== null) {
    const seg = m[2].endsWith('.html') ? m[2] : m[2].replace(/\\/$/, '') + '/index.html';
    found.add(`workspace/${m[1]}/${seg}`);
  }

  // 4. Backtick: `jobid/` shorthand
  const re4 = new RegExp(`\`(${JOB_ID})\\/\``, 'g');
  while ((m = re4.exec(content)) !== null) {
    found.add(`workspace/${m[1]}/output/index.html`);
  }

  return Array.from(found);
}

/**
 * Secondary path source: scan write_file / create_file tool calls.
 * This catches cases where the AI writes the files but doesn't mention
 * the workspace path in its final text (narration is optional).
 */
function extractPathsFromToolCalls(toolCalls: ToolCallRecord[]): string[] {
  const found = new Set<string>();
  const outputDirs = new RegExp(`/(${OUTPUT_DIRS})/`);

  for (const tc of toolCalls) {
    if (tc.status !== 'done') continue;
    const pathArg =
      (typeof tc.args?.path       === 'string' ? tc.args.path       : null) ||
      (typeof tc.args?.file_path  === 'string' ? tc.args.file_path  : null) ||
      (typeof tc.args?.filepath   === 'string' ? tc.args.filepath   : null) ||
      (typeof tc.args?.filename   === 'string' ? tc.args.filename   : null);
    if (!pathArg) continue;

    // Match workspace/{id}/output/... (absolute or relative)
    const rel = pathArg.replace(/^.*?workspace\//, 'workspace/');
    const m = rel.match(new RegExp(`workspace\\/(${JOB_ID})\\/(${OUTPUT_DIRS}\\/[\\s\\S]*)`));
    if (m) {
      const seg = m[2].endsWith('.html') ? m[2] : m[2].split('/').slice(0, 1).join('/') + '/index.html';
      found.add(`workspace/${m[1]}/${seg}`);
    }
  }

  return Array.from(found);
}

const ARCHIVE_RE = /\\.(zip|tar\\.gz|tar\\.bz2|tar\\.xz|tar|gz|bz2|7z|rar|pdf)$/i;

/** Detect downloadable files (zip, archive, pdf, …) in message text and tool results. */
function extractDownloadPaths(content: string, toolCalls?: ToolCallRecord[]): string[] {
  const found = new Set<string>();

  if (content) {
    const re = new RegExp(`workspace\\/(${JOB_ID})\\/[^\\s\"')\\]\\`<>]+`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (ARCHIVE_RE.test(m[0])) found.add(m[0]);
    }
    const rebt = new RegExp(`\`(workspace\\/(${JOB_ID})\\/[^\`]+)\``, 'g');
    while ((m = rebt.exec(content)) !== null) {
      if (ARCHIVE_RE.test(m[1])) found.add(m[1]);
    }
  }

  if (toolCalls) {
    for (const tc of toolCalls) {
      if (tc.status !== 'done') continue;
      const candidates: string[] = [];

      // Tool args
      for (const key of ['path', 'output_path', 'dest', 'file_path', 'filepath']) {
        const v = (tc.args as Record<string, unknown>)?.[key];
        if (typeof v === 'string') candidates.push(v);
      }

      // Tool result
      if (typeof tc.result === 'string') {
        const lines = tc.result.split('\n');
        for (const line of lines) {
          if (ARCHIVE_RE.test(line)) candidates.push(line.trim());
        }
      }

      for (const cand of candidates) {
        const rel = cand.replace(/^.*?workspace\//, 'workspace/');
        if (ARCHIVE_RE.test(rel)) found.add(rel);
      }
    }
  }

  return Array.from(found);
}

// ── Single message bubble ──────────────────────────────────────────────────

interface MessageBubbleProps {
  message: ChatMessage;
  onRetry?: (msgId: string) => void;
  onRetryWithFeedback?: (msgId: string, feedback: string) => void;
  liveAgents?: Map<string, LiveAgent>;
}

function MessageBubble({ message, onRetry, onRetryWithFeedback, liveAgents }: MessageBubbleProps) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  const isUser    = message.role === 'user';
  const isThinking = message.status === 'thinking';
  const isStreaming = message.status === 'streaming';
  const isDone    = message.status === 'done' || message.status === 'completed';
  const isError   = message.status === 'error';

  // Determine what content to show:
  // 1. If content exists and is reasonably complete (not just a short extract), use it
  // 2. If content is short (< 100 chars) and reasoning exists, use reasoning as main content
  // 3. Otherwise fall back to content or empty
  const contentToShow = (() => {
    if (!message.content && message.reasoning) {
      // No content at all, use reasoning
      return message.reasoning;
    }
    if (message.content && message.reasoning) {
      // Both exist - check if content looks like a short extract
      const contentLines = message.content.split('\n').filter(l => l.trim().length > 0);
      const reasoningLines = message.reasoning.split('\n').filter(l => l.trim().length > 0);
      
      // If content is very short (< 100 chars) and reasoning is much longer (> 3x)
      // likely content is just an extract, reasoning is the full answer
      if (message.content.length < 100 && message.reasoning.length > message.content.length * 3) {
        return message.reasoning;
      }
      
      // If content ends abruptly (no punctuation, ends with "...", "→", etc.)
      const endsAbruptly = /[…:]\\s*$|\\.{3}\\s*$|→\\s*$/.test(message.content.trim());
      if (endsAbruptly && reasoningLines.length > contentLines.length) {
        return message.reasoning;
      }
    }
    return message.content || '';
  })();

  const showReasoningSeparately = message.reasoning && contentToShow !== message.reasoning;

  const htmlPaths = useMemo(() => {
    const fromText  = message.content ? extractHtmlPaths(message.content) : [];
    const fromTools = message.toolCalls ? extractPathsFromToolCalls(message.toolCalls) : [];
    return [...new Set([...fromText, ...fromTools])];
  }, [message.content, message.toolCalls]);

  const downloadPaths = useMemo(() =>
    isDone || message.status === 'error'
      ? extractDownloadPaths(message.content || '', message.toolCalls)
      : []
  , [isDone, message.status, message.content, message.toolCalls]);

  const showActions = (isDone || message.status === 'error') && contentToShow;

  return (
    <>
    <div className={`msg-bubble ${isUser ? 'msg-user' : 'msg-ai'} ${isError ? 'msg-error' : ''}`}>
      <div className="msg-header">
        <div className="msg-role">
          {isUser ? 'Ty' : 'DeeperSeek'}
          {message.agent && <span className="msg-agent-tag">{message.agent}</span>}
        </div>
        {message.createdAt && (
          <div className="msg-time">
            {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
      </div>

      <div className="msg-body">
        {/* User text */}
        {isUser && message.content && (
          <div className="msg-user-text">{message.content}</div>
        )}

        {/* User attachments */}
        {isUser && message.attachments && message.attachments.length > 0 && (
          <div className="msg-attachments">
            {message.attachments.map((att) => (
              <div key={att.id} className="msg-attachment">
                {att.type.startsWith('image/') ? (
                  <img src={att.url} alt={att.name} className="msg-attachment-img" />
                ) : (
                  <div className="msg-attachment-file">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M9.5 1.75a.75.75 0 0 1 .75.75v8.5a.75.75 0 0 1-1.5 0V2.5a.75.75 0 0 1 .75-.75Z"/>
                      <path d="M5.47 7.47a.75.75 0 0 1 1.06 0l2.25 2.25a.75.75 0 1 1-1.06 1.06L7 9.06v4.19a.75.75 0 0 1-1.5 0V9.06L4.28 10.78a.75.75 0 1 1-1.06-1.06l2.25-2.25Z"/>
                    </svg>
                    <span>{att.name}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* AI thinking indicator */}
        {isThinking && (
          <div className="msg-thinking">
            <ThinkingBlock content={message.reasoning || ''} />
          </div>
        )}

        {/* Reasoning chain (collapsed by default) */}
        {showReasoningSeparately && !isThinking && (
          <ThinkingBlock content={message.reasoning} />
        )}

        {/* Content — rendered first so tool badges appear below streamed text */}
        {!isThinking && contentToShow && (
          <div className={`msg-ai-content ${isError ? 'msg-error' : ''}`}>
            <Markdown content={contentToShow} />
          </div>
        )}

        {/* Tool badges — after content so latest activity sits below the text */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="msg-tool-badges">
            {message.toolCalls.map(tc => (
              <ToolCallBadge
                key={tc.id}
                tc={tc}
                liveAgent={tc.spawnedAgentId ? liveAgents?.get(tc.spawnedAgentId) : undefined}
              />
            ))}
          </div>
        )}

        {/* Streaming cursor */}
        {message.status === 'streaming' && (
          <span className="msg-cursor" />
        )}

        {/* Action row: preview (HTML) + download (zip/archive/pdf) */}
        {(htmlPaths.length > 0 || downloadPaths.length > 0) && (
          <div className="msg-actions-row">
            {htmlPaths.map(p => (
              <button
                key={p}
                className="msg-action-preview"
                onClick={() => setPreviewSrc(`/${p}`)}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 2.75a5.25 5.25 0 0 0-5.25 5.25.75.75 0 0 1-1.5 0 6.75 6.75 0 1 1 13.5 0 .75.75 0 0 1-1.5 0A5.25 5.25 0 0 0 8 2.75Z"/>
                  <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM5.5 8a2.5 2.5 0 1 1 5 0 2.5 2.5 0 0 1-5 0Z"/>
                </svg>
                Preview
              </button>
            ))}
            {downloadPaths.map(p => (
              <a
                key={p}
                className="msg-action-download"
                href={`/${p}`}
                download
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M9.5 1.75a.75.75 0 0 1 .75.75v8.5a.75.75 0 0 1-1.5 0V2.5a.75.75 0 0 1 .75-.75Z"/>
                  <path d="M5.47 7.47a.75.75 0 0 1 1.06 0l2.25 2.25a.75.75 0 1 1-1.06 1.06L7 9.06v4.19a.75.75 0 0 1-1.5 0V9.06L4.28 10.78a.75.75 0 1 1-1.06-1.06l2.25-2.25Z"/>
                </svg>
                Download
              </a>
            ))}
          </div>
        )}

        {/* Action buttons: copy, retry, feedback */}
        {showActions && (
          <AssistantActions
            text={contentToShow}
            onRetry={onRetry ? () => onRetry(message.id) : undefined}
            onRetryWithFeedback={onRetryWithFeedback ? (feedback) => onRetryWithFeedback(message.id, feedback) : undefined}
          />
        )}

        {/* Meta */}
        {message.status === 'done' && message.usage && (
          <div className="msg-meta">
            {message.rounds != null && (
              <span>{message.rounds} round{message.rounds !== 1 ? 's' : ''}</span>
            )}
            <span>↑{message.usage.prompt_tokens} ↓{message.usage.completion_tokens} tok</span>
          </div>
        )}
      </div>
    </div>

    {/* Preview modal */}
    {previewSrc && (
      <PreviewModal
        src={previewSrc}
        title={previewSrc.split('/').pop()}
        onClose={() => setPreviewSrc(null)}
      />
    )}
    </>
  );
}

// ── Message list ──────────────────────────────────────────────────────────

interface MessagesListProps {
  messages: ChatMessage[];
  onRetry?: (msgId: string) => void;
  onRetryWithFeedback?: (msgId: string, feedback: string) => void;
  /** Optional: when present, ghost suggestions in the empty state become
   *  clickable and auto-fill the input via this callback. */
  onPickSuggestion?: (text: string) => void;
  /** Optional: greeting name to personalise the empty state title. */
  greetingName?: string | null;
  /** App-level live sub-agent map — passed through to ToolCallBadge so
   *  `agent_spawn` badges render real-time sub-agent activity inline. */
  liveAgents?: Map<string, LiveAgent>;
}

// Two ghost suggestions per session — picked once on first mount from a
// rotating pool so the same user doesn't always see the same prompts.
// User explicitly asked for "2 not 3" — keep the area uncluttered.
const SUGGESTION_POOL: string[] = [
  'Zaplanuj projekt na ten tydzień i rozbij na kroki',
  'Zrób research po sieci i streszcz mi to po polsku',
  'Przeglądnij ten kod i powiedz co z nim nie tak',
  'Napisz mi prompt który robi X — masz wymyślić X',
  'Wytłumacz mi <coś co cię nudzi> w 5 minut',
  'Postaw prosty landing page i daj mi link do podglądu',
];

function AssistantActions({ text, onRetry, onRetryWithFeedback }: AssistantActionsProps) {
  const [copied, setCopied] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <>
    <div className="msg-actions">
      <button
        className="msg-action-btn"
        onClick={copy}
        title={copied ? 'Copied!' : 'Copy response'}
      >
        {copied
          ? <svg width="13" height="13" viewBox="0 0 16 16" fill="var(--green)"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>
          : <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
        }
      </button>

      {onRetry && (
        <button
          className="msg-action-btn"
          onClick={onRetry}
          title="Try again with the same prompt"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.001 7.001 0 0 1 14.95 7.16a.75.75 0 1 1-1.49.178A5.501 5.501 0 0 0 8 2.5ZM1.705 8.005a.75.75 0 0 1 .834.656 5.501 5.501 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.001 7.001 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834Z"/>
          </svg>
        </button>
      )}

      {onRetryWithFeedback && (
        <button
          className="msg-action-btn"
          onClick={() => setFeedbackOpen(true)}
          title="Tell DeeperSeek what to fix and try again"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.609Z"/>
          </svg>
        </button>
      )}
    </div>

    {feedbackOpen && onRetryWithFeedback && (
      <RetryFeedbackModal
        onCancel={() => setFeedbackOpen(false)}
        onSubmit={(text) => { setFeedbackOpen(false); onRetryWithFeedback(text); }}
      />
    )}
    </>
  );
}

function RetryFeedbackModal({ onCancel, onSubmit }: {
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSubmit(t);
  };

  return (
    <div className="retry-modal-backdrop" onClick={onCancel}>
      <div className="retry-modal" onClick={e => e.stopPropagation()}>
        <h3 className="retry-modal-title">Co poprawić w odpowiedzi?</h3>
        <p className="retry-modal-sub">
          Krótko — co było nie tak, czego brakowało, co zmienić.
        </p>
        <textarea
          ref={ref}
          className="retry-modal-textarea"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
            if (e.key === 'Escape') onCancel();
          }}
          placeholder={'np. „za długie”, „chcę więcej kodu, mniej teorii”, „brakuje obsługi błędów”…'}
          rows={4}
          maxLength={500}
        />
        <div className="retry-modal-actions">
          <button className="retry-modal-btn-secondary" onClick={onCancel}>Anuluj</button>
          <button
            className="retry-modal-btn-primary"
            onClick={submit}
            disabled={!text.trim()}
          >
            Wyślij i spróbuj ponownie
          </button>
        </div>
      </div>
    </div>
  );
}

function MessagesList({
  messages,
  onRetry,
  onRetryWithFeedback,
  onPickSuggestion,
  greetingName,
  liveAgents,
}: MessagesListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  // Pick two random suggestions on first mount
  useEffect(() => {
    const shuffled = [...SUGGESTION_POOL].sort(() => Math.random() - 0.5);
    setSuggestions(shuffled.slice(0, 2));
  }, []);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (!containerRef.current) return;
    const { scrollHeight, clientHeight, scrollTop } = containerRef.current;
    const isNearBottom = scrollHeight - clientHeight - scrollTop < 100;
    if (isNearBottom) {
      containerRef.current.scrollTop = scrollHeight;
    }
  }, [messages]);

  const isEmpty = messages.length === 0;

  return (
    <div className="messages-container" ref={containerRef}>
      {isEmpty ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
              <circle cx="32" cy="32" r="30" stroke="var(--border)" strokeWidth="2"/>
              <path d="M24 28L32 36L40 28" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <h2 className="empty-state-title">
            {greetingName ? `Cześć ${greetingName}!` : 'Cześć!'}
          </h2>
          <p className="empty-state-sub">
            Jestem DeeperSeek — AI agent z pełnym dostępem do narzędzi.
            Mogę kodować, badać sieć, analizować pliki, deployować, automatyzować.
          </p>
          <p className="empty-state-sub">
            <strong>Po prostu powiedz co chcesz zrobić.</strong>
          </p>
          {suggestions.length > 0 && onPickSuggestion && (
            <div className="empty-state-suggestions">
              {suggestions.map((text, i) => (
                <button
                  key={i}
                  className="empty-state-suggestion"
                  onClick={() => onPickSuggestion(text)}
                >
                  {text}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        messages.map(msg => (
          <MessageBubble
            key={msg.id}
            message={msg}
            onRetry={onRetry}
            onRetryWithFeedback={onRetryWithFeedback}
            liveAgents={liveAgents}
          />
        ))
      )}
    </div>
  );
}

export default MessagesList;