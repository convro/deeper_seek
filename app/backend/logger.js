'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../../logs');

function ensureLogDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

function fmt(level, msg) {
  return `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
}

function write(filename, line) {
  ensureLogDir();
  try {
    fs.appendFileSync(path.join(LOG_DIR, filename), line + '\n');
  } catch {}
}

const logger = {
  debug: (msg) => {
    const line = fmt('debug', msg);
    if (process.env.NODE_ENV !== 'production') console.log(line);
    write('system.log', line);
  },
  info: (msg) => {
    const line = fmt('info', msg);
    console.log(line);
    write('system.log', line);
  },
  warn: (msg) => {
    const line = fmt('warn', msg);
    console.warn(line);
    write('system.log', line);
  },
  error: (msg, err) => {
    const detail = err ? `\n  ${err.stack || err}` : '';
    const line = fmt('error', msg + detail);
    console.error(line);
    write('system.log', line);
    write('error.log', line);
  },
  agent: (msg) => {
    const line = fmt('agent', msg);
    console.log(line);
    write('agent.log', line);
  },
  tool: (msg) => {
    const line = fmt('tool', msg);
    write('tool.log', line);
  },
  ws: (msg) => {
    const line = fmt('ws', msg);
    write('websocket.log', line);
  },
};

module.exports = logger;
