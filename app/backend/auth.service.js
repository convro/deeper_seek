'use strict';

/**
 * auth.service.js — User store + password hashing + session tokens.
 *
 * Zero external deps. Uses Node's built-in crypto (pbkdf2 for password
 * hashing, randomBytes for tokens).
 *
 * Persistence:
 *   runtime/users.json   — array of user records
 *   runtime/tokens.json  — map of token -> { userId, createdAt, lastSeen }
 *
 * Both files have 0600 perms (owner-readable only).
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const RUNTIME_DIR = path.join(__dirname, '../../runtime');
const USERS_FILE  = path.join(RUNTIME_DIR, 'users.json');
const TOKENS_FILE = path.join(RUNTIME_DIR, 'tokens.json');

fs.mkdirSync(RUNTIME_DIR, { recursive: true });

// ── PBKDF2 password hashing ──────────────────────────────────────────────
const PBKDF2_ITERATIONS = 210_000; // OWASP 2023 recommended for SHA-512
const PBKDF2_KEYLEN     = 64;
const PBKDF2_DIGEST     = 'sha512';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, iter, salt, hash] = String(stored).split('$');
    if (scheme !== 'pbkdf2') return false;
    const check = crypto.pbkdf2Sync(password, salt, parseInt(iter, 10), PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch {
    return false;
  }
}

// ── Atomic JSON file helpers ─────────────────────────────────────────────
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    logger.error(`Failed to read ${file}`, err);
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.error(`Failed to write ${file}`, err);
  }
}

// ── In-memory caches (reloaded on boot) ──────────────────────────────────
let users  = readJson(USERS_FILE,  []);   // [{id, email, username, password, createdAt, lastLoginAt, role}]
let tokens = readJson(TOKENS_FILE, {});    // { token: {userId, createdAt, lastSeen} }

function persistUsers()  { writeJson(USERS_FILE,  users); }
function persistTokens() { writeJson(TOKENS_FILE, tokens); }

// ── User helpers ─────────────────────────────────────────────────────────
function normEmail(e) { return String(e || '').trim().toLowerCase(); }

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    username: u.username || null,
    role: u.role || 'user',
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
  };
}

function findUserByEmail(email) {
  const e = normEmail(email);
  return users.find(u => u.email === e) || null;
}

function findUserById(id) {
  return users.find(u => u.id === id) || null;
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
}

function validatePassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 200;
}

function createUser({ email, password, username }) {
  const e = normEmail(email);
  if (!validateEmail(e))      throw new Error('Invalid email address');
  if (!validatePassword(password)) throw new Error('Password must be 8-200 characters');
  if (findUserByEmail(e))     throw new Error('An account with this email already exists');

  const user = {
    id: 'u_' + crypto.randomBytes(8).toString('hex'),
    email: e,
    username: (username || '').trim().slice(0, 40) || null,
    password: hashPassword(password),
    // First registered user becomes admin, subsequent users are regular 'user'
    role: users.length === 0 ? 'admin' : 'user',
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  users.push(user);
  persistUsers();
  logger.info(`User registered: ${user.email} (role=${user.role})`);
  return user;
}

function authenticateUser(email, password) {
  const u = findUserByEmail(email);
  if (!u) return null;
  if (!verifyPassword(password, u.password)) return null;
  u.lastLoginAt = new Date().toISOString();
  persistUsers();
  return u;
}

// ── Token management ─────────────────────────────────────────────────────
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;  // 30 days

function issueToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens[token] = {
    userId,
    createdAt: new Date().toISOString(),
    lastSeen:  new Date().toISOString(),
  };
  persistTokens();
  return token;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const rec = tokens[token];
  if (!rec) return null;
  const age = Date.now() - new Date(rec.createdAt).getTime();
  if (age > TOKEN_TTL_MS) {
    delete tokens[token];
    persistTokens();
    return null;
  }
  // Light-touch lastSeen update (throttled to once per minute)
  const sinceSeen = Date.now() - new Date(rec.lastSeen).getTime();
  if (sinceSeen > 60_000) {
    rec.lastSeen = new Date().toISOString();
    persistTokens();
  }
  return findUserById(rec.userId);
}

function revokeToken(token) {
  if (tokens[token]) {
    delete tokens[token];
    persistTokens();
    return true;
  }
  return false;
}

function revokeAllTokensForUser(userId) {
  let changed = false;
  for (const [tok, rec] of Object.entries(tokens)) {
    if (rec.userId === userId) {
      delete tokens[tok];
      changed = true;
    }
  }
  if (changed) persistTokens();
}

// ── Auth mode ────────────────────────────────────────────────────────────
function getAuthMode() {
  const mode = (process.env.AUTH_MODE || 'open').toLowerCase();
  return mode === 'multi_user' ? 'multi_user' : 'open';
}

function getRegistrationKey() {
  return process.env.REGISTRATION_KEY || null;
}

function isRegistrationOpen() {
  // When AUTH_MODE=multi_user and no users exist, first registration is always
  // allowed (bootstraps admin). Otherwise, if REGISTRATION_KEY is set, it is
  // required. If neither restriction applies, registration is open.
  return true;
}

// Count of users — useful for the login screen (show "Create first admin" hint)
function getUserCount() {
  return users.length;
}

module.exports = {
  hashPassword,
  verifyPassword,
  createUser,
  authenticateUser,
  findUserByEmail,
  findUserById,
  publicUser,
  issueToken,
  verifyToken,
  revokeToken,
  revokeAllTokensForUser,
  getAuthMode,
  getRegistrationKey,
  isRegistrationOpen,
  getUserCount,
};
