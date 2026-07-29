#!/bin/sh
set -e

# Durable root. /data is the mounted bucket; fall back to a local dir so the
# Space still boots (ephemerally) before a bucket is attached.
DATA_DIR="${DATA_DIR:-/data}"
if ! mkdir -p "$DATA_DIR/workspaces" 2>/dev/null; then
  echo "WARN: $DATA_DIR not writable — running EPHEMERAL (Claude login resets on restart)."
  DATA_DIR="$HOME/data"
  mkdir -p "$DATA_DIR/workspaces"
fi
export DATA_DIR

# HOME and Claude's config on the bucket, so a login survives rebuilds — same
# arrangement agent-manager uses.
export HOME="$DATA_DIR/home"
export CLAUDE_CONFIG_DIR="$DATA_DIR/state/claude"
mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR" "$DATA_DIR/state"

SEED=/app/seed

# One workspace per panel. Both get the same seed so the two sessions start from
# identical context; --ignore-existing means the agent's own edits survive.
for dir in the-gatherer-a the-gatherer-b; do
  target="$DATA_DIR/workspaces/$dir"
  mkdir -p "$target/memory"
  cp -n "$SEED/workspace/CLAUDE.md" "$target/CLAUDE.md" 2>/dev/null || true
  cp -n "$SEED/memory/"*.md "$target/memory/" 2>/dev/null || true

  # Also drop the memories where Claude Code looks for per-project memory, so
  # they load whether or not the CLI reads the in-workspace copy. The project
  # slug is the absolute path with separators replaced by dashes.
  slug=$(printf '%s' "$target" | tr '/' '-')
  mkdir -p "$CLAUDE_CONFIG_DIR/projects/$slug/memory"
  cp -n "$SEED/memory/"*.md "$CLAUDE_CONFIG_DIR/projects/$slug/memory/" 2>/dev/null || true
done

if [ -z "$ANTHROPIC_API_KEY" ] && [ ! -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then
  echo "NOTE: no ANTHROPIC_API_KEY and no stored Claude login."
  echo "      Both panels will show Claude's login prompt — log in once in either one."
fi

cd /app/server
exec node src/index.js
