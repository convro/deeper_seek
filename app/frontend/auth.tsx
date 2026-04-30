/**
 * auth.tsx — Login / Register screen + user menu.
 * Shown when AUTH_MODE=multi_user and no valid token is stored.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  loginRequest, registerRequest, setAuthToken, clearAuthToken, logoutRequest,
  fetchAuthConfig, fetchMe,
} from './api';
import type { AuthUser, AuthConfig } from './api';

const LOGO_URL = 'https://r.convro.eu/content/Stable/realises/ds73';

// ── Canvas snowflake animation ────────────────────────────────────────────

// Each variant is a list of [stemFraction, branchXFraction] pairs.
// The branch goes: from (0, -size*sf) to (±size*xf, -size*(sf + xf*0.9))
const FLAKE_VARIANTS: ReadonlyArray<ReadonlyArray<[number, number]>> = [
  [[0.35, 0.22], [0.70, 0.16]],
  [[0.25, 0.19], [0.50, 0.27], [0.76, 0.15]],
  [[0.30, 0.30], [0.65, 0.20]],
  [[0.22, 0.18], [0.44, 0.24], [0.66, 0.22], [0.84, 0.12]],
  [[0.38, 0.26], [0.72, 0.17]],
];

interface Flake {
  baseX: number; y: number; size: number; baseAlpha: number;
  rot: number; rotSpeed: number; fallSpeed: number;
  driftAmp: number; driftSpeed: number; driftPhase: number;
  variant: number; bursted: boolean;
}
interface Particle {
  x: number; y: number; vx: number; vy: number; gravity: number;
  size: number; baseAlpha: number; rot: number; rotSpeed: number;
  variant: number; life: number; decay: number;
}

function makeFlake(h: number): Flake {
  return {
    baseX: Math.random(), y: -Math.random() * h,
    size: 6 + Math.random() * 10, baseAlpha: 0.4 + Math.random() * 0.5,
    rot: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 1.2,
    fallSpeed: 28 + Math.random() * 35,
    driftAmp: 12 + Math.random() * 22,
    driftSpeed: 0.35 + Math.random() * 0.55,
    driftPhase: Math.random() * Math.PI * 2,
    variant: Math.floor(Math.random() * FLAKE_VARIANTS.length), bursted: false,
  };
}

function drawFlake(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, rot: number, alpha: number, variant: number) {
  const branches = FLAKE_VARIANTS[variant % FLAKE_VARIANTS.length];
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = Math.max(0.7, size / 9);
  ctx.lineCap = 'round';
  for (let arm = 0; arm < 6; arm++) {
    ctx.save();
    ctx.rotate(arm * Math.PI / 3);
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(0, -size);
    for (const [sf, xf] of branches) {
      const sy = -size * sf;
      const bx = size * xf;
      const by = sy - size * xf * 0.9;
      ctx.moveTo(0, sy); ctx.lineTo(-bx, by);
      ctx.moveTo(0, sy); ctx.lineTo( bx, by);
    }
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function spawnBurst(x: number, y: number, f: Flake, particles: Particle[]) {
  const count = 5 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.9;
    const speed = 40 + Math.random() * 65;
    particles.push({
      x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 28,
      gravity: 20, size: f.size * (0.22 + Math.random() * 0.28),
      baseAlpha: 0.75 + Math.random() * 0.25,
      rot: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 5,
      variant: f.variant, life: 1, decay: 1.2 + Math.random() * 0.8,
    });
  }
}

function SnowCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (window.innerWidth <= 768) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const flakes: Flake[] = [];
    const particles: Particle[] = [];

    // Track mouse position for hover-burst; null = off-screen
    let mx = -9999, my = -9999;
    const onMouseMove = (e: MouseEvent) => { mx = e.clientX; my = e.clientY; };
    const onMouseLeave = () => { mx = -9999; my = -9999; };
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('mouseleave', onMouseLeave, { passive: true });

    const resize = () => {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      if (flakes.length === 0)
        for (let i = 0; i < 28; i++) flakes.push(makeFlake(canvas.height));
    };
    resize();
    window.addEventListener('resize', resize, { passive: true });

    let lastTime = performance.now();
    let rafId = 0;

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);

      const burstY     = height * 0.82;
      const fadeStartY = height * 0.70;

      for (const f of flakes) {
        f.y   += f.fallSpeed * dt;
        f.rot += f.rotSpeed  * dt;
        const x = f.baseX * width + Math.sin(now / 1000 * f.driftSpeed + f.driftPhase) * f.driftAmp;

        if (!f.bursted && f.y >= burstY) {
          f.bursted = true;
          spawnBurst(x, f.y, f, particles);
        }

        // Cursor proximity burst — trigger if pointer is within the flake radius
        if (!f.bursted) {
          const dx = mx - x, dy = my - f.y;
          if (dx * dx + dy * dy < (f.size + 8) * (f.size + 8)) {
            f.bursted = true;
            spawnBurst(x, f.y, f, particles);
          }
        }

        if (f.y > height + 80) {
          f.y = -f.size * 4 - Math.random() * 120;
          f.baseX   = Math.random();
          f.bursted = false;
        }
        if (f.bursted) continue;

        let alpha = f.baseAlpha;
        if (f.y > fadeStartY) {
          const t = (f.y - fadeStartY) / (burstY - fadeStartY);
          alpha *= 1 - t * 0.85;
        }
        drawFlake(ctx, x, f.y, f.size, f.rot, alpha, f.variant);
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= p.decay * dt;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        p.x  += p.vx * dt;
        p.y  += p.vy * dt;
        p.vy += p.gravity * dt;
        p.vx *= Math.pow(0.88, dt * 60);
        p.rot += p.rotSpeed * dt;
        drawFlake(ctx, p.x, p.y, p.size, p.rot, p.baseAlpha * p.life, p.variant);
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseleave', onMouseLeave);
    };
  }, []);

  if (typeof window !== 'undefined' && window.innerWidth <= 768) return null;
  return <canvas ref={canvasRef} className="auth-snow-canvas" aria-hidden="true" />;
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
  const [email,        setEmail]       = useState('');
  const [password,     setPassword]    = useState('');
  const [username,     setUsername]    = useState('');
  const [license,      setLicense]     = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error,        setError]       = useState<string | null>(null);
  const [loading,      setLoading]     = useState(false);

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
      <SnowCanvas />

      {/* ── Left panel (desktop only) ──────────────────────────────── */}
      <div className="auth-panel-left" aria-hidden="true">
        <div className="auth-panel-brand">
          <img src={LOGO_URL} alt="" className="auth-panel-logo" />
          <span className="auth-panel-name">DeeperSeek</span>
        </div>

        <h2 className="auth-panel-headline">The AI that actually works.</h2>
        <p className="auth-panel-sub">
          Not a chatbot. Extended reasoning, parallel agents,<br />
          and 60+ real tools — all in one workspace.
        </p>

        <ul className="auth-features">
          <li className="auth-feature">
            <span className="auth-feature-icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 1.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 4a.75.75 0 0 1 .75.75v3.5l2 1.15a.75.75 0 1 1-.75 1.3L7.5 9.2a.75.75 0 0 1-.375-.65v-3.8A.75.75 0 0 1 8 4z" fill="currentColor"/>
              </svg>
            </span>
            <div>
              <strong>Extended Thinking</strong>
              <span>Chain-of-thought reasoning before every complex answer</span>
            </div>
          </li>
          <li className="auth-feature">
            <span className="auth-feature-icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="3" cy="8" r="2" fill="currentColor"/>
                <circle cx="13" cy="4" r="2" fill="currentColor"/>
                <circle cx="13" cy="12" r="2" fill="currentColor"/>
                <path d="M5 8h3M10 4.5 8.5 7M10 11.5 8.5 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </span>
            <div>
              <strong>Parallel Agents</strong>
              <span>Spawn multiple specialized agents that work simultaneously</span>
            </div>
          </li>
          <li className="auth-feature">
            <span className="auth-feature-icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="1" width="6" height="6" rx="1.5" fill="currentColor" opacity=".8"/>
                <rect x="9" y="1" width="6" height="6" rx="1.5" fill="currentColor" opacity=".6"/>
                <rect x="1" y="9" width="6" height="6" rx="1.5" fill="currentColor" opacity=".6"/>
                <rect x="9" y="9" width="6" height="6" rx="1.5" fill="currentColor" opacity=".4"/>
              </svg>
            </span>
            <div>
              <strong>60+ Built-in Tools</strong>
              <span>Web, code, browser, files, GitHub, APIs — zero setup</span>
            </div>
          </li>
          <li className="auth-feature">
            <span className="auth-feature-icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v7a1.5 1.5 0 0 1-1.5 1.5H9l1 2H10l-2-2-2 2H5l1-2H3.5A1.5 1.5 0 0 1 2 10.5v-7z" fill="currentColor" opacity=".7"/>
                <path d="M5.5 6.5h5M5.5 8.5h3" stroke="white" strokeWidth="1.1" strokeLinecap="round"/>
              </svg>
            </span>
            <div>
              <strong>Isolated Workspaces</strong>
              <span>Every task gets its own sandbox — export as ZIP anytime</span>
            </div>
          </li>
        </ul>

        {state.userCount > 0 && (
          <div className="auth-panel-stat">
            <span className="auth-panel-stat-dot" />
            {state.userCount.toLocaleString()} {state.userCount === 1 ? 'user' : 'users'} active
          </div>
        )}
      </div>

      {/* ── Right panel — form ──────────────────────────────────────── */}
      <div className="auth-card">
        {/* Brand shown only on mobile (hidden on desktop via CSS) */}
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
            <div className="auth-input-wrap">
              <input
                type={showPassword ? 'text' : 'password'}
                className="auth-input"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={tab === 'register' ? 'min 8 characters' : '••••••••'}
                autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
                required
                minLength={tab === 'register' ? 8 : undefined}
              />
              <button
                type="button"
                className="auth-pw-toggle"
                onClick={() => setShowPassword(p => !p)}
                tabIndex={-1}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 8s2.667-5 7-5 7 5 7 5-2.667 5-7 5-7-5-7-5z"/>
                    <circle cx="8" cy="8" r="2.2"/>
                    <line x1="2" y1="2" x2="14" y2="14"/>
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 8s2.667-5 7-5 7 5 7 5-2.667 5-7 5-7-5-7-5z"/>
                    <circle cx="8" cy="8" r="2.2"/>
                  </svg>
                )}
              </button>
            </div>
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
