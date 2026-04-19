import React, { useEffect, useState } from 'react';
import type { UserSettings } from './api';
import { connectGithubOAuth, disconnectGithub } from './api';

interface SettingsModalProps {
  settings: UserSettings;
  onSave: (settings: UserSettings) => Promise<void>;
  onClose: () => void;
}

export function SettingsModal({ settings, onSave, onClose }: SettingsModalProps) {
  const [local, setLocal] = useState<UserSettings>({ ...settings });
  const [saving, setSaving] = useState(false);

  // GitHub OAuth state
  const [ghConnecting,  setGhConnecting]  = useState(false);
  const [ghError,       setGhError]       = useState<string | null>(null);
  const [ghDisconnecting, setGhDisconnecting] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(local);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key: keyof UserSettings) =>
    setLocal(s => ({ ...s, [key]: !s[key] }));

  const handleConnectGithub = async () => {
    setGhConnecting(true);
    setGhError(null);
    try {
      const result = await connectGithubOAuth();
      if (result.ok && result.login) {
        // Token was stored server-side in soul settings automatically.
        // Update local mirror so Settings modal shows the connected state
        // without requiring a round-trip fetch.
        setLocal(s => ({ ...s, github_username: result.login!, github_pat: '__oauth__' }));
      } else if (!result.ok && result.error !== 'Window closed') {
        setGhError(result.error || 'Authorization failed');
      }
    } finally {
      setGhConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setGhDisconnecting(true);
    try {
      await disconnectGithub();
      setLocal(s => ({ ...s, github_username: '', github_pat: '' }));
    } finally {
      setGhDisconnecting(false);
    }
  };

  const isConnected = !!(local.github_username && local.github_pat);

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close-btn" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="settings-body">

          {/* ── Model ─────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-section-label">Model</div>

            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-name">Extended Thinking</div>
                <div className="settings-row-desc">
                  {local.extended_thinking
                    ? 'DeepSeek-R1 — deep chain-of-thought reasoning. Best for complex tasks, slower.'
                    : 'DeepSeek-Chat — fast responses. Great for quick tasks and iterating.'}
                </div>
              </div>
              <button
                className={`settings-toggle ${local.extended_thinking ? 'on' : 'off'}`}
                onClick={() => toggle('extended_thinking')}
                aria-pressed={local.extended_thinking}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-name">Agent Extended Thinking</div>
                <div className="settings-row-desc">
                  {local.agent_extended_thinking
                    ? 'Specialist agents (planner, validator) use DeepSeek-R1. More thorough, slower.'
                    : 'All agents use DeepSeek-Chat. Faster parallel execution, lighter tasks.'}
                </div>
              </div>
              <button
                className={`settings-toggle ${local.agent_extended_thinking ? 'on' : 'off'}`}
                onClick={() => toggle('agent_extended_thinking')}
                aria-pressed={local.agent_extended_thinking}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>
          </div>

          {/* ── GitHub ────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-section-label">GitHub</div>

            {isConnected ? (
              <div className="gh-connected-row">
                <svg className="gh-icon" width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                </svg>
                <div className="gh-connected-info">
                  <span className="gh-connected-name">@{local.github_username}</span>
                  <span className="gh-connected-label">Connected</span>
                </div>
                <button
                  className="gh-disconnect-btn"
                  onClick={handleDisconnect}
                  disabled={ghDisconnecting}
                >
                  {ghDisconnecting ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>
            ) : (
              <div className="gh-oauth-section">
                <p className="gh-oauth-desc">
                  Connect your GitHub account to let DeeperSeek clone repos, commit code,
                  and push branches — no tokens to copy, no config to touch.
                </p>
                <button
                  className="gh-oauth-btn"
                  onClick={handleConnectGithub}
                  disabled={ghConnecting}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                  </svg>
                  {ghConnecting ? 'Opening GitHub…' : 'Connect with GitHub'}
                </button>
                {ghError && (
                  <div className="gh-oauth-error">{ghError}</div>
                )}
              </div>
            )}
          </div>

        </div>

        <div className="settings-footer">
          <button className="settings-cancel-btn" onClick={onClose}>Cancel</button>
          <button className="settings-save-btn" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
