'use strict';

/**
 * auth.js — minimal auth for personal single-user tool.
 * Just checks a static API key from .env if set.
 * Not needed for local access — can be disabled entirely.
 */

function authMiddleware(req, res, next) {
  const requiredKey = process.env.ACCESS_KEY;

  // If no ACCESS_KEY set → open access (personal VPS, single user)
  if (!requiredKey) return next();

  const provided = req.headers['x-api-key'] || req.query.key;
  if (provided === requiredKey) return next();

  res.status(401).json({ error: 'Unauthorized' });
}

module.exports = authMiddleware;
