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

// ── Snow effect (desktop only) ────────────────────────────────────────────

// Six rotations for the 6-fold crystalline symmetry of each snowflake arm.
const FLAKE_ROTATIONS = [0, 60, 120, 180, 240, 300];

// Five distinct arm patterns (SVG path, arm points up toward negative Y).
// Each arm is stamped 6× at 60° increments to form a full snowflake.
const FLAKE_ARMS: string[] = [
  // A — classic dendrite: two symmetric branch pairs
  'M0,0L0,-12 M0,-4.2L-2.8,-7M0,-4.2L2.8,-7 M0,-8.5L-2,-10.5M0,-8.5L2,-10.5',
  // B — fern-stellar: three branch pairs tapering toward tip
  'M0,0L0,-13.5 M0,-3L-2.5,-5.5M0,-3L2.5,-5.5 M0,-7L-3,-9.5M0,-7L3,-9.5 M0,-11L-1.8,-13M0,-11L1.8,-13',
  // C — bullet rosette: wide angled branches
  'M0,0L0,-11.5 M0,-3.5L-3.5,-7M0,-3.5L3.5,-7 M0,-7.5L-2.5,-10.5M0,-7.5L2.5,-10.5',
  // D — short ornate: four tight branch pairs with tip spurs
  'M0,0L0,-10.5 M0,-2L-1.8,-3.8M0,-2L1.8,-3.8 M0,-4.5L-2.5,-7M0,-4.5L2.5,-7 M0,-7.5L-2,-9.5M0,-7.5L2,-9.5 M0,-10.5L-1.5,-12M0,-10.5L1.5,-12',
  // E — stellar plates: long sparse arms with tip fork
  'M0,0L0,-13 M0,-5L-3,-8.5M0,-5L3,-8.5 M0,-9.5L-2,-12M0,-9.5L2,-12 M0,-13L-1,-14M0,-13L1,-14',
];

const SNOW_FLAKES = (() => {
  const count = 28;
  return Array.from({ length: count }, (_, i) => ({
    left:      (i / count) * 100 + (Math.sin(i * 1.73) * 50 + 50) / count,
    size:      Math.round(12 + (Math.cos(i * 2.31) * 0.5 + 0.5) * 13), // 12–25 px
    opacity:   +(0.45 + (Math.sin(i * 1.17) * 0.5 + 0.5) * 0.48).toFixed(2), // 0.45–0.93
    fallDur:   +(13 + (Math.sin(i * 0.79) * 0.5 + 0.5) * 11).toFixed(1), // 13–24 s
    fallDelay: +(-Math.abs(Math.sin(i * 3.14)) * 24).toFixed(1),
    driftDur:  +(3.5 + (Math.cos(i * 1.27) * 0.5 + 0.5) * 4.5).toFixed(1), // 3.5–8 s
    driftDelay:+(-Math.abs(Math.sin(i * 2.61)) * 5).toFixed(1),
    driftAmt:  Math.round(10 + (Math.sin(i * 0.91) * 0.5 + 0.5) * 22), // 10–32 px
    driftDir:  (i % 2 === 0 ? 'alternate' : 'alternate-reverse') as React.CSSProperties['animationDirection'],
    variant:   i % FLAKE_ARMS.length,
  }));
})();

function SnowflakeParticles() {
  if (typeof window === 'undefined' || window.innerWidth <= 768) return null;
  return (
    <div className="auth-snow" aria-hidden="true">
      {SNOW_FLAKES.map((f, i) => (
        <div
          key={i}
          className="auth-snow-outer"
          style={{
            left: `${f.left.toFixed(1)}%`,
            ['--drift' as string]: `${f.driftAmt}px`,
            animationDuration: `${f.driftDur}s`,
            animationDelay: `${f.driftDelay}s`,
            animationDirection: f.driftDir,
          } as React.CSSProperties}
        >
          <svg
            className="auth-snow-inner"
            viewBox="-14 -14 28 28"
            width={f.size}
            height={f.size}
            style={{
              opacity: f.opacity,
              animationDuration: `${f.fallDur}s`,
              animationDelay: `${f.fallDelay}s`,
            }}
          >
            <g
              stroke="rgba(255,255,255,0.94)"
              strokeWidth={f.size >= 20 ? '1.2' : '1.5'}
              strokeLinecap="round"
              fill="none"
            >
              {FLAKE_ROTATIONS.map(r => (
                <g key={r} transform={`rotate(${r})`}>
                  <path d={FLAKE_ARMS[f.variant]} />
                </g>
              ))}
            </g>
          </svg>
        </div>
      ))}
    </div>
  );
}

export type AuthMode = 'open' | 'multi_user';

export interface AuthState {
  mode: AuthMode;
  user: AuthUser | null;
  ready: boolean;           // finished bootstrapping (fetched config + me)
  userCount: number;
}

/**
 * Bootstrap auth state on app load.
 *  - Fetches /api/auth/config to learn the mode.
 *  - If multi_user and a token is stored, calls /api/auth/me to validate it.
 */
export function useAuth(): [AuthState, {
  login: (e: string, p: string) => Promise<void>;
  register: (e: string, p: string, licenseKey: string, u?: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}] {
  const [state, setState] = useState<AuthState>({
    mode: 'open',
    user: null,
    ready: false,
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
          userCount: me.user_count,
        });
      } catch {
        setState({
          mode: 'multi_user',
          user: null,
          ready: true,
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

  const register = useCallback(async (email: string, password: string, licenseKey: string, username?: string) => {
    const r = await registerRequest(email, password, licenseKey, username);
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
  onRegister: (email: string, password: string, licenseKey: string, username?: string) => Promise<void>;
}

export function AuthScreen({ state, onLogin, onRegister }: AuthScreenProps) {
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [email,      setEmail]    = useState('');
  const [password,   setPassword] = useState('');
  const [username,   setUsername] = useState('');
  const [license,    setLicense]  = useState('');
  const [error,      setError]    = useState<string | null>(null);
  const [loading,    setLoading]  = useState(false);

  // ── iOS keyboard pin ────────────────────────────────────────────────
  // .auth-screen is position:fixed, so when the iOS keyboard opens the
  // visual viewport shrinks/pans and the card appears to slide under
  // the keyboard. Pin the element to the live visual viewport instead
  // of the (static) layout viewport. Mirrors the logic in index.tsx for
  // the main .app-root container.
  useEffect(() => {
    const vv = window.visualViewport;
    const el = document.querySelector('.auth-screen') as HTMLElement | null;
    if (!el) return;

    let fullHeight = vv ? vv.height : window.innerHeight;

    const update = () => {
      const h   = vv ? vv.height    : window.innerHeight;
      const top = vv ? vv.offsetTop : 0;
      if (h > fullHeight) fullHeight = h;

      el.style.height = h + 'px';
      el.style.top    = top + 'px';

      document.body.classList.toggle('keyboard-open', h < fullHeight * 0.85);

      // Kill any residual document-level scroll iOS may have introduced
      window.scrollTo(0, 0);
    };

    update();

    if (vv) {
      vv.addEventListener('resize', update, { passive: true });
      vv.addEventListener('scroll', update, { passive: true });
    } else {
      window.addEventListener('resize', update, { passive: true });
    }

    return () => {
      if (vv) {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      } else {
        window.removeEventListener('resize', update);
      }
      document.body.classList.remove('keyboard-open');
    };
  }, []);

  // Scroll focused input into view when the virtual keyboard shrinks the viewport.
  useEffect(() => {
    const onFocus = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.tagName !== 'INPUT') return;
      setTimeout(() => t.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 160);
    };
    document.addEventListener('focusin', onFocus, { passive: true });
    return () => document.removeEventListener('focusin', onFocus);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (tab === 'login') {
        await onLogin(email.trim(), password);
      } else {
        if (password.length < 8) throw new Error('Password must be at least 8 characters.');
        if (!license.trim())     throw new Error('License key is required.');
        await onRegister(email.trim(), password, license.trim().toUpperCase(), username.trim() || undefined);
      }
    } catch (err: any) {
      setError(err?.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <SnowflakeParticles />
      <div className="auth-card">
        <div className="auth-brand">
          <img src={LOGO_URL} alt="DeeperSeek" className="auth-logo" />
          <h1 className="auth-title">DeeperSeek</h1>
          <p className="auth-tagline">
            {tab === 'login' ? 'Welcome back.' : 'Create your account.'}
          </p>
        </div>

        <div className="auth-tabs">
          <button
            type="button"
            className={`auth-tab ${tab === 'login' ? 'active' : ''}`}
            onClick={() => { setTab('login'); setError(null); }}
          >Sign in</button>
          <button
            type="button"
            className={`auth-tab ${tab === 'register' ? 'active' : ''}`}
            onClick={() => { setTab('register'); setError(null); }}
          >Create account</button>
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

          {tab === 'register' && (
            <label className="auth-field">
              <span className="auth-label">License key</span>
              <input
                type="text"
                className="auth-input auth-input-license"
                value={license}
                onChange={e => setLicense(e.target.value.toUpperCase())}
                placeholder="DS-XXXX-XXXX-XXXX-XXXX"
                autoComplete="off"
                spellCheck={false}
                required
                maxLength={24}
              />
            </label>
          )}

          {error && <div className="auth-error">{error}</div>}

          <button
            type="submit"
            className="auth-submit"
            disabled={loading || !email || !password || (tab === 'register' && !license)}
          >
            {loading
              ? <span className="auth-spinner" />
              : tab === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Compact user menu (for sidebar) ──────────────────────────────────────
interface UserMenuProps {
  user: AuthUser;
  onLogout: () => void;
  /** Optional: when set, shows an "Edit profile" item that calls this
   *  (typically wired to reset onboarding so the questionnaire opens again). */
  onEditProfile?: () => void | Promise<void>;
  /** Optional: opens the settings modal. */
  onSettings?: () => void;
}

function formatJoined(iso: string | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return ''; }
}

export function UserMenu({ user, onLogout, onEditProfile, onSettings }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const name = user.username || user.email.split('@')[0];
  const initial = (name[0] || '?').toUpperCase();
  const roleLabel = user.role === 'admin' ? 'Admin' : 'Member';

  return (
    <div className="user-menu">
      <button
        className="user-menu-trigger"
        onClick={() => setOpen(o => !o)}
        title={user.email}
      >
        <span className="user-avatar">{initial}</span>
        <span className="user-trigger-text">
          <span className="user-name">{name}</span>
          <span className="user-sub">{user.email}</span>
        </span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style={{ marginLeft: 'auto', flexShrink: 0 }}>
          <path d="M5 7 1 3h8z" />
        </svg>
      </button>
      {open && (
        <>
          <div className="user-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="user-menu-popover">
            <div className="user-menu-header">
              <div className="user-menu-header-row">
                <span className="user-avatar user-avatar-lg">{initial}</span>
                <div className="user-menu-meta">
                  <div className="user-menu-name">{name}</div>
                  <div className="user-menu-email">{user.email}</div>
                </div>
              </div>
              <div className="user-menu-stats">
                <span className={`user-menu-role-badge ${user.role === 'admin' ? 'admin' : ''}`}>{roleLabel}</span>
                {user.createdAt && (
                  <span className="user-menu-joined">since {formatJoined(user.createdAt)}</span>
                )}
              </div>
            </div>

            {onSettings && (
              <button
                className="user-menu-item"
                onClick={() => { setOpen(false); onSettings(); }}
                title="App settings"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/>
                  <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.474l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z"/>
                </svg>
                Settings
              </button>
            )}

            {onEditProfile && (
              <button
                className="user-menu-item"
                onClick={() => { setOpen(false); onEditProfile(); }}
                title="Re-do the soul questionnaire"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.609Z"/>
                </svg>
                Edit profile
              </button>
            )}

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
