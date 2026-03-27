#!/bin/bash
set -e

# Start MCP server in background
node build/index.js &
MCP_PID=$!

# Start Slack bot in foreground
node slack-bot.js &
SLACK_PID=$!

# Wait for either process to exit
wait -n $MCP_PID $SLACK_PID

# If one exits, kill the other
kill $MCP_PID $SLACK_PID 2>/dev/null
