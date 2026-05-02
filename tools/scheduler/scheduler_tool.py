"""
scheduler_tool.py — Start a long-running background task that the AI manages
autonomously for a set duration, then reports back.

How it works:
  1. AI calls this tool with a task description and duration.
  2. Tool spawns scheduler_worker.py as a detached subprocess.
  3. Immediately POSTs to /api/scheduler/register so the backend can emit
     `scheduler_start` → frontend shows countdown timer bubble in chat.
  4. Returns immediately with "started" confirmation.
  5. Worker runs in the background, waking every wake_every_sec seconds,
     calling tools and the LLM as needed to make progress on the task.
  6. Worker POSTs progress ticks → frontend updates the timer bubble.
  7. When time is up, worker generates a full report and POSTs to
     /api/scheduler/complete → backend injects the report as a new chat
     message and the timer bubble transitions to "Done".

Example tasks:
  - "Chat with @username on Discord channel #general for 30 minutes,
     responding naturally to whatever they write."
  - "Monitor the DM conversation with user 123456 for 1 hour and reply
     when they send new messages."
  - "Every 2 minutes for 20 minutes, check if a new pull request was
     opened on owner/repo and notify me."
"""

import json
import os
import subprocess
import sys
import time
import uuid

import requests


def execute(
    task:           str,
    duration_min:   int   = 30,
    wake_every_sec: int   = 90,
    label:          str   = '',
    context:        str   = '',
    **kwargs,
) -> dict:
    """
    Start a background autonomous task.

    Args:
        task (str, required):
            Plain-language description of what the AI should do. Be specific:
            include channel IDs, usernames, goals, and any constraints.
            Example: "Chat with Discord user @friend in channel 1234567890
            for 30 minutes. Reply to each message they send in a friendly,
            casual tone. Keep track of topics discussed."

        duration_min (int, default 30):
            How many minutes the task should run. Min 1, max 480 (8 hours).

        wake_every_sec (int, default 90):
            How often (in seconds) the worker wakes up to check for new work
            and take actions. Shorter = more responsive, more API calls.
            Recommended: 60–120 for chat tasks, 120–300 for monitoring tasks.

        label (str, optional):
            Short display label shown in the chat timer bubble.
            Defaults to the first 80 chars of `task`.

        context (str, optional):
            Any extra context the worker should have (e.g. current conversation
            state, IDs, preferences). Appended to the worker's system prompt.

    Returns:
        On success: { started: true, task_id, duration_min, label, message }
        On failure: { started: false, error }
    """
    t0 = time.perf_counter()

    # ── Validate ──────────────────────────────────────────────────────────────
    task = str(task or '').strip()
    if not task:
        return _err('task is required', t0)

    duration_min   = max(1, min(int(duration_min or 30), 480))
    wake_every_sec = max(15, min(int(wake_every_sec or 90), 600))
    label          = str(label or task[:80]).strip()
    context        = str(context or '').strip()

    task_id     = str(uuid.uuid4())
    duration_ms = duration_min * 60 * 1000
    started_at  = int(time.time() * 1000)

    # ── Collect env context the worker needs ──────────────────────────────────
    backend_url    = os.environ.get('DEEPERSEEK_BACKEND_URL', 'http://127.0.0.1:3000')
    internal_token = os.environ.get('DEEPERSEEK_INTERNAL_TOKEN', '')
    session_id     = os.environ.get('DEEPERSEEK_CURRENT_SESSION_ID', '')
    user_id        = os.environ.get('DEEPERSEEK_CURRENT_USER_ID', '')
    discord_token  = os.environ.get('DISCORD_TOKEN', '')
    github_token   = os.environ.get('GITHUB_TOKEN', '')
    api_key        = os.environ.get('DEEPSEEK_API_KEY', '')

    if not session_id:
        return _err('session_id not available in tool environment — cannot attach timer to chat', t0)
    if not api_key:
        return _err('DEEPSEEK_API_KEY not set — worker cannot call the LLM', t0)

    # ── Spawn the worker as a fully detached process ──────────────────────────
    worker_path  = os.path.join(os.path.dirname(__file__), 'scheduler_worker.py')
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

    worker_payload = {
        'task_id':        task_id,
        'task':           task,
        'context':        context,
        'label':          label,
        'duration_min':   duration_min,
        'wake_every_sec': wake_every_sec,
        'session_id':     session_id,
        'user_id':        user_id,
        'started_at':     started_at,
        'backend_url':    backend_url,
        'internal_token': internal_token,
        'discord_token':  discord_token,
        'github_token':   github_token,
        'api_key':        api_key,
        'project_root':   project_root,
    }

    try:
        proc = subprocess.Popen(
            [sys.executable, worker_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            # start_new_session detaches from our process group so the
            # worker survives after this tool process exits.
            start_new_session=True,
            cwd=project_root,
        )
        proc.stdin.write(json.dumps(worker_payload).encode())
        proc.stdin.close()
        pid = proc.pid
    except Exception as exc:
        return _err(f'Failed to spawn worker: {exc}', t0)

    # ── Register with backend (triggers frontend scheduler_start event) ───────
    try:
        resp = requests.post(
            f'{backend_url}/api/scheduler/register',
            json={
                'task_id':        task_id,
                'session_id':     session_id,
                'user_id':        user_id,
                'label':          label,
                'task':           task,
                'duration_ms':    duration_ms,
                'wake_every_sec': wake_every_sec,
                'pid':            pid,
                'started_at':     started_at,
            },
            headers={'Authorization': f'Bearer {internal_token}'},
            timeout=10,
        )
        if resp.status_code != 200:
            # Worker is already running — it will self-register on first tick
            # if the initial register failed. Log but don't fail the tool.
            pass
    except Exception:
        pass  # Non-fatal — worker will still run

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    return {
        'status': 'ok',
        'result': {
            'started':      True,
            'task_id':      task_id,
            'duration_min': duration_min,
            'label':        label,
            'pid':          pid,
            'message': (
                f'Background task started. '
                f'Running for {duration_min} min, waking every {wake_every_sec}s. '
                f'A live countdown timer is now shown in the chat. '
                f'I will post a full report when the task finishes.'
            ),
        },
        'error': None,
        'metadata': {'tool': 'scheduler_tool', 'duration_ms': elapsed_ms},
    }


def _err(msg: str, t0: float) -> dict:
    return {
        'status': 'error',
        'result': None,
        'error': msg,
        'metadata': {
            'tool': 'scheduler_tool',
            'duration_ms': int((time.perf_counter() - t0) * 1000),
        },
    }
