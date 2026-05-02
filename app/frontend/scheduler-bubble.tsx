import React, { useEffect, useRef, useState } from 'react';
import type { SchedulerTask } from './state';

interface Props {
  task: SchedulerTask;
  onCancel?: (taskId: string) => void;
}

// ── Countdown ring constants ──────────────────────────────────────────────────
const RADIUS      = 52;
const CIRCUMF     = 2 * Math.PI * RADIUS;

function fmt(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sc = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(sc)}`;
  return `${pad(m)}:${pad(sc)}`;
}

function fmtElapsed(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SchedulerBubble({ task, onCancel }: Props) {
  const [localRemaining, setLocalRemaining] = useState(task.remainingMs);
  const [localElapsed,   setLocalElapsed]   = useState(task.elapsedMs);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sync from parent whenever a tick arrives
  useEffect(() => {
    setLocalRemaining(task.remainingMs);
    setLocalElapsed(task.elapsedMs);
  }, [task.remainingMs, task.elapsedMs]);

  // Self-tick every second so the counter is smooth between server ticks
  useEffect(() => {
    if (task.status !== 'running') {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(() => {
      setLocalRemaining(r => Math.max(0, r - 1000));
      setLocalElapsed(e => e + 1000);
    }, 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [task.status]);

  const progress   = task.durationMs > 0
    ? Math.min(1, localElapsed / task.durationMs)
    : 0;
  const dashOffset = CIRCUMF * (1 - progress);
  const isRunning  = task.status === 'running';
  const isDone     = task.status === 'complete';
  const isCancelled= task.status === 'cancelled';

  const ringColor  = isDone     ? '#22c55e'
                   : isCancelled? '#ef4444'
                   : '#6366f1';

  return (
    <div className={`sched-bubble ${task.status}`} aria-live="polite">
      {/* ── Header ── */}
      <div className="sched-header">
        <div className="sched-icon">
          {isDone      ? <CheckIcon /> :
           isCancelled ? <CrossIcon /> :
                         <ClockIcon />}
        </div>
        <div className="sched-title">
          <span className="sched-label">{task.label}</span>
          <span className={`sched-status-badge ${task.status}`}>
            {isDone ? 'Complete' : isCancelled ? 'Cancelled' : 'Running…'}
          </span>
        </div>
        {isRunning && onCancel && (
          <button
            className="sched-cancel-btn"
            onClick={() => onCancel(task.taskId)}
            title="Cancel task"
          >
            ✕
          </button>
        )}
      </div>

      {/* ── Timer ring + countdown ── */}
      <div className="sched-body">
        <div className="sched-ring-wrap">
          <svg className="sched-ring" viewBox="0 0 120 120" aria-hidden>
            {/* Background track */}
            <circle
              cx="60" cy="60" r={RADIUS}
              fill="none" stroke="rgba(99,102,241,0.12)" strokeWidth="8"
            />
            {/* Progress arc */}
            <circle
              cx="60" cy="60" r={RADIUS}
              fill="none"
              stroke={ringColor}
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={CIRCUMF}
              strokeDashoffset={dashOffset}
              transform="rotate(-90 60 60)"
              style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.4s' }}
            />
          </svg>
          <div className="sched-countdown">
            <span className="sched-time">{fmt(localRemaining)}</span>
            <span className="sched-time-label">
              {isDone ? 'finished' : isCancelled ? 'stopped' : 'remaining'}
            </span>
          </div>
        </div>

        {/* ── Stats column ── */}
        <div className="sched-stats-col">
          <div className="sched-stat">
            <span className="sched-stat-key">Elapsed</span>
            <span className="sched-stat-val">{fmtElapsed(localElapsed)}</span>
          </div>
          {Object.entries(task.stats).map(([k, v]) => (
            <div className="sched-stat" key={k}>
              <span className="sched-stat-key">{k.replace(/_/g, ' ')}</span>
              <span className="sched-stat-val">{v}</span>
            </div>
          ))}
          {/* Progress bar */}
          <div className="sched-progress-wrap" title={`${Math.round(progress * 100)}% elapsed`}>
            <div
              className="sched-progress-fill"
              style={{ width: `${Math.min(100, progress * 100).toFixed(1)}%`, background: ringColor }}
            />
          </div>
        </div>
      </div>

      {/* ── Current action ── */}
      {task.currentAction && (
        <div className="sched-action">
          {isRunning && <span className="sched-action-dot" />}
          <span className="sched-action-text">{task.currentAction}</span>
        </div>
      )}

      {isDone && (
        <div className="sched-done-hint">
          Report posted below ↓
        </div>
      )}
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
         stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
         stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}
