'use strict';

/**
 * discord.service.js — Discord user-token management.
 *
 * Bookmarklet → clipboard → paste flow:
 *   1. beginBookmarklet() → { script, expiresAt }
 *   2. User drags the bookmarklet to their bar, clicks it on discord.com
 *   3. Bookmarklet extracts the token and copies "ds:<token>" to clipboard
 *   4. User returns to DeeperSeek and pastes in the connection field
 *   5. Frontend POSTs to /api/discord/connect → connectWithToken()
 *   6. connectWithToken validates the token via Discord API and stores it
 */

const https = require('https');

// Bookmarklet "expiry" is purely informational now — the script doesn't
// embed any server-side state. Kept so the frontend can show a refresh hint.
const OTT_TTL_MS = 15 * 60 * 1000;


/**
 * Generate the bookmarklet script.
 *
 * Discord.com's strict CSP plus Chrome's Private Network Access blocks
 * make it impossible for the bookmarklet to fetch back to a self-hosted
 * DeeperSeek instance (which is usually on localhost or a private IP).
 *
 * Working flow on every browser:
 *   1. Bookmarklet extracts the user token (4 fallback methods).
 *   2. Bookmarklet writes `ds:<token>` to the clipboard.
 *   3. Bookmarklet alerts the user to return to DeeperSeek and paste.
 *   4. DeeperSeek's settings modal has a paste field that strips the
 *      `ds:` prefix and POSTs to /api/discord/connect on same origin
 *      — no CORS, no CSP, no PNA issues.
 */
function beginBookmarklet(_userId, _backendOrigin) {
  const expiresAt = Date.now() + OTT_TTL_MS;
  const script =
    `javascript:(function(){` +
      `if(!location.host.endsWith('discord.com')){` +
        `alert('DeeperSeek: open discord.com first, then click this bookmarklet.');return;` +
      `}` +
      `var token=null;` +
      // Method 1 — iframe localStorage trick (most reliable as of 2025)
      `try{` +
        `var f=document.createElement('iframe');` +
        `document.body.appendChild(f);` +
        `var lt=f.contentWindow.localStorage.token;` +
        `document.body.removeChild(f);` +
        `if(lt){token=lt.replace(/^"|"$/g,'');}` +
      `}catch(e){}` +
      // Methods 2-4 — webpack chunk push, multiple module shapes
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
      `var payload='ds:'+token;` +
      `var done=function(){alert('\\u2713 DeeperSeek: Discord token copied!\\n\\nReturn to DeeperSeek (your other tab) and paste it in the connection field.');};` +
      // Clipboard API — bookmarklet click counts as user activation
      `try{` +
        `if(navigator.clipboard&&navigator.clipboard.writeText){` +
          `navigator.clipboard.writeText(payload).then(done).catch(function(){` +
            `prompt('DeeperSeek: copy the line below, return to DeeperSeek and paste it:',payload);` +
          `});` +
        `}else{` +
          // execCommand fallback for older browsers
          `var ta=document.createElement('textarea');` +
          `ta.value=payload;ta.style.position='fixed';ta.style.opacity='0';` +
          `document.body.appendChild(ta);ta.select();` +
          `var ok=false;try{ok=document.execCommand('copy');}catch(e){}` +
          `document.body.removeChild(ta);` +
          `if(ok)done();` +
          `else prompt('DeeperSeek: copy the line below, return to DeeperSeek and paste it:',payload);` +
        `}` +
      `}catch(e){` +
        `prompt('DeeperSeek: copy the line below, return to DeeperSeek and paste it:',payload);` +
      `}` +
    `})();`;

  return { script, expiresAt };
}


/**
 * Verify a pasted Discord token, then save it to the user's soul settings.
 * Called from /api/discord/connect when the user pastes the bookmarklet output.
 */
async function connectWithToken(userId, discordToken, soulService) {
  const tok = String(discordToken || '').trim();
  if (!tok) throw new Error('Empty token');
  // Strip the bookmarklet prefix if user pasted the whole "ds:..." string
  const clean = tok.startsWith('ds:') ? tok.slice(3).trim() : tok;
  if (clean.length < 30) throw new Error('That doesn\'t look like a valid Discord token');

  const identity = await verifyToken(clean);

  soulService.saveUserSettings(userId, {
    discord_token:      clean,
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


module.exports = { beginBookmarklet, connectWithToken, verifyToken, disconnect };
