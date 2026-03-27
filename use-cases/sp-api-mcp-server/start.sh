#!/bin/bash
set -e

PORT=${PORT:-3000}

echo "[start.sh] Starting MCP server on port $PORT..."
node build/index.js &
MCP_PID=$!

echo "[start.sh] Waiting for MCP server to be ready..."
until node -e "
fetch('http://localhost:$PORT/health')
  .then(r => { if(r.ok) process.exit(0); else process.exit(1); })
  .catch(() => process.exit(1));
" 2>/dev/null; do
  echo "[start.sh] MCP server not ready yet, retrying in 3s..."
  sleep 3
done

echo "[start.sh] MCP server is ready! Starting Slack bot..."
node slack-bot.js &
SLACK_PID=$!

wait -n $MCP_PID $SLACK_PID
kill $MCP_PID $SLACK_PID 2>/dev/null
