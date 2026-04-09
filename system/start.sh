#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Load .env if present
if [ -f ".env" ]; then
    export $(grep -v '^#' .env | xargs)
fi

: "${PORT:=3000}"
: "${NODE_ENV:=production}"

echo "=== Starting DeeperSeek ==="
echo "  Backend port: $PORT"
echo "  Environment: $NODE_ENV"

# Use PM2 if available, else direct node
if command -v pm2 &>/dev/null && [ "$NODE_ENV" = "production" ]; then
    echo "  Using PM2..."
    pm2 start infra/pm2/ecosystem.config.js --env production
    pm2 logs --lines 20
else
    echo "  Starting directly..."
    node app/backend/server.js
fi
