'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');

const { initWebSocket } = require('./websocket');
const routes = require('./routes');
const logger = require('./logger');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// API routes
app.use('/api', routes);

// Serve frontend static files
const frontendDist = path.join(__dirname, '../frontend/dist');
const frontendRoot = path.join(__dirname, '../frontend');
try {
  require('fs').accessSync(frontendDist);
  app.use(express.static(frontendDist));
  // Named pages served before the SPA catch-all
  app.get('/welcome', (req, res) => res.sendFile(path.join(frontendDist, 'welcome.html')));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(frontendDist, 'index.html'));
    }
  });
} catch {
  // Serve raw frontend if not built
  app.use(express.static(frontendRoot));
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', uptime: process.uptime() });
});

// WebSocket
initWebSocket(server);

// Start
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`DeeperSeek running on http://0.0.0.0:${PORT} [${NODE_ENV}]`);
  logger.info(`WebSocket available at ws://0.0.0.0:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down');
  server.close(() => process.exit(0));
});

module.exports = { app, server };
