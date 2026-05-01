"""
discord_tool.py — Full Discord REST API client operating as the authenticated user
                  (self-bot / user token mode).

The DISCORD_TOKEN env var is injected by orchestrator.service.js from the user's
stored soul settings (discord_token field). All API calls are made with the raw
user token, exactly as Discord's own web client does.

NOTE: Using a user token to automate actions is against Discord's ToS. Users of
DeeperSeek have explicitly consented to this via the settings connection flow.
"""

import os
import time
import json
import urllib.request
import urllib.error
import urllib.parse

DISCORD_API = 'https://discord.com/api/v10'

# Mimics a real browser session so Discord doesn't immediately flag the token.
_UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/122.0.0.0 Safari/537.36'
)
# Base64-encoded JSON with client metadata — keeps the session looking legitimate.
_SUPER_PROPS = (
    'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2'
    'xvY2FsZSI6ImVuLVVTIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRv'
    'd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZS'
    'BHZWN0bykgQ2hyb21lLzEyMi4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9u'
    'IjoiMTIyLjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVmZXJyZXIiOiIiLCJyZWZlcnJpbm'
    'dfZG9tYWluIjoiIiwicmVmZXJyZXJfY3VycmVudCI6IiIsInJlZmVycmluZ19kb21haW5fY3Vy'
    'cmVudCI6IiIsInJlbGVhc2VfY2hhbm5lbCI6InN0YWJsZSIsImNsaWVudF9idWlsZF9udW1iZX'
    'IiOjI3MDIyNiwiY2xpZW50X2V2ZW50X3NvdXJjZSI6bnVsbH0='
)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _token() -> str:
    t = os.environ.get('DISCORD_TOKEN', '').strip()
    if not t:
        raise RuntimeError(
            'Discord not connected. Ask the user to connect their Discord account '
            'in Settings → Discord, then try again.'
        )
    return t


def _headers(token: str, with_content_type: bool = True) -> dict:
    h = {
        'Authorization': token,
        'User-Agent': _UA,
        'X-Super-Properties': _SUPER_PROPS,
        'X-Discord-Locale': 'en-US',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://discord.com',
        'Referer': 'https://discord.com/channels/@me',
    }
    if with_content_type:
        h['Content-Type'] = 'application/json'
    return h


def _req(method: str, path: str, data=None, token: str = None) -> any:
    if token is None:
        token = _token()
    url = f'{DISCORD_API}{path}'
    has_body = data is not None
    body = json.dumps(data).encode('utf-8') if has_body else None
    req = urllib.request.Request(
        url, data=body,
        headers=_headers(token, with_content_type=has_body or method in ('POST', 'PUT', 'PATCH')),
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read()
            if not raw or resp.status == 204:
                return {}
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', errors='replace')
        try:
            err = json.loads(raw)
            msg = err.get('message', raw)
            code = err.get('code', '')
            raise RuntimeError(f'Discord API {e.code} (code {code}): {msg}')
        except (json.JSONDecodeError, KeyError):
            raise RuntimeError(f'Discord API {e.code}: {raw[:300]}')


def _require(args: dict, key: str):
    v = args.get(key)
    if v is None:
        raise RuntimeError(f"Required parameter missing: '{key}'")
    return v


def _q(s: str) -> str:
    return urllib.parse.quote(str(s), safe='')


# ── Main entry point ────────────────────────────────────────────────────────────

def execute(action: str, **kwargs) -> dict:
    start = time.time()
    try:
        result = _dispatch(action, kwargs)
        return {
            'status': 'ok',
            'result': result,
            'error': None,
            'metadata': {
                'tool': 'discord_tool',
                'action': action,
                'duration_ms': int((time.time() - start) * 1000),
            },
        }
    except Exception as e:
        return {
            'status': 'error',
            'result': None,
            'error': str(e),
            'metadata': {
                'tool': 'discord_tool',
                'action': action,
                'duration_ms': int((time.time() - start) * 1000),
            },
        }


# ── Dispatcher ─────────────────────────────────────────────────────────────────

def _dispatch(action: str, args: dict):  # noqa: C901 (complex by design)

    # ── Account / Profile ─────────────────────────────────────────────────────

    if action == 'get_me':
        return _req('GET', '/users/@me')

    if action == 'edit_me':
        data = {}
        if 'username' in args:    data['username'] = args['username']
        if 'global_name' in args: data['global_name'] = args['global_name']
        if 'bio' in args:         data['bio'] = args['bio']
        if 'avatar' in args:      data['avatar'] = args['avatar']  # data URI: "data:image/png;base64,..."
        if 'banner' in args:      data['banner'] = args['banner']
        if 'accent_color' in args: data['accent_color'] = args['accent_color']  # int RGB
        return _req('PATCH', '/users/@me', data)

    if action == 'set_status':
        # Sets online presence and optional custom status text.
        # status: "online" | "idle" | "dnd" | "invisible"
        data = {'status': args.get('status', 'online')}
        if 'custom_text' in args or 'custom_emoji' in args:
            data['custom_status'] = {
                'text': args.get('custom_text', ''),
                'emoji_name': args.get('custom_emoji') or None,
                'expires_at': args.get('expires_at') or None,
            }
        return _req('PATCH', '/users/@me/settings', data)

    if action == 'get_settings':
        return _req('GET', '/users/@me/settings')

    if action == 'get_connections':
        # Returns linked accounts: Twitch, Spotify, Steam, Reddit, etc.
        return _req('GET', '/users/@me/connections')

    if action == 'get_nitro_info':
        try:
            return _req('GET', '/users/@me/billing/subscriptions')
        except RuntimeError:
            return {'subscriptions': [], 'note': 'No Nitro or billing info not accessible'}

    # ── Guilds / Servers ──────────────────────────────────────────────────────

    if action == 'list_guilds':
        guilds = _req('GET', '/users/@me/guilds')
        if args.get('with_details'):
            detailed = []
            for g in guilds:
                try:
                    detailed.append(_req('GET', f'/guilds/{g["id"]}?with_counts=true'))
                except Exception:
                    detailed.append(g)
            return detailed
        return guilds

    if action == 'get_guild':
        guild_id = _require(args, 'guild_id')
        return _req('GET', f'/guilds/{guild_id}?with_counts=true')

    if action == 'create_guild':
        name = _require(args, 'name')
        data: dict = {'name': name}
        if 'icon' in args:   data['icon'] = args['icon']   # data URI base64
        if 'region' in args: data['region'] = args['region']
        if 'verification_level' in args: data['verification_level'] = args['verification_level']
        if 'default_message_notifications' in args:
            data['default_message_notifications'] = args['default_message_notifications']
        if 'explicit_content_filter' in args:
            data['explicit_content_filter'] = args['explicit_content_filter']
        return _req('POST', '/guilds', data)

    if action == 'edit_guild':
        guild_id = _require(args, 'guild_id')
        data = {}
        for k in ('name', 'icon', 'banner', 'splash', 'description', 'preferred_locale',
                  'verification_level', 'default_message_notifications',
                  'explicit_content_filter', 'afk_timeout', 'afk_channel_id',
                  'system_channel_id', 'rules_channel_id', 'public_updates_channel_id'):
            if k in args: data[k] = args[k]
        return _req('PATCH', f'/guilds/{guild_id}', data)

    if action == 'leave_guild':
        guild_id = _require(args, 'guild_id')
        _req('DELETE', f'/users/@me/guilds/{guild_id}')
        return {'left': guild_id}

    if action == 'delete_guild':
        # Only works if the authenticated user is the server owner.
        guild_id = _require(args, 'guild_id')
        _req('DELETE', f'/guilds/{guild_id}')
        return {'deleted': guild_id}

    if action == 'get_guild_preview':
        guild_id = _require(args, 'guild_id')
        return _req('GET', f'/guilds/{guild_id}/preview')

    if action == 'get_guild_vanity_url':
        guild_id = _require(args, 'guild_id')
        return _req('GET', f'/guilds/{guild_id}/vanity-url')

    # ── Channels ──────────────────────────────────────────────────────────────

    if action == 'list_channels':
        guild_id = _require(args, 'guild_id')
        channels = _req('GET', f'/guilds/{guild_id}/channels')
        if args.get('type') is not None:
            channels = [c for c in channels if c.get('type') == int(args['type'])]
        return channels

    if action == 'get_channel':
        channel_id = _require(args, 'channel_id')
        return _req('GET', f'/channels/{channel_id}')

    if action == 'create_channel':
        guild_id = _require(args, 'guild_id')
        name = _require(args, 'name')
        # type: 0=text, 2=voice, 4=category, 5=announcement, 13=stage, 15=forum
        data = {'name': name, 'type': int(args.get('type', 0))}
        if 'topic' in args:       data['topic'] = args['topic']
        if 'category_id' in args: data['parent_id'] = args['category_id']
        if 'position' in args:    data['position'] = args['position']
        if 'nsfw' in args:        data['nsfw'] = bool(args['nsfw'])
        if 'rate_limit_per_user' in args: data['rate_limit_per_user'] = args['rate_limit_per_user']
        if 'bitrate' in args:     data['bitrate'] = args['bitrate']
        if 'user_limit' in args:  data['user_limit'] = args['user_limit']
        return _req('POST', f'/guilds/{guild_id}/channels', data)

    if action == 'edit_channel':
        channel_id = _require(args, 'channel_id')
        data = {}
        for k in ('name', 'topic', 'position', 'nsfw', 'rate_limit_per_user',
                  'bitrate', 'user_limit', 'default_auto_archive_duration'):
            if k in args: data[k] = args[k]
        if 'category_id' in args: data['parent_id'] = args['category_id']
        return _req('PATCH', f'/channels/{channel_id}', data)

    if action == 'delete_channel':
        channel_id = _require(args, 'channel_id')
        return _req('DELETE', f'/channels/{channel_id}')

    if action == 'get_channel_permissions':
        channel_id = _require(args, 'channel_id')
        ch = _req('GET', f'/channels/{channel_id}')
        return ch.get('permission_overwrites', [])

    # ── Messages ──────────────────────────────────────────────────────────────

    if action == 'get_messages':
        channel_id = _require(args, 'channel_id')
        limit = min(int(args.get('limit', 50)), 100)
        url = f'/channels/{channel_id}/messages?limit={limit}'
        if 'before'  in args: url += f'&before={args["before"]}'
        if 'after'   in args: url += f'&after={args["after"]}'
        if 'around'  in args: url += f'&around={args["around"]}'
        return _req('GET', url)

    if action == 'get_message':
        channel_id = _require(args, 'channel_id')
        message_id = _require(args, 'message_id')
        return _req('GET', f'/channels/{channel_id}/messages/{message_id}')

    if action == 'send_message':
        channel_id = _require(args, 'channel_id')
        data = {}
        if 'content' in args: data['content'] = args['content']
        if 'embeds'  in args: data['embeds']  = args['embeds']
        if 'tts'     in args: data['tts']     = bool(args['tts'])
        if 'reply_to' in args:
            data['message_reference'] = {
                'message_id': args['reply_to'],
                'fail_if_not_exists': False,
            }
        if 'allowed_mentions' in args: data['allowed_mentions'] = args['allowed_mentions']
        if not data:
            raise RuntimeError("send_message requires at least 'content' or 'embeds'")
        return _req('POST', f'/channels/{channel_id}/messages', data)

    if action == 'send_reply':
        channel_id = _require(args, 'channel_id')
        message_id = _require(args, 'message_id')
        content    = _require(args, 'content')
        data = {
            'content': content,
            'message_reference': {'message_id': message_id, 'fail_if_not_exists': False},
        }
        if 'embeds' in args: data['embeds'] = args['embeds']
        return _req('POST', f'/channels/{channel_id}/messages', data)

    if action == 'edit_message':
        channel_id = _require(args, 'channel_id')
        message_id = _require(args, 'message_id')
        data = {}
        if 'content' in args: data['content'] = args['content']
        if 'embeds'  in args: data['embeds']  = args['embeds']
        return _req('PATCH', f'/channels/{channel_id}/messages/{message_id}', data)

    if action == 'delete_message':
        channel_id = _require(args, 'channel_id')
        message_id = _require(args, 'message_id')
        _req('DELETE', f'/channels/{channel_id}/messages/{message_id}')
        return {'deleted': message_id, 'channel': channel_id}

    if action == 'bulk_delete_messages':
        # Only works for messages younger than 14 days via bot token, but user token
        # can delete individually. This action deletes up to 10 messages in sequence.
        channel_id  = _require(args, 'channel_id')
        message_ids = _require(args, 'message_ids')  # list of message IDs
        deleted, errors = [], []
        for mid in message_ids[:10]:
            try:
                _req('DELETE', f'/channels/{channel_id}/messages/{mid}')
                deleted.append(mid)
                time.sleep(0.35)  # stay under rate limit
            except Exception as e:
                errors.append({'id': mid, 'error': str(e)})
        return {'deleted': deleted, 'errors': errors}

    if action == 'pin_message':
        channel_id = _require(args, 'channel_id')
        message_id = _require(args, 'message_id')
        _req('PUT', f'/channels/{channel_id}/pins/{message_id}')
        return {'pinned': message_id, 'channel': channel_id}

    if action == 'unpin_message':
        channel_id = _require(args, 'channel_id')
        message_id = _require(args, 'message_id')
        _req('DELETE', f'/channels/{channel_id}/pins/{message_id}')
        return {'unpinned': message_id}

    if action == 'get_pinned_messages':
        channel_id = _require(args, 'channel_id')
        return _req('GET', f'/channels/{channel_id}/pins')

    if action == 'search_messages':
        query = _require(args, 'query')
        guild_id   = args.get('guild_id')
        channel_id = args.get('channel_id')
        if not guild_id and not channel_id:
            raise RuntimeError("search_messages requires 'guild_id' or 'channel_id'")
        params: dict = {'content': query}
        if 'author_id'  in args: params['author_id']  = args['author_id']
        if 'channel_id' in args and guild_id: params['channel_id'] = args['channel_id']
        if 'mentions'   in args: params['mentions']   = args['mentions']
        if 'has'        in args: params['has']        = args['has']
        if 'before'     in args: params['max_id']     = args['before']
        if 'after'      in args: params['min_id']     = args['after']
        params['limit'] = min(int(args.get('limit', 25)), 25)
        qs = urllib.parse.urlencode(params)
        if guild_id:
            return _req('GET', f'/guilds/{guild_id}/messages/search?{qs}')
        return _req('GET', f'/channels/{channel_id}/messages/search?{qs}')

    # ── Reactions ─────────────────────────────────────────────────────────────

    if action == 'add_reaction':
        channel_id = _require(args, 'channel_id')
        message_id = _require(args, 'message_id')
        emoji      = _require(args, 'emoji')  # unicode: "👍"  or custom: "name:id"
        _req('PUT', f'/channels/{channel_id}/messages/{message_id}/reactions/{_q(emoji)}/@me')
        return {'reaction': emoji, 'message': message_id}

    if action == 'remove_reaction':
        channel_id = _require(args, 'channel_id')
        message_id = _require(args, 'message_id')
        emoji      = _require(args, 'emoji')
        user_id    = args.get('user_id', '@me')
        _req('DELETE', f'/channels/{channel_id}/messages/{message_id}/reactions/{_q(emoji)}/{user_id}')
        return {'removed_reaction': emoji}

    if action == 'get_reactions':
        channel_id = _require(args, 'channel_id')
        message_id = _require(args, 'message_id')
        emoji      = _require(args, 'emoji')
        limit      = min(int(args.get('limit', 25)), 100)
        return _req('GET', f'/channels/{channel_id}/messages/{message_id}/reactions/{_q(emoji)}?limit={limit}')

    if action == 'clear_reactions':
        channel_id = _require(args, 'channel_id')
        message_id = _require(args, 'message_id')
        _req('DELETE', f'/channels/{channel_id}/messages/{message_id}/reactions')
        return {'cleared': message_id}

    # ── Threads ───────────────────────────────────────────────────────────────

    if action == 'create_thread':
        channel_id = _require(args, 'channel_id')
        name       = _require(args, 'name')
        message_id = args.get('message_id')
        data = {
            'name': name,
            'auto_archive_duration': int(args.get('auto_archive_duration', 1440)),
        }
        if 'rate_limit_per_user' in args:
            data['rate_limit_per_user'] = args['rate_limit_per_user']
        if message_id:
            return _req('POST', f'/channels/{channel_id}/messages/{message_id}/threads', data)
        data['type'] = int(args.get('type', 11))  # 11=PUBLIC_THREAD, 12=PRIVATE_THREAD
        return _req('POST', f'/channels/{channel_id}/threads', data)

    if action == 'list_threads':
        guild_id = _require(args, 'guild_id')
        return _req('GET', f'/guilds/{guild_id}/threads/active')

    if action == 'join_thread':
        channel_id = _require(args, 'channel_id')
        _req('PUT', f'/channels/{channel_id}/thread-members/@me')
        return {'joined_thread': channel_id}

    if action == 'leave_thread':
        channel_id = _require(args, 'channel_id')
        _req('DELETE', f'/channels/{channel_id}/thread-members/@me')
        return {'left_thread': channel_id}

    # ── Members & Moderation ──────────────────────────────────────────────────

    if action == 'list_guild_members':
        guild_id = _require(args, 'guild_id')
        limit = min(int(args.get('limit', 100)), 1000)
        url = f'/guilds/{guild_id}/members?limit={limit}'
        if 'after' in args: url += f'&after={args["after"]}'
        return _req('GET', url)

    if action == 'search_guild_members':
        guild_id = _require(args, 'guild_id')
        query    = _require(args, 'query')
        limit    = min(int(args.get('limit', 25)), 100)
        return _req('GET', f'/guilds/{guild_id}/members/search?query={_q(query)}&limit={limit}')

    if action == 'get_member':
        guild_id = _require(args, 'guild_id')
        user_id  = _require(args, 'user_id')
        return _req('GET', f'/guilds/{guild_id}/members/{user_id}')

    if action == 'edit_member':
        guild_id = _require(args, 'guild_id')
        user_id  = _require(args, 'user_id')
        data = {}
        if 'nick'  in args: data['nick']  = args['nick']
        if 'roles' in args: data['roles'] = args['roles']  # full list of role IDs
        if 'mute'  in args: data['mute']  = bool(args['mute'])
        if 'deaf'  in args: data['deaf']  = bool(args['deaf'])
        if 'communication_disabled_until' in args:
            data['communication_disabled_until'] = args['communication_disabled_until']  # ISO8601 or null
        return _req('PATCH', f'/guilds/{guild_id}/members/{user_id}', data)

    if action == 'edit_own_nick':
        guild_id = _require(args, 'guild_id')
        nick     = _require(args, 'nick')
        return _req('PATCH', f'/guilds/{guild_id}/members/@me', {'nick': nick})

    if action == 'kick_member':
        guild_id = _require(args, 'guild_id')
        user_id  = _require(args, 'user_id')
        _req('DELETE', f'/guilds/{guild_id}/members/{user_id}')
        return {'kicked': user_id, 'guild': guild_id}

    if action == 'ban_member':
        guild_id = _require(args, 'guild_id')
        user_id  = _require(args, 'user_id')
        data = {}
        if 'delete_message_seconds' in args:
            data['delete_message_seconds'] = int(args['delete_message_seconds'])
        _req('PUT', f'/guilds/{guild_id}/bans/{user_id}', data)
        return {'banned': user_id, 'guild': guild_id}

    if action == 'unban_member':
        guild_id = _require(args, 'guild_id')
        user_id  = _require(args, 'user_id')
        _req('DELETE', f'/guilds/{guild_id}/bans/{user_id}')
        return {'unbanned': user_id, 'guild': guild_id}

    if action == 'list_bans':
        guild_id = _require(args, 'guild_id')
        limit = min(int(args.get('limit', 100)), 1000)
        url = f'/guilds/{guild_id}/bans?limit={limit}'
        if 'after' in args: url += f'&after={args["after"]}'
        return _req('GET', url)

    if action == 'timeout_member':
        # Sets communication_disabled_until to a future ISO8601 timestamp.
        guild_id  = _require(args, 'guild_id')
        user_id   = _require(args, 'user_id')
        until     = _require(args, 'until')  # ISO8601 e.g. "2025-06-01T12:00:00.000Z", or null to remove
        return _req('PATCH', f'/guilds/{guild_id}/members/{user_id}', {
            'communication_disabled_until': until,
        })

    # ── Roles ─────────────────────────────────────────────────────────────────

    if action == 'list_roles':
        guild_id = _require(args, 'guild_id')
        return _req('GET', f'/guilds/{guild_id}/roles')

    if action == 'create_role':
        guild_id = _require(args, 'guild_id')
        data = {}
        if 'name'        in args: data['name']        = args['name']
        if 'permissions' in args: data['permissions'] = str(args['permissions'])
        if 'color'       in args: data['color']       = int(args['color'])  # int RGB e.g. 0xFF0000
        if 'hoist'       in args: data['hoist']       = bool(args['hoist'])
        if 'mentionable' in args: data['mentionable'] = bool(args['mentionable'])
        if 'icon'        in args: data['icon']        = args['icon']  # data URI base64
        return _req('POST', f'/guilds/{guild_id}/roles', data)

    if action == 'edit_role':
        guild_id = _require(args, 'guild_id')
        role_id  = _require(args, 'role_id')
        data = {}
        for k in ('name', 'color', 'hoist', 'mentionable', 'position'):
            if k in args: data[k] = args[k]
        if 'permissions' in args: data['permissions'] = str(args['permissions'])
        return _req('PATCH', f'/guilds/{guild_id}/roles/{role_id}', data)

    if action == 'delete_role':
        guild_id = _require(args, 'guild_id')
        role_id  = _require(args, 'role_id')
        _req('DELETE', f'/guilds/{guild_id}/roles/{role_id}')
        return {'deleted_role': role_id}

    if action == 'add_role_to_member':
        guild_id = _require(args, 'guild_id')
        user_id  = _require(args, 'user_id')
        role_id  = _require(args, 'role_id')
        _req('PUT', f'/guilds/{guild_id}/members/{user_id}/roles/{role_id}')
        return {'added_role': role_id, 'to_user': user_id}

    if action == 'remove_role_from_member':
        guild_id = _require(args, 'guild_id')
        user_id  = _require(args, 'user_id')
        role_id  = _require(args, 'role_id')
        _req('DELETE', f'/guilds/{guild_id}/members/{user_id}/roles/{role_id}')
        return {'removed_role': role_id, 'from_user': user_id}

    # ── Invites ───────────────────────────────────────────────────────────────

    if action == 'create_invite':
        channel_id = _require(args, 'channel_id')
        data = {
            'max_age':   int(args.get('max_age', 86400)),   # seconds; 0 = never expires
            'max_uses':  int(args.get('max_uses', 0)),      # 0 = unlimited
            'temporary': bool(args.get('temporary', False)),
            'unique':    bool(args.get('unique', True)),
        }
        invite = _req('POST', f'/channels/{channel_id}/invites', data)
        if isinstance(invite, dict):
            invite['url'] = f"https://discord.gg/{invite.get('code', '')}"
        return invite

    if action == 'list_invites':
        guild_id = _require(args, 'guild_id')
        return _req('GET', f'/guilds/{guild_id}/invites')

    if action == 'get_invite':
        code = _require(args, 'code')
        return _req('GET', f'/invites/{code}?with_counts=true&with_expiration=true')

    if action == 'delete_invite':
        code = _require(args, 'code')
        _req('DELETE', f'/invites/{code}')
        return {'deleted_invite': code}

    # ── DMs & Relationships ───────────────────────────────────────────────────

    if action == 'get_dm_channels':
        return _req('GET', '/users/@me/channels')

    if action == 'create_dm':
        user_id = _require(args, 'user_id')
        return _req('POST', '/users/@me/channels', {'recipient_id': user_id})

    if action == 'send_dm':
        user_id = _require(args, 'user_id')
        content = _require(args, 'content')
        dm = _req('POST', '/users/@me/channels', {'recipient_id': user_id})
        channel_id = dm.get('id') if isinstance(dm, dict) else None
        if not channel_id:
            raise RuntimeError('Could not open DM channel with this user')
        data: dict = {'content': content}
        if 'embeds' in args: data['embeds'] = args['embeds']
        return _req('POST', f'/channels/{channel_id}/messages', data)

    if action == 'close_dm':
        channel_id = _require(args, 'channel_id')
        _req('DELETE', f'/channels/{channel_id}')
        return {'closed_dm': channel_id}

    if action == 'get_relationships':
        # Returns friends (type 1), blocked (type 2), incoming requests (type 3), outgoing (type 4)
        rels = _req('GET', '/users/@me/relationships')
        if args.get('type') is not None:
            rels = [r for r in rels if r.get('type') == int(args['type'])]
        return rels

    if action == 'send_friend_request':
        username = _require(args, 'username')
        if '#' in username:
            parts = username.rsplit('#', 1)
            data = {'username': parts[0], 'discriminator': int(parts[1])}
        else:
            data = {'username': username}
        return _req('POST', '/users/@me/relationships', data)

    if action == 'remove_friend':
        user_id = _require(args, 'user_id')
        _req('DELETE', f'/users/@me/relationships/{user_id}')
        return {'removed': user_id}

    if action == 'block_user':
        user_id = _require(args, 'user_id')
        _req('PUT', f'/users/@me/relationships/{user_id}', {'type': 2})
        return {'blocked': user_id}

    if action == 'unblock_user':
        user_id = _require(args, 'user_id')
        _req('DELETE', f'/users/@me/relationships/{user_id}')
        return {'unblocked': user_id}

    # ── Users ─────────────────────────────────────────────────────────────────

    if action == 'get_user':
        user_id = _require(args, 'user_id')
        return _req('GET', f'/users/{user_id}')

    if action == 'get_user_profile':
        user_id  = _require(args, 'user_id')
        guild_id = args.get('guild_id', '')
        qs = f'?with_mutual_guilds=true&with_mutual_friends_count=true'
        if guild_id: qs += f'&guild_id={guild_id}'
        return _req('GET', f'/users/{user_id}/profile{qs}')

    # ── Webhooks ──────────────────────────────────────────────────────────────

    if action == 'get_guild_webhooks':
        guild_id = _require(args, 'guild_id')
        return _req('GET', f'/guilds/{guild_id}/webhooks')

    if action == 'get_channel_webhooks':
        channel_id = _require(args, 'channel_id')
        return _req('GET', f'/channels/{channel_id}/webhooks')

    if action == 'create_webhook':
        channel_id = _require(args, 'channel_id')
        data = {'name': args.get('name', 'DeeperSeek Webhook')}
        if 'avatar' in args: data['avatar'] = args['avatar']
        return _req('POST', f'/channels/{channel_id}/webhooks', data)

    if action == 'edit_webhook':
        webhook_id = _require(args, 'webhook_id')
        data = {}
        if 'name'       in args: data['name']       = args['name']
        if 'avatar'     in args: data['avatar']     = args['avatar']
        if 'channel_id' in args: data['channel_id'] = args['channel_id']
        return _req('PATCH', f'/webhooks/{webhook_id}', data)

    if action == 'delete_webhook':
        webhook_id = _require(args, 'webhook_id')
        _req('DELETE', f'/webhooks/{webhook_id}')
        return {'deleted_webhook': webhook_id}

    if action == 'execute_webhook':
        webhook_id    = _require(args, 'webhook_id')
        webhook_token = _require(args, 'webhook_token')
        data = {}
        if 'content'  in args: data['content']  = args['content']
        if 'username' in args: data['username'] = args['username']
        if 'avatar_url' in args: data['avatar_url'] = args['avatar_url']
        if 'embeds'   in args: data['embeds']   = args['embeds']
        if 'tts'      in args: data['tts']      = bool(args['tts'])
        # Execute webhook does NOT use user token — uses webhook token
        url  = f'https://discord.com/api/v10/webhooks/{webhook_id}/{webhook_token}'
        body = json.dumps(data).encode('utf-8')
        req  = urllib.request.Request(url, data=body, method='POST',
                                       headers={'Content-Type': 'application/json', 'User-Agent': _UA})
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}

    # ── Emoji & Stickers ──────────────────────────────────────────────────────

    if action == 'list_guild_emoji':
        guild_id = _require(args, 'guild_id')
        return _req('GET', f'/guilds/{guild_id}/emojis')

    if action == 'get_emoji':
        guild_id = _require(args, 'guild_id')
        emoji_id = _require(args, 'emoji_id')
        return _req('GET', f'/guilds/{guild_id}/emojis/{emoji_id}')

    if action == 'list_guild_stickers':
        guild_id = _require(args, 'guild_id')
        return _req('GET', f'/guilds/{guild_id}/stickers')

    # ── Audit Log ─────────────────────────────────────────────────────────────

    if action == 'get_audit_log':
        guild_id = _require(args, 'guild_id')
        limit    = min(int(args.get('limit', 50)), 100)
        url = f'/guilds/{guild_id}/audit-logs?limit={limit}'
        if 'action_type' in args: url += f'&action_type={args["action_type"]}'
        if 'user_id'     in args: url += f'&user_id={args["user_id"]}'
        if 'before'      in args: url += f'&before={args["before"]}'
        return _req('GET', url)

    # ── Typing ────────────────────────────────────────────────────────────────

    if action == 'start_typing':
        # Triggers "User is typing..." indicator in the channel for ~5 seconds.
        channel_id = _require(args, 'channel_id')
        _req('POST', f'/channels/{channel_id}/typing')
        return {'typing_started': channel_id}

    # ── Scheduled Events ──────────────────────────────────────────────────────

    if action == 'list_scheduled_events':
        guild_id = _require(args, 'guild_id')
        return _req('GET', f'/guilds/{guild_id}/scheduled-events?with_user_count=true')

    if action == 'create_scheduled_event':
        guild_id = _require(args, 'guild_id')
        name       = _require(args, 'name')
        start_time = _require(args, 'start_time')   # ISO8601
        event_type = int(args.get('event_type', 3)) # 1=stage, 2=voice, 3=external
        data = {
            'name': name,
            'scheduled_start_time': start_time,
            'entity_type': event_type,
            'privacy_level': 2,  # GUILD_ONLY
        }
        if 'end_time'    in args: data['scheduled_end_time'] = args['end_time']
        if 'description' in args: data['description']        = args['description']
        if 'channel_id'  in args: data['channel_id']         = args['channel_id']
        if 'location'    in args: data['entity_metadata']    = {'location': args['location']}
        if 'image'       in args: data['image']              = args['image']
        return _req('POST', f'/guilds/{guild_id}/scheduled-events', data)

    if action == 'delete_scheduled_event':
        guild_id = _require(args, 'guild_id')
        event_id = _require(args, 'event_id')
        _req('DELETE', f'/guilds/{guild_id}/scheduled-events/{event_id}')
        return {'deleted_event': event_id}

    # ── Unknown action ────────────────────────────────────────────────────────

    valid = (
        'get_me edit_me set_status get_settings get_connections get_nitro_info '
        'list_guilds get_guild create_guild edit_guild leave_guild delete_guild '
        'get_guild_preview get_guild_vanity_url '
        'list_channels get_channel create_channel edit_channel delete_channel '
        'get_channel_permissions '
        'get_messages get_message send_message send_reply edit_message delete_message '
        'bulk_delete_messages pin_message unpin_message get_pinned_messages '
        'search_messages '
        'add_reaction remove_reaction get_reactions clear_reactions '
        'create_thread list_threads join_thread leave_thread '
        'list_guild_members search_guild_members get_member edit_member edit_own_nick '
        'kick_member ban_member unban_member list_bans timeout_member '
        'list_roles create_role edit_role delete_role '
        'add_role_to_member remove_role_from_member '
        'create_invite list_invites get_invite delete_invite '
        'get_dm_channels create_dm send_dm close_dm '
        'get_relationships send_friend_request remove_friend block_user unblock_user '
        'get_user get_user_profile '
        'get_guild_webhooks get_channel_webhooks create_webhook edit_webhook '
        'delete_webhook execute_webhook '
        'list_guild_emoji get_emoji list_guild_stickers '
        'get_audit_log start_typing '
        'list_scheduled_events create_scheduled_event delete_scheduled_event'
    )
    raise RuntimeError(
        f"Unknown action '{action}'. Valid actions:\n{valid}"
    )
