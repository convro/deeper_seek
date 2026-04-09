import React from 'react';
import type { AgentEvent } from './state';

// ── Event Badge ──────────────────────────────────────────────────────────────

const EVENT_COLORS: Record<string, string> = {
  tool_call: '#3b82f6',
  tool_result: '#10b981',
  agent: '#8b5cf6',
  reasoning: '#f59e0b',
  error: '#ef4444',
  content: '#6b7280',
  done: '#10b981',
  llm_start: '#6366f1',
};

interface EventBadgeProps {
  type: string;
}
export function EventBadge({ type }: EventBadgeProps) {
  const color = EVENT_COLORS[type] || '#6b7280';
  return (
    <span style={{
      backgroundColor: color,
      color: '#fff',
      fontSize: '10px',
      fontWeight: 700,
      padding: '2px 6px',
      borderRadius: '4px',
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
    }}>
      {type}
    </span>
  );
}

// ── Event Item ───────────────────────────────────────────────────────────────

interface EventItemProps {
  event: AgentEvent;
}
export function EventItem({ event }: EventItemProps) {
  const [expanded, setExpanded] = React.useState(false);

  const hasDetail = event.args || event.result || event.error || event.reasoning;

  return (
    <div
      style={{
        padding: '6px 10px',
        borderBottom: '1px solid #1f2937',
        cursor: hasDetail ? 'pointer' : 'default',
        fontSize: '12px',
        fontFamily: 'monospace',
      }}
      onClick={() => hasDetail && setExpanded(e => !e)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <EventBadge type={event.type} />
        {event.tool && <span style={{ color: '#60a5fa' }}>{event.tool}</span>}
        {event.agent_type && <span style={{ color: '#a78bfa' }}>{event.agent_type}</span>}
        {event.duration_ms && (
          <span style={{ color: '#6b7280', marginLeft: 'auto' }}>{event.duration_ms}ms</span>
        )}
        {event.timestamp && (
          <span style={{ color: '#374151' }}>{new Date(event.timestamp).toLocaleTimeString()}</span>
        )}
      </div>

      {event.type === 'content' && event.content && (
        <div style={{ color: '#9ca3af', marginTop: '4px', maxHeight: '60px', overflow: 'hidden' }}>
          {event.content.slice(0, 200)}
        </div>
      )}

      {event.error && (
        <div style={{ color: '#ef4444', marginTop: '4px' }}>
          {event.error.slice(0, 200)}
        </div>
      )}

      {expanded && hasDetail && (
        <pre style={{
          marginTop: '8px',
          padding: '8px',
          backgroundColor: '#111827',
          borderRadius: '4px',
          color: '#d1d5db',
          fontSize: '11px',
          overflowX: 'auto',
          maxHeight: '200px',
        }}>
          {JSON.stringify({ args: event.args, result: event.result, reasoning: event.reasoning }, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Spinner ──────────────────────────────────────────────────────────────────

export function Spinner() {
  return (
    <span style={{
      display: 'inline-block',
      width: '14px',
      height: '14px',
      border: '2px solid #374151',
      borderTopColor: '#3b82f6',
      borderRadius: '50%',
      animation: 'spin 0.8s linear infinite',
    }} />
  );
}

// ── Status Dot ───────────────────────────────────────────────────────────────

export function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span style={{
      display: 'inline-block',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      backgroundColor: connected ? '#10b981' : '#ef4444',
    }} />
  );
}

// ── File Tree Item ────────────────────────────────────────────────────────────

interface FileItem {
  path: string;
  name: string;
  type: 'file' | 'dir';
  size?: number | null;
}

interface FileTreeItemProps {
  file: FileItem;
  onSelect: (file: FileItem) => void;
  selected: boolean;
}

export function FileTreeItem({ file, onSelect, selected }: FileTreeItemProps) {
  const indent = (file.path.split('/').length - 1) * 12;

  return (
    <div
      onClick={() => file.type === 'file' && onSelect(file)}
      style={{
        paddingLeft: `${indent + 8}px`,
        paddingTop: '3px',
        paddingBottom: '3px',
        paddingRight: '8px',
        cursor: file.type === 'file' ? 'pointer' : 'default',
        backgroundColor: selected ? '#1e3a5f' : 'transparent',
        color: file.type === 'dir' ? '#94a3b8' : '#e2e8f0',
        fontSize: '12px',
        fontFamily: 'monospace',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
      }}
    >
      <span>{file.type === 'dir' ? '📁' : '📄'}</span>
      <span>{file.name}</span>
      {file.size != null && (
        <span style={{ color: '#4b5563', marginLeft: 'auto', fontSize: '10px' }}>
          {formatSize(file.size)}
        </span>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

// ── Inject global CSS ─────────────────────────────────────────────────────────

const style = document.createElement('style');
style.textContent = `
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .msg-appear { animation: fadeIn 0.15s ease; }
  * { box-sizing: border-box; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: #111; }
  ::-webkit-scrollbar-thumb { background: #374151; border-radius: 2px; }
`;
document.head.appendChild(style);
