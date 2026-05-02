'use strict';

/**
 * auth.js — Request authentication middleware.
 *
 * Modes (via AUTH_MODE env var):
 *   - 'open' (default)         : no auth required. req.user = null.
 *                                Preserves legacy single-user behavior.
 *   - 'multi_user'             : Bearer token required. req.user is populated.
 *
 * Legacy ACCESS_KEY support: still honored in BOTH modes as an additional
 * accepted credential (X-API-Key header or ?key=...), so old integrations
 * keep working. In multi_user mode, a request with a valid ACCESS_KEY passes
 * as an "api-key" user (no per-user namespacing).
 */

const authService = require('./auth.service');
const { extractToken } = require('./auth.controller');

function authMiddleware(req, res, next) {
  const mode = authService.getAuthMode();

  // Internal service token — used by Python tool subprocesses that call back
  // into the backend (e.g. agent_spawn.py). Must be localhost-only AND carry
  // the shared secret that was generated at boot. Can impersonate a user via
  // X-Internal-User-Id header.
  const internalTok = req.headers['x-internal-token'];
  if (internalTok && internalTok === authService.getInternalToken()) {
    const remote = req.socket && req.socket.remoteAddress || '';
    const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (isLocal) {
      const impersonatedId = req.headers['x-internal-user-id'];
      if (impersonatedId) {
        const u = authService.findUserById(impersonatedId);
        if (u) {
          req.user = { ...authService.publicUser(u), via: 'internal' };
          return next();
        }
      }
      // No impersonation — treat as admin service call (open-mode compatible)
      req.user = { id: '__internal__', email: null, role: 'admin', via: 'internal' };
      return next();
    }
  }

  // Legacy: ACCESS_KEY grants full access in either mode
  const accessKey = process.env.ACCESS_KEY;
  if (accessKey) {
    const provided = req.headers['x-api-key'] || req.query.key;
    if (provided === accessKey) {
      req.user = { id: '__api_key__', email: null, role: 'admin', via: 'api_key' };
      return next();
    }
    // If ACCESS_KEY is set and AUTH_MODE is 'open', we still require the key
    if (mode === 'open') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (mode === 'open') {
    req.user = null;
    return next();
  }

  // multi_user mode — require valid bearer token
  const token = extractToken(req);
  const user  = token ? authService.verifyToken(token) : null;
  if (!user) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  req.user = { ...authService.publicUser(user), via: 'token' };
  next();
}

// Optional middleware: populates req.user if token is present, but never
// blocks. Used for routes that work for both logged-in and anonymous users.
function optionalAuth(req, res, next) {
  const token = extractToken(req);
  const user  = token ? authService.verifyToken(token) : null;
  req.user = user ? { ...authService.publicUser(user), via: 'token' } : null;
  next();
}

// Admin-only middleware (must be chained AFTER authMiddleware)
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = authMiddleware;
module.exports.authMiddleware = authMiddleware;
module.exports.optionalAuth   = optionalAuth;
module.exports.requireAdmin   = requireAdmin;
