"""
scheduler_worker.py — Autonomous background task runner.

Improvements over v1:
  • Smart sleep: cycle fires immediately after wake interval minus actual cycle
    duration — no drift, no artificial floor.
  • Rolling context summary: the LLM updates a compact summary each cycle so
    the prompt stays small and focused regardless of run length.
  • Discord context cache: resolves own identity + target DM channels once,
    stores in memory so every subsequent cycle knows exactly where to look
    and which message IDs it already processed.
  • Tool executor runs in a thread pool so slow tools don't block the loop.
  • Better error recovery: individual tool errors are captured and reported
    without crashing the cycle.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FuturesTimeout
from typing import Any

import requests
from openai import OpenAI

# ── Paths ─────────────────────────────────────────────────────────────────────

def _find_project_root(cfg: dict) -> str:
    if cfg.get('project_root') and os.path.isdir(cfg['project_root']):
        return cfg['project_root']
    p = os.path.abspath(__file__)
    for _ in range(6):
        p = os.path.dirname(p)
        if os.path.isfile(os.path.join(p, 'package.json')):
            return p
    return os.getcwd()


TOOL_EXECUTOR_NAME = os.path.join('system', 'tool_executor.py')

_executor = ThreadPoolExecutor(max_workers=4)


# ── Tool execution ────────────────────────────────────────────────────────────

def call_tool(tool_name: str, args: dict, project_root: str,
              timeout: int = 45) -> dict:
    """Run a DeeperSeek tool in a subprocess. Returns result dict."""
    executor_path = os.path.join(project_root, TOOL_EXECUTOR_NAME)
    payload = json.dumps({'tool': tool_name, 'args': args})
    try:
        proc = subprocess.run(
            [sys.executable, executor_path],
            input=payload.encode(),
            capture_output=True,
            timeout=timeout,
            cwd=project_root,
            env=os.environ,
        )
        if proc.stdout:
            return json.loads(proc.stdout.decode())
        err = proc.stderr.decode()[:500] if proc.stderr else 'No output'
        return {'status': 'error', 'result': None, 'error': err}
    except subprocess.TimeoutExpired:
        return {'status': 'error', 'result': None,
                'error': f'{tool_name} timed out after {timeout}s'}
    except Exception as exc:
        return {'status': 'error', 'result': None, 'error': str(exc)}


def call_tool_async(tool_name: str, args: dict, project_root: str,
                    timeout: int = 45) -> dict:
    """Submit tool call to thread pool with timeout."""
    future = _executor.submit(call_tool, tool_name, args, project_root, timeout)
    try:
        return future.result(timeout=timeout + 5)
    except FuturesTimeout:
        return {'status': 'error', 'result': None,
                'error': f'{tool_name} thread timed out'}
    except Exception as exc:
        return {'status': 'error', 'result': None, 'error': str(exc)}


# ── LLM client ────────────────────────────────────────────────────────────────

def make_client(api_key: str) -> OpenAI:
    return OpenAI(api_key=api_key, base_url='https://api.deepseek.com')


# ── Worker tool definitions ───────────────────────────────────────────────────

WORKER_TOOLS = [
    {
        'type': 'function',
        'function': {
            'name': 'discord_tool',
            'description': (
                'Interact with Discord as the authenticated user. '
                'Actions: get_me, send_message, read_messages, send_dm, '
                'set_status, list_guilds, get_guild, list_channels, '
                'get_channel_messages, add_reaction, edit_message, '
                'delete_message, start_typing, get_user.'
            ),
            'parameters': {
                'type': 'object',
                'properties': {
                    'action':     {'type': 'string'},
                    'channel_id': {'type': 'string'},
                    'guild_id':   {'type': 'string'},
                    'user_id':    {'type': 'string'},
                    'message_id': {'type': 'string'},
                    'content':    {'type': 'string'},
                    'limit':      {'type': 'integer'},
                    'status':     {'type': 'string'},
                    'emoji':      {'type': 'string'},
                },
                'required': ['action'],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'web_search',
            'description': 'Search the web for current information.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'query':       {'type': 'string'},
                    'num_results': {'type': 'integer'},
                },
                'required': ['query'],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'web_fetch',
            'description': 'Fetch and read a URL.',
            'parameters': {
                'type': 'object',
                'properties': {'url': {'type': 'string'}},
                'required': ['url'],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'memory_store',
            'description': 'Persist a key/value pair that survives across wake cycles.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'key':   {'type': 'string'},
                    'value': {'type': 'string'},
                },
                'required': ['key', 'value'],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'memory_get',
            'description': 'Retrieve a previously stored memory by key.',
            'parameters': {
                'type': 'object',
                'properties': {'key': {'type': 'string'}},
                'required': ['key'],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'run_python',
            'description': 'Execute Python code for calculations or data processing.',
            'parameters': {
                'type': 'object',
                'properties': {'code': {'type': 'string'}},
                'required': ['code'],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'github_ops',
            'description': 'GitHub operations: list_prs, get_pr, list_issues, comment, etc.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'action': {'type': 'string'},
                    'repo':   {'type': 'string'},
                    'number': {'type': 'integer'},
                    'body':   {'type': 'string'},
                },
                'required': ['action'],
            },
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'http_request',
            'description': 'Make an HTTP request to any URL.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'url':     {'type': 'string'},
                    'method':  {'type': 'string'},
                    'headers': {'type': 'object'},
                    'body':    {'type': 'string'},
                },
                'required': ['url'],
            },
        },
    },
]


# ── Discord context resolution ────────────────────────────────────────────────

def resolve_discord_context(project_root: str) -> dict:
    """
    One-time preflight: get own identity.
    Returns a dict that gets injected into the system prompt and passed
    to each cycle so the LLM knows its own user ID without re-fetching.
    """
    ctx: dict = {}
    result = call_tool('discord_tool', {'action': 'get_me'}, project_root, timeout=15)
    if result.get('status') == 'ok' and isinstance(result.get('result'), dict):
        me = result['result']
        ctx['my_id']       = me.get('id')
        ctx['my_username'] = me.get('username') or me.get('global_name') or '(unknown)'
    return ctx


# ── System prompt ─────────────────────────────────────────────────────────────

def build_system_prompt(cfg: dict, cycle: int, total_cycles: int,
                        elapsed_min: float, remaining_min: float,
                        context_summary: str,
                        recent_actions: list[dict],
                        discord_ctx: dict) -> str:

    recent_text = 'None yet.'
    if recent_actions:
        recent_text = '\n'.join(
            f'  [{a["time"]}] {a["tool"]}({_fmt_args(a["args"])}) → {a["summary"]}'
            for a in recent_actions
        )

    discord_section = ''
    if os.environ.get('DISCORD_TOKEN'):
        me_line = ''
        if discord_ctx.get('my_id'):
            me_line = f'\n  • You are: {discord_ctx["my_username"]} (ID {discord_ctx["my_id"]})'
        cached = ''
        if discord_ctx.get('dm_channels'):
            lines = [f'    - {name}: channel {cid} (last seen msg: {discord_ctx["last_msg_ids"].get(cid, "none")})'
                     for name, cid in discord_ctx['dm_channels'].items()]
            cached = '\n  • Resolved DM channels:\n' + '\n'.join(lines)
        discord_section = f"""
DISCORD CONTEXT:{me_line}{cached}
  • When reading DMs: use get_channel_messages with the cached channel_id and after_id=<last seen msg id> to fetch ONLY new messages. Do not re-read old ones.
  • When responding: only reply to messages you have NOT already replied to.
  • start_typing before send_message to appear natural.
  • Cache any new channel/user IDs you discover using memory_store."""

    return f"""You are an autonomous background agent executing a scheduled long-running task.

TASK:
{cfg['task']}
{'EXTRA CONTEXT:\n' + cfg['context'] if cfg.get('context') else ''}

TIMING:
  Cycle {cycle}/{total_cycles} | Elapsed {elapsed_min:.1f} min | Remaining {remaining_min:.1f} min
  Wake interval: {cfg['wake_every_sec']}s
{discord_section}
ROLLING CONTEXT SUMMARY (what has happened so far):
{context_summary or 'First cycle — no prior history.'}

RECENT ACTIONS (last {len(recent_actions)} cycles):
{recent_text}

INSTRUCTIONS:
  1. Review the task and rolling context. Decide the single most valuable next action.
  2. Execute it with tools. Chain multiple tools if needed.
  3. Be natural and goal-focused. Never repeat an action unless genuinely needed.
  4. For messaging tasks: only reply to NEW messages you haven't seen yet.
  5. After tool calls, write 1–2 sentences summarising what you did THIS cycle.
     This is shown live in the UI timer bubble — make it descriptive.

You are running autonomously. The user will see the full report at the end."""


def _fmt_args(args: dict) -> str:
    s = json.dumps(args, ensure_ascii=False)
    return s[:100] + ('…' if len(s) > 100 else '')


# ── Rolling context updater ───────────────────────────────────────────────────

def update_context_summary(client: OpenAI, model: str, prev_summary: str,
                           cycle_narrative: str, tool_records: list[dict],
                           cycle: int) -> str:
    """
    Ask the LLM to update the rolling context summary in ≤150 words.
    This replaces the full action log in the next cycle's prompt.
    """
    tool_summary = '; '.join(
        f'{r["tool"]}→{r["summary"][:80]}'
        for r in tool_records
    ) or 'no tools used'

    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {'role': 'system', 'content':
                    'You maintain a compact rolling context summary for an autonomous agent. '
                    'Update it to reflect what just happened. Max 150 words. '
                    'Keep facts that matter (IDs, names, decisions, state). Drop old details.'},
                {'role': 'user', 'content':
                    f'PREVIOUS SUMMARY:\n{prev_summary or "(none)"}\n\n'
                    f'CYCLE {cycle} — Tools used: {tool_summary}\n'
                    f'Narrative: {cycle_narrative}\n\n'
                    'Write the updated summary (max 150 words):'},
            ],
            max_tokens=200,
            temperature=0.2,
        )
        return (resp.choices[0].message.content or '').strip()
    except Exception:
        # If update fails, append a note to the existing summary
        note = f'[C{cycle}] {cycle_narrative[:100]}'
        return (prev_summary + '\n' + note).strip()[-800:]


# ── Per-cycle LLM + tool loop ─────────────────────────────────────────────────

def run_cycle(client: OpenAI, model: str, system_prompt: str,
              project_root: str, max_tool_rounds: int = 10) -> tuple[str, list[dict]]:
    """
    Full LLM + tool loop for one wake cycle.
    Returns (narrative, tool_records).
    """
    messages = [
        {'role': 'system', 'content': system_prompt},
        {'role': 'user',   'content': 'Execute the next step of the task now.'},
    ]
    tool_records: list[dict] = []

    for _round in range(max_tool_rounds):
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            tools=WORKER_TOOLS,
            tool_choice='auto',
            max_tokens=2048,
            temperature=0.35,
        )
        msg = response.choices[0].message
        messages.append(msg)

        if not msg.tool_calls:
            return (msg.content or '').strip(), tool_records

        # Execute tool calls — run independent ones in parallel
        calls = [(tc.id, tc.function.name, tc.function.arguments)
                 for tc in msg.tool_calls]

        futures = {}
        for tc_id, tool_name, raw_args in calls:
            try:
                args = json.loads(raw_args)
            except Exception:
                args = {}
            tool_timeout = 60 if tool_name in ('web_fetch', 'web_browse', 'web_research') else 45
            fut = _executor.submit(call_tool, tool_name, args, project_root, tool_timeout)
            futures[tc_id] = (tool_name, args, fut)

        # Collect results in original order and append tool messages
        for tc_id, tool_name, raw_args in calls:
            tool_name, args, fut = futures[tc_id]
            try:
                result = fut.result(timeout=70)
            except FuturesTimeout:
                result = {'status': 'error', 'result': None,
                          'error': f'{tool_name} timed out'}
            except Exception as exc:
                result = {'status': 'error', 'result': None, 'error': str(exc)}

            result_text = json.dumps(result.get('result') if result.get('result') is not None
                                     else result.get('error', ''))
            if len(result_text) > 4000:
                result_text = result_text[:4000] + '…[truncated]'

            tool_records.append({
                'tool':    tool_name,
                'args':    args,
                'status':  result.get('status', 'error'),
                'summary': result_text[:400],
            })
            messages.append({
                'role':         'tool',
                'tool_call_id': tc_id,
                'content':      result_text,
            })

    # Exhausted rounds — ask for summary
    messages.append({'role': 'user',
                     'content': 'Summarise what you just did in 1–2 sentences.'})
    final = client.chat.completions.create(
        model=model, messages=messages, max_tokens=200, temperature=0.2
    )
    return (final.choices[0].message.content or '').strip(), tool_records


# ── Final report ──────────────────────────────────────────────────────────────

def generate_report(client: OpenAI, model: str, cfg: dict,
                    context_summary: str, actions: list[dict],
                    elapsed_min: float) -> str:
    action_log = '\n'.join(
        f'  [{i+1}] [{a["time"]}] {a["tool"]}({_fmt_args(a["args"])}) → {a["summary"]}'
        for i, a in enumerate(actions)
    ) or 'No actions recorded.'

    prompt = (
        f'TASK: {cfg["task"]}\n'
        f'DURATION: {elapsed_min:.1f} min (planned: {cfg["duration_min"]} min)\n'
        f'CYCLES COMPLETED: {cfg.get("cycles_completed", "?")}\n\n'
        f'ROLLING CONTEXT (final state):\n{context_summary}\n\n'
        f'FULL ACTION LOG ({len(actions)} entries):\n{action_log}\n\n'
        'Write a concise structured Markdown report:\n'
        '1. **Summary** — what was accomplished (2–3 sentences)\n'
        '2. **Key actions** — bullet list\n'
        '3. **Outcome** — did it succeed? any issues?\n'
        '4. **Notes** — anything the user should know\n\n'
        'Start with "## Task Complete ✅". Use Markdown.'
    )

    response = client.chat.completions.create(
        model=model,
        messages=[
            {'role': 'system', 'content': 'You write concise, accurate task completion reports.'},
            {'role': 'user',   'content': prompt},
        ],
        max_tokens=2048,
        temperature=0.2,
    )
    return response.choices[0].message.content or '*(No report generated.)*'


# ── Backend communication ─────────────────────────────────────────────────────

def post_tick(cfg: dict, elapsed_ms: int, remaining_ms: int,
              current_action: str, stats: dict) -> None:
    try:
        requests.post(
            f"{cfg['backend_url']}/api/scheduler/tick",
            json={
                'task_id':        cfg['task_id'],
                'elapsed_ms':     elapsed_ms,
                'remaining_ms':   remaining_ms,
                'current_action': current_action,
                'stats':          stats,
            },
            headers={'Authorization': f"Bearer {cfg['internal_token']}"},
            timeout=8,
        )
    except Exception:
        pass


def post_complete(cfg: dict, report: str, tool_calls: list) -> None:
    try:
        requests.post(
            f"{cfg['backend_url']}/api/scheduler/complete",
            json={
                'task_id':    cfg['task_id'],
                'report':     report,
                'tool_calls': tool_calls,
            },
            headers={'Authorization': f"Bearer {cfg['internal_token']}"},
            timeout=30,
        )
    except Exception:
        pass


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    try:
        cfg = json.loads(sys.stdin.buffer.read().decode())
    except Exception as exc:
        sys.exit(f'[scheduler_worker] Bad config: {exc}')

    # Inject credentials into env so subprocesses inherit them
    for env_key, cfg_key in [
        ('DISCORD_TOKEN',              'discord_token'),
        ('GITHUB_TOKEN',               'github_token'),
        ('DEEPSEEK_API_KEY',           'api_key'),
        ('DEEPERSEEK_INTERNAL_TOKEN',  'internal_token'),
        ('DEEPERSEEK_BACKEND_URL',     'backend_url'),
    ]:
        if cfg.get(cfg_key):
            os.environ[env_key] = str(cfg[cfg_key])

    project_root   = _find_project_root(cfg)
    client         = make_client(cfg['api_key'])
    model          = 'deepseek-v4-flash'

    duration_ms    = int(cfg['duration_min'] * 60 * 1000)
    wake_every_sec = max(5, int(cfg['wake_every_sec']))
    start_ms       = cfg.get('started_at') or int(time.time() * 1000)
    deadline_ms    = start_ms + duration_ms
    total_cycles   = max(1, int(cfg['duration_min'] * 60 / wake_every_sec))

    context_summary: str      = ''
    discord_ctx:     dict     = {}
    actions:         list     = []
    all_tool_calls:  list     = []
    stats:           dict     = {'cycles': 0, 'tool_calls': 0, 'errors': 0}
    cycle                     = 0

    def _now_ms()       -> int: return int(time.time() * 1000)
    def _elapsed_ms()   -> int: return _now_ms() - start_ms
    def _remaining_ms() -> int: return max(0, deadline_ms - _now_ms())

    # ── Discord pre-flight (cycle 0) ─────────────────────────────────────────
    if os.environ.get('DISCORD_TOKEN') and 'discord' in cfg['task'].lower():
        discord_ctx = resolve_discord_context(project_root)
        discord_ctx.setdefault('dm_channels',  {})
        discord_ctx.setdefault('last_msg_ids', {})

    # ── Main loop ─────────────────────────────────────────────────────────────
    while _remaining_ms() > 0:
        cycle += 1
        stats['cycles'] = cycle
        cycle_start = time.monotonic()

        elapsed_min   = _elapsed_ms() / 60_000
        remaining_min = _remaining_ms() / 60_000

        system_prompt = build_system_prompt(
            cfg, cycle, total_cycles, elapsed_min, remaining_min,
            context_summary,
            actions[-5:],       # only the 5 most-recent action records in prompt
            discord_ctx,
        )

        cycle_summary = f'Cycle {cycle} in progress…'
        try:
            narrative, tool_records = run_cycle(
                client, model, system_prompt, project_root
            )
            stats['tool_calls'] += len(tool_records)

            ts = time.strftime('%H:%M:%S')
            for tr in tool_records:
                actions.append({
                    'time':    ts,
                    'tool':    tr['tool'],
                    'args':    tr['args'],
                    'summary': tr['summary'],
                })
                all_tool_calls.append({
                    'tool':   tr['tool'],
                    'args':   tr['args'],
                    'status': tr['status'],
                })

            cycle_summary = narrative[:250] if narrative else f'Cycle {cycle} done.'

            # Update rolling context summary asynchronously (don't block tick)
            fut_ctx = _executor.submit(
                update_context_summary, client, model,
                context_summary, cycle_summary, tool_records, cycle
            )

            # Non-blocking: try to get result within 8s, else keep old summary
            try:
                context_summary = fut_ctx.result(timeout=8)
            except Exception:
                pass

        except Exception as exc:
            stats['errors'] += 1
            cycle_summary = f'Cycle {cycle} error: {str(exc)[:150]}'
            traceback.print_exc(file=sys.stderr)

        post_tick(
            cfg,
            elapsed_ms    = _elapsed_ms(),
            remaining_ms  = _remaining_ms(),
            current_action= cycle_summary,
            stats         = dict(stats),
        )

        # Smart sleep: fire the next cycle exactly wake_every_sec after this
        # cycle started, minus however long the cycle actually took.
        cycle_duration = time.monotonic() - cycle_start
        sleep_secs = max(1, wake_every_sec - cycle_duration)

        sleep_end = time.monotonic() + sleep_secs
        while time.monotonic() < sleep_end and _remaining_ms() > 0:
            time.sleep(min(0.5, sleep_end - time.monotonic()))

    # ── Final report ─────────────────────────────────────────────────────────
    cfg['cycles_completed'] = cycle
    elapsed_min = _elapsed_ms() / 60_000
    try:
        report = generate_report(client, model, cfg, context_summary, actions, elapsed_min)
    except Exception as exc:
        report = (
            f'## Task Complete ✅\n\n'
            f'**Duration:** {elapsed_min:.1f} min | **Cycles:** {cycle} | '
            f'**Actions:** {len(actions)}\n\n'
            f'**Context:**\n{context_summary}\n\n'
            f'*(Report generation failed: {exc})*\n\n'
            + '\n'.join(f'- `{a["tool"]}` [{a["time"]}]: {a["summary"][:100]}' for a in actions)
        )

    post_complete(cfg, report, all_tool_calls)
    _executor.shutdown(wait=False)


if __name__ == '__main__':
    main()
