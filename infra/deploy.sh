#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== DeeperSeek Deploy ==="

# Pull latest
echo "[1/4] Pulling latest..."
git pull origin claude/deepseek-agent-tool-mQzLG

# Install deps
echo "[2/4] Installing dependencies..."
npm install
cd app/frontend && npm install && npm run build && cd "$PROJECT_ROOT"

# Restart PM2
echo "[3/4] Restarting service..."
if pm2 list | grep -q deeperseek; then
    pm2 reload deeperseek
else
    pm2 start infra/pm2/ecosystem.config.js --env production
fi

echo "[4/4] Saving PM2 state..."
pm2 save

echo ""
echo "=== Deploy Complete ==="
pm2 status deeperseek
