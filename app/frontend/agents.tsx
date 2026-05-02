import React, { useState, useEffect } from 'react';
import { listAgents, killAgent } from './api';
import type { LiveAgent } from './state';

interface PolledAgent {
  id: string;
  type: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  task_preview: string;
  started_at: string;
  completed_at?: string;
  tool_calls?: number;
}

interface MergedAgent {
  id: string;
  type: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  task_preview: string;
  started_at: string;
  completed_at?: string;
  tool_calls?: number;
  /** Real-time fields from the websocket-driven live map. */
  currentTool?: string;
  lastText?: string;
  lastEventAt?: string;
  isLive?: boolean;
}

const STATUS: Record<string, { color: string; label: string; icon: string }> = {
  running:   { color: 'var(--orange)',  label: 'Running',   icon: '⟳' },
  completed: { color: 'var(--green)',   label: 'Done',      icon: '✓' },
  failed:    { color: 'var(--red)',     label: 'Failed',    icon: '✗' },
  killed:    { color: 'var(--text3)',   label: 'Killed',    icon: '⊗' },
};

function AgentCard({ agent, onKill }: { agent: MergedAgent; onKill: (id: string) => void }) {
  const st  = STATUS[agent.status] || STATUS.failed;
  const dur = agent.completed_at
    ? Math.round((+new Date(agent.completed_at) - +new Date(agent.started_at)) / 1000)
    : null;

  // Stale detection: a "running" agent that hasn't emitted any event in >30s
  // is probably wedged or its parent WS connection dropped. Show a warning.
  const stale = agent.status === 'running' && agent.lastEventAt
    ? (Date.now() - new Date(agent.lastEventAt).getTime()) > 30_000
    : false;

  return (
    <div style={{
      background: 'var(--bg2)',
      border: `1px solid ${stale ? 'var(--red)44' : 'var(--border)'}`,
      borderRadius: 10,
      padding: '10px 14px',
      marginBottom: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 8px',
          borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.4,
          background: `${st.color}22`, color: st.color,
        }}>
          {st.icon} {st.label}
        </span>
        <span style={{ color: 'var(--purple)', fontWeight: 600, fontSize: 13 }}>{agent.type}</span>
        {agent.tool_calls != null && agent.tool_calls > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>{agent.tool_calls} tool calls</span>
        )}
        {agent.currentTool && agent.status === 'running' && (
          <span style={{
            fontSize: 11, color: 'var(--accent)', fontFamily: 'var(--mono)',
            background: 'var(--bg3)', padding: '1px 6px', borderRadius: 3,
          }}>
            → {agent.currentTool}
          </span>
        )}
        {agent.isLive && (
          <span style={{
            fontSize: 9, color: 'var(--green)', letterSpacing: 0.5,
            background: 'var(--green)22', padding: '1px 5px', borderRadius: 3,
          }}>
            LIVE
          </span>
        )}
        {stale && (
          <span style={{
            fontSize: 9, color: 'var(--red)', letterSpacing: 0.5,
            background: 'var(--red)22', padding: '1px 5px', borderRadius: 3,
          }}>
            STALE
          </span>
        )}
        <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 'auto', fontFamily: 'var(--mono)' }}>
          {agent.id.slice(0, 8)}
        </span>
        {agent.status === 'running' && (
          <button onClick={() => onKill(agent.id)} style={{
            background: 'var(--red)22', border: '1px solid var(--red)44',
            borderRadius: 4, color: 'var(--red)', padding: '2px 8px', fontSize: 11,
            cursor: 'pointer',
          }}>
            Kill
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text2)', fontFamily: 'var(--mono)' }}>
        {agent.task_preview}
      </div>
      {agent.lastText && agent.status === 'running' && (
        <div style={{
          fontSize: 11, color: 'var(--text3)', marginTop: 6,
          fontFamily: 'var(--mono)', fontStyle: 'italic',
          maxHeight: 60, overflow: 'hidden',
          borderLeft: '2px solid var(--accent)44', paddingLeft: 8,
        }}>
          {agent.lastText.length > 200 ? '…' + agent.lastText.slice(-200) : agent.lastText}
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 10, color: 'var(--text3)' }}>
        <span>Started {new Date(agent.started_at).toLocaleTimeString()}</span>
        {dur != null && <span>{dur}s</span>}
      </div>
    </div>
  );
}

interface AgentsProps {
  /** Live agent map from App — driven by websocket events, no polling lag. */
  liveAgents: Map<string, LiveAgent>;
}

export function Agents({ liveAgents }: AgentsProps) {
  const [polled, setPolled] = useState<PolledAgent[]>([]);

  // Polling kept as a low-frequency safety net to surface agents that
  // started in another session/restart (the WS only carries events for the
  // currently-open session). Frequency dropped from 3s → 15s now that the
  // live map handles the real-time path.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, []);

  const refresh = async () => {
    try { const d = await listAgents(); setPolled(d.agents || []); } catch {}
  };

  const handleKill = async (id: string) => {
    try { await killAgent(id); await refresh(); } catch {}
  };

  // ── Merge polled snapshot with live websocket data ─────────────────
  // The live map is authoritative for anything currently running in the
  // open session — it has currentTool, lastText, fresh status — but the
  // poll is the only source for cross-session/historical agents.
  const merged: MergedAgent[] = React.useMemo(() => {
    const byId = new Map<string, MergedAgent>();

    for (const a of polled) {
      byId.set(a.id, {
        id:           a.id,
        type:         a.type,
        status:       a.status,
        task_preview: a.task_preview,
        started_at:   a.started_at,
        completed_at: a.completed_at,
        tool_calls:   a.tool_calls,
      });
    }

    for (const [id, la] of liveAgents) {
      const existing = byId.get(id);
      byId.set(id, {
        id,
        type:         la.type,
        // Live status wins — the WS is more current than a 15s poll.
        status:       la.status,
        task_preview: existing?.task_preview ?? (la.lastText?.slice(0, 100) || `${la.type} agent`),
        started_at:   existing?.started_at ?? la.startedAt,
        completed_at: la.completedAt ?? existing?.completed_at,
        tool_calls:   Math.max(la.toolCount, existing?.tool_calls ?? 0),
        currentTool:  la.currentTool,
        lastText:     la.lastText,
        lastEventAt:  la.lastEventAt,
        isLive:       true,
      });
    }

    return Array.from(byId.values()).sort((a, b) => {
      // Running first, then most recent
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (b.status === 'running' && a.status !== 'running') return 1;
      return +new Date(b.started_at) - +new Date(a.started_at);
    });
  }, [polled, liveAgents]);

  const running   = merged.filter(a => a.status === 'running');
  const completed = merged.filter(a => a.status !== 'running');

  return (
    <div style={{ padding: 16, overflowY: 'auto', height: '100%' }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', letterSpacing: 1, marginBottom: 8 }}>
          ACTIVE AGENTS ({running.length})
        </div>
        {running.length === 0 ? (
          <div style={{ color: 'var(--text3)', fontSize: 13 }}>No agents running</div>
        ) : (
          running.map(a => <AgentCard key={a.id} agent={a} onKill={handleKill} />)
        )}
      </div>
      <div>
        <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', letterSpacing: 1, marginBottom: 8 }}>
          HISTORY ({completed.length})
        </div>
        {completed.slice(0, 50).map(a => <AgentCard key={a.id} agent={a} onKill={handleKill} />)}
      </div>
    </div>
  );
}
