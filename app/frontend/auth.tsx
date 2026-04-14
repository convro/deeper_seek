/**
 * auth.tsx — Login / Register screen + user menu.
 * Shown when AUTH_MODE=multi_user and no valid token is stored.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  loginRequest, registerRequest, setAuthToken, clearAuthToken, logoutRequest,
  fetchAuthConfig, fetchMe,
} from './api';
import type { AuthUser, AuthConfig } from './api';

const LOGO_URL = 'https://r.convro.eu/content/Stable/realises/ds73';

export type AuthMode = 'open' | 'multi_user';

export interface AuthState {
  mode: AuthMode;
  user: AuthUser | null;
  ready: boolean;           // finished bootstrapping (fetched config + me)
  registrationGated: boolean;
  userCount: number;
}

/**
 * Bootstrap auth state on app load.
 *  - Fetches /api/auth/config to learn the mode.
 *  - If multi_user and a token is stored, calls /api/auth/me to validate it.
 */
export function useAuth(): [AuthState, {
  login: (e: string, p: string) => Promise<void>;
  register: (e: string, p: string, u?: string, invite?: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}] {
  const [state, setState] = useState<AuthState>({
    mode: 'open',
    user: null,
    ready: false,
    registrationGated: false,
    userCount: 0,
  });

  const bootstrap = useCallback(async () => {
    try {
      const cfg: AuthConfig = await fetchAuthConfig();
      if (cfg.mode !== 'multi_user') {
        setState({
          mode: 'open',
          user: null,
          ready: true,
          registrationGated: false,
          userCount: cfg.user_count,
        });
        return;
      }
      // multi_user mode — check current session
      try {
        const me = await fetchMe();
        setState({
          mode: 'multi_user',
          user: me.user,
          ready: true,
          registrationGated: me.registration_gated,
          userCount: me.user_count,
        });
      } catch {
        setState({
          mode: 'multi_user',
          user: null,
          ready: true,
          registrationGated: cfg.registration_gated,
          userCount: cfg.user_count,
        });
      }
    } catch {
      // Backend unreachable? Default to open so we don't block the app forever.
      setState(s => ({ ...s, ready: true }));
    }
  }, []);

  useEffect(() => { bootstrap(); }, [bootstrap]);

  // Listen for 401s elsewhere in the app — force re-login
  useEffect(() => {
    const h = () => setState(s => ({ ...s, user: null }));
    window.addEventListener('deeperseek-auth-required', h);
    return () => window.removeEventListener('deeperseek-auth-required', h);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await loginRequest(email, password);
    setAuthToken(r.token);
    setState(s => ({ ...s, user: r.user }));
  }, []);

  const register = useCallback(async (email: string, password: string, username?: string, invite?: string) => {
    const r = await registerRequest(email, password, username, invite);
    setAuthToken(r.token);
    setState(s => ({ ...s, user: r.user, userCount: s.userCount + 1 }));
  }, []);

  const logout = useCallback(async () => {
    await logoutRequest();
    clearAuthToken();
    setState(s => ({ ...s, user: null }));
  }, []);

  return [state, { login, register, logout, refresh: bootstrap }];
}

// ── Login / Register Screen ──────────────────────────────────────────────
interface AuthScreenProps {
  state: AuthState;
  onLogin:    (email: string, password: string) => Promise<void>;
  onRegister: (email: string, password: string, username?: string, invite?: string) => Promise<void>;
}

export function AuthScreen({ state, onLogin, onRegister }: AuthScreenProps) {
  const [tab, setTab] = useState<'login' | 'register'>(
    state.userCount === 0 ? 'register' : 'login',
  );
  const [email,      setEmail]    = useState('');
  const [password,   setPassword] = useState('');
  const [username,   setUsername] = useState('');
  const [invite,     setInvite]   = useState('');
  const [error,      setError]    = useState<string | null>(null);
  const [loading,    setLoading]  = useState(false);

  const isBootstrap = state.userCount === 0;
  const needInvite  = state.registrationGated && state.userCount > 0 && tab === 'register';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (tab === 'login') {
        await onLogin(email.trim(), password);
      } else {
        if (password.length < 8) throw new Error('Password must be at least 8 characters.');
        await onRegister(email.trim(), password, username.trim() || undefined, invite.trim() || undefined);
      }
    } catch (err: any) {
      setError(err?.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      {/* Ambient glow backdrop */}
      <div className="auth-backdrop">
        <div className="auth-orb auth-orb-1" />
        <div className="auth-orb auth-orb-2" />
        <div className="auth-orb auth-orb-3" />
      </div>

      <div className="auth-card">
        <div className="auth-brand">
          <img src={LOGO_URL} alt="DeeperSeek" className="auth-logo" />
          <h1 className="auth-title">
            {'DeeperSeek'.split('').map((ch, i) => (
              <span
                key={i}
                className="auth-title-letter"
                style={{ animationDelay: `${i * 0.35}s` }}
              >{ch}</span>
            ))}
          </h1>
          <p className="auth-tagline">
            {isBootstrap
              ? 'Create the first account — you will be the admin.'
              : tab === 'login' ? 'Welcome back.' : 'Create your account.'}
          </p>
        </div>

        <div className="auth-tabs">
          <button
            type="button"
            className={`auth-tab ${tab === 'login' ? 'active' : ''}`}
            onClick={() => { setTab('login'); setError(null); }}
            disabled={isBootstrap}
          >Sign in</button>
          <button
            type="button"
            className={`auth-tab ${tab === 'register' ? 'active' : ''}`}
            onClick={() => { setTab('register'); setError(null); }}
          >{isBootstrap ? 'Create admin' : 'Create account'}</button>
        </div>

        <form className="auth-form" onSubmit={submit}>
          {tab === 'register' && (
            <label className="auth-field">
              <span className="auth-label">Username <span className="auth-optional">(optional)</span></span>
              <input
                type="text"
                className="auth-input"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="mordeczko"
                autoComplete="username"
                maxLength={40}
              />
            </label>
          )}

          <label className="auth-field">
            <span className="auth-label">Email</span>
            <input
              type="email"
              className="auth-input"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              required
            />
          </label>

          <label className="auth-field">
            <span className="auth-label">Password</span>
            <input
              type="password"
              className="auth-input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={tab === 'register' ? 'min 8 characters' : '••••••••'}
              autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
              required
              minLength={tab === 'register' ? 8 : undefined}
            />
          </label>

          {needInvite && (
            <label className="auth-field">
              <span className="auth-label">Invite code</span>
              <input
                type="text"
                className="auth-input"
                value={invite}
                onChange={e => setInvite(e.target.value)}
                placeholder="required for registration"
                required
              />
            </label>
          )}

          {error && <div className="auth-error">{error}</div>}

          <button
            type="submit"
            className="auth-submit"
            disabled={loading || !email || !password}
          >
            {loading
              ? <span className="auth-spinner" />
              : tab === 'login' ? 'Sign in' : (isBootstrap ? 'Create admin account' : 'Create account')}
          </button>
        </form>

        <div className="auth-footer">
          <span className="auth-footer-brand">DeeperSeek</span>
          <span className="auth-footer-dot">•</span>
          <span>Autonomous AI agent system</span>
        </div>
      </div>
    </div>
  );
}

// ── Compact user menu (for sidebar) ──────────────────────────────────────
interface UserMenuProps {
  user: AuthUser;
  onLogout: () => void;
}

export function UserMenu({ user, onLogout }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const name = user.username || user.email.split('@')[0];
  const initial = (name[0] || '?').toUpperCase();

  return (
    <div className="user-menu">
      <button
        className="user-menu-trigger"
        onClick={() => setOpen(o => !o)}
        title={user.email}
      >
        <span className="user-avatar">{initial}</span>
        <span className="user-name">{name}</span>
        {user.role === 'admin' && <span className="user-badge">admin</span>}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style={{ marginLeft: 'auto' }}>
          <path d="M5 7 1 3h8z" />
        </svg>
      </button>
      {open && (
        <>
          <div className="user-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="user-menu-popover">
            <div className="user-menu-header">
              <div className="user-menu-email">{user.email}</div>
              <div className="user-menu-role">{user.role === 'admin' ? 'Administrator' : 'Member'}</div>
            </div>
            <button className="user-menu-item danger" onClick={() => { setOpen(false); onLogout(); }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M6 2a1 1 0 0 1 0-2h6a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a1 1 0 1 1 0-2h6V2zM3.707 8.707 5.414 10.414a1 1 0 0 1-1.414 1.414L.293 8.121a1 1 0 0 1 0-1.414L4 3a1 1 0 1 1 1.414 1.414L3.707 6.293H10a1 1 0 1 1 0 2H3.707z"/>
              </svg>
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
