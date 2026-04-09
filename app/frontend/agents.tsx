import React, { useState, useEffect } from 'react';
import type { Agent } from './state';
import { listAgents, killAgent } from './api';

const STATUS_COLORS: Record<string, string> = {
  running: '#f59e0b',
  completed: '#10b981',
  failed: '#ef4444',
  killed: '#6b7280',
};

export function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, []);

  const refresh = async () => {
    try {
      const data = await listAgents();
      setAgents(data.agents || []);
    } catch {}
  };

  const handleKill = async (agentId: string) => {
    try {
      await killAgent(agentId);
      await refresh();
    } catch {}
  };

  const running = agents.filter(a => a.status === 'running');
  const done = agents.filter(a => a.status !== 'running');

  return (
    <div style={{ padding: '16px', overflowY: 'auto', height: '100%' }}>
      <div style={{ marginBottom: '16px' }}>
        <div style={{ color: '#94a3b8', fontSize: '12px', fontFamily: 'monospace', marginBottom: '8px' }}>
          ACTIVE AGENTS ({running.length})
        </div>
        {running.length === 0 && (
          <div style={{ color: '#374151', fontSize: '13px' }}>No agents running</div>
        )}
        {running.map(agent => (
          <AgentCard key={agent.id} agent={agent} onKill={handleKill} />
        ))}
      </div>

      <div>
        <div style={{ color: '#4b5563', fontSize: '12px', fontFamily: 'monospace', marginBottom: '8px' }}>
          COMPLETED / HISTORY ({done.length})
        </div>
        {done.slice(0, 20).map(agent => (
          <AgentCard key={agent.id} agent={agent} onKill={handleKill} />
        ))}
      </div>
    </div>
  );
}

interface AgentCardProps {
  agent: Agent;
  onKill: (id: string) => void;
}

function AgentCard({ agent, onKill }: AgentCardProps) {
  const statusColor = STATUS_COLORS[agent.status] || '#6b7280';
  const duration = agent.completed_at
    ? Math.round((new Date(agent.completed_at).getTime() - new Date(agent.started_at).getTime()) / 1000)
    : null;

  return (
    <div style={{
      backgroundColor: '#111827',
      border: '1px solid #1f2937',
      borderRadius: '8px',
      padding: '10px 12px',
      marginBottom: '8px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
        <span style={{
          backgroundColor: `${statusColor}22`,
          color: statusColor,
          fontSize: '10px',
          fontWeight: 700,
          padding: '2px 8px',
          borderRadius: '4px',
          textTransform: 'uppercase',
        }}>
          {agent.status}
        </span>
        <span style={{ color: '#8b5cf6', fontSize: '12px', fontWeight: 600 }}>
          {agent.type}
        </span>
        {agent.tool_calls != null && (
          <span style={{ color: '#4b5563', fontSize: '11px' }}>
            {agent.tool_calls} tool calls
          </span>
        )}
        <span style={{ color: '#374151', fontSize: '10px', marginLeft: 'auto', fontFamily: 'monospace' }}>
          {agent.id.slice(0, 8)}
        </span>
        {agent.status === 'running' && (
          <button
            onClick={() => onKill(agent.id)}
            style={{
              background: '#7f1d1d',
              border: 'none',
              borderRadius: '4px',
              color: '#fca5a5',
              padding: '2px 8px',
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            Kill
          </button>
        )}
      </div>

      <div style={{ color: '#9ca3af', fontSize: '12px', fontFamily: 'monospace' }}>
        {agent.task_preview}
      </div>

      <div style={{ display: 'flex', gap: '12px', marginTop: '6px', fontSize: '10px', color: '#4b5563' }}>
        <span>Started: {new Date(agent.started_at).toLocaleTimeString()}</span>
        {duration != null && <span>Duration: {duration}s</span>}
      </div>
    </div>
  );
}
