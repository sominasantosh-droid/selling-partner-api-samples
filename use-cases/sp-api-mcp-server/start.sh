#!/bin/bash
set -e

echo "[start.sh] Starting MCP server..."
node build/index.js &
MCP_PID=$!

echo "[start.sh] Starting Slack bot..."
node slack-bot.js &
SLACK_PID=$!

# Exit if either process dies
wait -n $MCP_PID $SLACK_PID
kill $MCP_PID $SLACK_PID 2>/dev/null
