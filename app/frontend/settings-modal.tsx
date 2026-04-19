import React, { useEffect, useState } from 'react';
import type { UserSettings, GithubValidateResult } from './api';
import { validateGithubToken } from './api';

interface SettingsModalProps {
  settings: UserSettings;
  onSave: (settings: UserSettings) => Promise<void>;
  onClose: () => void;
}

export function SettingsModal({ settings, onSave, onClose }: SettingsModalProps) {
  const [local, setLocal] = useState<UserSettings>({ ...settings });
  const [saving, setSaving] = useState(false);

  // GitHub PAT validation state
  const [ghValidating,  setGhValidating]  = useState(false);
  const [ghValidResult, setGhValidResult] = useState<GithubValidateResult | null>(null);
  const [ghPatVisible,  setGhPatVisible]  = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Reset validation result when PAT changes
  useEffect(() => {
    setGhValidResult(null);
  }, [local.github_pat]);

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

  const handleValidateGithub = async () => {
    if (!local.github_pat?.trim()) return;
    setGhValidating(true);
    setGhValidResult(null);
    try {
      const result = await validateGithubToken(local.github_pat.trim());
      setGhValidResult(result);
      if (result.ok && result.login) {
        setLocal(s => ({ ...s, github_username: result.login }));
      }
    } catch {
      setGhValidResult({ ok: false, error: 'Validation request failed' });
    } finally {
      setGhValidating(false);
    }
  };

  const handleDisconnectGithub = () => {
    setLocal(s => ({ ...s, github_pat: '', github_username: '' }));
    setGhValidResult(null);
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
          {/* ── Model section ─────────────────────────────────────── */}
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
                title={local.extended_thinking ? 'Turn off' : 'Turn on'}
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
                title={local.agent_extended_thinking ? 'Turn off' : 'Turn on'}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>
          </div>

          {/* ── GitHub section ────────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-section-label">GitHub</div>

            {isConnected ? (
              <div className="gh-connected-row">
                <svg className="gh-icon" width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                </svg>
                <div className="gh-connected-info">
                  <span className="gh-connected-name">@{local.github_username}</span>
                  <span className="gh-connected-label">Connected</span>
                </div>
                <button className="gh-disconnect-btn" onClick={handleDisconnectGithub}>Disconnect</button>
              </div>
            ) : (
              <>
                <div className="settings-row-desc" style={{ marginBottom: 10 }}>
                  Connect your GitHub account to let DeeperSeek clone repos, commit code, and push branches automatically.
                </div>
                <div className="gh-pat-row">
                  <div className="gh-pat-input-wrap">
                    <input
                      className="gh-pat-input"
                      type={ghPatVisible ? 'text' : 'password'}
                      placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      value={local.github_pat || ''}
                      onChange={e => setLocal(s => ({ ...s, github_pat: e.target.value }))}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      className="gh-pat-toggle-vis"
                      onClick={() => setGhPatVisible(v => !v)}
                      title={ghPatVisible ? 'Hide token' : 'Show token'}
                      type="button"
                    >
                      {ghPatVisible ? (
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M.143 2.31a.75.75 0 0 1 1.047-.166l14.5 10.5a.75.75 0 1 1-.88 1.212l-2.553-1.85A8.098 8.098 0 0 1 8 13.5C3.417 13.5.19 9.755.037 8.2a.75.75 0 0 1 .026-.42l.08-.27zm3.386 3.76 1.2.87A3.5 3.5 0 0 0 8 11.5c1.82 0 3.29-1.385 3.468-3.147l1.56 1.129A6.8 6.8 0 0 1 8 12C5.34 12 3.25 10.367 2.066 8.854L.143 2.31l3.386 3.76zM8 2.5c.607 0 1.2.086 1.76.245l-1.27.92A3.5 3.5 0 0 0 4.836 7.2L2.55 5.527A6.8 6.8 0 0 1 8 2.5z"/>
                        </svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M8 2C4.208 2 .983 4.498.037 8c.946 3.502 4.171 6 7.963 6s7.017-2.498 7.963-6C14.017 4.498 10.792 2 8 2zm0 10a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>
                        </svg>
                      )}
                    </button>
                  </div>
                  <button
                    className="gh-validate-btn"
                    onClick={handleValidateGithub}
                    disabled={!local.github_pat?.trim() || ghValidating}
                  >
                    {ghValidating ? 'Checking…' : 'Validate'}
                  </button>
                </div>

                {ghValidResult && (
                  <div className={`gh-validate-result ${ghValidResult.ok ? 'ok' : 'err'}`}>
                    {ghValidResult.ok
                      ? `✓ Connected as @${ghValidResult.login}`
                      : `✗ ${ghValidResult.error}`}
                  </div>
                )}

                <div className="gh-pat-hint">
                  Create a token at github.com → Settings → Developer settings → Personal access tokens.
                  Needs <code>repo</code> scope for private repos, <code>public_repo</code> for public only.
                </div>
              </>
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
