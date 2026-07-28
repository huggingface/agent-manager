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

# Empty directories do NOT persist on the bucket — there is no backing object
# key, so a dir created empty is gone after a restart, and anything pointing at
# it (a symlink, a config path) breaks. `keepdir` occupies the path with a real
# file so it survives. Use it for every bucket-backed dir created empty.
#   Seen in the wild: $CODEX_DURABLE/sessions vanished, leaving
#   $CODEX_HOME/sessions dangling -> codex "thread-store internal error:
#   File exists (os error 17)" and every transcript lost.
keepdir() {
  for d in "$@"; do
    mkdir -p "$d" 2>/dev/null || continue
    [ -e "$d/.keep" ] || echo "keep marker: empty dirs are not persisted on the /data bucket" > "$d/.keep" 2>/dev/null || true
  done
}

# Occupy a config path with a real file when nothing lives there. Two bugs need
# this. (1) A tool that writes atomically (temp + rename) can leave the temp
# behind and never land the target. (2) The bucket tree API then matches
# `<path>` against the leftover `<path>.<uuid>.tmp` by RAW STRING PREFIX, and
# hf-mount reads a non-empty listing as proof the path is a DIRECTORY — so the
# missing file materializes as a phantom dir and readers die with EISDIR.
# A real file short-circuits it: the HEAD succeeds, so the listing fallback that
# synthesizes the directory never runs. See docs/fuse-phantom-directories.md.
occupy_file() {
  path="$1"; default="$2"
  mkdir -p "$(dirname "$path")" 2>/dev/null || return 0
  [ -d "$path" ] && rm -rf "$path" 2>/dev/null
  [ -e "$path" ] || printf '%s\n' "$default" > "$path" 2>/dev/null || true
}

# Put HOME on the durable bucket so EVERY agent's logins/config persist across
# restarts (gemini ~/.gemini, etc.). Agents whose SQLite state can't live on the
# FUSE bucket (codex, openclaw, opencode, hermes) are relocated to local disk
# below, each with its own durable copy on the bucket.
export HOME="$DATA_DIR/home"
mkdir -p "$HOME"
# Gemini writes its project registry atomically and the rename can fail on the
# bucket, leaving projects.json.<uuid>.tmp orphans and no projects.json — after
# which the prefix bug above turns projects.json into a directory and the CLI
# dies with `EISDIR: illegal operation on a directory, read`. Keep a real file
# there. Same class as the opencode.json guard in server/src/runner.js.
occupy_file "$HOME/.gemini/projects.json" '{"projects": {}}'
# Claude keeps its established dir (so existing logins keep working). Codex's
# home moves to local disk below (its SQLite databases corrupt on the bucket).
export CLAUDE_CONFIG_DIR="$DATA_DIR/state/claude"
mkdir -p "$CLAUDE_CONFIG_DIR"

# NOTE: every var exported below must be listed in NON_SECRET (server/src/
# index.js) — this script runs after the build-time env snapshot, so anything
# exported here would otherwise show up as a detected "secret" in Settings.

# Fast, EPHEMERAL local area for tools / Python envs / package caches. Never the
# /data bucket — object storage is slow for many-small-files and can't mmap or
# lock well, so running libraries from it is painful. These reinstall on demand.
export AM_LOCAL="/home/node/local"
if ! mkdir -p "$AM_LOCAL/bin" 2>/dev/null; then AM_LOCAL="$DATA_DIR/.local-cache"; mkdir -p "$AM_LOCAL/bin"; fi
export UV_CACHE_DIR="$AM_LOCAL/uv-cache"

# Codex keeps a growing family of SQLite databases (logs_2, goals_1, memories_1
# plus mmap'd -shm siblings) that corrupt on the FUSE bucket: SQLite needs real
# locking/mmap. Same cure as OpenClaw — codex's HOME lives on LOCAL disk. The
# heavyweight append-only rollouts stay on the bucket via one symlink (plain
# files never corrupted there, and pinned rollout paths keep working); the
# small durable state (auth, config, history) restores at boot and syncs back
# every 60s; the SQLite caches are purely local, rebuilt from rollouts when
# the disk resets.
CODEX_DURABLE="$DATA_DIR/state/codex"
export CODEX_HOME="$AM_LOCAL/codex-home"
mkdir -p "$CODEX_HOME"
# keepdir, not mkdir: `sessions` is the symlink target below, and an empty dir
# on the bucket disappears — which is exactly how codex lost its thread store.
keepdir "$CODEX_DURABLE/sessions" "$CODEX_DURABLE/db-backups"
# quarantine sqlite remnants on the bucket (incl. the earlier symlink attempt)
keepdir "$CODEX_DURABLE/db-backups/am-quarantine"
for f in "$CODEX_DURABLE"/logs_2.sqlite* "$CODEX_DURABLE"/goals_1.sqlite* "$CODEX_DURABLE"/memories_1.sqlite*; do
  [ -e "$f" ] || [ -L "$f" ] && mv "$f" "$CODEX_DURABLE/db-backups/am-quarantine/" 2>/dev/null || true
done
rsync -a --exclude 'sessions' --exclude '*.sqlite*' --exclude 'db-backups' \
  --exclude 'cache' --exclude '.tmp' --exclude 'mcp-oauth-locks' \
  "$CODEX_DURABLE/" "$CODEX_HOME/" 2>/dev/null || true
ln -sfn "$CODEX_DURABLE/sessions" "$CODEX_HOME/sessions"
( while :; do
    sleep 60
    rsync -a --exclude 'sessions' --exclude '*.sqlite*' --exclude 'db-backups' \
      --exclude 'cache' --exclude '.tmp' --exclude 'mcp-oauth-locks' \
      "$CODEX_HOME/" "$CODEX_DURABLE/" 2>/dev/null || true
  done ) &
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
# OpenClaw can't run its state on the FUSE bucket (its session fence
# false-positives on unstable metadata) and it REJECTS symlinked paths (the
# workspace boundary check). No symlinks, no env overrides — OpenClaw simply
# gets its OWN HOME on local disk: a real, ordinary install from its point of
# view. Durable copy on the bucket: restored on boot, synced back every 60s.
# Worst case on an unclean stop: the last minute of claw state.
export OPENCLAW_HOME="$AM_LOCAL/oc-home"                # runner launches openclaw with HOME=$OPENCLAW_HOME
export OPENCLAW_STATE_DIR="$OPENCLAW_HOME/.openclaw"    # where the server finds its config/traces
OC_BACKUP="$DATA_DIR/state/openclaw-backup"
mkdir -p "$OPENCLAW_STATE_DIR" "$OC_BACKUP"
# heal from the earlier symlink experiment
[ -L "$HOME/.openclaw" ] && rm "$HOME/.openclaw"
# seed local state: backup (freshest) first, then legacy dirs fill gaps (--update: never clobber newer)
[ -n "$(ls -A "$OC_BACKUP" 2>/dev/null)" ] && rsync -a "$OC_BACKUP/" "$OPENCLAW_STATE_DIR/" 2>/dev/null
for legacy in "$HOME/.openclaw.pre-symlink" "$HOME/.openclaw"; do
  if [ -d "$legacy" ] && [ ! -L "$legacy" ]; then
    rsync -a --update "$legacy/" "$OPENCLAW_STATE_DIR/" 2>/dev/null || true
  fi
done
# small comforts in the private HOME (harmless if missing)
cp "$HOME/.gitconfig" "$OPENCLAW_HOME/.gitconfig" 2>/dev/null || true
( while :; do
    sleep 60
    rsync -a --delete "$OPENCLAW_STATE_DIR/" "$OC_BACKUP/" 2>/dev/null || true
  done ) &

# opencode + hermes keep their conversation history in SQLite (opencode at
# ~/.local/share/opencode, hermes at ~/.hermes). SQLite on the FUSE bucket
# corrupts, and worse: a SYNCHRONOUS read can STALL on FUSE and wedge the
# server's event loop — the Overview reads these dbs on every poll, so one
# stalled read takes the whole Space down. The live data therefore lives on
# LOCAL disk, exposed at the well-known path via a symlink, with a durable copy
# on the bucket: restored on boot, synced back every 60s. Unlike codex these
# dbs ARE the source of truth (no rollout files to rebuild from), so the
# sync-back INCLUDES the sqlite. Worst case on an unclean stop: the last minute
# of chat history.
OC_LIVE="$AM_LOCAL/opencode-share"; OC_DURABLE="$DATA_DIR/state/opencode"; OC_LINK="$HOME/.local/share/opencode"
HERMES_LIVE="$AM_LOCAL/hermes"; HERMES_DURABLE="$DATA_DIR/state/hermes"; HERMES_LINK="$HOME/.hermes"
mkdir -p "$OC_LIVE" "$HERMES_LIVE" "$(dirname "$OC_LINK")"
keepdir "$OC_DURABLE" "$HERMES_DURABLE"
# One-time migration: existing history is a REAL dir at the well-known path on
# the bucket. Fold it into the durable store BEFORE the path becomes a symlink,
# so no conversation is stranded on the bucket or lost.
for pair in "$OC_LINK|$OC_DURABLE" "$HERMES_LINK|$HERMES_DURABLE"; do
  lnk="${pair%%|*}"; dur="${pair##*|}"
  if [ -e "$lnk" ] && [ ! -L "$lnk" ]; then
    rsync -a "$lnk/" "$dur/" 2>/dev/null || true
    rm -rf "$lnk" 2>/dev/null || true
  fi
done
rsync -a "$OC_DURABLE/" "$OC_LIVE/" 2>/dev/null || true       # restore durable → live (local disk is wiped each boot)
rsync -a "$HERMES_DURABLE/" "$HERMES_LIVE/" 2>/dev/null || true
ln -sfn "$OC_LIVE" "$OC_LINK"
ln -sfn "$HERMES_LIVE" "$HERMES_LINK"
( while :; do
    sleep 60
    rsync -a "$OC_LIVE/" "$OC_DURABLE/" 2>/dev/null || true
    rsync -a "$HERMES_LIVE/" "$HERMES_DURABLE/" 2>/dev/null || true
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
