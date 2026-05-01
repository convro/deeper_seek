import React, { useEffect, useRef, useState } from 'react';
import type { UserSettings, DiscordStatus } from './api';
import { connectGithubOAuth, disconnectGithub, getDiscordBookmarklet, getDiscordStatus, disconnectDiscord, verifyDiscord } from './api';

interface SettingsModalProps {
  settings: UserSettings;
  onSave: (settings: UserSettings) => Promise<void>;
  onClose: () => void;
}

export function SettingsModal({ settings, onSave, onClose }: SettingsModalProps) {
  const [local, setLocal] = useState<UserSettings>({ ...settings });
  const [saving, setSaving] = useState(false);

  // GitHub OAuth state
  const [ghConnecting,    setGhConnecting]    = useState(false);
  const [ghError,         setGhError]         = useState<string | null>(null);
  const [ghDisconnecting, setGhDisconnecting] = useState(false);

  // Discord bookmarklet state
  const [dcStep,         setDcStep]         = useState<'idle' | 'waiting' | 'done'>('idle');
  const [dcScript,       setDcScript]       = useState<string>('');
  const [dcError,        setDcError]        = useState<string | null>(null);
  const [dcDisconnecting,setDcDisconnecting]= useState(false);
  const [dcStale,        setDcStale]        = useState(false);  // token rotated/expired
  const [dcCopied,       setDcCopied]       = useState(false);
  const [dcShowManual,   setDcShowManual]   = useState(false);
  const dcPollRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const bookmarkletWrapRef = useRef<HTMLDivElement>(null);

  // React sanitizes javascript: hrefs in JSX props AND can also reset DOM
  // attributes set via setAttribute on subsequent renders. The bulletproof
  // way to render a draggable bookmarklet is to inject raw HTML so React
  // never touches the anchor. We attach the onClick handler manually after.
  useEffect(() => {
    const wrap = bookmarkletWrapRef.current;
    if (!wrap || !dcScript) return;
    const anchor = wrap.querySelector('a');
    if (!anchor) return;
    const onClick = (e: Event) => e.preventDefault();
    anchor.addEventListener('click', onClick);
    return () => anchor.removeEventListener('click', onClick);
  }, [dcScript]);

  const handleCopyScript = async () => {
    if (!dcScript) return;
    try {
      await navigator.clipboard.writeText(dcScript);
      setDcCopied(true);
      setTimeout(() => setDcCopied(false), 1800);
    } catch {
      // Clipboard API unavailable — fall back to the visible textarea select trick
      const ta = document.getElementById('dc-script-fallback') as HTMLTextAreaElement | null;
      if (ta) { ta.select(); document.execCommand('copy'); setDcCopied(true); setTimeout(() => setDcCopied(false), 1800); }
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Stop polling on unmount
  useEffect(() => () => { if (dcPollRef.current) clearInterval(dcPollRef.current); }, []);

  // On modal open: if Discord is connected, ping it to verify token is still alive.
  // Discord rotates tokens silently (e.g. when the user changes their password),
  // so we want to detect a dead token immediately rather than wait until the AI
  // tries to use the tool.
  useEffect(() => {
    if (!settings.discord_username) return;
    let cancelled = false;
    verifyDiscord().then(r => {
      if (cancelled) return;
      if (r.connected && !r.valid) {
        setDcStale(true);
      } else if (r.connected && r.valid) {
        // Refresh username/avatar from Discord if it changed
        setLocal(s => ({
          ...s,
          discord_username:    r.username || s.discord_username,
          discord_global_name: r.global_name || s.discord_global_name,
          discord_avatar:      r.avatar !== undefined ? r.avatar : s.discord_avatar,
        }));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [settings.discord_username]);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Strip server-managed tokens — never overwrite with stale frontend state.
      const { github_pat, github_username, discord_token, discord_user_id,
              discord_username, discord_global_name, discord_avatar,
              ...modelSettings } = local;
      await onSave(modelSettings as UserSettings);
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
        // Token already stored server-side by OAuth callback.
        // Only update github_username locally so connected state renders correctly.
        setLocal(s => ({ ...s, github_username: result.login! }));
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

  const handleConnectDiscord = async () => {
    setDcError(null);
    setDcStep('idle');
    try {
      const { script } = await getDiscordBookmarklet();
      setDcScript(script);
      setDcStep('waiting');
      // Poll every 2s for up to 15 minutes
      dcPollRef.current = setInterval(async () => {
        try {
          const status = await getDiscordStatus();
          if (status.connected && status.username) {
            if (dcPollRef.current) clearInterval(dcPollRef.current);
            setDcStep('done');
            setLocal(s => ({
              ...s,
              discord_username:    status.username,
              discord_global_name: status.global_name,
              discord_user_id:     status.user_id,
              discord_avatar:      status.avatar,
            }));
          }
        } catch {}
      }, 2000);
    } catch (e: any) {
      setDcError(e.message || 'Failed to generate bookmarklet');
    }
  };

  const handleDisconnectDiscord = async () => {
    setDcDisconnecting(true);
    if (dcPollRef.current) clearInterval(dcPollRef.current);
    try {
      await disconnectDiscord();
      setLocal(s => ({ ...s, discord_username: '', discord_user_id: '', discord_global_name: '', discord_avatar: '' }));
      setDcStep('idle');
      setDcScript('');
      setDcStale(false);
    } finally {
      setDcDisconnecting(false);
    }
  };

  // PAT lives server-side only — use github_username as connected indicator.
  const isConnected = !!(local.github_username);
  const isDiscordConnected = !!(local.discord_username);

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
                    ? 'Thinking mode ON — AI reasons step-by-step before responding. Best for complex multi-step tasks.'
                    : 'Thinking mode OFF — direct responses, no chain-of-thought. Fastest mode.'}
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
                <div className="settings-row-name">Pro Model (V4 Pro)</div>
                <div className="settings-row-desc">
                  {local.use_pro_model
                    ? 'DeepSeek V4 Pro — 1.6T params, frontier-grade intelligence. Higher cost, best for hardest tasks.'
                    : 'DeepSeek V4 Flash — fast, cheap, powerful. Best for most tasks including coding.'}
                </div>
              </div>
              <button
                className={`settings-toggle ${local.use_pro_model ? 'on' : 'off'}`}
                onClick={() => toggle('use_pro_model')}
                aria-pressed={local.use_pro_model}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-name">Agent Thinking</div>
                <div className="settings-row-desc">
                  {local.agent_extended_thinking
                    ? 'Background agents use chain-of-thought reasoning. More thorough, slightly slower.'
                    : 'Agents respond directly without reasoning chain. Faster parallel execution.'}
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

          {/* ── Discord ───────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-section-label">Discord</div>

            {isDiscordConnected ? (
              <>
                <div className={`gh-connected-row${dcStale ? ' dc-stale' : ''}`}>
                  {local.discord_avatar ? (
                    <img
                      src={`https://cdn.discordapp.com/avatars/${local.discord_user_id}/${local.discord_avatar}.webp?size=40`}
                      alt=""
                      className="dc-avatar"
                    />
                  ) : (
                    <span className="dc-avatar dc-avatar-placeholder">
                      {(local.discord_global_name || local.discord_username || '?')[0].toUpperCase()}
                    </span>
                  )}
                  <div className="gh-connected-info">
                    <span className="gh-connected-name">
                      {local.discord_global_name || local.discord_username}
                    </span>
                    <span className="gh-connected-label">
                      @{local.discord_username} · {dcStale ? 'Token expired' : 'Connected'}
                    </span>
                  </div>
                  <button
                    className="gh-disconnect-btn"
                    onClick={handleDisconnectDiscord}
                    disabled={dcDisconnecting}
                  >
                    {dcDisconnecting ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                </div>
                {dcStale && (
                  <div className="dc-stale-warning">
                    Discord rejected the stored token. This usually means you changed
                    your password or logged out elsewhere. Disconnect and reconnect to refresh.
                  </div>
                )}
              </>
            ) : dcStep === 'waiting' ? (
              <div className="dc-waiting-section">
                <div className="dc-steps">
                  <div className="dc-step">
                    <span className="dc-step-num">1</span>
                    <span>Drag the button below to your bookmarks bar</span>
                  </div>
                  <div className="dc-step">
                    <span className="dc-step-num">2</span>
                    <span>Open <strong>discord.com</strong> in your browser (already logged in)</span>
                  </div>
                  <div className="dc-step">
                    <span className="dc-step-num">3</span>
                    <span>Click the bookmarklet — connection completes automatically</span>
                  </div>
                </div>
                <div
                  ref={bookmarkletWrapRef}
                  className="dc-bookmarklet-wrap"
                  dangerouslySetInnerHTML={{
                    __html: dcScript
                      ? `<a href="${dcScript.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" class="dc-bookmarklet-btn" draggable="true" title="Drag this to your bookmarks bar"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8V1.5Z"/></svg>Connect Discord</a>`
                      : ''
                  }}
                />
                <div className="dc-waiting-hint">
                  <span className="dc-pulse" />
                  Waiting for connection…
                </div>
                <div className="dc-manual-toggle">
                  <button
                    type="button"
                    className="dc-manual-link"
                    onClick={() => setDcShowManual(s => !s)}
                  >
                    {dcShowManual ? 'Hide manual setup' : 'Drag not working? Set up manually'}
                  </button>
                </div>
                {dcShowManual && (
                  <div className="dc-manual-section">
                    <ol className="dc-manual-steps">
                      <li>Right-click your bookmarks bar → <strong>Add bookmark</strong> (or press <kbd>Ctrl/Cmd</kbd>+<kbd>D</kbd>)</li>
                      <li>Name it anything (e.g. <em>DeeperSeek Discord</em>)</li>
                      <li>Paste the code below as the URL, then save</li>
                      <li>Open <strong>discord.com</strong> and click your new bookmark</li>
                    </ol>
                    <textarea
                      id="dc-script-fallback"
                      className="dc-script-textarea"
                      readOnly
                      value={dcScript}
                      onClick={e => (e.target as HTMLTextAreaElement).select()}
                    />
                    <button
                      type="button"
                      className="dc-copy-btn"
                      onClick={handleCopyScript}
                    >
                      {dcCopied ? '✓ Copied' : 'Copy bookmarklet code'}
                    </button>
                  </div>
                )}
                <button
                  className="dc-cancel-btn"
                  onClick={() => { if (dcPollRef.current) clearInterval(dcPollRef.current); setDcStep('idle'); setDcShowManual(false); }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="gh-oauth-section">
                <p className="gh-oauth-desc">
                  Connect your Discord account so the AI can send messages, manage servers,
                  create invites, handle DMs, and control everything on Discord — acting
                  as you, in your name.{' '}
                  <span className="dc-tos-note">You authorize this at your own responsibility.</span>
                </p>
                <button
                  className="dc-connect-btn"
                  onClick={handleConnectDiscord}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                  </svg>
                  Connect Discord
                </button>
                {dcError && <div className="gh-oauth-error">{dcError}</div>}
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
