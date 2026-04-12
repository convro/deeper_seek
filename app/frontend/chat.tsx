import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { ChatMessage, ToolCallRecord, Attachment } from './state';
import { generateLocalId } from './state';
import { Spinner, TypingDots, ThinkingBlock, ToolCallBadge } from './components';
import { Markdown, PreviewModal } from './markdown';

/** Extract workspace HTML file paths from AI response text. */
function extractHtmlPaths(content: string): string[] {
  const found = new Set<string>();
  // Match patterns like: workspace/job123/output/index.html or workspace/abc/output/site/index.html
  const re = /workspace\/[a-zA-Z0-9_-]+\/[^\s"')\]`]+\.html/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    found.add(m[0]);
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

// ── Assistant message ─────────────────────────────────────────────────────

function AssistantMessage({ message }: { message: ChatMessage }) {
  const isThinking = message.status === 'thinking';
  const isError    = message.status === 'error';
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  // Detect workspace HTML file references in the response (for "Preview Site" buttons)
  const htmlPaths = message.status === 'done' && message.content
    ? extractHtmlPaths(message.content)
    : [];

  return (
    <>
    <div className="msg-row msg-row-ai anim-fade-up">
      {/* Avatar */}
      <div className="msg-ai-avatar">
        <img
          src="https://r.convro.eu/content/Stable/realises/ds73"
          alt="DS"
          style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}
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
        {message.reasoning && !isThinking && (
          <ThinkingBlock content={message.reasoning} />
        )}

        {/* Tool badges */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="msg-tool-badges">
            {message.toolCalls.map(tc => <ToolCallBadge key={tc.id} tc={tc} />)}
          </div>
        )}

        {/* Content */}
        {!isThinking && message.content && (
          <div className={`msg-ai-content ${isError ? 'msg-error' : ''}`}>
            <Markdown content={message.content} />
          </div>
        )}

        {/* Streaming cursor */}
        {message.status === 'streaming' && (
          <span className="msg-cursor" />
        )}

        {/* Preview site buttons — shown when AI created HTML files */}
        {htmlPaths.length > 0 && (
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
          </div>
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

interface MessagesListProps { messages: ChatMessage[] }

export function MessagesList({ messages }: MessagesListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

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
        <div className="empty-title">DeeperSeek</div>
        <div className="empty-subtitle">
          Autonomous AI agent with tools, memory, and multi-agent orchestration.<br />
          Ask anything — it plans, executes, and delivers real results.
        </div>
        <div className="empty-suggestions">
          {[
            'Write a Python web scraper',
            'Analyze this codebase and find bugs',
            'Research the latest AI papers',
            'Build a REST API with tests',
          ].map(ex => (
            <div key={ex} className="suggestion-chip">{ex}</div>
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
          : <AssistantMessage key={msg.id} message={msg} />
      )}
      <div ref={bottomRef} />
    </div>
  );
}

// ── Input area (with attachments) ─────────────────────────────────────────

interface InputAreaProps {
  onSend: (text: string, attachments?: Attachment[]) => void;
  disabled: boolean;
}

export function InputArea({ onSend, disabled }: InputAreaProps) {
  const [value,       setValue]       = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attLoading,  setAttLoading]  = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(() => {
    const t = value.trim();
    if ((!t && attachments.length === 0) || disabled) return;
    onSend(t, attachments.length > 0 ? attachments : undefined);
    setValue('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [value, attachments, disabled, onSend]);

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

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setAttLoading(true);
    const results: Attachment[] = [];

    for (const file of list) {
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
          disabled={disabled}
          placeholder={disabled ? 'DeeperSeek is working…' : 'Message DeeperSeek… (or drop files here)'}
          rows={1}
          className="input-textarea"
          onFocus={() => {
            // iOS Safari scrolls the layout viewport to reveal the focused input.
            // Counter-scroll immediately so the header stays visible.
            requestAnimationFrame(() => { window.scrollTo(0, 0); });
          }}
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

      <div className="input-hint">
        Ctrl+Enter to send · Enter for new line · Paste or drop files to attach
      </div>
    </div>
  );
}
