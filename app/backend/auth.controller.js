'use strict';

const authService = require('./auth.service');
const logger = require('./logger');

// ── POST /api/auth/register ──────────────────────────────────────────────
// Requires a valid, unused license key. Every registered user is a plain
// 'user' role — there is no admin bootstrap.
async function register(req, res) {
  if (authService.getAuthMode() !== 'multi_user') {
    return res.status(403).json({ error: 'Account creation is disabled on this instance.' });
  }

  const { email, password, username, license_key } = req.body || {};
  if (!license_key) {
    return res.status(400).json({ error: 'License key is required.' });
  }

  try {
    const user  = authService.createUser({ email, password, username, licenseKey: license_key });
    const token = authService.issueToken(user.id);
    res.json({
      token,
      user: authService.publicUser(user),
    });
  } catch (err) {
    // Surface all validation failures as 400 (including bad/used license)
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
      user_count: 0,
    });
  }

  const token = extractToken(req);
  const user  = token ? authService.verifyToken(token) : null;
  res.json({
    mode: 'multi_user',
    user: authService.publicUser(user),
    user_count: authService.getUserCount(),
  });
}

// ── GET /api/auth/config ─────────────────────────────────────────────────
// Lightweight public endpoint so the frontend can decide whether to show the
// login screen BEFORE anyone has logged in. Safe to expose — returns no PII.
async function config(req, res) {
  res.json({
    mode: authService.getAuthMode(),
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
