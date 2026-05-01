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

  // The bookmarklet runs on discord.com (cross-origin). It tries multiple
  // proven token-extraction methods and falls through to the next on failure:
  //   1. iframe localStorage trick — uses a fresh iframe to read localStorage
  //      because Discord deletes window.localStorage.token after page load.
  //   2. webpack chunk push (default export) — for older Discord builds.
  //   3. webpack chunk push (Z export) — common in newer minified builds.
  //   4. Deep webpack scan — looks at every property of every module.
  //
  // After extracting, POSTs { ott, discord_token } to DeeperSeek.
  const apiUrl = `${backendOrigin}/api/discord/bookmarklet/submit`;
  const script =
    `javascript:(function(){` +
      `var ott=${JSON.stringify(ott)};` +
      `var api=${JSON.stringify(apiUrl)};` +
      `if(!location.host.endsWith('discord.com')){` +
        `alert('DeeperSeek: open discord.com first, then click this bookmarklet.');return;` +
      `}` +
      `var token=null;` +
      // Method 1 — iframe trick (most reliable as of 2025)
      `try{` +
        `var f=document.createElement('iframe');` +
        `document.body.appendChild(f);` +
        `var lt=f.contentWindow.localStorage.token;` +
        `document.body.removeChild(f);` +
        `if(lt){token=lt.replace(/^"|"$/g,'');}` +
      `}catch(e){}` +
      // Method 2-4 — webpack chunk push, multiple known shapes
      `if(!token){` +
        `try{` +
          `var found=null;` +
          `(window.webpackChunkdiscord_app=window.webpackChunkdiscord_app||[]).push([` +
            `[Math.random()],{},` +
            `function(req){` +
              `for(var c in req.c){` +
                `var m=req.c[c]&&req.c[c].exports;if(!m)continue;` +
                `var cands=[m,m.default,m.Z,m.ZP];` +
                `for(var i=0;i<cands.length;i++){` +
                  `var x=cands[i];` +
                  `if(x&&typeof x.getToken==='function'){` +
                    `try{var v=x.getToken();if(v){found=v;return;}}catch(_){}` +
                  `}` +
                `}` +
                // Deep scan — sometimes getToken is on a nested key
                `if(typeof m==='object'){` +
                  `for(var k in m){` +
                    `try{` +
                      `var y=m[k];` +
                      `if(y&&typeof y.getToken==='function'){` +
                        `var v2=y.getToken();if(v2){found=v2;return;}` +
                      `}` +
                    `}catch(_){}` +
                  `}` +
                `}` +
              `}` +
            `}` +
          `]);` +
          `if(found)token=found;` +
        `}catch(e){}` +
      `}` +
      `if(!token){` +
        `alert('DeeperSeek: could not read Discord token.\\n\\nMake sure you are on discord.com (not Canary/PTB) and logged in.\\nIf this keeps failing, log out and back in to Discord, then retry.');` +
        `return;` +
      `}` +
      `fetch(api,{` +
        `method:'POST',` +
        `headers:{'Content-Type':'application/json'},` +
        `body:JSON.stringify({ott:ott,discord_token:token})` +
      `}).then(function(r){return r.json();})` +
      `.then(function(d){` +
        `if(d.ok){alert('✓ DeeperSeek: Discord connected as '+(d.global_name||'@'+d.username)+'!\\nYou can close this and return to DeeperSeek.');}` +
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
