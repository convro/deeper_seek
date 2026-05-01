'use strict';

/**
 * discord.service.js — Discord user-token management.
 *
 * Handles one-time-token (OTT) bookmarklet flow:
 *   1. beginBookmarklet(userId) → { ott, bookmarkletJs, expiresAt }
 *   2. User drags the bookmarklet to their bar, clicks it on discord.com
 *   3. Bookmarklet extracts the user token and calls submitBookmarklet(ott, discordToken)
 *   4. Backend validates the Discord token, stores it in soul settings
 */

const crypto = require('crypto');
const https  = require('https');

// In-memory OTT store: ott → { userId, expiresAt }
// Short TTL — if the user takes longer than 15min they just click "Generate" again.
const _otts = new Map();
const OTT_TTL_MS = 15 * 60 * 1000;

// Prune expired OTTs every minute
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _otts) {
    if (v.expiresAt < now) _otts.delete(k);
  }
}, 60_000);


/**
 * Generate a one-time-token and return the bookmarklet script.
 * The bookmarklet embeds the OTT and the backend origin so it can POST back.
 */
function beginBookmarklet(userId, backendOrigin) {
  const ott       = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + OTT_TTL_MS;
  _otts.set(ott, { userId, expiresAt });

  // The bookmarklet runs on discord.com (cross-origin). It:
  //   1. Extracts the user token from Discord's webpack bundle
  //   2. POSTs { ott, discord_token } to DeeperSeek
  //   3. Shows an alert on success/error
  //
  // We use a self-invoking function wrapped as javascript: URI.
  // The OTT and API URL are baked in at generation time.
  const apiUrl  = `${backendOrigin}/api/discord/bookmarklet/submit`;
  const script  = `javascript:(function(){` +
    `var ott=${JSON.stringify(ott)};` +
    `var api=${JSON.stringify(apiUrl)};` +
    `function gt(){` +
      `try{` +
        `var t;` +
        // Webpack 5 chunk push trick — works on Discord web and Canary
        `webpackChunkdiscord_app.push([[Math.random()],{},` +
          `function(e){` +
            `Object.values(e.c).forEach(function(m){` +
              `if(m&&m.exports){` +
                `var x=m.exports.default||m.exports;` +
                `if(x&&typeof x.getToken==='function'){t=x.getToken();}` +
                `if(!t&&x.Z&&typeof x.Z.getToken==='function'){t=x.Z.getToken();}` +
              `}` +
            `});` +
          `}` +
        `]);` +
        `return t;` +
      `}catch(e){return null;}` +
    `}` +
    `var token=gt();` +
    `if(!token){alert('DeeperSeek: could not read Discord token.\\nMake sure you are on discord.com');return;}` +
    `fetch(api,{` +
      `method:'POST',` +
      `headers:{'Content-Type':'application/json'},` +
      `body:JSON.stringify({ott:ott,discord_token:token})` +
    `}).then(function(r){return r.json();})` +
    `.then(function(d){` +
      `if(d.ok){alert('✓ DeeperSeek: Discord connected as @'+d.username+'!');}` +
      `else{alert('DeeperSeek error: '+(d.error||'unknown'));}` +
    `}).catch(function(e){alert('DeeperSeek: request failed — '+e.message);});` +
  `})();`;

  return { ott, script, expiresAt };
}


/**
 * Validate OTT, verify the Discord token, then save it to soul settings.
 * Returns Discord user identity on success.
 */
async function submitBookmarklet(ott, discordToken, soulService) {
  const entry = _otts.get(ott);
  if (!entry) throw new Error('Invalid or expired link — generate a new one in Settings.');
  if (entry.expiresAt < Date.now()) {
    _otts.delete(ott);
    throw new Error('Link expired — generate a new one in Settings.');
  }
  _otts.delete(ott); // consume immediately

  const identity = await verifyToken(discordToken);

  await soulService.saveUserSettings(entry.userId, {
    discord_token:      discordToken,
    discord_user_id:    identity.id,
    discord_username:   identity.username,
    discord_global_name: identity.global_name || identity.username,
    discord_avatar:     identity.avatar || '',
  });

  return identity;
}


/**
 * Verify a Discord user token by calling /users/@me.
 * Returns the Discord user object on success, throws on failure.
 */
function verifyToken(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'discord.com',
      path:     '/api/v10/users/@me',
      method:   'GET',
      headers: {
        'Authorization': token,
        'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type':  'application/json',
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        try {
          const body = JSON.parse(raw);
          if (res.statusCode === 200) return resolve(body);
          reject(new Error(body.message || `Discord API ${res.statusCode}`));
        } catch {
          reject(new Error('Invalid response from Discord'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}


/**
 * Remove Discord credentials from user soul settings.
 */
async function disconnect(userId, soulService) {
  await soulService.saveUserSettings(userId, {
    discord_token:       '',
    discord_user_id:     '',
    discord_username:    '',
    discord_global_name: '',
    discord_avatar:      '',
  });
}


module.exports = { beginBookmarklet, submitBookmarklet, verifyToken, disconnect };
