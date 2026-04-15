'use strict';

/**
 * auth.service.js — User store + password hashing + session tokens + licenses.
 *
 * Zero external deps. Uses Node's built-in crypto (pbkdf2 for password
 * hashing, randomBytes for tokens + license keys).
 *
 * Persistence:
 *   runtime/users.json     — array of user records
 *   runtime/tokens.json    — map of token -> { userId, createdAt, lastSeen }
 *   runtime/licenses.json  — map of key   -> { createdAt, usedBy, usedAt }
 *
 * All files have 0600 perms (owner-readable only).
 *
 * Registration model:
 *   Every account must be created with a valid, unused license key. License
 *   keys are generated on the server via `node scripts/license.js` and
 *   consumed atomically during registration (one key = one account).
 *   There is no "admin" role for user accounts — every registered user is
 *   an equal, isolated tenant. The `role` field is only ever 'admin' for
 *   synthetic service identities (internal token, ACCESS_KEY api-key).
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const RUNTIME_DIR   = path.join(__dirname, '../../runtime');
const USERS_FILE    = path.join(RUNTIME_DIR, 'users.json');
const TOKENS_FILE   = path.join(RUNTIME_DIR, 'tokens.json');
const LICENSES_FILE = path.join(RUNTIME_DIR, 'licenses.json');

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
let users    = readJson(USERS_FILE,    []);   // [{id, email, username, password, createdAt, lastLoginAt, role, licenseKey}]
let tokens   = readJson(TOKENS_FILE,   {});    // { token: {userId, createdAt, lastSeen} }
let licenses = readJson(LICENSES_FILE, {});    // { key: {createdAt, usedBy, usedAt} }

function persistUsers()    { writeJson(USERS_FILE,    users); }
function persistTokens()   { writeJson(TOKENS_FILE,   tokens); }
function persistLicenses() { writeJson(LICENSES_FILE, licenses); }

// ── User helpers ─────────────────────────────────────────────────────────
function normEmail(e) { return String(e || '').trim().toLowerCase(); }
function normLicense(k) { return String(k || '').trim().toUpperCase(); }

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

function createUser({ email, password, username, licenseKey }) {
  const e = normEmail(email);
  const k = normLicense(licenseKey);
  if (!validateEmail(e))            throw new Error('Invalid email address');
  if (!validatePassword(password))  throw new Error('Password must be 8-200 characters');
  if (findUserByEmail(e))           throw new Error('An account with this email already exists');
  if (!k)                           throw new Error('License key is required');

  // Atomically validate + consume license
  const lic = licenses[k];
  if (!lic)        throw new Error('Invalid license key');
  if (lic.usedBy)  throw new Error('This license key has already been used');

  const user = {
    id: 'u_' + crypto.randomBytes(8).toString('hex'),
    email: e,
    username: (username || '').trim().slice(0, 40) || null,
    password: hashPassword(password),
    role: 'user',            // real users are never admin — no VIP accounts
    licenseKey: k,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };

  // Stamp license as consumed BEFORE persisting user — if either write fails,
  // reload caches from disk on next boot and the inconsistency is obvious.
  lic.usedBy = user.id;
  lic.usedAt = user.createdAt;
  persistLicenses();

  users.push(user);
  persistUsers();
  logger.info(`User registered: ${user.email} (license=${k})`);
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

// ── License management ───────────────────────────────────────────────────
// Format: DS-XXXX-XXXX-XXXX-XXXX  (4 groups of 4 uppercase alphanumeric)
// ~20 bits per group → ~80 bits of entropy total. Plenty for invite-gating.
const LICENSE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/1/I
function _randGroup() {
  const buf = crypto.randomBytes(4);
  let out = '';
  for (let i = 0; i < 4; i++) out += LICENSE_ALPHABET[buf[i] % LICENSE_ALPHABET.length];
  return out;
}

function generateLicense() {
  let key;
  do {
    key = `DS-${_randGroup()}-${_randGroup()}-${_randGroup()}-${_randGroup()}`;
  } while (licenses[key]); // extremely unlikely collision, but be safe
  licenses[key] = {
    createdAt: new Date().toISOString(),
    usedBy: null,
    usedAt: null,
  };
  persistLicenses();
  return key;
}

function listLicenses() {
  return Object.entries(licenses).map(([key, rec]) => ({
    key,
    createdAt: rec.createdAt,
    usedBy: rec.usedBy,
    usedAt: rec.usedAt,
    used: !!rec.usedBy,
  }));
}

function revokeLicense(key) {
  const k = normLicense(key);
  const lic = licenses[k];
  if (!lic)       return { ok: false, reason: 'Unknown license key' };
  if (lic.usedBy) return { ok: false, reason: 'License already consumed — cannot revoke' };
  delete licenses[k];
  persistLicenses();
  return { ok: true };
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

// ── Internal service token ───────────────────────────────────────────────
// Generated once at module load; passed to Python subprocesses via env var
// so they can make authenticated HTTP calls back to the backend (e.g.
// agent_spawn.py → POST /api/agents/spawn). Never persisted to disk.
const INTERNAL_TOKEN = crypto.randomBytes(32).toString('hex');

function getInternalToken() {
  return INTERNAL_TOKEN;
}

// ── Auth mode ────────────────────────────────────────────────────────────
function getAuthMode() {
  const mode = (process.env.AUTH_MODE || 'open').toLowerCase();
  return mode === 'multi_user' ? 'multi_user' : 'open';
}

function getUserCount() {
  return users.length;
}

function getAvailableLicenseCount() {
  let n = 0;
  for (const rec of Object.values(licenses)) if (!rec.usedBy) n++;
  return n;
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
  getUserCount,
  getAvailableLicenseCount,
  getInternalToken,
  // licenses
  generateLicense,
  listLicenses,
  revokeLicense,
};
