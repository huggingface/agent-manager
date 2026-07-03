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

# NOTE: every var exported below must be listed in NON_SECRET (server/src/
# index.js) — this script runs after the build-time env snapshot, so anything
# exported here would otherwise show up as a detected "secret" in Settings.

# Fast, EPHEMERAL local area for tools / Python envs / package caches. Never the
# /data bucket — object storage is slow for many-small-files and can't mmap or
# lock well, so running libraries from it is painful. These reinstall on demand.
export AM_LOCAL="/home/node/local"
if ! mkdir -p "$AM_LOCAL/bin" 2>/dev/null; then AM_LOCAL="$DATA_DIR/.local-cache"; mkdir -p "$AM_LOCAL/bin"; fi
export UV_CACHE_DIR="$AM_LOCAL/uv-cache"
export PIP_CACHE_DIR="$AM_LOCAL/pip-cache"
export PYTHONPYCACHEPREFIX="$AM_LOCAL/pycache"
export PYTHONUSERBASE="$AM_LOCAL/py"          # pip install --user → local, fast
export NPM_CONFIG_PREFIX="$AM_LOCAL/npm"       # npm install -g → local, no root needed
export PATH="$AM_LOCAL/py/bin:$AM_LOCAL/npm/bin:$AM_LOCAL/bin:$HOME/.local/bin:$PATH"

# OpenClaw: its session engine fingerprints file metadata at nanosecond
# precision and false-positives on the FUSE bucket ("session file changed while
# embedded prompt lock was released"). Its state therefore lives on LOCAL disk,
# with a durable copy on the bucket: restored on boot, synced back every 60s.
# Worst case on an unclean stop: the last minute of chat history.
export OPENCLAW_STATE_DIR="$AM_LOCAL/openclaw"
OPENCLAW_BACKUP="$DATA_DIR/state/openclaw-backup"
mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_BACKUP"
if [ -n "$(ls -A "$OPENCLAW_BACKUP" 2>/dev/null)" ]; then
  cp -a "$OPENCLAW_BACKUP/." "$OPENCLAW_STATE_DIR/" 2>/dev/null || true
elif [ -d "$HOME/.openclaw" ]; then
  # one-time migration from the old bucket location (kept in place untouched)
  cp -a "$HOME/.openclaw/." "$OPENCLAW_STATE_DIR/" 2>/dev/null || true
fi
( while :; do
    sleep 60
    rsync -a --delete "$OPENCLAW_STATE_DIR/" "$OPENCLAW_BACKUP/" 2>/dev/null || true
  done ) &

# Durable, user-editable setup script. Runs on EVERY start (keep it idempotent);
# seed a template on first boot.
if [ ! -f "$DATA_DIR/install.sh" ]; then
  cat > "$DATA_DIR/install.sh" <<'EOF'
#!/bin/sh
# Runs at Space startup on the fast LOCAL disk (not the /data bucket). Re-runs on
# every restart, so keep it idempotent. Log: /data/install.log
#
# Platform-provided vars: $AM_LOCAL (fast ephemeral root for tools/envs/caches),
# $UV_CACHE_DIR, $PIP_CACHE_DIR.
#
# Examples --------------------------------------------------------------------
# CLI tools (land on PATH, local + fast):
#   uv tool install ruff
#   pip install --user httpie
#   npm install -g prettier
#
# A project's Python env — build it on LOCAL disk from the workspace lockfile
# (never a .venv on the bucket). pyproject.toml/uv.lock stay in the workspace:
#   UV_PROJECT_ENVIRONMENT="$AM_LOCAL/envs/myproj" \
#     sh -c 'cd /data/workspaces/myproj && uv sync'
# -----------------------------------------------------------------------------
EOF
fi
# Run it BLOCKING so custom tools/envs are ready before any session starts —
# but bounded: a hung install (e.g. curl to a dead host) must not brick the
# Space with no UI to fix it. Log to a file and echo to the Space logs; capture
# the real exit code; continue regardless.
INSTALL_TIMEOUT="${INSTALL_TIMEOUT:-600}"
echo "Running $DATA_DIR/install.sh (blocking, ${INSTALL_TIMEOUT}s limit)…"
timeout "$INSTALL_TIMEOUT" sh "$DATA_DIR/install.sh" > "$DATA_DIR/install.log" 2>&1
INSTALL_CODE=$?
cat "$DATA_DIR/install.log"
if [ "$INSTALL_CODE" -eq 0 ]; then
  echo "[install.sh OK]"
elif [ "$INSTALL_CODE" -eq 124 ]; then
  echo "[install.sh TIMED OUT after ${INSTALL_TIMEOUT}s — starting anyway; fix it via the Files browser, see $DATA_DIR/install.log]"
else
  echo "[install.sh FAILED (exit $INSTALL_CODE) — starting anyway; fix it via the Files browser, see $DATA_DIR/install.log]"
fi
echo "[install.sh finished $(date -u) exit=$INSTALL_CODE]" >> "$DATA_DIR/install.log"

exec node /app/server/src/index.js
