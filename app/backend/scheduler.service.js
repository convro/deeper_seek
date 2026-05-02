'use strict';

/**
 * scheduler.service.js — background task registry and lifecycle management.
 *
 * Tasks flow:
 *   1. AI calls scheduler_tool → tool POSTs /api/scheduler/register
 *   2. registerTask() stores task, emits scheduler_start SSE, spawns worker
 *   3. Worker wakes every N seconds, POSTs /api/scheduler/tick → tickTask()
 *   4. tickTask() updates in-memory state, emits scheduler_tick SSE
 *   5. Worker finishes, POSTs /api/scheduler/complete → completeTask()
 *   6. completeTask() streams the final report into the session via SSE,
 *      saves to disk, emits scheduler_complete SSE
 */

const { sendEvent } = require('./websocket');
const logger        = require('./logger');

// taskId → TaskRecord
const _tasks = new Map();

/**
 * @typedef {Object} TaskRecord
 * @property {string}  taskId
 * @property {string}  sessionId
 * @property {string|null} userId
 * @property {string}  label
 * @property {string}  task
 * @property {number}  durationMs
 * @property {number}  startedAt      — unix ms
 * @property {number}  wakeEverySec
 * @property {number}  pid            — worker process PID
 * @property {'running'|'complete'|'cancelled'|'error'} status
 * @property {string}  [currentAction]
 * @property {Object}  [stats]
 * @property {number}  [elapsedMs]
 * @property {number}  [remainingMs]
 */

/**
 * Register a new scheduler task (called from scheduler.controller after tool triggers it).
 * Emits `scheduler_start` to the session WebSocket.
 */
function registerTask({ taskId, sessionId, userId, label, task, durationMs, wakeEverySec, pid, startedAt }) {
  const record = {
    taskId, sessionId, userId, label, task,
    durationMs, wakeEverySec, pid,
    startedAt: startedAt || Date.now(),
    status: 'running',
    currentAction: 'Initializing…',
    stats: {},
    elapsedMs: 0,
    remainingMs: durationMs,
  };
  _tasks.set(taskId, record);

  sendEvent(sessionId, {
    type:        'scheduler_start',
    task_id:     taskId,
    label,
    duration_ms: durationMs,
    started_at:  record.startedAt,
  });

  logger.info(`[scheduler] Task ${taskId} registered (${label}) session=${sessionId}`);
  return record;
}

/**
 * Receive a progress tick from the worker.
 * Emits `scheduler_tick` to the session WebSocket.
 */
function tickTask(taskId, { elapsedMs, remainingMs, currentAction, stats }) {
  const t = _tasks.get(taskId);
  if (!t || t.status !== 'running') return false;

  t.elapsedMs     = elapsedMs;
  t.remainingMs   = remainingMs;
  t.currentAction = currentAction || t.currentAction;
  if (stats) Object.assign(t.stats, stats);

  sendEvent(t.sessionId, {
    type:           'scheduler_tick',
    task_id:        taskId,
    elapsed_ms:     elapsedMs,
    remaining_ms:   remainingMs,
    current_action: t.currentAction,
    stats:          t.stats,
  });

  return true;
}

/**
 * Mark a task complete, stream the final report into the session as an
 * assistant message (using the same llm_start / content_delta / done
 * event sequence the normal chat loop uses), then emit scheduler_complete.
 */
async function completeTask(taskId, { report, toolCalls }) {
  const t = _tasks.get(taskId);
  if (!t) return false;

  t.status      = 'complete';
  t.remainingMs = 0;
  t.elapsedMs   = Date.now() - t.startedAt;

  // Inject the final report into the session so it persists.
  try {
    const { injectAssistantMessage } = require('./chat.controller');
    await injectAssistantMessage(t.sessionId, report, toolCalls || []);
  } catch (err) {
    logger.error(`[scheduler] Failed to inject report for ${taskId}`, err);
  }

  sendEvent(t.sessionId, {
    type:    'scheduler_complete',
    task_id: taskId,
  });

  logger.info(`[scheduler] Task ${taskId} complete`);
  _tasks.delete(taskId);
  return true;
}

/**
 * Cancel a running task (user-initiated or timeout).
 */
function cancelTask(taskId) {
  const t = _tasks.get(taskId);
  if (!t) return false;

  if (t.pid) {
    try { process.kill(t.pid, 'SIGTERM'); } catch {}
  }

  t.status = 'cancelled';
  sendEvent(t.sessionId, { type: 'scheduler_cancelled', task_id: taskId });
  logger.info(`[scheduler] Task ${taskId} cancelled`);
  _tasks.delete(taskId);
  return true;
}

function getTask(taskId) {
  return _tasks.get(taskId) || null;
}

function listTasksForUser(userId) {
  return Array.from(_tasks.values()).filter(t =>
    userId ? t.userId === userId : true
  );
}

module.exports = { registerTask, tickTask, completeTask, cancelTask, getTask, listTasksForUser };
