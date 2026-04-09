#!/usr/bin/env bash
set -euo pipefail

echo "=== DeeperSeek Bootstrap ==="

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Create required directories
echo "[1/5] Creating directories..."
mkdir -p workspace/jobs memory logs tmp uploads/{images,zips,files,raw}
mkdir -p memory
touch memory/short_term.json memory/long_term.json memory/event_log.json memory/agent_history.json
echo '{}' > memory/short_term.json 2>/dev/null || true
echo '{}' > memory/long_term.json 2>/dev/null || true
echo '[]' > memory/event_log.json 2>/dev/null || true
echo '[]' > memory/agent_history.json 2>/dev/null || true

# Check Python
echo "[2/5] Checking Python..."
if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found. Install Python 3.8+"
    exit 1
fi
PYTHON_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
echo "  Python: $PYTHON_VER"

# Install Python deps
echo "[3/5] Checking Python packages..."
python3 -c "import urllib.request, json, re, importlib, subprocess, tempfile" 2>/dev/null && \
    echo "  Core packages: OK" || echo "  Warning: some packages may be missing"

# Install pip packages if requirements.txt exists
if [ -f "requirements.txt" ]; then
    pip3 install -r requirements.txt --quiet
fi

# Check Node.js
echo "[4/5] Checking Node.js..."
if ! command -v node &>/dev/null; then
    echo "ERROR: node not found. Install Node.js 18+"
    exit 1
fi
NODE_VER=$(node --version)
echo "  Node.js: $NODE_VER"

# Install npm deps
echo "[5/5] Installing npm packages..."
if [ -f "package.json" ]; then
    npm install --quiet
fi
if [ -f "app/frontend/package.json" ]; then
    cd app/frontend && npm install --quiet && cd "$PROJECT_ROOT"
fi

echo ""
echo "=== Bootstrap Complete ==="
echo "Run: ./system/start.sh"
