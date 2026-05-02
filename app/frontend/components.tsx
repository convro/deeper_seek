import React, { useState } from 'react';
import type { AgentEvent, ToolCallRecord, LiveAgent } from './state';

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

interface ToolCallBadgeProps {
  tc: ToolCallRecord;
  /** When this tool call is `agent_spawn`, the live state of the spawned
   *  sub-agent — pulled from App-level liveAgents map. */
  liveAgent?: LiveAgent;
}

export function ToolCallBadge({ tc, liveAgent }: ToolCallBadgeProps) {
  const [open, setOpen] = useState(false);

  // For an agent_spawn that's still running, show the live sub-agent
  // status instead of the stale tool-result status.
  const liveRunning = liveAgent && liveAgent.status === 'running';

  const statusColor = liveRunning
    ? 'var(--orange)'
    : tc.status === 'done'
      ? 'var(--green)'
      : tc.status === 'error'
        ? 'var(--red)'
        : 'var(--orange)';

  const statusIcon = liveRunning
    ? '⟳'
    : tc.status === 'done' ? '✓' : tc.status === 'error' ? '✗' : '⟳';

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
      <div
        onClick={() => setOpen(o => !o)}
        className="tool-badge"
      >
        <span style={{ color: statusColor, fontWeight: 700, fontSize: 12 }}>{statusIcon}</span>
        <span style={{ color: 'var(--accent)' }}>{tc.tool}</span>
        {liveAgent && (
          <span style={{ color: 'var(--purple)', fontSize: 11 }}>
            [{liveAgent.type}]
          </span>
        )}
        {tc.duration_ms != null && !liveRunning && (
          <span style={{ color: 'var(--text3)' }}>{tc.duration_ms}ms</span>
        )}
        {liveAgent && (
          <span style={{ color: 'var(--text3)', fontSize: 10 }}>
            · {liveAgent.toolCount} tool{liveAgent.toolCount === 1 ? '' : 's'}
          </span>
        )}
        {open && (
          <span style={{ color: 'var(--text2)', marginLeft: 4, fontSize: 10, fontStyle: 'italic' }}>
            {JSON.stringify(tc.args).slice(0, 80)}
          </span>
        )}
      </div>

      {/* Inline sub-agent live panel. Only shown when this badge represents
          a spawn AND the sub-agent has any live state (running, finished,
          or failed during this session). */}
      {liveAgent && <SubAgentLivePanel agent={liveAgent} />}
    </div>
  );
}

function SubAgentLivePanel({ agent }: { agent: LiveAgent }) {
  const [expanded, setExpanded] = useState(agent.status === 'running');
  const isRunning = agent.status === 'running';

  const statusBg =
    agent.status === 'running'   ? 'var(--orange)18' :
    agent.status === 'completed' ? 'var(--green)18'  :
    agent.status === 'failed'    ? 'var(--red)18'    :
                                   'var(--bg3)';
  const borderCol =
    agent.status === 'running'   ? 'var(--orange)44' :
    agent.status === 'completed' ? 'var(--green)44'  :
    agent.status === 'failed'    ? 'var(--red)44'    :
                                   'var(--border)';

  return (
    <div style={{
      marginLeft: 14, marginTop: 2, marginBottom: 4,
      borderLeft: `2px solid ${borderCol}`,
      paddingLeft: 8,
      maxWidth: '100%',
    }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 11, cursor: 'pointer',
          padding: '2px 8px', borderRadius: 4,
          background: statusBg,
          fontFamily: 'var(--mono)',
        }}
      >
        <span style={{ color: 'var(--text3)', fontSize: 9 }}>{expanded ? '▼' : '▶'}</span>
        {isRunning && <Spinner size={9} />}
        <span style={{ color: 'var(--purple)', fontWeight: 600 }}>sub-agent</span>
        <span style={{ color: 'var(--text2)' }}>{agent.type}</span>
        {agent.currentTool && isRunning && (
          <span style={{ color: 'var(--accent)' }}>→ {agent.currentTool}</span>
        )}
        <span style={{ color: 'var(--text3)' }}>
          · {agent.toolCount} call{agent.toolCount === 1 ? '' : 's'}
        </span>
        {!isRunning && (
          <span style={{
            color: agent.status === 'completed' ? 'var(--green)' :
                   agent.status === 'failed'    ? 'var(--red)'   : 'var(--text3)',
            fontWeight: 600,
          }}>
            {agent.status}
          </span>
        )}
      </div>

      {expanded && (
        <div style={{
          marginTop: 4, padding: '6px 10px',
          background: 'var(--bg2)', borderRadius: 6,
          fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text2)',
          maxHeight: 180, overflowY: 'auto',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          border: `1px solid ${borderCol}`,
        }}>
          {agent.error && (
            <div style={{ color: 'var(--red)', marginBottom: 4 }}>
              ✗ {agent.error}
            </div>
          )}
          {agent.lastText && (
            <div style={{ color: isRunning ? 'var(--text3)' : 'var(--text2)' }}>
              {agent.lastText}
              {isRunning && <span className="msg-cursor" style={{ marginLeft: 2 }} />}
            </div>
          )}
          {!agent.lastText && !agent.error && (
            <div style={{ color: 'var(--text3)', fontStyle: 'italic' }}>
              {isRunning ? 'Sub-agent starting…' : 'No output captured.'}
            </div>
          )}
          {agent.result && agent.result !== agent.lastText && (
            <div style={{
              marginTop: 6, paddingTop: 6,
              borderTop: '1px dashed var(--border)',
              color: 'var(--text)',
            }}>
              <div style={{ fontSize: 10, color: 'var(--green)', marginBottom: 2, letterSpacing: 0.5 }}>RESULT</div>
              {agent.result.slice(0, 800)}
              {agent.result.length > 800 && '…'}
            </div>
          )}
        </div>
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

export function EventItem({ event, indent = false }: { event: AgentEvent; indent?: boolean }) {
  const [open, setOpen] = useState(false);
  const dotColor = EVENT_DOT_COLOR[event.type] || 'var(--text4)';
  const typeLabel = EVENT_TYPE_LABEL[event.type] || event.type.slice(0, 4).toUpperCase();
  const hasDetail = !!(event.args || event.result || event.error);

  return (
    <div style={indent ? {
      marginLeft: 18,
      borderLeft: '2px solid var(--purple)33',
      paddingLeft: 10,
    } : undefined}>
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

/**
 * Groups consecutive sub-agent events (those carrying agent_id) under a
 * collapsible header so the main-turn activity stays easy to scan.
 */
function SubAgentGroupHeader({ agentType, agentId, count }: { agentType?: string; agentId: string; count: number }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 10px 2px',
      fontSize: 10, fontFamily: 'var(--mono)',
      color: 'var(--purple)', letterSpacing: 0.5,
      marginTop: 4,
    }}>
      <span>↳</span>
      <span style={{ fontWeight: 600 }}>SUB-AGENT</span>
      {agentType && <span style={{ color: 'var(--text2)' }}>{agentType}</span>}
      <span style={{ color: 'var(--text4)' }}>#{agentId.slice(0, 6)}</span>
      <span style={{ color: 'var(--text3)', marginLeft: 'auto' }}>
        {count} event{count === 1 ? '' : 's'}
      </span>
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
          {(() => {
            // Collapse runs of consecutive sub-agent events (same agent_id)
            // into an indented group with a header. Main-turn events are
            // rendered inline, sub-agent events appear under their spawn.
            const out: React.ReactNode[] = [];
            let i = 0;
            while (i < events.length) {
              const ev = events[i];
              if (!ev.agent_id) {
                out.push(<EventItem key={i} event={ev} />);
                i++;
                continue;
              }
              // Gather the full run of consecutive events for this agent_id
              const aid = ev.agent_id;
              const start = i;
              while (i < events.length && events[i].agent_id === aid) i++;
              const slice = events.slice(start, i);
              const atype = slice.find(e => e.agent_type)?.agent_type;
              out.push(
                <SubAgentGroupHeader
                  key={`h-${start}`}
                  agentId={aid}
                  agentType={atype}
                  count={slice.length}
                />
              );
              slice.forEach((sev, j) => {
                out.push(<EventItem key={`${start}-${j}`} event={sev} indent />);
              });
            }
            return out;
          })()}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
