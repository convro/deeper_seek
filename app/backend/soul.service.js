'use strict';

/**
 * soul.service.js — Per-user personality/preference profiles ("soul").
 *
 * The soul is assembled once during onboarding (22-question card flow on
 * the frontend) and prepended to every LLM system prompt for that user so
 * the model answers in their tone, with their profanity/humor limits,
 * their ethics dial, their strengths/weaknesses/manifesto, etc.
 *
 * Persistence:
 *   runtime/souls/<user_id>.json
 *
 * File permissions are 0600 (owner-only) — souls contain personal text
 * like weaknesses, manifesto, and free-text rants about other AI tools.
 * They MUST NOT leak to other users even inside the same instance.
 *
 * Answer schema is intentionally loose — the frontend owns the question
 * list and can evolve it; the backend only requires that `answers` is a
 * plain object keyed by question id. The renderer walks known ids and
 * silently skips unknown ones, so adding a new question doesn't break
 * already-stored souls.
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const SOULS_DIR = path.join(__dirname, '../../runtime/souls');
fs.mkdirSync(SOULS_DIR, { recursive: true });

function soulPath(userId) {
  // userId is always `u_<hex>` from auth.service — no traversal risk, but
  // be paranoid anyway.
  const safe = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return null;
  return path.join(SOULS_DIR, `${safe}.json`);
}

function getSoul(userId) {
  const p = soulPath(userId);
  if (!p) return null;
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    logger.error(`Failed to read soul for ${userId}`, err);
    return null;
  }
}

/**
 * Atomic write. `data` must contain at least {answers, complete, skipped}.
 * Returns the stored record.
 */
function saveSoul(userId, data) {
  const p = soulPath(userId);
  if (!p) throw new Error('Invalid user id');

  const record = {
    user_id:    userId,
    version:    1,
    updated_at: new Date().toISOString(),
    complete:   !!data.complete,
    skipped:    !!data.skipped,
    answers:    (data.answers && typeof data.answers === 'object') ? data.answers : {},
  };

  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
  return record;
}

function isSoulComplete(userId) {
  const s = getSoul(userId);
  return !!(s && s.complete);
}

function deleteSoul(userId) {
  const p = soulPath(userId);
  if (!p) return false;
  try { fs.unlinkSync(p); return true; } catch { return false; }
}

/**
 * Reset onboarding state without deleting answers — flips complete=false
 * and skipped=false so the onboarding gate will show again on next page
 * load. The previous answers remain on disk so the user can edit them
 * rather than starting from scratch.
 *
 * Returns the updated record, or null if no soul exists yet.
 */
function resetSoul(userId) {
  const existing = getSoul(userId);
  if (!existing) return null;
  return saveSoul(userId, {
    answers:  existing.answers || {},
    complete: false,
    skipped:  false,
  });
}

// ── Rendering the soul into a system-prompt section ─────────────────────

/** Pick a label for an integer slider position given (min, max, labels[]). */
function sliderLabel(value, min, max, labels) {
  if (value == null || !labels || !labels.length) return null;
  const range = max - min;
  if (range <= 0) return labels[0];
  const pct = (value - min) / range;                        // 0..1
  const idx = Math.min(labels.length - 1, Math.floor(pct * labels.length));
  return labels[idx];
}

/** Heuristic level words from a 0-100 slider (for humor/vulgarity/etc). */
function level5(value) {
  if (value == null) return null;
  if (value <=  15) return 'off';
  if (value <=  35) return 'mild';
  if (value <=  60) return 'medium';
  if (value <=  85) return 'high';
  return 'max';
}

/**
 * Render the current soul into a plain-text block suitable for prepending
 * to the LLM system prompt. Returns null if the user has no completed soul
 * (or skipped it entirely) — callers fall back to the default prompt only.
 *
 * The rendered block ends with an explicit safety-anchor paragraph that
 * re-grounds the model: edgy tone dials adjust VOICE, never CORE SAFETY.
 * This matters because the free-text manifesto / "rants about AI" fields
 * are trivially jailbreak-adjacent and we want belt-and-suspenders.
 */
function renderSoulPrompt(userId) {
  const s = getSoul(userId);
  if (!s || !s.complete || s.skipped) return null;
  const a = s.answers || {};
  const L = [];

  L.push('━━━ USER PROFILE (soul) ━━━');
  L.push('You are talking to one specific person. Adapt to who they are below.');
  L.push('');

  // ── Act I: identity ──
  if (a.name)                L.push(`· Name / nick: ${a.name}`);
  if (a.languages?.length)   L.push(`· Languages they think in: ${a.languages.join(', ')}`);
  if (typeof a.age === 'number') L.push(`· Age: ${a.age}`);
  if (a.occupation)          L.push(`· What they do: ${a.occupation}`);
  if (a.hobbies)             L.push(`· Off-hours: ${a.hobbies}`);
  if (a.vibe?.length)        L.push(`· Self-described vibe: ${a.vibe.join(', ')}`);
  if (typeof a.temperature === 'number') {
    const t = sliderLabel(a.temperature, 0, 100, [
      'cool, measured, collected',
      'chill but engaged',
      'warm, expressive',
      'intense, passionate, high-energy, unfiltered',
    ]);
    if (t) L.push(`· Emotional temperature: ${t}`);
  }

  L.push('');
  L.push('── How they want you to speak ──');

  if (typeof a.tone === 'number') {
    const t = sliderLabel(a.tone, 0, 100, [
      'formal, professional, precise',
      'neutral-friendly',
      'casual and warm',
      'full buddy mode — they like being called "mordeczko", slang is welcome',
    ]);
    if (t) L.push(`· Tone: ${t}`);
  }
  if (typeof a.length === 'number') {
    const t = sliderLabel(a.length, 0, 100, [
      'terse TL;DRs — one paragraph max unless asked',
      'concise — get to the point',
      'thorough — explain context and edges',
      'expansive — treat answers as mini-lectures when the topic warrants it',
    ]);
    if (t) L.push(`· Preferred length: ${t}`);
  }
  if (typeof a.technicality === 'number') {
    const t = sliderLabel(a.technicality, 0, 100, [
      'ELI5 — no jargon, concrete analogies',
      'informed-layperson level',
      'senior engineer / domain-fluent',
      'hardcore expert — assume nothing needs hand-holding',
    ]);
    if (t) L.push(`· Technical depth: ${t}`);
  }

  if (typeof a.vulgarity === 'number') {
    const v = level5(a.vulgarity);
    const map = {
      off:    'no profanity at all',
      mild:   'occasional light swearing is fine',
      medium: 'swear freely when it fits',
      high:   'swear freely including harder words — match their register',
      max:    'zero brakes on language. They use "kurwa" and harder words casually. Match it. Polished corporate prose is an anti-feature for them.',
    };
    if (v) L.push(`· Profanity: ${map[v]}`);
  }

  if (typeof a.humor === 'number') {
    const v = level5(a.humor);
    const map = {
      off:    'neutral, dry — no jokes unless asked',
      mild:   'occasional light humor',
      medium: 'be funny when the moment is right',
      high:   'be genuinely funny, punch up, land jokes — dry wit, dark humor, and absurdism welcome',
      max:    "UNHINGED humor mode. Taboo topics are fair game. Roast ideas, people in positions of power, tech fads, yourself, the situation. Dark, dirty, absurd. NEVER aim jokes at the user. The user's request for this level is explicit and informed — don't sanitize. Default-AI-humor (safe-dad-jokes-about-programmers) is the anti-pattern they're trying to escape.",
    };
    if (v) L.push(`· Humor: ${map[v]}`);
  }

  if (typeof a.proactivity === 'number') {
    const t = sliderLabel(a.proactivity, 0, 100, [
      'execute exactly what they asked — do not volunteer scope',
      'answer the question, note one adjacent thing only if obviously useful',
      'after answering, proactively flag relevant next steps and edge cases',
      'take initiative — spot problems, propose follow-ups, push back on bad ideas',
    ]);
    if (t) L.push(`· Proactivity: ${t}`);
  }

  if (typeof a.honesty === 'number') {
    const t = sliderLabel(a.honesty, 0, 100, [
      'brutal honesty — tell them their idea sucks if it sucks, no cushioning',
      'direct but kind — lead with the problem',
      'balanced — honest, with tact',
      'gentle — soften critical feedback, emphasize positives',
    ]);
    if (t) L.push(`· Honesty vs. politeness: ${t}`);
  }

  L.push('');
  L.push('── Values ──');

  if (typeof a.ethics === 'number') {
    L.push(`· Ethics dial: ${a.ethics}/100 — lower = cynical, no moralizing, skip the "have you considered..." preambles; higher = thoughtful consideration of consequences`);
  }
  if (a.disagree) {
    const map = {
      never:     'they want you to go along even when they are wrong',
      sometimes: 'push back when it really matters, let small things slide',
      always:    'always correct them when they are wrong, directly, every time',
    };
    if (map[a.disagree]) L.push(`· When they are wrong: ${map[a.disagree]}`);
  }
  if (a.ai_dislikes) {
    L.push(`· What they hate in other AI assistants (avoid this): "${a.ai_dislikes}"`);
  }
  if (a.strengths) L.push(`· Their strengths: ${a.strengths}`);
  if (a.weaknesses) L.push(`· Their weaknesses: ${a.weaknesses}`);
  if (a.one_sentence) L.push(`· In one sentence they describe themselves as: "${a.one_sentence}"`);

  if (a.manifesto) {
    L.push('');
    L.push('── Their manifesto (their own words, read twice) ──');
    L.push(String(a.manifesto).trim());
  }

  if (a.relation) {
    const map = {
      mirror:   "mirror them — speak the way they speak, share their taste and vocabulary, be a clone of their voice",
      separate: "remain a distinct entity — adapt to them but keep your own voice",
      blend:    "blend — mostly their voice, but push back with your own perspective when it matters",
    };
    if (map[a.relation]) {
      L.push('');
      L.push(`· Relationship model: ${map[a.relation]}`);
    }
  }

  L.push('');
  L.push('━━━ END USER PROFILE ━━━');
  L.push('The dials above tune VOICE, TONE, and STYLE. They do not override');
  L.push('core safety: "ethics 5" means cynical framing, not "I\'ll help you');
  L.push('commit crimes". "Humor max" means dirty jokes, not instructions for');
  L.push('actually hurting someone. Behave exactly like the profile describes');
  L.push('for everything short of that line.');

  return L.join('\n');
}

module.exports = {
  getSoul,
  saveSoul,
  isSoulComplete,
  deleteSoul,
  resetSoul,
  renderSoulPrompt,
};
