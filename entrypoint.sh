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

# HOME remains the durable place for ordinary shell/user configuration. Agent
# harness state is relocated to local disk below and checkpointed explicitly:
# actively-mutated files and SQLite databases must not use the FUSE bucket as
# their live filesystem.
export HOME="$DATA_DIR/home"
mkdir -p "$HOME"

# NOTE: every var exported below must be listed in NON_SECRET (server/src/
# index.js) — this script runs after the build-time env snapshot, so anything
# exported here would otherwise show up as a detected "secret" in Settings.

# Fast, EPHEMERAL local area for tools / Python envs / package caches. Never the
# /data bucket — object storage is slow for many-small-files and can't mmap or
# lock well, so running libraries from it is painful. These reinstall on demand.
export AM_LOCAL="/home/node/local"
if ! mkdir -p "$AM_LOCAL/bin" 2>/dev/null; then
  # Never fall back onto the bucket: agent state needs POSIX close/locking
  # semantics even when the preferred local prefix is unavailable.
  AM_LOCAL="/tmp/agent-manager-local"
  mkdir -p "$AM_LOCAL/bin"
fi
export UV_CACHE_DIR="$AM_LOCAL/uv-cache"

# One state model for every harness:
#   * live files are ordinary local POSIX files under $AM_LOCAL;
#   * the bucket contains closed checkpoints only;
#   * SQLite checkpoints use the online backup API rather than racing copies
#     of a DB, WAL, and SHM.
#
# hf-mount's streaming writer buffers a long-lived append until close. Codex
# keeps its rollout open for the life of a session, so the old sessions symlink
# could lose the whole open epoch on a restart.
export CODEX_DURABLE="$DATA_DIR/state/codex"
export CODEX_HOME="$AM_LOCAL/codex-home"
export CLAUDE_DURABLE="$DATA_DIR/state/claude"
export CLAUDE_CONFIG_DIR="$AM_LOCAL/agent-state/claude"
export GEMINI_DURABLE="$DATA_DIR/state/gemini"
export GEMINI_CLI_HOME="$AM_LOCAL/agent-state/gemini-home"
export GEMINI_LIVE="$GEMINI_CLI_HOME/.gemini"
export OPENCLAW_HOME="$AM_LOCAL/oc-home"
export OPENCLAW_STATE_DIR="$OPENCLAW_HOME/.openclaw"
export OPENCLAW_DURABLE="$DATA_DIR/state/openclaw-backup"
export OPENCODE_LIVE="$AM_LOCAL/opencode-share"
export OPENCODE_DURABLE="$DATA_DIR/state/opencode"
export HERMES_LIVE="$AM_LOCAL/hermes"
export HERMES_DURABLE="$DATA_DIR/state/hermes"
# fx has no config-dir override at all — auth, settings and sessions are
# hardcoded to ~/.fx — so the symlink is the only way to keep it off the
# bucket. It must be: fx appends to a session's events.jsonl through one handle
# held open for the whole conversation, exactly the shape that loses its open
# epoch on the mount (see Codex above).
export FX_LIVE="$AM_LOCAL/fx-home"
export FX_DURABLE="$DATA_DIR/state/fx"

mkdir -p "$CODEX_HOME" "$CODEX_DURABLE/sessions" "$CODEX_DURABLE/db-backups" \
  "$CLAUDE_CONFIG_DIR" "$CLAUDE_DURABLE" "$GEMINI_LIVE" "$GEMINI_DURABLE" \
  "$OPENCLAW_STATE_DIR" "$OPENCLAW_DURABLE" "$OPENCODE_LIVE" \
  "$OPENCODE_DURABLE" "$HERMES_LIVE" "$HERMES_DURABLE" "$FX_LIVE" "$FX_DURABLE"

# Heal the old Codex layout on hot/dev restarts. Only unlink the known local
# sessions symlink; never recursively remove its durable target.
[ -L "$CODEX_HOME/sessions" ] && rm "$CODEX_HOME/sessions"
mkdir -p "$CODEX_HOME/sessions"

# Quarantine SQLite remnants from the old Codex bucket layout. Codex SQLite is
# disposable cache state; transcripts and user history are checkpointed.
mkdir -p "$CODEX_DURABLE/db-backups/am-quarantine"
for f in "$CODEX_DURABLE"/logs_2.sqlite* "$CODEX_DURABLE"/goals_1.sqlite* "$CODEX_DURABLE"/memories_1.sqlite*; do
  [ -e "$f" ] || [ -L "$f" ] && mv "$f" "$CODEX_DURABLE/db-backups/am-quarantine/" 2>/dev/null || true
done

# Preserve existing Gemini state while moving it out of durable HOME. The
# legacy directory remains in place as a rollback copy.
if [ -d "$HOME/.gemini" ] && [ ! -L "$HOME/.gemini" ]; then
  if ! rsync -a --update "$HOME/.gemini/" "$GEMINI_DURABLE/"; then
    echo "ERROR: could not migrate Gemini state; refusing to start with an empty live home" >&2
    exit 1
  fi
fi

# OpenClaw rejects a symlinked HOME/state path; migrate any state from the
# earlier layouts into its durable checkpoint before restore.
[ -L "$HOME/.openclaw" ] && rm "$HOME/.openclaw"
for legacy in "$HOME/.openclaw.pre-symlink" "$HOME/.openclaw"; do
  if [ -d "$legacy" ] && [ ! -L "$legacy" ]; then
    if ! rsync -a --update "$legacy/" "$OPENCLAW_DURABLE/"; then
      echo "ERROR: could not migrate OpenClaw state from $legacy" >&2
      exit 1
    fi
  fi
done

# opencode, Hermes and fx expect their state at paths under HOME. The live
# targets are local; legacy real directories are retained as rollback copies
# instead of being deleted during migration.
OPENCODE_LINK="$HOME/.local/share/opencode"
HERMES_LINK="$HOME/.hermes"
FX_LINK="$HOME/.fx"
mkdir -p "$(dirname "$OPENCODE_LINK")"
for pair in "$OPENCODE_LINK|$OPENCODE_DURABLE" "$HERMES_LINK|$HERMES_DURABLE" \
  "$FX_LINK|$FX_DURABLE"; do
  lnk="${pair%%|*}"; dur="${pair##*|}"
  if [ -e "$lnk" ] && [ ! -L "$lnk" ]; then
    if ! rsync -a --update "$lnk/" "$dur/"; then
      echo "ERROR: could not migrate agent state from $lnk" >&2
      exit 1
    fi
    backup="$lnk.pre-agent-state"
    if [ -e "$backup" ] || [ -L "$backup" ]; then
      backup="$backup.$(date -u +%Y%m%dT%H%M%SZ).$$"
    fi
    if ! mv "$lnk" "$backup"; then
      echo "ERROR: could not retain rollback copy at $backup" >&2
      exit 1
    fi
  fi
done
ln -sfn "$OPENCODE_LIVE" "$OPENCODE_LINK"
ln -sfn "$HERMES_LIVE" "$HERMES_LINK"
ln -sfn "$FX_LIVE" "$FX_LINK"

# Restore after all one-time migrations have populated the durable side. On a
# hot/dev restart, --update preserves newer local state.
AGENT_STATE_SCRIPT="${AGENT_STATE_SCRIPT:-/app/scripts/agent-state.sh}"
export AGENT_STATE_SCRIPT
if ! sh "$AGENT_STATE_SCRIPT" restore; then
  echo "ERROR: agent-state restore was incomplete; refusing to start agents against partial state" >&2
  exit 1
fi

# Small comforts in OpenClaw's private HOME (harmless if missing).
cp "$HOME/.gitconfig" "$OPENCLAW_HOME/.gitconfig" 2>/dev/null || true
export PIP_CACHE_DIR="$AM_LOCAL/pip-cache"
export PYTHONPYCACHEPREFIX="$AM_LOCAL/pycache"
export PYTHONUSERBASE="$AM_LOCAL/py"          # pip install --user → local, fast
export NPM_CONFIG_PREFIX="$AM_LOCAL/npm"       # npm install -g → local, no root needed
export PATH="$AM_LOCAL/py/bin:$AM_LOCAL/npm/bin:$AM_LOCAL/bin:$HOME/.local/bin:$PATH"

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

# Keep PID 1 as a tiny supervisor so normal Space/dev restarts receive a final
# state checkpoint. The timer bounds loss on an ungraceful stop; the child is
# stopped before the final checkpoint so SQLite and transcript state is quiet.
AGENT_STATE_CHECKPOINT_SECONDS="${AGENT_STATE_CHECKPOINT_SECONDS:-15}"
node /app/server/src/index.js &
APP_PID=$!

checkpoint_loop() {
  while kill -0 "$APP_PID" 2>/dev/null; do
    sleep "$AGENT_STATE_CHECKPOINT_SECONDS"
    kill -0 "$APP_PID" 2>/dev/null || break
    sh "$AGENT_STATE_SCRIPT" checkpoint \
      || echo "WARN: periodic agent-state checkpoint failed"
  done
}
checkpoint_loop &
CHECKPOINT_PID=$!

finish() {
  code="${1:-0}"
  kill "$CHECKPOINT_PID" 2>/dev/null || true
  wait "$CHECKPOINT_PID" 2>/dev/null || true
  # A timer checkpoint may still be finishing after its loop shell is stopped.
  # checkpoint-final waits for that lock, then captures the quiet post-Node
  # state instead of silently treating a busy lock as success.
  sh "$AGENT_STATE_SCRIPT" checkpoint-final \
    || echo "WARN: final agent-state checkpoint failed"
  exit "$code"
}

shutdown() {
  trap - TERM INT HUP
  kill -TERM "$APP_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null
  code=$?
  finish "$code"
}
trap shutdown TERM INT HUP

wait "$APP_PID"
APP_CODE=$?
finish "$APP_CODE"
