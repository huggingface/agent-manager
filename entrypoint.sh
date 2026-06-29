#!/bin/sh
# Resolve a writable durable root. /data is the mounted bucket; fall back to a
# local (non-persistent) dir so the Space still boots before a bucket is attached.
DATA_DIR="${DATA_DIR:-/data}"
if ! mkdir -p "$DATA_DIR/workspaces" 2>/dev/null; then
  echo "WARN: $DATA_DIR is not writable — running EPHEMERAL (sessions/logins reset on restart)."
  echo "      For durability, attach a private Storage Bucket mounted read-write at /data."
  DATA_DIR="$HOME/data"
  mkdir -p "$DATA_DIR/workspaces"
fi
export DATA_DIR

# Put HOME on the durable bucket so EVERY agent's logins/config persist across
# restarts (gemini ~/.gemini, opencode ~/.local/share, hermes ~/.hermes, etc.).
export HOME="$DATA_DIR/home"
mkdir -p "$HOME"
# Claude/Codex keep their established dirs (so existing logins keep working).
export CLAUDE_CONFIG_DIR="$DATA_DIR/state/claude"
export CODEX_HOME="$DATA_DIR/state/codex"
mkdir -p "$CLAUDE_CONFIG_DIR" "$CODEX_HOME"

exec node /app/server/src/index.js
