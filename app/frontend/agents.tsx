import React, { useState, useEffect } from 'react';
import { listAgents, killAgent } from './api';

interface Agent {
  id: string;
  type: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  task_preview: string;
  started_at: string;
  completed_at?: string;
  tool_calls?: number;
}

const STATUS: Record<string, { color: string; label: string; icon: string }> = {
  running:   { color: 'var(--orange)',  label: 'Running',   icon: '⟳' },
  completed: { color: 'var(--green)',   label: 'Done',      icon: '✓' },
  failed:    { color: 'var(--red)',     label: 'Failed',    icon: '✗' },
  killed:    { color: 'var(--text3)',   label: 'Killed',    icon: '⊗' },
};

function AgentCard({ agent, onKill }: { agent: Agent; onKill: (id: string) => void }) {
  const st  = STATUS[agent.status] || STATUS.failed;
  const dur = agent.completed_at
    ? Math.round((+new Date(agent.completed_at) - +new Date(agent.started_at)) / 1000)
    : null;

  return (
    <div style={{
      background: 'var(--bg2)',
      border: '1px solid var(--border)',
      borderRadius: 10,
      padding: '10px 14px',
      marginBottom: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
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
      <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 10, color: 'var(--text3)' }}>
        <span>Started {new Date(agent.started_at).toLocaleTimeString()}</span>
        {dur != null && <span>{dur}s</span>}
      </div>
    </div>
  );
}

export function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  const refresh = async () => {
    try { const d = await listAgents(); setAgents(d.agents || []); } catch {}
  };

  const handleKill = async (id: string) => {
    try { await killAgent(id); await refresh(); } catch {}
  };

  const running   = agents.filter(a => a.status === 'running');
  const completed = agents.filter(a => a.status !== 'running');

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
