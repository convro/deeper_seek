"""
scheduler_worker.py — Autonomous background task runner.

Launched by scheduler_tool.py as a detached subprocess. Receives its full
configuration via stdin as a JSON blob, then:

  1. Enters the main loop: sleep → wake → think → act → report tick → repeat
  2. Each wake cycle: calls the DeepSeek LLM with full task context and the
     actions taken so far, executes any tool calls the LLM requests, records
     actions, and POSTs a progress tick to the backend.
  3. When the duration expires: generates a comprehensive summary/report via
     a final LLM call and POSTs it to /api/scheduler/complete.
  4. The backend injects the report as a new chat message and emits
     `scheduler_complete` so the frontend timer bubble transitions to Done.

The worker has access to all DeeperSeek tools (discord_tool, web_search,
memory_store, git_ops, etc.) via the same tool_executor.py subprocess
mechanism the main orchestrator uses.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import traceback
from typing import Any

import requests
from openai import OpenAI

# ── Paths ─────────────────────────────────────────────────────────────────────

def _find_project_root(cfg: dict) -> str:
    """Use config value first, then walk up from __file__."""
    if cfg.get('project_root') and os.path.isdir(cfg['project_root']):
        return cfg['project_root']
    p = os.path.abspath(__file__)
    for _ in range(6):
        p = os.path.dirname(p)
        if os.path.isfile(os.path.join(p, 'package.json')):
            return p
    return os.getcwd()


TOOL_EXECUTOR_NAME = os.path.join('system', 'tool_executor.py')


# ── Tool execution ────────────────────────────────────────────────────────────

def call_tool(tool_name: str, args: dict, project_root: str) -> dict:
    """
    Execute a DeeperSeek tool via tool_executor.py and return the result dict.
    Times out after 60 s (most tools complete well under that).
    """
    executor = os.path.join(project_root, TOOL_EXECUTOR_NAME)
    payload  = json.dumps({'tool': tool_name, 'args': args})
    try:
        proc = subprocess.run(
            [sys.executable, executor],
            input=payload.encode(),
            capture_output=True,
            timeout=120,
            cwd=project_root,
            env=os.environ,
        )
        if proc.stdout:
            return json.loads(proc.stdout.decode())
        return {'status': 'error', 'result': None,
                'error': proc.stderr.decode()[:500] or 'No output from tool'}
    except subprocess.TimeoutExpired:
        return {'status': 'error', 'result': None, 'error': 'Tool timed out'}
    except Exception as exc:
        return {'status': 'error', 'result': None, 'error': str(exc)}


# ── LLM tool definitions exposed to the worker ────────────────────────────────

WORKER_TOOLS = [
    {
        'type': 'function',
        'function': {
            'name': 'discord_tool',
            'description': (
                'Interact with Discord as the authenticated user. '
                'Actions: get_me, send_message, read_messages, send_dm, '
                'set_status, list_guilds, get_guild, list_channels, '
                'get_channel_messages, add_reaction, create_invite, '
                'kick_member, ban_member, create_channel, delete_channel, '
                'edit_message, delete_message, start_typing, get_user.'
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
            'description': 'Search the web for information.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'query': {'type': 'string'},
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
            'description': 'Fetch and read the content of a URL.',
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
            'description': 'Store a key-value fact in memory across wake cycles.',
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
            'description': 'Execute a Python script snippet for calculations or data processing.',
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
            'description': 'GitHub operations: list_prs, get_pr, list_issues, etc.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'action': {'type': 'string'},
                    'repo':   {'type': 'string'},
                    'number': {'type': 'integer'},
                },
                'required': ['action'],
            },
        },
    },
]


# ── LLM client ────────────────────────────────────────────────────────────────

def make_client(api_key: str) -> OpenAI:
    return OpenAI(api_key=api_key, base_url='https://api.deepseek.com')


# ── System prompt builder ─────────────────────────────────────────────────────

def build_system_prompt(cfg: dict, cycle: int, total_cycles: int,
                        elapsed_min: float, remaining_min: float,
                        actions: list[dict]) -> str:
    actions_text = 'None yet.' if not actions else '\n'.join(
        f'  [{i+1}] [{a["time"]}] {a["tool"]}({_fmt_args(a["args"])}) → {a["summary"]}'
        for i, a in enumerate(actions[-40:])   # last 40 actions to avoid huge prompts
    )

    discord_note = ''
    if os.environ.get('DISCORD_TOKEN'):
        discord_note = (
            '\n\nDISCORD: You have a Discord user token available. '
            'Use discord_tool for all Discord actions. '
            'When reading messages, remember to check for new ones since your last read '
            'and only reply to messages you have not already replied to.'
        )

    return f"""You are an autonomous background agent executing a long-running task on behalf of the user.

TASK:
{cfg['task']}

{'EXTRA CONTEXT:\n' + cfg['context'] if cfg.get('context') else ''}

TIMING:
  • Total duration : {cfg['duration_min']} minutes
  • Elapsed        : {elapsed_min:.1f} min  ({cycle}/{total_cycles} cycles)
  • Remaining      : {remaining_min:.1f} min
  • This cycle     : {cycle}

ACTIONS TAKEN SO FAR ({len(actions)} total):
{actions_text}
{discord_note}

INSTRUCTIONS FOR THIS WAKE CYCLE:
  1. Review the task and what has been done so far.
  2. Decide what the most valuable next action is.
  3. Use tools to take that action. You may call multiple tools in sequence.
  4. Be concise and goal-focused. The user sees a timer, not live output.
  5. Do NOT repeat actions you have already performed unless the task requires it.
  6. For chat/messaging tasks: read new messages, respond naturally, do not spam.
  7. After your tool calls, write a VERY brief (1–2 sentence) note of what you did
     this cycle — this becomes the "current action" shown in the timer bubble.

Remember: you are running autonomously. The user will see the full report at the end.
Act as a competent human assistant would."""


def _fmt_args(args: dict) -> str:
    s = json.dumps(args)
    return s[:120] + ('…' if len(s) > 120 else '')


# ── Tool-use execution loop per wake cycle ────────────────────────────────────

def run_cycle(client: OpenAI, model: str, system_prompt: str,
              project_root: str, max_tool_rounds: int = 8) -> tuple[str, list[dict]]:
    """
    Run one full LLM + tool loop for this wake cycle.
    Returns (narrative, tool_records) where narrative is the AI's text response.
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
            temperature=0.4,
        )

        msg = response.choices[0].message
        messages.append(msg)

        if not msg.tool_calls:
            return (msg.content or '').strip(), tool_records

        # Execute each tool call
        for tc in msg.tool_calls:
            tool_name = tc.function.name
            try:
                args = json.loads(tc.function.arguments)
            except Exception:
                args = {}

            result = call_tool(tool_name, args, project_root)
            result_text = json.dumps(result.get('result', result.get('error', '')))
            if len(result_text) > 3000:
                result_text = result_text[:3000] + '…[truncated]'

            tool_records.append({
                'tool':    tool_name,
                'args':    args,
                'status':  result.get('status', 'error'),
                'summary': result_text[:300],
            })

            messages.append({
                'role':         'tool',
                'tool_call_id': tc.id,
                'content':      result_text,
            })

    # Ran out of rounds — ask for a summary
    messages.append({'role': 'user', 'content': 'Summarise what you just did in 1–2 sentences.'})
    final = client.chat.completions.create(
        model=model, messages=messages, max_tokens=256, temperature=0.3
    )
    return (final.choices[0].message.content or '').strip(), tool_records


# ── Final report generation ───────────────────────────────────────────────────

def generate_report(client: OpenAI, model: str, cfg: dict,
                    actions: list[dict], elapsed_min: float) -> str:
    actions_text = '\n'.join(
        f'  [{i+1}] [{a["time"]}] {a["tool"]}({_fmt_args(a["args"])}) → {a["summary"]}'
        for i, a in enumerate(actions)
    ) or 'No actions were recorded.'

    prompt = f"""You are writing the final report for a completed background task.

TASK: {cfg['task']}
DURATION: {elapsed_min:.1f} minutes (planned: {cfg['duration_min']} min)
TOTAL ACTIONS: {len(actions)}

FULL ACTION LOG:
{actions_text}

Write a clear, structured Markdown report covering:
1. **Summary** — what was accomplished in 2–3 sentences
2. **Actions taken** — brief bullet list of the key actions
3. **Outcome** — result/status (succeeded? any issues?)
4. **Notable details** — anything the user should know

Be concise but thorough. Use Markdown formatting. Start with "## Task Complete 🎯"."""

    response = client.chat.completions.create(
        model=model,
        messages=[
            {'role': 'system', 'content': 'You write concise, accurate task reports.'},
            {'role': 'user',   'content': prompt},
        ],
        max_tokens=2048,
        temperature=0.3,
    )
    return response.choices[0].message.content or '*(No report generated.)*'


# ── Backend communication ─────────────────────────────────────────────────────

def post_tick(cfg: dict, cycle: int, total_cycles: int, elapsed_ms: int,
              remaining_ms: int, current_action: str, stats: dict) -> None:
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
            timeout=10,
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


# ── Main entry point ──────────────────────────────────────────────────────────

def main() -> None:
    # Read config from stdin (written by scheduler_tool.py)
    try:
        raw = sys.stdin.buffer.read()
        cfg  = json.loads(raw.decode())
    except Exception as exc:
        sys.exit(f'[scheduler_worker] Failed to read config: {exc}')

    # Inject credentials into env so call_tool subprocesses inherit them
    if cfg.get('discord_token'):
        os.environ['DISCORD_TOKEN'] = cfg['discord_token']
    if cfg.get('github_token'):
        os.environ['GITHUB_TOKEN'] = cfg['github_token']
    if cfg.get('api_key'):
        os.environ['DEEPSEEK_API_KEY'] = cfg['api_key']
    if cfg.get('internal_token'):
        os.environ['DEEPERSEEK_INTERNAL_TOKEN'] = cfg['internal_token']
    if cfg.get('backend_url'):
        os.environ['DEEPERSEEK_BACKEND_URL'] = cfg['backend_url']

    project_root = _find_project_root(cfg)

    client = make_client(cfg['api_key'])
    model  = 'deepseek-v4-flash'

    duration_ms    = cfg['duration_min'] * 60 * 1000
    wake_every_sec = cfg['wake_every_sec']
    start_time     = cfg.get('started_at', int(time.time() * 1000))
    deadline_ms    = start_time + duration_ms
    total_cycles   = max(1, int(cfg['duration_min'] * 60 / wake_every_sec))

    actions: list[dict]     = []
    all_tool_calls: list    = []
    stats: dict[str, int]   = {'cycles': 0, 'tool_calls': 0, 'errors': 0}
    cycle                   = 0

    def _now_ms() -> int:
        return int(time.time() * 1000)

    def _elapsed_ms() -> int:
        return _now_ms() - start_time

    def _remaining_ms() -> int:
        return max(0, deadline_ms - _now_ms())

    # ── Main loop ─────────────────────────────────────────────────────────────
    while _remaining_ms() > 0:
        cycle += 1
        stats['cycles'] = cycle

        elapsed_min   = _elapsed_ms() / 60_000
        remaining_min = _remaining_ms() / 60_000

        system_prompt = build_system_prompt(
            cfg, cycle, total_cycles, elapsed_min, remaining_min, actions
        )

        cycle_summary = f'Cycle {cycle} — thinking…'
        try:
            narrative, tool_records = run_cycle(
                client, model, system_prompt, project_root
            )
            stats['tool_calls'] += len(tool_records)

            # Record each tool invocation in the action log
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

            cycle_summary = narrative[:200] if narrative else f'Cycle {cycle} complete.'

        except Exception as exc:
            stats['errors'] += 1
            cycle_summary = f'Cycle {cycle} error: {str(exc)[:120]}'
            traceback.print_exc(file=sys.stderr)

        # Post tick to backend
        post_tick(
            cfg, cycle, total_cycles,
            elapsed_ms    = _elapsed_ms(),
            remaining_ms  = _remaining_ms(),
            current_action= cycle_summary,
            stats         = dict(stats),
        )

        # Sleep until next wake, but stop early if deadline passed
        sleep_end = time.time() + wake_every_sec
        while time.time() < sleep_end and _remaining_ms() > 0:
            time.sleep(1)

    # ── Generate final report ─────────────────────────────────────────────────
    elapsed_min = _elapsed_ms() / 60_000
    try:
        report = generate_report(client, model, cfg, actions, elapsed_min)
    except Exception as exc:
        report = (
            f'## Task Complete 🎯\n\n'
            f'**Duration:** {elapsed_min:.1f} minutes\n'
            f'**Actions:** {len(actions)} total\n'
            f'**Note:** Report generation failed — {exc}\n\n'
            f'**Action log:**\n' +
            '\n'.join(f'- {a["time"]} `{a["tool"]}`: {a["summary"][:120]}' for a in actions)
        )

    post_complete(cfg, report, all_tool_calls)


if __name__ == '__main__':
    main()
