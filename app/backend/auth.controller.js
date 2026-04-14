'use strict';

const authService = require('./auth.service');
const logger = require('./logger');

// ── POST /api/auth/register ──────────────────────────────────────────────
async function register(req, res) {
  if (authService.getAuthMode() !== 'multi_user') {
    return res.status(403).json({ error: 'Account creation is disabled on this instance.' });
  }

  const { email, password, username, invite_code } = req.body || {};

  // Invite code gate — required for every registration AFTER the first user,
  // if REGISTRATION_KEY is set.
  const requiredKey = authService.getRegistrationKey();
  const userCount   = authService.getUserCount();
  if (requiredKey && userCount > 0 && invite_code !== requiredKey) {
    return res.status(403).json({ error: 'Invalid or missing invite code.' });
  }

  try {
    const user  = authService.createUser({ email, password, username });
    const token = authService.issueToken(user.id);
    res.json({
      token,
      user: authService.publicUser(user),
      is_admin_bootstrap: user.role === 'admin' && userCount === 0,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Registration failed' });
  }
}

// ── POST /api/auth/login ─────────────────────────────────────────────────
async function login(req, res) {
  if (authService.getAuthMode() !== 'multi_user') {
    return res.status(403).json({ error: 'Login is disabled on this instance.' });
  }

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const user = authService.authenticateUser(email, password);
  if (!user) {
    // Same message whether email missing or password wrong — avoid enumeration
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = authService.issueToken(user.id);
  logger.info(`User logged in: ${user.email}`);
  res.json({ token, user: authService.publicUser(user) });
}

// ── POST /api/auth/logout ────────────────────────────────────────────────
async function logout(req, res) {
  const token = extractToken(req);
  if (token) authService.revokeToken(token);
  res.json({ ok: true });
}

// ── GET /api/auth/me ─────────────────────────────────────────────────────
async function me(req, res) {
  if (authService.getAuthMode() !== 'multi_user') {
    return res.json({
      mode: 'open',
      user: null,
      registration_gated: false,
      user_count: 0,
    });
  }

  const token = extractToken(req);
  const user  = token ? authService.verifyToken(token) : null;
  res.json({
    mode: 'multi_user',
    user: authService.publicUser(user),
    registration_gated: !!authService.getRegistrationKey(),
    user_count: authService.getUserCount(),
  });
}

// ── GET /api/auth/config ─────────────────────────────────────────────────
// Lightweight public endpoint so the frontend can decide whether to show the
// login screen BEFORE anyone has logged in. Safe to expose — returns no PII.
async function config(req, res) {
  res.json({
    mode: authService.getAuthMode(),
    registration_gated: !!authService.getRegistrationKey(),
    user_count: authService.getUserCount(),
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────
function extractToken(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  if (req.query && req.query.token) return String(req.query.token);
  return null;
}

module.exports = { register, login, logout, me, config, extractToken };
