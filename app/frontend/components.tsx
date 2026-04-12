import React, { useState } from 'react';
import type { AgentEvent, ToolCallRecord } from './state';

// ── Spinner ───────────────────────────────────────────────────────────────

export function Spinner({ size = 14, color = 'var(--accent)' }: { size?: number; color?: string }) {
  return (
    <span style={{
      display: 'inline-block',
      width: size, height: size,
      border: `2px solid var(--bg4)`,
      borderTopColor: color,
      borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
      flexShrink: 0,
    }} />
  );
}

// ── Status dot ────────────────────────────────────────────────────────────

export function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span className={`status-dot ${connected ? 'status-dot-live' : 'status-dot-off'}`} />
  );
}

// ── Typing indicator ──────────────────────────────────────────────────────

export function TypingDots() {
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', padding: '2px 0' }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: 6, height: 6,
          borderRadius: '50%',
          backgroundColor: 'var(--text3)',
          animation: `pulse 1.2s ease ${i * 0.2}s infinite`,
          display: 'inline-block',
        }} />
      ))}
    </span>
  );
}

// ── Thinking block ────────────────────────────────────────────────────────

export function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const wordCount = content.split(/\s+/).length;

  return (
    <div className="thinking-block">
      <div
        className={`thinking-block__header ${open ? 'open' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        <span style={{ color: 'var(--purple)', fontSize: 13 }}>◈</span>
        <span style={{ color: 'var(--purple)', fontWeight: 600, fontSize: 12 }}>Reasoning chain</span>
        <span style={{ color: 'var(--text3)', fontSize: 11, marginLeft: 6 }}>~{wordCount} words</span>
        <span className="chevron">▶</span>
      </div>
      {open && (
        <div className="thinking-block__content anim-slide-down">
          {content}
        </div>
      )}
    </div>
  );
}

// ── Tool call badge ───────────────────────────────────────────────────────

export function ToolCallBadge({ tc }: { tc: ToolCallRecord }) {
  const [open, setOpen] = useState(false);

  const statusColor = tc.status === 'done'
    ? 'var(--green)'
    : tc.status === 'error'
      ? 'var(--red)'
      : 'var(--orange)';

  const statusIcon = tc.status === 'done' ? '✓' : tc.status === 'error' ? '✗' : '⟳';

  return (
    <div
      onClick={() => setOpen(o => !o)}
      className="tool-badge"
    >
      <span style={{ color: statusColor, fontWeight: 700, fontSize: 12 }}>{statusIcon}</span>
      <span style={{ color: 'var(--accent)' }}>{tc.tool}</span>
      {tc.duration_ms != null && (
        <span style={{ color: 'var(--text3)' }}>{tc.duration_ms}ms</span>
      )}
      {open && (
        <span style={{ color: 'var(--text2)', marginLeft: 4, fontSize: 10, fontStyle: 'italic' }}>
          {JSON.stringify(tc.args).slice(0, 80)}
        </span>
      )}
    </div>
  );
}

// ── Event item — terminal-log style ──────────────────────────────────────

const EVENT_DOT_COLOR: Record<string, string> = {
  tool_call:   'var(--accent)',
  tool_result: 'var(--green)',
  done:        'var(--green)',
  final:       'var(--green)',
  error:       'var(--red)',
  agent:       'var(--purple)',
};

const EVENT_TYPE_LABEL: Record<string, string> = {
  tool_call:   'CALL',
  tool_result: 'DONE',
  done:        'END',
  final:       'END',
  error:       'ERR',
  agent:       'AGNT',
};

export function EventItem({ event }: { event: AgentEvent }) {
  const [open, setOpen] = useState(false);
  const dotColor = EVENT_DOT_COLOR[event.type] || 'var(--text4)';
  const typeLabel = EVENT_TYPE_LABEL[event.type] || event.type.slice(0, 4).toUpperCase();
  const hasDetail = !!(event.args || event.result || event.error);

  return (
    <div>
      <div
        className="event-item"
        onClick={() => hasDetail && setOpen(o => !o)}
        style={{ cursor: hasDetail ? 'pointer' : 'default' }}
      >
        <span className="event-item__dot" style={{ background: dotColor }} />
        <span className="event-item__type" style={{ color: dotColor }}>{typeLabel}</span>
        <span className="event-item__tool">
          {event.tool && <span style={{ color: 'var(--text)' }}>{event.tool}</span>}
          {event.agent_type && <span style={{ color: 'var(--purple)' }}> [{event.agent_type}]</span>}
          {event.error && <span style={{ color: 'var(--red)' }}> {event.error.slice(0, 80)}</span>}
          {event.type === 'done' && event.usage && (
            <span style={{ color: 'var(--text3)' }}>
              {' '}· ↑{event.usage.prompt_tokens} ↓{event.usage.completion_tokens} tok
            </span>
          )}
        </span>
        {event.duration_ms != null && (
          <span className="event-item__ms">{event.duration_ms}ms</span>
        )}
      </div>
      {open && hasDetail && (
        <div className="event-item__detail anim-slide-down">
          {JSON.stringify({ args: event.args, result: event.result, error: event.error }, null, 2)}
        </div>
      )}
    </div>
  );
}

// ── Events drawer ─────────────────────────────────────────────────────────

interface EventsDrawerProps {
  events: AgentEvent[];
  open: boolean;
  onToggle: () => void;
  processing: boolean;
}

export function EventsDrawer({ events, open, onToggle, processing }: EventsDrawerProps) {
  const toolCalls = events.filter(e => e.type === 'tool_call').length;
  const bottomRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events, open]);

  return (
    <div className="events-drawer">
      <button className="events-drawer-toggle" onClick={onToggle}>
        <span style={{ color: 'var(--text3)', fontSize: 9 }}>{open ? '▼' : '▶'}</span>
        <span>TOOL ACTIVITY</span>
        {toolCalls > 0 && (
          <span className="events-count-badge">{toolCalls}</span>
        )}
        {processing && <Spinner size={10} />}
        {!processing && events.length > 0 && (
          <span style={{ color: 'var(--text3)', marginLeft: 'auto', fontSize: 11 }}>
            {events.length} events
          </span>
        )}
      </button>

      {open && (
        <div className="events-list">
          {events.length === 0 && (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
              Tool activity will appear here in real-time
            </div>
          )}
          {events.map((ev, i) => <EventItem key={i} event={ev} />)}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
