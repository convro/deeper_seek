import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { ChatMessage, ToolCallRecord, Attachment, LiveAgent, Segment } from './state';
import { generateLocalId } from './state';
import { Spinner, TypingDots, ThinkingBlock, ToolCallBadge } from './components';
import { Markdown, PreviewModal } from './markdown';
import { SchedulerBubble } from './scheduler-bubble';

const OUTPUT_DIRS = '(?:output|dist|build|public|www|site|src)';
const JOB_ID      = '[a-zA-Z0-9_-]{4,}';
const WEB_EXT_RE  = /\.(html?|css|jsx?|tsx?)$/i;

/** Extract workspace HTML file paths from AI response text. */
function extractHtmlPaths(content: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;

  // 1. Full: workspace/jobid/output/... (file or dir)
  const re1 = new RegExp(`workspace\\/(${JOB_ID})\\/(${OUTPUT_DIRS}\\/[^\\s"')\\]\`]*)`, 'g');
  while ((m = re1.exec(content)) !== null) {
    const seg = m[2].endsWith('.html') ? m[2] : m[2].replace(/\/$/, '') + '/index.html';
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
    const seg = m[2].endsWith('.html') ? m[2] : m[2].replace(/\/$/, '') + '/index.html';
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

const ARCHIVE_RE = /\.(zip|tar\.gz|tar\.bz2|tar\.xz|tar|gz|bz2|7z|rar|pdf)$/i;

/** Detect downloadable files (zip, archive, pdf, …) in message text and tool results. */
function extractDownloadPaths(content: string, toolCalls?: ToolCallRecord[]): string[] {
  const found = new Set<string>();

  if (content) {
    const re = new RegExp(`workspace\\/(${JOB_ID})\\/[^\\s"')\\]\`<>]+`, 'g');
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
      const result = tc.result as Record<string, unknown> | null | undefined;
      if (result && typeof result === 'object') {
        for (const key of ['path', 'output_path', 'zip_path', 'archive_path', 'file', 'dest']) {
          const v = result[key];
          if (typeof v === 'string') candidates.push(v);
        }
        // Some tools return { result: { path: ... } }
        const inner = result.result as Record<string, unknown> | undefined;
        if (inner && typeof inner === 'object') {
          for (const key of ['path', 'zip_path', 'archive_path']) {
            const v = inner[key];
            if (typeof v === 'string') candidates.push(v);
          }
        }
      }

      for (const raw of candidates) {
        if (!ARCHIVE_RE.test(raw)) continue;
        const norm = raw.replace(/^.*?workspace\//, 'workspace/');
        if (norm.startsWith('workspace/')) found.add(norm);
      }
    }
  }

  return Array.from(found);
}

const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

// ── Attachment helpers ────────────────────────────────────────────────────

function isImage(mime: string) {
  return mime.startsWith('image/');
}

async function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

// ── Context menu (long-press / right-click on user messages) ─────────────

interface CtxPos { x: number; y: number }

function MsgContextMenu({ pos, text, onClose }: { pos: CtxPos; text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const close = () => onClose();
    // Close on any tap/click outside (one tick later so the opening tap doesn't immediately close it)
    const t = setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
    return () => { clearTimeout(t); document.removeEventListener('click', close); };
  }, [onClose]);

  const copy = () => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(onClose, 900);
  };

  // Clamp to viewport
  const x = Math.min(pos.x, (typeof window !== 'undefined' ? window.innerWidth : 400) - 160);
  const y = Math.max(8, Math.min(pos.y - 8, (typeof window !== 'undefined' ? window.innerHeight : 800) - 96));

  return (
    <div
      className="msg-ctx-menu"
      style={{ left: x, top: y }}
      onClick={e => e.stopPropagation()}
    >
      <button className="msg-ctx-item" onClick={copy}>
        {copied
          ? <svg width="14" height="14" viewBox="0 0 16 16" fill="var(--green)"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>
          : <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
        }
        <span>{copied ? 'Copied!' : 'Copy'}</span>
      </button>
    </div>
  );
}

// ── User message ──────────────────────────────────────────────────────────

function AttachmentChip({ att }: { att: Attachment }) {
  if (isImage(att.type) && att.previewUrl) {
    return (
      <div className="att-image-preview">
        <img src={att.previewUrl} alt={att.name} />
        <span className="att-image-name">{att.name}</span>
      </div>
    );
  }
  return (
    <div className="att-file-chip">
      <span className="att-file-icon">{fileIcon(att.name)}</span>
      <span className="att-file-name">{att.name}</span>
      <span className="att-file-size">{fmtBytes(att.size)}</span>
    </div>
  );
}

// V4 pricing per 1M tokens (USD)
const PRICING: Record<string, { input: number; cached: number; output: number }> = {
  'deepseek-v4-flash': { input: 0.14,  cached: 0.028, output: 0.28  },
  'deepseek-v4-pro':   { input: 1.74,  cached: 0.145, output: 3.48  },
  default:             { input: 0.14,  cached: 0.028, output: 0.28  },
};

export function calcMsgCost(usage: { prompt_tokens: number; completion_tokens: number; cache_hit_tokens?: number; model?: string }): string {
  const p = PRICING[usage.model ?? ''] ?? PRICING.default;
  const cacheHit  = usage.cache_hit_tokens ?? 0;
  const cacheMiss = Math.max(0, usage.prompt_tokens - cacheHit);
  const cost = (cacheMiss * p.input + cacheHit * p.cached + usage.completion_tokens * p.output) / 1_000_000;
  if (cost < 0.0001) return '<0.01¢';
  if (cost < 0.01)   return (cost * 100).toFixed(2) + '¢';
  return '$' + cost.toFixed(4);
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1_048_576) return `${Math.round(b / 1024)}KB`;
  return `${(b / 1_048_576).toFixed(1)}MB`;
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['py'].includes(ext))                         return '🐍';
  if (['js','ts','tsx','jsx'].includes(ext))         return '📜';
  if (['json'].includes(ext))                        return '{}';
  if (['md','txt'].includes(ext))                    return '📝';
  if (['pdf'].includes(ext))                         return '📕';
  if (['sh','bash'].includes(ext))                   return '⚙';
  if (['html','css'].includes(ext))                  return '🌐';
  if (['png','jpg','jpeg','gif','webp','svg'].includes(ext)) return '🖼';
  if (['zip','tar','gz'].includes(ext))              return '📦';
  if (['csv','tsv'].includes(ext))                   return '📊';
  return '📄';
}

function UserMessage({ message }: { message: ChatMessage }) {
  const hasAtts = message.attachments && message.attachments.length > 0;
  const [ctxPos, setCtxPos] = useState<CtxPos | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openCtx = (x: number, y: number) => {
    if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(40);
    setCtxPos({ x, y });
  };

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    longPressTimer.current = setTimeout(() => openCtx(t.clientX, t.clientY), 480);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    openCtx(e.clientX, e.clientY);
  };

  return (
    <>
    <div className="msg-row msg-row-user anim-fade-up">
      <div
        className="msg-user-bubble"
        onTouchStart={onTouchStart}
        onTouchEnd={cancelLongPress}
        onTouchMove={cancelLongPress}
        onContextMenu={onContextMenu}
      >
        {/* Attachments above text */}
        {hasAtts && (
          <div className="msg-attachments">
            {message.attachments!.map(a => (
              <AttachmentChip key={a.localId} att={a} />
            ))}
          </div>
        )}
        {message.content && (
          <div className="msg-user-text">{message.content}</div>
        )}
      </div>
    </div>
    {ctxPos && (
      <MsgContextMenu
        pos={ctxPos}
        text={message.content || ''}
        onClose={() => setCtxPos(null)}
      />
    )}
    </>
  );
}

// ── Assistant message hover actions ──────────────────────────────────────
interface AssistantActionsProps {
  text: string;
  onRetry?: () => void;
  onRetryWithFeedback?: (feedback: string) => void;
}

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
      <RetryFeedbackSheet
        onCancel={() => setFeedbackOpen(false)}
        onSubmit={(text) => { setFeedbackOpen(false); onRetryWithFeedback(text); }}
      />
    )}
    </>
  );
}

function RetryFeedbackSheet({ onCancel, onSubmit }: {
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
    <>
      <div className="rfb-backdrop" onClick={onCancel} />
      <div className="rfb-sheet">
        <div className="rfb-handle-wrap"><div className="rfb-handle" /></div>
        <p className="rfb-title">Co poprawić w odpowiedzi?</p>
        <p className="rfb-sub">Krótko — co było nie tak, czego brakowało, co zmienić.</p>
        <textarea
          ref={ref}
          className="rfb-textarea"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
            if (e.key === 'Escape') onCancel();
          }}
          placeholder="np. 'za dlugie', 'wiecej kodu, mniej teorii', 'brakuje obslugi bledow'..."
          maxLength={500}
        />
        <div className="rfb-actions">
          <button className="rfb-btn-secondary" onClick={onCancel}>Anuluj</button>
          <button className="rfb-btn-primary" onClick={submit} disabled={!text.trim()}>
            Spróbuj ponownie
          </button>
        </div>
      </div>
    </>
  );
}

// ── Raw Commands Mode — ToolCommandBlock ──────────────────────────────────

function fmtCmd(tc: ToolCallRecord): string {
  const a = (tc.args || {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  switch (tc.tool) {
    case 'bash': case 'execute_command': case 'run_command':
      return s(a.command || a.cmd || a.code || '');
    case 'read_file': case 'file_read':
      return `cat ${s(a.path || a.file_path || a.filepath || '')}`;
    case 'write_file': case 'file_write': case 'create_file': {
      const p = s(a.path || a.file_path || a.filepath || '');
      const len = String(a.content || '').length;
      return `write → ${p}  (${len} chars)`;
    }
    case 'web_search': case 'search':
      return `search "${s(a.query || a.q || '')}"`;
    case 'web_navigate': case 'navigate':
      return `navigate ${s(a.url || '')}`;
    case 'web_screenshot':
      return `screenshot ${s(a.url || a.path || '')}`;
    case 'web_get_text': case 'get_page_text':
      return `get_text ${s(a.url || '')}`;
    case 'image_analyze': case 'analyze_image': {
      const paths = Array.isArray(a.paths) ? (a.paths as string[]).join(' ') : s(a.path || '');
      return `analyze_image ${paths}`;
    }
    case 'python': case 'python_repl': case 'run_python': {
      const first = String(a.code || '').split('\n')[0];
      return `python → ${first.slice(0, 90)}${first.length > 90 ? '…' : ''}`;
    }
    case 'agent_spawn': {
      const task = String(a.task || '').slice(0, 60);
      return `spawn [${s(a.agent_type || '?')}] "${task}${task.length >= 60 ? '…' : ''}"`;
    }
    case 'agent_status': return `agent_status ${s(a.agent_id || '')}`;
    case 'list_files': case 'ls': return `ls ${s(a.path || a.directory || '.')}`;
    case 'make_dir': case 'mkdir': return `mkdir -p ${s(a.path || '')}`;
    case 'delete_file': case 'rm': return `rm ${s(a.path || '')}`;
    case 'create_zip': case 'zip_files':
      return `zip ${s(a.output || a.zip_path || '')} ${s(a.directory || '')}`;
    default: {
      const parts = Object.entries(a)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => { const sv = typeof v === 'string' ? v : JSON.stringify(v); return `${k}=${sv.slice(0, 40)}${sv.length > 40 ? '…' : ''}`; })
        .join(' ');
      return `${tc.tool} ${parts}`.slice(0, 160);
    }
  }
}

function fmtResult(tc: ToolCallRecord): string | null {
  const r = tc.result as Record<string, unknown> | string | null | undefined;
  if (!r) return null;
  let text = '';
  if (typeof r === 'string') { text = r; }
  else if (typeof r === 'object') {
    text = String(
      (r as any).output ?? (r as any).stdout ?? (r as any).result ??
      (r as any).content ?? (r as any).text ?? JSON.stringify(r, null, 2)
    );
  }
  if (!text.trim()) return null;
  const lines = text.split('\n');
  return lines.length > 10
    ? lines.slice(0, 10).join('\n') + `\n… (+${lines.length - 10} lines)`
    : text;
}

function ToolCommandBlock({ tc }: { tc: ToolCallRecord }) {
  const [expanded, setExpanded] = useState(false);
  const fmtOutput = fmtResult(tc);
  const errorMsg = tc.status === 'error' ? (tc.error as string | null | undefined) ?? null : null;
  const hasOutput = fmtOutput !== null || errorMsg !== null;
  const result = expanded ? (fmtOutput ?? errorMsg) : null;
  const dur = tc.duration_ms != null
    ? (tc.duration_ms < 1000 ? `${tc.duration_ms}ms` : `${(tc.duration_ms / 1000).toFixed(1)}s`)
    : null;
  return (
    <div className={`cmd-block cmd-${tc.status}`}>
      <div className="cmd-header">
        <span className="cmd-name">{tc.tool}</span>
        {dur && <span className="cmd-dur">{dur}</span>}
        <span className="cmd-status-dot">
          {tc.status === 'done' ? '✓' : tc.status === 'error' ? '✗' : '●'}
        </span>
        {hasOutput && (
          <button className="cmd-expand" onClick={() => setExpanded(e => !e)}>
            {expanded ? '▲ hide' : '▼ output'}
          </button>
        )}
      </div>
      <div className="cmd-line">
        <span className="cmd-prompt">$</span>
        <code className="cmd-text">{fmtCmd(tc)}</code>
      </div>
      {expanded && result && (
        <pre className={`cmd-output${tc.status === 'error' ? ' cmd-output-error' : ''}`}>
          {result}
        </pre>
      )}
    </div>
  );
}

// ── Assistant message ─────────────────────────────────────────────────────

interface AssistantMessageProps {
  message: ChatMessage;
  onRetry?: (msgId: string) => void;
  onRetryWithFeedback?: (msgId: string, feedback: string) => void;
  onCancelScheduler?: (taskId: string) => void;
  liveAgents?: Map<string, LiveAgent>;
  rawCommandsMode?: boolean;
}

function AssistantMessage({ message, onRetry, onRetryWithFeedback, onCancelScheduler, liveAgents, rawCommandsMode = false }: AssistantMessageProps) {
  const isThinking = message.status === 'thinking';
  const isError    = message.status === 'error';
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  const isDone = message.status === 'done';

  // Compute which workspace jobIds have web files (HTML/CSS/JS) — gates the Preview button.
  // Only infer index.html for a workspace if we know web files were actually created there.
  const webJobIds = (() => {
    const ids = new Set<string>();
    if (!isDone) return ids;
    for (const tc of (message.toolCalls || [])) {
      if (tc.status !== 'done') continue;
      const a = (tc.args || {}) as Record<string, unknown>;
      const p = String(a.path || a.file_path || a.filepath || a.filename || '');
      if (p && WEB_EXT_RE.test(p)) {
        const rel = p.replace(/^.*?workspace\//, '');
        const jm = rel.match(new RegExp(`^(${JOB_ID})/`));
        if (jm) ids.add(jm[1]);
      }
    }
    // Also catch explicit .html mentions in text
    if (message.content) {
      const re = new RegExp(`workspace\\/(${JOB_ID})\\/[^\\s"')\\]]+\\.html?`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(message.content)) !== null) ids.add(m[1]);
    }
    return ids;
  })();

  const htmlPaths = isDone
    ? (() => {
        const fromText  = message.content ? extractHtmlPaths(message.content) : [];
        const fromTools = message.toolCalls ? extractPathsFromToolCalls(message.toolCalls) : [];
        const merged = [...fromText, ...fromTools];
        // Only show Preview if the jobId has actual web files
        return merged.filter((p, i) => {
          if (merged.indexOf(p) !== i) return false;
          const m = p.match(new RegExp(`workspace\\/(${JOB_ID})\\/`));
          return m ? webJobIds.has(m[1]) : false;
        });
      })()
    : [];

  const downloadPaths = isDone
    ? extractDownloadPaths(message.content || '', message.toolCalls)
    : [];

  const contentToShow = (() => {
    // During active thinking/streaming there's no final content yet — don't
    // fall back to raw reasoning text here, it causes a flash before the
    // proper ThinkingBlock + final response renders.
    if (isThinking || message.status === 'streaming') return message.content || '';
    if (!message.content && message.reasoning) return message.reasoning;
    if (message.content && message.reasoning) {
      if (message.content.length < 100 && message.reasoning.length > message.content.length * 3) {
        return message.reasoning;
      }
      const contentLines = message.content.split('\n').filter(l => l.trim().length > 0);
      const reasoningLines = message.reasoning.split('\n').filter(l => l.trim().length > 0);
      const endsAbruptly = /[…:]\s*$|\.{3}\s*$|→\s*$/.test(message.content.trim());
      if (endsAbruptly && reasoningLines.length > contentLines.length) return message.reasoning;
    }
    return message.content || '';
  })();
  const showReasoningSeparately = !!(message.reasoning && contentToShow !== message.reasoning);

  // Hover actions only appear once the response has actually landed.
  const showActions = (isDone || message.status === 'error') && contentToShow;

  // ── Scheduler task bubble ─────────────────────────────────────────────────
  if (message.schedulerTask) {
    return (
      <div className="msg-row msg-row-ai anim-fade-up">
        <div className="msg-ai-avatar">
          <img
            src="https://r.convro.eu/content/Stable/realises/ds73"
            alt="DS"
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            onError={e => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
              (e.currentTarget.parentNode as HTMLElement).textContent = '🧠';
            }}
          />
        </div>
        <div className="msg-ai-body">
          <SchedulerBubble task={message.schedulerTask} onCancel={onCancelScheduler} />
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="msg-row msg-row-ai anim-fade-up">
      {/* Avatar */}
      <div className="msg-ai-avatar">
        <img
          src="https://r.convro.eu/content/Stable/realises/ds73"
          alt="DS"
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          onError={e => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
            (e.currentTarget.parentNode as HTMLElement).textContent = '🧠';
          }}
        />
      </div>

      <div className="msg-ai-body">
        {/* Thinking */}
        {isThinking && (
          <div className="msg-thinking-row">
            <TypingDots />
            <span className="msg-thinking-label">Thinking…</span>
          </div>
        )}

        {/* Reasoning chain */}
        {showReasoningSeparately && !isThinking && (
          <ThinkingBlock content={message.reasoning} />
        )}

        {/* Raw commands mode with segments: interleaved text + tool blocks */}
        {rawCommandsMode && !isThinking && message.segments && message.segments.length > 0 ? (
          <>
            {message.segments.map((seg: Segment, i: number) =>
              seg.type === 'text' ? (
                <div key={i} className={`msg-ai-content ${isError ? 'msg-error' : ''}`}>
                  <Markdown content={seg.content} />
                </div>
              ) : (
                <div key={i} className="msg-cmd-blocks">
                  {seg.callIds
                    .map((id: string) => message.toolCalls?.find(tc => tc.id === id))
                    .filter((tc): tc is ToolCallRecord => tc != null)
                    .map(tc => <ToolCommandBlock key={tc.id} tc={tc} />)}
                </div>
              )
            )}
            {message.status === 'streaming' && <span className="msg-cursor" />}
          </>
        ) : rawCommandsMode && !isThinking && message.toolCalls && message.toolCalls.length > 0 ? (
          // Fallback: no segments yet (streaming just started) — show blocks then content
          <>
            <div className="msg-cmd-blocks">
              {message.toolCalls.map(tc => <ToolCommandBlock key={tc.id} tc={tc} />)}
            </div>
            {contentToShow && (
              <div className={`msg-ai-content ${isError ? 'msg-error' : ''}`}>
                <Markdown content={contentToShow} />
              </div>
            )}
            {message.status === 'streaming' && <span className="msg-cursor" />}
          </>
        ) : (
          <>
            {/* Content */}
            {!isThinking && contentToShow && (
              <div className={`msg-ai-content ${isError ? 'msg-error' : ''}`}>
                <Markdown content={contentToShow} />
              </div>
            )}

            {/* Tool badges — default mode only */}
            {!rawCommandsMode && message.toolCalls && message.toolCalls.length > 0 && (
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
          </>
        )}

        {/* Action row: preview (HTML) + download (zip/archive/pdf) */}
        {(htmlPaths.length > 0 || downloadPaths.length > 0) && (
          <div className="msg-preview-row">
            {htmlPaths.map(p => (
              <button
                key={p}
                className="msg-preview-btn"
                onClick={() => setPreviewSrc(`/api/preview/${p}`)}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9Zm1.5 0v9h11v-9h-11Z"/>
                </svg>
                Preview&nbsp;<span className="msg-preview-path">{p.split('/').pop()}</span>
              </button>
            ))}
            {downloadPaths.map(p => (
              <a
                key={p}
                href={`/api/download/${p}`}
                download
                className="msg-download-btn"
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
                  <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
                </svg>
                Download&nbsp;<span className="msg-preview-path">{p.split('/').pop()}</span>
              </a>
            ))}
          </div>
        )}

        {/* Hover actions: copy / retry / retry-with-feedback */}
        {showActions && (
          <AssistantActions
            text={contentToShow}
            onRetry={onRetry ? () => onRetry(message.id) : undefined}
            onRetryWithFeedback={onRetryWithFeedback ? (fb) => onRetryWithFeedback(message.id, fb) : undefined}
          />
        )}

        {/* Meta */}
        {message.status === 'done' && message.usage && (
          <div className="msg-meta">
            {message.rounds != null && (
              <span>{message.rounds} round{message.rounds !== 1 ? 's' : ''}</span>
            )}
            <span>↑{message.usage.prompt_tokens.toLocaleString()} ↓{message.usage.completion_tokens.toLocaleString()} tok</span>
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
  onPickSuggestion?: (text: string) => void;
  onCancelScheduler?: (taskId: string) => void;
  greetingName?: string | null;
  liveAgents?: Map<string, LiveAgent>;
  rawCommandsMode?: boolean;
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
  'Pomóż mi nazwać tę rzecz — bez korpo-żargonu',
  'Pogadajmy luźno — co byś zrobił na moim miejscu w X',
];

function pickTwo<T>(arr: T[]): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, 2);
}

export function MessagesList({
  messages, onRetry, onRetryWithFeedback, onPickSuggestion, onCancelScheduler, greetingName, liveAgents, rawCommandsMode,
}: MessagesListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  // Pick suggestions once per mount so they don't reshuffle on every render.
  const suggestions = React.useMemo(() => pickTwo(SUGGESTION_POOL), []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="empty-state">
        <img
          src="https://r.convro.eu/content/Stable/realises/ds73"
          alt="DeeperSeek"
          className="empty-logo"
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
        <div className="empty-title">
          {greetingName ? `Cześć, ${greetingName}.` : 'DeeperSeek'}
        </div>
        <div className="empty-subtitle">
          {greetingName
            ? 'Na czym dziś działamy?'
            : 'Autonomous AI agent with tools, memory, and multi-agent orchestration.'}
        </div>
        <div className="empty-suggestions">
          {suggestions.map(ex => (
            <button
              key={ex}
              type="button"
              className="suggestion-chip"
              onClick={() => onPickSuggestion?.(ex)}
              disabled={!onPickSuggestion}
            >{ex}</button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="messages-list">
      {messages.map(msg =>
        msg.role === 'user'
          ? <UserMessage key={msg.id} message={msg} />
          : <AssistantMessage
              key={msg.id}
              message={msg}
              onRetry={onRetry}
              onRetryWithFeedback={onRetryWithFeedback}
              onCancelScheduler={onCancelScheduler}
              liveAgents={liveAgents}
              rawCommandsMode={rawCommandsMode}
            />
      )}
      <div ref={bottomRef} />
    </div>
  );
}

// ── Input area (with attachments) ─────────────────────────────────────────

const SCHED_PREFIX = 'scheduler:';

interface InputAreaProps {
  onSend: (text: string, attachments?: Attachment[]) => void;
  disabled: boolean;
}

export function InputArea({ onSend, disabled }: InputAreaProps) {
  const [value,       setValue]       = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attLoading,  setAttLoading]  = useState(false);
  const [schedDuration, setSchedDuration] = useState(30);
  const [schedWake,     setSchedWake]     = useState(20);
  const [schedLabel,    setSchedLabel]    = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isSchedulerMode = value.trimStart().toLowerCase().startsWith(SCHED_PREFIX);

  const submit = useCallback(() => {
    let t = value.trim();
    if ((!t && attachments.length === 0) || disabled) return;

    if (t.toLowerCase().startsWith(SCHED_PREFIX)) {
      const taskText = t.slice(SCHED_PREFIX.length).trim();
      if (!taskText) return;
      const labelPart = schedLabel.trim() ? `\n- label: "${schedLabel.trim()}"` : '';
      t = (
        `Użyj scheduler_tool z następującymi parametrami:\n` +
        `- task: "${taskText}"\n` +
        `- duration_min: ${schedDuration}\n` +
        `- wake_every_sec: ${schedWake}` +
        labelPart
      );
    }

    onSend(t, attachments.length > 0 ? attachments : undefined);
    setValue('');
    setAttachments([]);
    setSchedLabel('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [value, attachments, disabled, onSend, schedDuration, schedWake, schedLabel]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+Enter or Cmd+Enter → send; plain Enter → newline (natural textarea behavior)
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
  };

  const MAX_IMAGES = 5;

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;

    // Enforce max 5 images
    const currentImageCount = attachments.filter(a => isImage(a.type)).length;
    const incomingImages = list.filter(f => isImage(f.type));
    const slots = MAX_IMAGES - currentImageCount;
    if (incomingImages.length > 0 && slots <= 0) {
      alert(`Maximum ${MAX_IMAGES} images per message.`);
      return;
    }
    const filteredList = list.filter(f => {
      if (!isImage(f.type)) return true; // non-images always allowed
      const used = incomingImages.indexOf(f);
      return used < slots;
    });

    setAttLoading(true);
    const results: Attachment[] = [];

    for (const file of filteredList) {
      const att: Attachment = {
        localId: generateLocalId(),
        name:    file.name,
        type:    file.type || 'application/octet-stream',
        size:    file.size,
      };

      if (isImage(file.type)) {
        if (file.size <= MAX_INLINE_IMAGE_BYTES) {
          try {
            att.data = await readFileAsBase64(file);
            // Use data URL — never expires, no blob lifecycle issues
            att.previewUrl = `data:${file.type};base64,${att.data}`;
          } catch {}
        }
        // For oversized images (>5MB): no inline preview, base64 skipped
      } else if (
        file.type.startsWith('text/') ||
        ['application/json', 'application/xml'].includes(file.type) ||
        /\.(txt|md|json|csv|tsv|xml|yaml|yml|py|js|ts|sh|html|css)$/i.test(file.name)
      ) {
        try {
          const text = await readFileAsText(file);
          att.text = text.slice(0, 50_000); // limit to 50k chars
        } catch {}
      }

      results.push(att);
    }

    setAttachments(prev => [...prev, ...results]);
    setAttLoading(false);
  }, []);

  const removeAtt = (localId: string) => {
    setAttachments(prev => prev.filter(a => a.localId !== localId));
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      processFiles(e.target.files);
      e.target.value = '';
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) processFiles(e.dataTransfer.files);
  };

  const canSend = (value.trim() || attachments.length > 0) && !disabled && !attLoading;

  return (
    <div
      className="input-area"
      onDragOver={e => e.preventDefault()}
      onDrop={onDrop}
    >
      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="input-att-preview">
          {attachments.map(a => (
            <div key={a.localId} className="input-att-chip">
              {isImage(a.type) && a.previewUrl
                ? <img src={a.previewUrl} alt={a.name} className="input-att-thumb" />
                : <span className="input-att-fileicon">{fileIcon(a.name)}</span>
              }
              <span className="input-att-filename">{a.name}</span>
              <button
                className="input-att-remove"
                onClick={() => removeAtt(a.localId)}
                title="Remove"
              >×</button>
            </div>
          ))}
        </div>
      )}

      {/* Scheduler quick-settings panel */}
      {isSchedulerMode && (
        <div className="sched-qp">
          <div className="sched-qp-header">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                 stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            <span>Scheduler</span>
            <span className="sched-qp-hint">Ctrl+Enter to launch</span>
          </div>
          <div className="sched-qp-fields">
            <label className="sched-qp-field">
              <span>Duration</span>
              <div className="sched-qp-num">
                <input
                  type="number" value={schedDuration} min={1} max={480}
                  onChange={e => setSchedDuration(Math.max(1, Math.min(480, +e.target.value || 30)))}
                />
                <span>min</span>
              </div>
            </label>
            <label className="sched-qp-field">
              <span>Wake every</span>
              <div className="sched-qp-num">
                <input
                  type="number" value={schedWake} min={5} max={3600}
                  onChange={e => setSchedWake(Math.max(5, Math.min(3600, +e.target.value || 20)))}
                />
                <span>sec</span>
              </div>
            </label>
            <label className="sched-qp-field sched-qp-field-label">
              <span>Label</span>
              <input
                type="text" value={schedLabel} maxLength={60}
                placeholder="optional name…"
                onChange={e => setSchedLabel(e.target.value)}
              />
            </label>
          </div>
          <div className="sched-qp-preview">
            ~{Math.round(schedDuration * 60 / schedWake)} cycles · every {schedWake}s · {schedDuration} min total
          </div>
        </div>
      )}

      {/* Input row */}
      <div className={`input-row ${disabled ? 'input-row-disabled' : ''}`}>
        {/* Attachment button */}
        <button
          className="input-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          title="Attach files"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={onFileChange}
        />

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={onChange}
          onKeyDown={onKey}
          onFocus={() => { setTimeout(() => window.scrollTo(0, 0), 100); }}
          disabled={disabled}
          placeholder={disabled ? 'DeeperSeek is working…' : 'Message DeeperSeek…  (scheduler: to launch a background task)'}
          rows={1}
          className="input-textarea"
        />

        {/* Send button */}
        <button
          onClick={submit}
          disabled={!canSend}
          className={`input-send-btn ${canSend ? 'input-send-active' : ''}`}
          title="Send (Enter)"
        >
          {disabled
            ? <Spinner size={16} color="var(--text3)" />
            : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3.478 2.405a.75.75 0 0 0-.926.94l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.405z"/>
              </svg>
            )
          }
        </button>
      </div>

    </div>
  );
}
