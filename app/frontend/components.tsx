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
    <span style={{
      display: 'inline-block',
      width: 7, height: 7,
      borderRadius: '50%',
      backgroundColor: connected ? 'var(--green)' : 'var(--red)',
      boxShadow: connected ? '0 0 6px var(--green)' : 'none',
      animation: connected ? 'pulse 2s ease infinite' : 'none',
    }} />
  );
}

// ── Typing indicator (three dots) ─────────────────────────────────────────

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

// ── Thinking block (reasoning chain) ─────────────────────────────────────

export function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const wordCount = content.split(/\s+/).length;

  return (
    <div className="thinking-block">
      <div
        className={`thinking-block__header ${open ? 'open' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        <span style={{ color: 'var(--purple)', fontSize: 13 }}>🧠</span>
        <span style={{ color: 'var(--purple)', fontWeight: 600 }}>Reasoning chain</span>
        <span style={{ color: 'var(--text3)', fontSize: 11 }}>~{wordCount} words</span>
        <span className="chevron" style={{ marginLeft: 'auto' }}>▶</span>
      </div>
      {open && (
        <div className="thinking-block__content anim-slide-down">
          {content}
        </div>
      )}
    </div>
  );
}

// ── Tool call inline badge (inside message) ───────────────────────────────

export function ToolCallBadge({ tc }: { tc: ToolCallRecord }) {
  const [open, setOpen] = useState(false);

  const statusColor = tc.status === 'done' ? 'var(--green)' : tc.status === 'error' ? 'var(--red)' : 'var(--orange)';
  const statusIcon  = tc.status === 'done' ? '✓' : tc.status === 'error' ? '✗' : '⟳';

  return (
    <div
      onClick={() => setOpen(o => !o)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        background: 'var(--bg3)',
        border: `1px solid var(--border)`,
        borderRadius: 5,
        padding: '2px 8px',
        fontSize: 11,
        fontFamily: 'var(--mono)',
        cursor: 'pointer',
        marginRight: 4,
        marginBottom: 4,
        transition: 'background 0.1s',
      }}
    >
      <span style={{ color: statusColor, fontWeight: 700 }}>{statusIcon}</span>
      <span style={{ color: 'var(--accent)' }}>{tc.tool}</span>
      {tc.duration_ms && <span style={{ color: 'var(--text3)' }}>{tc.duration_ms}ms</span>}
      {open && (
        <span style={{ color: 'var(--text2)', marginLeft: 4, fontSize: 10 }}>
          {JSON.stringify(tc.args).slice(0, 80)}
        </span>
      )}
    </div>
  );
}

// ── Event item (activity log) ─────────────────────────────────────────────

const BADGE_STYLES: Record<string, { bg: string; color: string }> = {
  tool_call:   { bg: '#1d3557', color: '#58a6ff' },
  tool_result: { bg: '#1a3a2a', color: '#3fb950' },
  llm_start:   { bg: '#2d1f5e', color: '#bc8cff' },
  reasoning:   { bg: '#3b2a0e', color: '#e3b341' },
  content:     { bg: '#1c2128', color: '#8b949e' },
  done:        { bg: '#1a3a2a', color: '#3fb950' },
  final:       { bg: '#1a3a2a', color: '#3fb950' },
  agent:       { bg: '#2d1f5e', color: '#bc8cff' },
  error:       { bg: '#3a1a1a', color: '#f85149' },
};

export function EventItem({ event, idx }: { event: AgentEvent; idx: number }) {
  const [open, setOpen] = useState(false);
  const style = BADGE_STYLES[event.type] || { bg: 'var(--bg4)', color: 'var(--text2)' };
  const hasDetail = event.args || event.result || event.error;

  return (
    <div>
      <div
        className="event-item"
        onClick={() => hasDetail && setOpen(o => !o)}
        style={{ cursor: hasDetail ? 'pointer' : 'default' }}
      >
        <span className="event-item__badge" style={{ background: style.bg, color: style.color }}>
          {event.type}
        </span>
        <span className="event-item__tool">
          {event.tool && <span style={{ color: 'var(--accent)' }}>{event.tool}</span>}
          {event.agent_type && <span style={{ color: 'var(--purple)' }}> [{event.agent_type}]</span>}
          {event.error && <span style={{ color: 'var(--red)' }}> {event.error.slice(0, 60)}</span>}
          {event.type === 'content' && event.content && (
            <span style={{ color: 'var(--text3)' }}> {event.content.slice(0, 50)}…</span>
          )}
          {event.type === 'done' && event.usage && (
            <span style={{ color: 'var(--text3)' }}>
              {' '}↑{event.usage.prompt_tokens} ↓{event.usage.completion_tokens} tokens
            </span>
          )}
        </span>
        {event.duration_ms && <span className="event-item__ms">{event.duration_ms}ms</span>}
      </div>
      {open && hasDetail && (
        <div className="event-item__detail anim-slide-down">
          {JSON.stringify({ args: event.args, result: event.result }, null, 2)}
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
    <div style={{
      borderTop: '1px solid var(--border)',
      backgroundColor: 'var(--bg2)',
      flexShrink: 0,
    }}>
      {/* Toggle bar */}
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 14px',
          background: 'none',
          border: 'none',
          color: 'var(--text2)',
          fontSize: 12,
          fontFamily: 'var(--mono)',
          cursor: 'pointer',
          textAlign: 'left',
          transition: 'background 0.1s',
        }}
      >
        <span style={{ color: 'var(--text3)', fontSize: 9 }}>{open ? '▼' : '▶'}</span>
        <span>TOOL ACTIVITY</span>
        {toolCalls > 0 && (
          <span style={{
            background: 'var(--bg4)',
            color: 'var(--accent)',
            fontSize: 10,
            padding: '0 6px',
            borderRadius: 10,
            fontWeight: 700,
          }}>
            {toolCalls}
          </span>
        )}
        {processing && <Spinner size={10} />}
        {!processing && events.length > 0 && (
          <span style={{ color: 'var(--text3)', marginLeft: 'auto', fontSize: 11 }}>
            {events.length} events
          </span>
        )}
      </button>

      {/* Events list */}
      {open && (
        <div style={{ maxHeight: 220, overflowY: 'auto', borderTop: '1px solid var(--border)' }}>
          {events.length === 0 && (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
              Tool activity will appear here in real-time
            </div>
          )}
          {events.map((ev, i) => <EventItem key={i} event={ev} idx={i} />)}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
