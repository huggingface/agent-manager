#!/bin/sh
# Durable state bridge for the agent harnesses.
#
# Active state always lives on the container's POSIX filesystem. The mounted
# bucket only receives short-lived, closed writes made by rsync (ordinary file
# trees) or SQLite's online backup API (live databases). This is intentional:
# hf-mount's streaming writer holds an open file in memory until close, while
# copying a database and its WAL independently can produce a torn backup.

set -u

MODE="${1:-}"
case "$MODE" in
  restore|checkpoint|checkpoint-final) ;;
  *) echo "usage: $0 restore|checkpoint|checkpoint-final" >&2; exit 2 ;;
esac

: "${DATA_DIR:?DATA_DIR is required}"
: "${AM_LOCAL:?AM_LOCAL is required}"

CODEX_HOME="${CODEX_HOME:-$AM_LOCAL/codex-home}"
CODEX_DURABLE="${CODEX_DURABLE:-$DATA_DIR/state/codex}"
CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$AM_LOCAL/agent-state/claude}"
CLAUDE_DURABLE="${CLAUDE_DURABLE:-$DATA_DIR/state/claude}"
GEMINI_CLI_HOME="${GEMINI_CLI_HOME:-$AM_LOCAL/agent-state/gemini-home}"
GEMINI_LIVE="${GEMINI_LIVE:-$GEMINI_CLI_HOME/.gemini}"
GEMINI_DURABLE="${GEMINI_DURABLE:-$DATA_DIR/state/gemini}"
OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$AM_LOCAL/oc-home/.openclaw}"
OPENCLAW_DURABLE="${OPENCLAW_DURABLE:-$DATA_DIR/state/openclaw-backup}"
OPENCODE_LIVE="${OPENCODE_LIVE:-$AM_LOCAL/opencode-share}"
OPENCODE_DURABLE="${OPENCODE_DURABLE:-$DATA_DIR/state/opencode}"
HERMES_LIVE="${HERMES_LIVE:-$AM_LOCAL/hermes}"
HERMES_DURABLE="${HERMES_DURABLE:-$DATA_DIR/state/hermes}"
# fx keeps its coordination files beside the transcripts it must never lose.
# session.lock / commit.lock / subagent/*.lock name a live process, so a
# restored one is a lock nobody holds; index.pending is a half-written index fx
# rebuilds. Everything else under ~/.fx — auth, settings.json, mcp.json,
# memories.json, sessions/*/events.jsonl — has to come back after a restart.
# Both directions carry the excludes, so an older durable tree written before
# they existed cannot hand a stale lock back on restore.
FX_LIVE="${FX_LIVE:-$AM_LOCAL/fx-home}"
FX_DURABLE="${FX_DURABLE:-$DATA_DIR/state/fx}"

LOCK="$AM_LOCAL/agent-state-checkpoint.lock"
mkdir -p "$AM_LOCAL"
exec 9>"$LOCK"
if [ "$MODE" = restore ] || [ "$MODE" = checkpoint-final ]; then
  # A dev-mode restart may overlap the previous app's final checkpoint. Never
  # restore an older durable view while that checkpoint is still being made.
  flock 9
else
  # Timer and shutdown checkpoints can race; the one already holding the lock
  # is sufficient, and a later timer/shutdown will catch subsequent writes.
  flock -n 9 || exit 0
fi

# `find -newer` is a strict comparison. A file written in the same filesystem
# timestamp tick as a checkpoint marker would otherwise be skipped forever.
# Keep a small overlap at every successful boundary; an occasional repeat copy
# is harmless, while a missed transcript/config is not.
mark_checkpoint_floor() {
  touch -d '2 seconds ago' "$1" 2>/dev/null || touch "$1"
}

# rsync exit 24 is "partial transfer due to vanished source files": between
# building its file list and reading them, something deleted files the listing
# still named. Both tree copies are exposed to it — a restore walks the bucket
# for minutes while a harness prunes transcript scratch, and a checkpoint copies
# a live tree the harnesses are still writing. What vanishes is the scratch
# itself, so nothing durable is lost and the copy is otherwise complete.
# Treating it as a failure once refused to boot the Space at all.
# Single-file copies below keep the strict test: there, a vanished source is
# exactly the file we were asked for.
rsync_tree() {
  rsync "$@"; _rs_rc=$?
  [ "$_rs_rc" -eq 24 ] && _rs_rc=0
  return "$_rs_rc"
}

restore_tree() {
  key="$1" durable="$2" live="$3"; shift 3
  mkdir -p "$durable" "$live"
  stamp_dir="$AM_LOCAL/agent-state-stamps"
  stamp="$stamp_dir/$key"
  had_local=false
  [ -n "$(find "$live" -type f -print -quit 2>/dev/null)" ] && had_local=true
  # --update matters for hot/dev restarts: local disk survives those and can be
  # newer than the last completed bucket checkpoint. A fresh container starts
  # with an empty destination, so the same command performs a full restore.
  if rsync_tree -a --update "$@" "$durable/" "$live/"; then
    mkdir -p "$stamp_dir"
    if [ ! -e "$stamp" ]; then
      if [ "$had_local" = true ]; then
        # First deployment over an already-populated local tree: force one
        # checkpoint so newer local files skipped by --update become durable.
        touch -t 197001010000 "$stamp"
      else
        # Fresh container: every local byte came from this durable restore.
        mark_checkpoint_floor "$stamp"
      fi
    fi
  else
    return 1
  fi
}

checkpoint_tree() {
  key="$1" live="$2" durable="$3"; shift 3
  [ -d "$live" ] || return 0
  stamp_dir="$AM_LOCAL/agent-state-stamps"
  mkdir -p "$durable" "$stamp_dir"
  stamp="$stamp_dir/$key"
  if [ ! -e "$stamp" ]; then
    touch -t 197001010000 "$stamp"
  fi

  # Mark the START of this checkpoint. Any file changed during/after its copy
  # is newer than `next` and will therefore be selected again next time.
  next="$stamp.next.$$"
  list="$stamp.files.$$"
  mark_checkpoint_floor "$next"
  (cd "$live" && find . -type f -newer "$stamp" -print0) > "$list"

  if [ -s "$list" ]; then
    # --files-from means rsync walks only changed LOCAL paths. It does not scan
    # the remote tree every 15 seconds — a critical property on the bucket
    # mount. Destination temporaries close before rename, retaining the prior
    # object if this process dies during transfer.
    if ! rsync_tree -a -r --from0 --files-from="$list" --delay-updates \
      "$@" "$live/" "$durable/"; then
      rm -f "$next" "$list"
      return 1
    fi
  fi
  mv "$next" "$stamp"
  rm -f "$list"
}

restore_sqlite_tree() {
  durable="$1" live="$2" db_name="$3" checkpoint_name="$4"
  mkdir -p "$durable" "$live"

  if ! restore_tree "$checkpoint_name-files" "$durable" "$live" \
    --exclude 'checkpoints' --exclude '*.db' --exclude '*.db-*' \
    --exclude '*.sqlite*' --exclude '*-wal' --exclude '*-shm'; then
    return 1
  fi

  checkpoint="$durable/checkpoints/$checkpoint_name"
  target="$live/$db_name"
  if [ -s "$target" ] && [ "$(sqlite3 "$target" 'PRAGMA quick_check;' 2>/dev/null)" = ok ]; then
    # Local disk survives in-container/dev restarts. Its database can be newer
    # than the last checkpoint (including committed rows still in its WAL), so
    # a valid live database is always the restore authority on a hot restart.
    return 0
  fi

  # Retain an invalid local set for diagnosis, then recover from the last
  # known-good checkpoint. These are explicit ephemeral paths, never bucket
  # objects.
  had_invalid=false
  if [ -e "$target" ] || [ -e "$target-wal" ] || [ -e "$target-shm" ]; then
    had_invalid=true
    invalid_dir="$AM_LOCAL/agent-state-invalid/$checkpoint_name.$(date -u +%Y%m%dT%H%M%SZ).$$"
    mkdir -p "$invalid_dir"
    [ -e "$target" ] && mv "$target" "$invalid_dir/$db_name"
    [ -e "$target-wal" ] && mv "$target-wal" "$invalid_dir/$db_name-wal"
    [ -e "$target-shm" ] && mv "$target-shm" "$invalid_dir/$db_name-shm"
  fi

  if [ -s "$checkpoint" ]; then
    # WAL/SHM are ephemeral coordination files, never part of a restored
    # checkpoint. Removing these explicit local paths cannot touch bucket data.
    rm -f "$target-wal" "$target-shm"
    if ! rsync -a "$checkpoint" "$target"; then return 1; fi
  elif [ -s "$durable/$db_name" ]; then
    # One-release compatibility path for state written by the old raw-rsync
    # mechanism. Copy the legacy DB and any WAL so SQLite can recover it; the
    # first successful checkpoint replaces this path as the restore authority.
    if ! rsync -a "$durable/$db_name" "$target"; then return 1; fi
    if [ -f "$durable/$db_name-wal" ] && ! rsync -a "$durable/$db_name-wal" "$target-wal"; then return 1; fi
    if [ -f "$durable/$db_name-shm" ] && ! rsync -a "$durable/$db_name-shm" "$target-shm"; then return 1; fi
  fi

  if [ "$had_invalid" = true ] && [ ! -s "$target" ]; then
    echo "agent-state: invalid local SQLite state has no durable recovery for $target" >&2
    return 1
  fi
  if [ -s "$target" ] && [ "$(sqlite3 "$target" 'PRAGMA quick_check;' 2>/dev/null)" != ok ]; then
    echo "agent-state: restored SQLite state is invalid for $target" >&2
    return 1
  fi
}

checkpoint_sqlite_tree() {
  live="$1" durable="$2" db_name="$3" checkpoint_name="$4"
  source="$live/$db_name"

  # A harness can write ordinary state before it creates its database (Hermes
  # setup files are a real example). Always publish that file tree first. The
  # database backup is optional until the database itself exists.
  if ! checkpoint_tree "$checkpoint_name-files" "$live" "$durable" \
    --exclude 'checkpoints' --exclude '*.db' --exclude '*.db-*' \
    --exclude '*.sqlite*' --exclude '*-wal' --exclude '*-shm'; then
    return 1
  fi
  [ -s "$source" ] || return 0

  sqlite_stamp_dir="$AM_LOCAL/agent-state-stamps"
  sqlite_stamp="$sqlite_stamp_dir/$checkpoint_name-sqlite"
  mkdir -p "$sqlite_stamp_dir"
  # Timestamp-only detection has an equal-tick hole, while deliberately
  # overlapping the marker would rewrite an idle database on rapid successive
  # checkpoints. Record the exact local DB/WAL metadata observed BEFORE the
  # backup instead. A concurrent commit changes the next signature and is
  # therefore picked up by the following checkpoint.
  sqlite_next="$sqlite_stamp.next.$$"
  {
    stat -c 'db|%s|%y|%z' "$source"
    if [ -e "$source-wal" ]; then
      stat -c 'wal|%s|%y|%z' "$source-wal"
    else
      echo 'wal|absent'
    fi
  } > "$sqlite_next"
  if cmp -s "$sqlite_next" "$sqlite_stamp"; then
    rm -f "$sqlite_next"
    return 0
  fi

  stage_dir="$AM_LOCAL/agent-state-snapshots"
  mkdir -p "$stage_dir" "$durable/checkpoints"
  staged="$stage_dir/$checkpoint_name.$$.tmp"
  rm -f "$staged"
  escaped=$(printf '%s' "$staged" | sed "s/'/''/g")

  # .backup observes the main DB and WAL through one consistent SQLite read
  # transaction. The staged file is ordinary local storage and is closed before
  # rsync hands it to the bucket.
  if ! sqlite3 "$source" ".timeout 5000" ".backup '$escaped'"; then
    rm -f "$staged" "$sqlite_next"
    return 1
  fi
  if [ "$(sqlite3 "$staged" 'PRAGMA quick_check;' 2>/dev/null)" != ok ]; then
    echo "agent-state: refusing invalid SQLite checkpoint for $source" >&2
    rm -f "$staged" "$sqlite_next"
    return 1
  fi
  if ! rsync -a --delay-updates "$staged" "$durable/checkpoints/$checkpoint_name"; then
    rm -f "$staged" "$sqlite_next"
    return 1
  fi
  rm -f "$staged"
  mv "$sqlite_next" "$sqlite_stamp"
}

failures=0

if [ "$MODE" = restore ]; then
  restore_tree codex "$CODEX_DURABLE" "$CODEX_HOME" \
    --exclude '*.sqlite*' --exclude '*.db' --exclude '*.db-*' \
    --exclude '*-wal' --exclude '*-shm' --exclude 'db-backups' \
    --exclude 'cache' --exclude '.tmp' --exclude 'mcp-oauth-locks' || failures=$((failures + 1))
  restore_tree claude "$CLAUDE_DURABLE" "$CLAUDE_CONFIG_DIR" || failures=$((failures + 1))
  restore_tree gemini "$GEMINI_DURABLE" "$GEMINI_LIVE" || failures=$((failures + 1))
  restore_tree openclaw "$OPENCLAW_DURABLE" "$OPENCLAW_STATE_DIR" || failures=$((failures + 1))
  restore_sqlite_tree "$OPENCODE_DURABLE" "$OPENCODE_LIVE" opencode.db opencode.db || failures=$((failures + 1))
  restore_sqlite_tree "$HERMES_DURABLE" "$HERMES_LIVE" state.db state.db || failures=$((failures + 1))
  restore_tree fx "$FX_DURABLE" "$FX_LIVE" \
    --exclude '*.lock' --exclude 'index.pending' || failures=$((failures + 1))
else
  checkpoint_tree codex "$CODEX_HOME" "$CODEX_DURABLE" \
    --exclude '*.sqlite*' --exclude '*.db' --exclude '*.db-*' \
    --exclude '*-wal' --exclude '*-shm' --exclude 'db-backups' \
    --exclude 'cache' --exclude '.tmp' --exclude 'mcp-oauth-locks' || failures=$((failures + 1))
  checkpoint_tree claude "$CLAUDE_CONFIG_DIR" "$CLAUDE_DURABLE" || failures=$((failures + 1))
  checkpoint_tree gemini "$GEMINI_LIVE" "$GEMINI_DURABLE" || failures=$((failures + 1))
  checkpoint_tree openclaw "$OPENCLAW_STATE_DIR" "$OPENCLAW_DURABLE" || failures=$((failures + 1))
  checkpoint_sqlite_tree "$OPENCODE_LIVE" "$OPENCODE_DURABLE" opencode.db opencode.db || failures=$((failures + 1))
  checkpoint_sqlite_tree "$HERMES_LIVE" "$HERMES_DURABLE" state.db state.db || failures=$((failures + 1))
  checkpoint_tree fx "$FX_LIVE" "$FX_DURABLE" \
    --exclude '*.lock' --exclude 'index.pending' || failures=$((failures + 1))
fi

[ "$failures" -eq 0 ] || {
  echo "agent-state: $MODE completed with $failures failed adapter(s)" >&2
  exit 1
}
