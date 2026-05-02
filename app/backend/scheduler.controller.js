'use strict';

/**
 * scheduler.controller.js — HTTP handlers for the scheduler system.
 *
 * Two classes of endpoints:
 *
 * INTERNAL (worker → backend, authenticated with DEEPERSEEK_INTERNAL_TOKEN):
 *   POST /api/scheduler/register   — tool registers a new task + PID
 *   POST /api/scheduler/tick       — worker posts progress tick
 *   POST /api/scheduler/complete   — worker posts final report
 *
 * USER-FACING (authenticated with normal session auth):
 *   GET  /api/scheduler/tasks             — list active tasks for current user
 *   DELETE /api/scheduler/tasks/:taskId   — cancel a task
 */

const schedulerService = require('./scheduler.service');
const logger           = require('./logger');

// ── Internal token guard ─────────────────────────────────────────────────────

function requireInternalToken(req, res, next) {
  try {
    const authService = require('./auth.service');
    const token = authService.getInternalToken();
    const provided = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (provided && provided === token) {
      return next();
    }
  } catch {}
  return res.status(401).json({ error: 'Internal token required' });
}

// ── Internal handlers ─────────────────────────────────────────────────────────

/**
 * POST /api/scheduler/register
 * Called by scheduler_tool.py immediately after spawning the worker.
 * Body: { task_id, session_id, user_id, label, task, duration_ms,
 *          wake_every_sec, pid, started_at }
 */
async function register(req, res) {
  const {
    task_id, session_id, user_id, label, task,
    duration_ms, wake_every_sec, pid, started_at,
  } = req.body || {};

  if (!task_id || !session_id || !duration_ms) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const record = schedulerService.registerTask({
      taskId:      task_id,
      sessionId:   session_id,
      userId:      user_id || null,
      label:       label || task?.slice(0, 80) || 'Background task',
      task:        task || '',
      durationMs:  Number(duration_ms),
      wakeEverySec: Number(wake_every_sec) || 90,
      pid:         Number(pid) || 0,
      startedAt:   Number(started_at) || Date.now(),
    });
    res.json({ ok: true, task_id: record.taskId });
  } catch (err) {
    logger.error('[scheduler] register error', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/scheduler/tick
 * Called by the worker every wake cycle.
 * Body: { task_id, elapsed_ms, remaining_ms, current_action, stats }
 */
function tick(req, res) {
  const { task_id, elapsed_ms, remaining_ms, current_action, stats } = req.body || {};
  if (!task_id) return res.status(400).json({ error: 'Missing task_id' });

  const ok = schedulerService.tickTask(task_id, {
    elapsedMs:     Number(elapsed_ms) || 0,
    remainingMs:   Number(remaining_ms) || 0,
    currentAction: current_action || '',
    stats:         stats || {},
  });

  res.json({ ok });
}

/**
 * POST /api/scheduler/complete
 * Called by the worker when the task finishes.
 * Body: { task_id, report, tool_calls }
 */
async function complete(req, res) {
  const { task_id, report, tool_calls } = req.body || {};
  if (!task_id) return res.status(400).json({ error: 'Missing task_id' });

  try {
    const ok = await schedulerService.completeTask(task_id, {
      report:    report || '*(Task finished with no report.)*',
      toolCalls: tool_calls || [],
    });
    res.json({ ok });
  } catch (err) {
    logger.error(`[scheduler] complete error for ${task_id}`, err);
    res.status(500).json({ error: err.message });
  }
}

// ── User-facing handlers ─────────────────────────────────────────────────────

/**
 * GET /api/scheduler/tasks
 * Returns all active tasks owned by the current user.
 */
function listTasks(req, res) {
  const userId = req.user ? req.user.id : null;
  const tasks  = schedulerService.listTasksForUser(userId);
  res.json({ tasks });
}

/**
 * DELETE /api/scheduler/tasks/:taskId
 * Cancel a running task. Only the owning user (or admin) may cancel.
 */
function cancelTask(req, res) {
  const { taskId } = req.params;
  const task = schedulerService.getTask(taskId);

  if (!task) return res.status(404).json({ error: 'Task not found' });

  const userId = req.user ? req.user.id : null;
  if (task.userId && userId && task.userId !== userId && req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const ok = schedulerService.cancelTask(taskId);
  res.json({ ok });
}

module.exports = { requireInternalToken, register, tick, complete, listTasks, cancelTask };
