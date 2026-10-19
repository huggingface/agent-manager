#!/bin/sh
# Durable state bridge for the agent harnesses.
#
# Active state always lives on the container's POSIX filesystem. The mounted
# bucket only receives short-lived, closed writes made by rsync (ordinary file
# trees) or SQLite's online backup API (live databases). This is intentional:
# hf-mount's streaming writer holds an open file in memory until close, while
# copying a database and its WAL independently can produce a torn backup.
#
# Restore speed. The bucket costs ~27 ms per file, read or stat, so a restore is
# bound by file COUNT, not bytes — and one sequential rsync per harness kept a
# Space silent for 25 minutes at boot. Three things keep it short: what is not
# worth restoring is excluded (and pruned from the bucket once); the adapters
# restore concurrently; and the big trees are split by subdirectory into a
# bounded pool of rsyncs, each applying exactly the filters a single rsync
# would. The restore reports progress on stdout as it goes.

set -u

MODE="${1:-}"
case "$MODE" in
  restore|checkpoint|checkpoint-final|prune|stop-prune|_part|_adapter) ;;
  *) echo "usage: $0 restore|checkpoint|checkpoint-final|prune|stop-prune" >&2; exit 2 ;;
esac
SELF="$0"
START=$(date +%s)

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

# rsyncs one big tree may run at once when it is copied from the local API
# mirror. Claude and Codex each get a pool, the five small adapters one rsync
# each: at most 2×JOBS+5 concurrent at boot. Reads straight from $DATA_DIR are
# never split, and run one at a time across all adapters (restore_adapter).
JOBS="${AGENT_STATE_JOBS:-8}"
HEARTBEAT="${AGENT_STATE_HEARTBEAT:-30}"
# Claude writes a `.claude.json.backup.<ms>` on every config save and keeps the
# last five itself. Checkpoints never delete, so the bucket kept every one ever
# made (2,065, 250 MB, measured). Only the newest few come back.
KEEP_CLAUDE_BACKUPS="${AGENT_STATE_KEEP_CLAUDE_BACKUPS:-5}"
# The most junk files one prune removes; the rest goes on the next boot.
PRUNE_MAX="${AGENT_STATE_PRUNE_MAX:-50000}"
# The whole restore, start to finish, waiting for locks included, must end
# within this many seconds; see bounded.
BUDGET="${AGENT_STATE_BUDGET:-1200}"
# Diagnostic: `restore` with this set only lists what the tree rsyncs would
# copy (`rsync -n`) and writes nothing — no stamps, no databases.
DRY_RUN="${AGENT_STATE_DRY_RUN:-}"

LOCK="$AM_LOCAL/agent-state-checkpoint.lock"
mkdir -p "$AM_LOCAL"
if [ "$MODE" = stop-prune ]; then
  # The entrypoint, at shutdown: stop a running prune's whole process group
  # (it was started under setsid) and return once it is gone, so the final
  # checkpoint neither races it nor waits on it.
  _pf="$AM_LOCAL/agent-state-prune.pgid"
  _g=$(cat "$_pf" 2>/dev/null) || exit 0
  [ -n "$_g" ] || exit 0
  kill -TERM "-$_g" 2>/dev/null || { rm -f "$_pf"; exit 0; }
  _i=0
  while kill -0 "-$_g" 2>/dev/null && [ "$_i" -lt 50 ]; do sleep 0.1; _i=$((_i + 1)); done
  kill -KILL "-$_g" 2>/dev/null
  rm -f "$_pf"
  echo "agent-state: stopped the junk prune for shutdown"
  exit 0
elif [ "$MODE" = _part ] || [ "$MODE" = _adapter ]; then
  # Part of a parallel restore, started by the restore holding the lock.
  :
elif [ "$MODE" = prune ]; then
  # One prune at a time. It also takes the CHECKPOINT lock, a batch at a time
  # (see the prune below): a checkpoint that published a new Claude backup
  # between the prune listing the backups and deleting them would otherwise
  # lose it.
  exec 8>"$AM_LOCAL/agent-state-prune.lock"
  flock -n 8 || exit 0
  exec 9>"$LOCK"
else
  exec 9>"$LOCK"
  if [ "$MODE" = restore ]; then
    # A dev-mode restart may overlap the previous app's final checkpoint. Never
    # restore an older durable view while that checkpoint is still being made —
    # but never wait past the restore's budget for it either.
    flock -w "$BUDGET" 9 || {
      echo "agent-state: restore: out of time — a checkpoint still held the lock after ${BUDGET}s (AGENT_STATE_BUDGET)" >&2
      exit 1
    }
  elif [ "$MODE" = checkpoint-final ]; then
    flock 9
  else
    # Timer and shutdown checkpoints can race; the one already holding the lock
    # is sufficient, and a later timer/shutdown will catch subsequent writes.
    flock -n 9 || exit 0
  fi
fi

log() { echo "${AGENT_STATE_LOG_PREFIX:-}agent-state: $*"; }
now() { date +%s; }
elapsed() {
  _s=$(( $(now) - $1 ))
  if [ "$_s" -ge 60 ]; then printf '%dm%02ds' $((_s / 60)) $((_s % 60)); else printf '%ds' "$_s"; fi
}
count_files() { find "$1" -type f 2>/dev/null | wc -l | tr -d ' '; }
tree_size() { du -sh "$1" 2>/dev/null | cut -f1; }
# A name as a literal rsync pattern: [ ] * ? and \ would otherwise be wildcards.
literal() { printf '%s' "$1" | sed 's/[][*?\\]/\\&/g'; }

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
  bounded "rsync from ${SRC_DESC:-$DATA_DIR}" "" rsync "$@"; _rs_rc=$?
  [ "$_rs_rc" -eq 24 ] && _rs_rc=0
  return "$_rs_rc"
}

# ---------- the restore's time budget ----------
#
# One budget for the whole restore (AGENT_STATE_BUDGET seconds from the moment
# it started): every step that can block — bucket discovery, the backup
# listing, each API transfer, each rsync — runs under `timeout` with at most
# what is left, so a hung mount or API fails the boot with a clear message
# instead of holding it until HF kills the Space at 30 minutes. An adapter
# that runs out does not fall back to anything: it fails, naming the step, and
# the entrypoint refuses to start. DEADLINE is set in an adapter only;
# elsewhere (checkpoints, prune, a slice under an already bounded pool)
# bounded runs its command as it is.
DEADLINE="" KEY="" WORK=""
remaining() { echo $(( DEADLINE - $(now) )); }
# Where an adapter is now; an out-of-time failure names it.
step() { [ -n "$DEADLINE" ] && echo "$1" > "$WORK/step.$KEY"; }
# bounded STEP END COMMAND…: run COMMAND (not a shell function) until END
# (epoch seconds; empty means the deadline) or the deadline, whichever comes
# first. It runs in timeout's own process group, which timeout stops whole on
# expiry — every child of it too — and which is registered for stop_workers,
# so an interrupted restore stops it as well. Stopped by the deadline, it
# records STEP in $WORK/exhausted.$KEY. Returns COMMAND's status, or 124/137
# when it was stopped.
bounded() {
  _bs="$1" _be="${2:-$DEADLINE}"; shift 2
  [ -n "$DEADLINE" ] || { "$@"; return; }
  [ "$_be" -gt "$DEADLINE" ] && _be="$DEADLINE"
  step "$_bs"
  _bl=$(( _be - $(now) ))
  if [ "$_bl" -le 0 ]; then
    [ "$_be" -ge "$DEADLINE" ] && echo "$_bs" > "$WORK/exhausted.$KEY"
    return 124
  fi
  timeout -k 5 "$_bl" "$@" &
  _bp=$!
  echo "$_bp" > "$WORK/pgid.$KEY.$_bp"
  wait "$_bp"; _brc=$?
  rm -f "$WORK/pgid.$KEY.$_bp"
  if { [ "$_brc" -eq 124 ] || [ "$_brc" -eq 137 ]; } && [ "$(now)" -ge "$DEADLINE" ]; then
    echo "$_bs" > "$WORK/exhausted.$KEY"
  fi
  return "$_brc"
}

# Each adapter's filters, in ONE place, for both directions and for every slice
# of a parallel restore. Checkpoints enumerate files explicitly via
# --files-from, and excluding just a directory name does not exclude its
# explicitly listed descendants: subtree patterns (`**/x/***`, or `/x/***` for
# the top level only) cover both the directory and everything under it.
#
#   codex  tmp/ holds one `arg0/codex-arg0XXXXXX/.lock` per process that ever
#          ran (1,888 in the bucket, 9 live); plugins/ held only cache/ — the
#          curated plugins Codex downloads again — and its install staging.
#   claude backups/ come back as the newest few only (restore_claude_backups).
#          file-history/ is kept: it is what /rewind restores edited files from,
#          for resumed conversations too.
rsync_adapter() {
  _dir="$1" _key="$2"; shift 2
  case "$_key" in
    codex)
      rsync_tree --exclude '*.sqlite*' --exclude '*.db' --exclude '*.db-*' \
        --exclude '*-wal' --exclude '*-shm' --exclude '**/db-backups/***' \
        --exclude '**/cache/***' --exclude '**/.tmp/***' --exclude '**/mcp-oauth-locks/***' \
        --exclude '/tmp/***' --exclude '/plugins/.remote-plugin-install-staging/***' "$@" ;;
    claude)
      if [ "$_dir" = restore ]; then rsync_tree --exclude '/backups/***' "$@"; else rsync_tree "$@"; fi ;;
    fx)
      rsync_tree --exclude '*.lock' --exclude 'index.pending' "$@" ;;
    *-files)
      rsync_tree --exclude 'checkpoints' --exclude '*.db' --exclude '*.db-*' \
        --exclude '*.sqlite*' --exclude '*-wal' --exclude '*-shm' "$@" ;;
    *)
      rsync_tree "$@" ;;
  esac
}

restore_flags() {
  if [ -n "$DRY_RUN" ]; then echo '-a --update -n --out-format=%n'; else echo '-a --update'; fi
}

# One slice of a tree: the same transfer root and the same adapter filters as a
# whole-tree rsync, narrowed by include/exclude rules to one part of it. rsync
# never descends an excluded directory, so a slice walks only its own part.
#   all      the whole tree (no pool)
#   files:   the top-level files
#   files:D  the files directly in D
#   tree:D   all of D
#   tree:D/C all of D/C
restore_slice() {
  _key="$1" _durable="$2" _live="$3" _spec="$4"
  # shellcheck disable=SC2046  # restore_flags is a fixed list of flags
  set -- $(restore_flags)
  case "$_spec" in
    all) rsync_adapter restore "$_key" "$@" "$_durable/" "$_live/" ;;
    files:) rsync_adapter restore "$_key" --exclude '/*/' "$@" "$_durable/" "$_live/" ;;
    files:*)
      _d=$(literal "${_spec#files:}")
      rsync_adapter restore "$_key" --include "/$_d/" --exclude "/$_d/*/" --include "/$_d/*" --exclude '/*' \
        "$@" "$_durable/" "$_live/" ;;
    tree:*/*)
      _p="${_spec#tree:}"; _a=$(literal "${_p%%/*}"); _b=$(literal "${_p#*/}")
      rsync_adapter restore "$_key" --include "/$_a/" --include "/$_a/$_b/***" --exclude "/$_a/*" --exclude '/*' \
        "$@" "$_durable/" "$_live/" ;;
    tree:*)
      _d=$(literal "${_spec#tree:}")
      rsync_adapter restore "$_key" --include "/$_d/***" --exclude '/*' "$@" "$_durable/" "$_live/" ;;
    *) echo "agent-state: unknown restore slice '$_spec'" >&2; return 2 ;;
  esac
}

# The slices of a durable tree, NUL-separated: its top-level files, each
# top-level directory, and — for the directories named in $2 — each of their
# subdirectories instead. Listing reads directories only (no stat of their
# contents); symlinks are never followed into.
list_slices() {
  _root="$1" _split="$2"
  printf 'files:\0'
  for _e in "$_root"/* "$_root"/.[!.]* "$_root"/..?*; do
    [ -d "$_e" ] && [ ! -L "$_e" ] || continue
    _n="${_e##*/}"
    case " $_split " in
      *" $_n "*)
        printf 'files:%s\0' "$_n"
        for _c in "$_e"/* "$_e"/.[!.]* "$_e"/..?*; do
          [ -d "$_c" ] && [ ! -L "$_c" ] || continue
          printf 'tree:%s/%s\0' "$_n" "${_c##*/}"
        done ;;
      *) printf 'tree:%s\0' "$_n" ;;
    esac
  done
}

# Every slice of a tree through a pool of at most $JOBS rsyncs. Any failed
# slice fails the tree (xargs exits non-zero when any command did).
parallel_restore() {
  _key="$1" _durable="$2" _live="$3" _split="$4"
  # A tree read from $DATA_DIR itself (no API mirror) gets ONE rsync, under the
  # mount lock restore_adapter holds: on the bucket mount, parallel cold reads
  # are what fails (see restore_source).
  case "$_durable" in "${DATA_DIR%/}"/*) _serial=1 ;; *) _serial=0 ;; esac
  if [ "$JOBS" -le 1 ] || [ "$_serial" = 1 ]; then
    restore_slice "$_key" "$_durable" "$_live" all
    return
  fi
  # The whole pool is one bounded step: timeout stops xargs and every slice.
  _slices="$WORK/slices.$_key"
  list_slices "$_durable" "$_split" > "$_slices"
  bounded "rsync from ${SRC_DESC:-$_durable}" "" \
    xargs -0 -r -n 1 -P "$JOBS" -a "$_slices" sh "$SELF" _part "$_key" "$_durable" "$_live"
}

restore_tree() {
  key="$1" durable="$2" live="$3" split="${4:-}"
  mkdir -p "$durable" "$live"
  stamp_dir="$AM_LOCAL/agent-state-stamps"
  stamp="$stamp_dir/$key"
  had_local=false
  [ -n "$(find "$live" -type f -print -quit 2>/dev/null)" ] && had_local=true
  # --update matters for hot/dev restarts: local disk survives those and can be
  # newer than the last completed bucket checkpoint. A fresh container starts
  # with an empty destination, so the same command performs a full restore.
  if parallel_restore "$key" "$durable" "$live" "$split"; then
    [ -n "$DRY_RUN" ] && return 0
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
  key="$1" live="$2" durable="$3"
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
    if ! rsync_adapter checkpoint "$key" -a -r --from0 --files-from="$list" --delay-updates \
      "$live/" "$durable/"; then
      rm -f "$next" "$list"
      return 1
    fi
  fi
  mv "$next" "$stamp"
  rm -f "$list"
}

# The newest few Claude config backups, by the millisecond stamp in their
# names — read from the directory listing alone, without a stat per file.
# A listing that failed or was stopped is not an empty one: it fails, rather
# than handing back no backups at all.
newest_claude_backups() {
  _nl="$AM_LOCAL/agent-state-claude-ls.$$"
  if ! bounded "listing $1" "" ls -A "$1" > "$_nl" 2>/dev/null; then rm -f "$_nl"; return 1; fi
  grep -E '^\.claude\.json\.backup\.[0-9]+$' "$_nl" | sort -t . -k 5,5n | tail -n "$2"
  rm -f "$_nl"
}

restore_claude_backups() {
  _src="${1:-$CLAUDE_DURABLE}/backups" _dst="$CLAUDE_CONFIG_DIR/backups"
  [ -d "$_src" ] && [ ! -L "$_src" ] || return 0
  _list="$AM_LOCAL/agent-state-claude-backups.$$"
  if ! newest_claude_backups "$_src" "$KEEP_CLAUDE_BACKUPS" > "$_list"; then
    echo "agent-state: could not list the Claude backups in $_src" >&2
    rm -f "$_list"; return 1
  fi
  if [ -s "$_list" ] && [ -z "$DRY_RUN" ]; then
    mkdir -p "$_dst"
    if ! bounded "rsync from ${SRC_DESC:-$_src}" "" rsync -a --update --files-from="$_list" "$_src/" "$_dst/"; then
      rm -f "$_list"; return 1
    fi
  elif [ -n "$DRY_RUN" ]; then
    cat "$_list"
  fi
  rm -f "$_list"
}

restore_sqlite_tree() {
  durable="$1" live="$2" db_name="$3" checkpoint_name="$4"
  mkdir -p "$durable" "$live"

  if ! restore_tree "$checkpoint_name-files" "$durable" "$live"; then
    return 1
  fi
  [ -n "$DRY_RUN" ] && return 0

  checkpoint="$durable/checkpoints/$checkpoint_name"
  target="$live/$db_name"
  step "checking the restored SQLite database"
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
    if ! bounded "rsync from ${SRC_DESC:-$durable}" "" rsync -a "$checkpoint" "$target"; then return 1; fi
  elif [ -s "$durable/$db_name" ]; then
    # One-release compatibility path for state written by the old raw-rsync
    # mechanism. Copy the legacy DB and any WAL so SQLite can recover it; the
    # first successful checkpoint replaces this path as the restore authority.
    _step="rsync from ${SRC_DESC:-$durable}"
    if ! bounded "$_step" "" rsync -a "$durable/$db_name" "$target"; then return 1; fi
    if [ -f "$durable/$db_name-wal" ] && ! bounded "$_step" "" rsync -a "$durable/$db_name-wal" "$target-wal"; then return 1; fi
    if [ -f "$durable/$db_name-shm" ] && ! bounded "$_step" "" rsync -a "$durable/$db_name-shm" "$target-shm"; then return 1; fi
  fi

  if [ "$had_invalid" = true ] && [ ! -s "$target" ]; then
    echo "agent-state: invalid local SQLite state has no durable recovery for $target" >&2
    return 1
  fi
  step "checking the restored SQLite database"
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
  if ! checkpoint_tree "$checkpoint_name-files" "$live" "$durable"; then
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

# ---------- restore source: the bucket API, not the mount ----------
#
# Every restore read used to go through hf-mount. On 2026-10-19 that mount
# stopped serving reads ~90s into two consecutive boots — each read hung ~90s
# and failed with EIO, rsync exited 23, and the Space never started — while the
# same files downloaded over the bucket API in under a second each. Listing is
# cheap there too: 7,102 Claude files in 2s.
#
# So the restore first pulls each durable tree over the API (`hf buckets sync`)
# into a local MIRROR, with the bucket's mtimes reapplied, and then runs the
# unchanged rsync restore from that mirror instead of from /data. Every rule
# below — adapter filters, newest-N Claude backups, SQLite checkpoint
# validation, the legacy DB fallback, --update for hot restarts — therefore
# behaves exactly as before; it just reads fast local disk. Every boot starts
# from an empty mirror, each attempt fills a fresh directory of its own, and
# only an attempt that completed is restored from: a file left behind by an
# earlier, killed attempt can never reach the live tree. The mirror is deleted
# once the restore is done.
#
# When the API can't be used — no HF_TOKEN (it is optional for this app), the
# bucket can't be discovered, the backup listing fails, or a transfer still
# fails after one retry — the adapter restores straight from $DATA_DIR instead.
# Those reads hold the MOUNT lock: one rsync at a time across ALL adapters.
# That is the only mount read pattern that has held up: parallel cold reads are
# what fails (on a fresh container, 8 parallel rsyncs stopped at 1,538 of 4,689
# files every time, while a single rsync copied all of them, slowly). Parallel
# slices are therefore used only when copying from the local mirror; see
# parallel_restore. Each fallback is logged with its reason.
#
# Without a bucket there is nothing to fetch: a Space whose /data has no bucket
# attached (the entrypoint's ephemeral mode) or a local run restores straight
# from $DATA_DIR, which is then ordinary local disk (still one rsync at a
# time). AGENT_STATE_BUCKET names the bucket where the Space API can't (local
# runs against a bucket, tests).
#
# Each API attempt (backup listing, plan, download) gets at most
# AGENT_STATE_API_TIMEOUT seconds and there is one retry, so a hung API leaves
# most of the budget to the mount.
API_TIMEOUT="${AGENT_STATE_API_TIMEOUT:-240}"
# Files in flight per transfer. Measured on cpu-upgrade against a 4,686-file,
# 2.8 GB tree: 4 → 128s, default → ~63s, 16 → 38s, 64 → 28-30s.
export HF_XET_DATA_MAX_CONCURRENT_FILE_DOWNLOADS="${HF_XET_DATA_MAX_CONCURRENT_FILE_DOWNLOADS:-64}"
MIRROR_ROOT="$AM_LOCAL/agent-state-mirror"
MOUNT_LOCK="$AM_LOCAL/agent-state-mount-read.lock"

# The bucket mounted at $DATA_DIR, from GET /api/spaces/$SPACE_ID — the same
# source backup.js/visibility.js use. Prints the bucket id, or nothing when
# there is no bucket at $DATA_DIR (local disk). Returns non-zero, with the
# reason on stderr, when it CANNOT TELL.
bucket_id() {
  [ -n "${AGENT_STATE_BUCKET:-}" ] && { echo "$AGENT_STATE_BUCKET"; return 0; }
  [ -n "${SPACE_ID:-}" ] || return 0 # not a Space: local disk
  _cache="$AM_LOCAL/agent-state-bucket"
  [ -e "$_cache" ] && { cat "$_cache"; return 0; }
  [ -n "${HF_TOKEN:-}" ] || {
    echo "HF_TOKEN is not set; add an HF_TOKEN that can read the bucket for faster, more reliable boots" >&2; return 1; }
  command -v jq >/dev/null 2>&1 || { echo "jq is missing" >&2; return 1; }
  _info=$(bounded "bucket discovery" "$(( $(now) + 90 ))" \
    curl -fsS -m 20 --retry 2 -H "Authorization: Bearer $HF_TOKEN" "https://huggingface.co/api/spaces/$SPACE_ID") \
    || { echo "could not read the Space's volumes from the Hub API" >&2; return 1; }
  _b=$(printf '%s' "$_info" | jq -r --arg m "${DATA_DIR%/}" \
    '.runtime.volumes[]? | select(.type == "bucket" and (.mountPath | rtrimstr("/")) == $m) | .source') \
    || { echo "could not read the Space's volumes from the Hub API answer" >&2; return 1; }
  _b=$(printf '%s\n' "$_b" | head -n 1)
  printf '%s' "$_b" > "$_cache"
  echo "$_b"
}

# Coarse filters for the mirror, in `hf buckets sync` syntax (fnmatch on the
# path relative to the tree root; `*` crosses `/`). They only keep bulk junk
# from being DOWNLOADED; the adapter's rsync filters still apply when the
# mirror is restored, so anything let through here is filtered there as before.
# Fails (with the reason in $_why) when it cannot know what to fetch.
mirror_filters() {
  case "$1" in
    codex)
      printf '%s\n' '- tmp/*' '- .tmp/*' '- */.tmp/*' '- cache/*' '- */cache/*' \
        '- db-backups/*' '- */db-backups/*' '- plugins/.remote-plugin-install-staging/*' \
        '- mcp-oauth-locks/*' '- */mcp-oauth-locks/*' \
        '- *.sqlite*' '- *.db' '- *.db-*' '- *-wal' '- *-shm' ;;
    fx)
      printf '%s\n' '- *.lock' '- index.pending' '- */index.pending' ;;
    claude)
      # Only the newest few config backups are restored (restore_claude_backups);
      # fetch just those rather than all ~2,400 — which needs a listing we can
      # trust. A failed, hung or unreadable listing is NOT an empty one: it
      # fails this attempt, and the adapter falls back to the mount.
      _ls="$MIRROR_ROOT/$1.backups.json"
      bounded "listing the Claude backups over the API" "$3" \
        hf buckets list "hf://buckets/$2/backups" --format json >"$_ls" 2>"$_ls.err"; _rc=$?
      if [ "$_rc" -ne 0 ]; then
        if [ "$_rc" -eq 124 ] || [ "$_rc" -eq 137 ]; then _why="listing the Claude backups timed out"
        else _why="listing the Claude backups failed (exit $_rc: $(tail -n 1 "$_ls.err"))"; fi
        return 1
      fi
      # For a prefix holding no files hf prints nothing at all and exits 0
      # (checked against the API); anything else must be its JSON array.
      if [ -s "$_ls" ] && ! jq -e 'type == "array" and all(.[]; (.type | type) == "string" and (.path | type) == "string")' \
          "$_ls" >/dev/null 2>&1; then
        _why="the Claude backup listing is not a JSON file list"; return 1
      fi
      if [ -s "$_ls" ]; then
        jq -r '.[] | select(.type == "file") | .path | split("/") | last' "$_ls" \
          | grep -E '^\.claude\.json\.backup\.[0-9]+$' | sort -t . -k 5,5n | tail -n "$KEEP_CLAUDE_BACKUPS" \
          | sed 's|^|+ backups/|'
      fi
      echo '- backups/*' ;;
  esac
}

# Bucket mtimes back onto the mirror, so the rsync from it preserves them into
# the live tree exactly as `rsync -a` from the mount did: --update decisions on
# a later hot restart and the checkpoint floor both depend on them.
SET_MTIMES='
import json, os, sys
from datetime import datetime
plan, root = sys.argv[1], sys.argv[2]
for line in open(plan):
    op = json.loads(line)
    if op.get("type") != "operation" or op.get("action") != "download" or not op.get("remote_mtime"):
        continue
    t = datetime.fromisoformat(op["remote_mtime"].replace("Z", "+00:00")).timestamp()
    os.utime(os.path.join(root, op["path"]), (t, t))
'

# One attempt: listing (Claude), plan, apply, mtimes — all before $4 — into the
# EMPTY directory $3. Fails with the reason in $_why.
mirror_attempt() {
  _key="$1" _prefix="$2" _mirror="$3" _end="$4"
  _rules="$MIRROR_ROOT/$_key.filters" _plan="$MIRROR_ROOT/$_key.plan.jsonl"
  rm -rf "${_mirror:?}" "$_plan"
  mkdir -p "$_mirror"
  mirror_filters "$_key" "$_prefix" "$_end" > "$_rules" || return 1
  # Plan, then apply the plan: the plan carries each file's bucket mtime, which
  # the download itself does not set.
  bounded "fetching over the API (plan)" "$_end" hf buckets sync "hf://buckets/$_prefix" "$_mirror" \
    --filter-from "$_rules" --plan "$_plan" --quiet >/dev/null 2>"$_plan.err" \
    && bounded "fetching over the API (download)" "$_end" hf buckets sync --apply "$_plan" --quiet \
      >/dev/null 2>>"$_plan.err" \
    && bounded "fetching over the API (mtimes)" "$_end" python3 -c "$SET_MTIMES" "$_plan" "$_mirror" 2>>"$_plan.err"
  _rc=$?
  [ "$_rc" -eq 0 ] && return 0
  if [ "$_rc" -eq 124 ] || [ "$_rc" -eq 137 ]; then _why="timed out after ${API_TIMEOUT}s"
  else _why="exit $_rc: $(tail -n 1 "$_plan.err")"; fi
  return 1
}

# Pull one durable tree from bucket $3 into a fresh mirror; prints its path.
mirror_tree() {
  _key="$1" _durable="$2" _bucket="$3"
  command -v hf >/dev/null 2>&1 || { echo "the hf CLI is missing" >&2; return 1; }
  command -v jq >/dev/null 2>&1 || { echo "jq is missing" >&2; return 1; }
  case "$_durable" in "${DATA_DIR%/}"/*) ;; *) echo "$_durable is not under $DATA_DIR" >&2; return 1 ;; esac
  _prefix="$_bucket/${_durable#"${DATA_DIR%/}/"}"
  _try=1
  while :; do
    _m="$MIRROR_ROOT/$_key/try$_try" _why=""
    mirror_attempt "$_key" "$_prefix" "$_m" "$(( $(now) + API_TIMEOUT ))" && { echo "$_m"; return 0; }
    rm -rf "${_m:?}"
    # Out of budget: no retry, and no fallback either (restore_source).
    [ -e "$WORK/exhausted.$KEY" ] && { echo "$_why" >&2; return 1; }
    [ "$_try" -ge 2 ] && { echo "$_why" >&2; return 1; }
    log "$_key: bucket transfer failed, retrying ($_why)" >&3
    _try=$((_try + 1))
  done
}

# The tree an adapter restores FROM: its API mirror when $DATA_DIR is a bucket
# we can fetch, $DATA_DIR itself otherwise — local disk, or the mount read by a
# single rsync under the mount lock. The bucket was discovered once for the
# whole restore ($WORK/bucket, or $WORK/bucket.why when that failed). A dry
# run lists what the restore would copy from $DATA_DIR and fetches nothing.
restore_source() {
  _key="$1" _durable="$2"
  [ -n "$DRY_RUN" ] && { echo "$_durable"; return 0; }
  if [ -e "$WORK/bucket.why" ]; then
    log "$_key: bucket API not usable ($(cat "$WORK/bucket.why")) — reading $DATA_DIR directly, one rsync at a time (slow)" >&2
    echo "$_durable"; return 0
  fi
  _bucket=$(cat "$WORK/bucket" 2>/dev/null)
  [ -z "$_bucket" ] && { echo "$_durable"; return 0; } # local disk
  # The reason a fetch failed goes to why.$_key; progress (fd 3) to the log.
  if _m=$(mirror_tree "$_key" "$_durable" "$_bucket" 3>&2 2>"$WORK/why.$_key"); then
    : > "$WORK/fetched.$_key"
    log "$_key: fetched over the bucket API ($(count_files "$_m") files, $(tree_size "$_m"))" >&2
    echo "$_m"
  elif [ -e "$WORK/exhausted.$_key" ]; then
    return 1
  else
    log "$_key: could not fetch from bucket $_bucket ($(tail -n 1 "$WORK/why.$_key")) — reading $DATA_DIR directly, one rsync at a time (slow)" >&2
    rm -rf "${MIRROR_ROOT:?}/${_key:?}"
    echo "$_durable"
  fi
}

# ---------- restore: every adapter at once, with progress ----------

# Each restores from $1: the API mirror, or $DATA_DIR directly.
restore_codex() { restore_tree codex "$1" "$CODEX_HOME"; }
# projects/ is most of Claude's bytes in one directory: one slice per project.
restore_claude() {
  restore_tree claude "$1" "$CLAUDE_CONFIG_DIR" "projects file-history" && restore_claude_backups "$1"
}
restore_gemini() { restore_tree gemini "$1" "$GEMINI_LIVE"; }
restore_openclaw() { restore_tree openclaw "$1" "$OPENCLAW_STATE_DIR"; }
restore_opencode() { restore_sqlite_tree "$1" "$OPENCODE_LIVE" opencode.db opencode.db; }
restore_hermes() { restore_sqlite_tree "$1" "$HERMES_LIVE" state.db state.db; }
restore_fx() { restore_tree fx "$1" "$FX_LIVE"; }

ADAPTERS="codex claude gemini openclaw opencode hermes fx"
live_of() {
  case "$1" in
    codex) echo "$CODEX_HOME" ;; claude) echo "$CLAUDE_CONFIG_DIR" ;; gemini) echo "$GEMINI_LIVE" ;;
    openclaw) echo "$OPENCLAW_STATE_DIR" ;; opencode) echo "$OPENCODE_LIVE" ;; hermes) echo "$HERMES_LIVE" ;;
    fx) echo "$FX_LIVE" ;;
  esac
}
durable_of() {
  case "$1" in
    codex) echo "$CODEX_DURABLE" ;; claude) echo "$CLAUDE_DURABLE" ;; gemini) echo "$GEMINI_DURABLE" ;;
    openclaw) echo "$OPENCLAW_DURABLE" ;; opencode) echo "$OPENCODE_DURABLE" ;; hermes) echo "$HERMES_DURABLE" ;;
    fx) echo "$FX_DURABLE" ;;
  esac
}

# One adapter's restore from wherever restore_source says. Reading $DATA_DIR
# directly, it first takes the mount lock, waiting within the budget, and holds
# it until every read of its own is done: mount reads run strictly one at a
# time across the adapters.
restore_adapter() {
  _src=$(restore_source "$1" "$(durable_of "$1")") || return 1
  case "$_src" in
    "${DATA_DIR%/}"/*)
      SRC_DESC="$_src"
      exec 7>"$MOUNT_LOCK"
      step "waiting for $DATA_DIR (another adapter is reading it)"
      _wait=$(remaining)
      if ! { [ "$_wait" -gt 0 ] && flock -w "$_wait" 7; }; then
        echo "waiting for $DATA_DIR (another adapter was reading it)" > "$WORK/exhausted.$KEY"
        exec 7>&-
        return 1
      fi
      "restore_$1" "$_src"; _rc=$?
      exec 7>&-
      return "$_rc" ;;
  esac
  SRC_DESC="the API mirror"
  "restore_$1" "$_src"
}

# One adapter, start to finish, with its own progress lines. In a dry run its
# stdout is the list of paths that would be restored.
run_adapter() {
  _name="$1" _t0=$(now)
  if [ -n "$DRY_RUN" ]; then
    restore_adapter "$_name" > "$WORK/$_name.list"; _rc=$?
    log "$_name: $(grep -cv '/$' "$WORK/$_name.list") files would be restored ($(elapsed "$_t0"))"
    : > "$WORK/done.$_name"
    return "$_rc"
  fi
  log "restoring $_name…"
  if restore_adapter "$_name"; then
    _live=$(live_of "$_name")
    log "$_name done: $(count_files "$_live") files, $(tree_size "$_live") in $(elapsed "$_t0")"
    : > "$WORK/done.$_name"
  else
    if [ -e "$WORK/exhausted.$_name" ]; then
      log "$_name FAILED after $(elapsed "$_t0"): out of time — the restore budget (AGENT_STATE_BUDGET=${BUDGET}s) ran out during: $(cat "$WORK/exhausted.$_name")" >&2
    else
      log "$_name FAILED after $(elapsed "$_t0")" >&2
    fi
    : > "$WORK/failed.$_name"
    return 1
  fi
}

# Every $HEARTBEAT seconds, the files already on the LOCAL side of each adapter
# still restoring — counting there costs nothing, unlike walking the bucket —
# and how much of the budget is left.
heartbeat() {
  _parent="$1" _t0="$2" _sp=""
  # Killed, take the pending sleep with it: a sleep left behind keeps the
  # restore's stdout open, and whoever reads that output waits on it.
  trap 'kill $_sp 2>/dev/null; exit 0' TERM INT HUP
  while :; do
    sleep "$HEARTBEAT" & _sp=$!
    wait "$_sp"
    kill -0 "$_parent" 2>/dev/null || exit 0
    _line=""
    for _a in $ADAPTERS; do
      [ -e "$WORK/done.$_a" ] || [ -e "$WORK/failed.$_a" ] && continue
      # While an adapter is still downloading, its files are in the API mirror,
      # not yet on the live side — count those, or the log reads "0 files".
      if [ -d "$MIRROR_ROOT/$_a" ] && [ ! -e "$WORK/fetched.$_a" ]; then
        _line="$_line, $_a $(count_files "$MIRROR_ROOT/$_a") files fetched"
      else
        _line="$_line, $_a $(count_files "$(live_of "$_a")") files"
      fi
    done
    _left=$(remaining); [ "$_left" -lt 0 ] && _left=0
    [ -n "$_line" ] && log "still restoring after $(elapsed "$_t0") ($(elapsed "$(( $(now) - _left ))") of the budget left): ${_line#, } on local disk so far"
  done
}

# The last resort behind the per-step timeouts: a few seconds after the budget
# has run out, anything still running (a stat or listing of a hung mount is not
# under a timeout of its own) is stopped and the restore fails closed.
watchdog() {
  _parent="$1" _sp=""
  trap 'kill $_sp 2>/dev/null; exit 0' TERM INT HUP
  sleep "$(( DEADLINE + 15 - $(now) ))" & _sp=$!
  wait "$_sp"
  kill -USR1 "$_parent" 2>/dev/null
}

failures=0

if [ "$MODE" = _part ]; then
  restore_slice "$2" "$3" "$4" "$5"
  exit $?
fi

if [ "$MODE" = _adapter ]; then
  # One adapter in its own process group (the restore starts it under setsid),
  # so an interrupted restore can stop it and every xargs, slice and rsync
  # under it in one kill — not just this shell.
  WORK="$2" KEY="$3" DEADLINE="${AGENT_STATE_DEADLINE:?}"
  echo "$$" > "$WORK/pgid.$3"
  run_adapter "$3"
  exit $?
fi

if [ "$MODE" = prune ]; then
  # Junk the excludes above keep out of every restore and checkpoint, but that
  # an older version had already written to the bucket — 10k+ files of it,
  # paid for at every boot. Deletes exactly these paths and nothing else:
  # only under the durable roots, never through a symlink (find does not
  # follow them; rm removes a link, not its target), at most $PRUNE_MAX files.
  WORK=$(mktemp -d "$AM_LOCAL/agent-state-prune.XXXXXX")
  # The entrypoint starts the prune as a process-group leader and stops that
  # group at shutdown; this is how it finds it.
  echo "$$" > "$AM_LOCAL/agent-state-prune.pgid"
  trap 'rm -rf "$WORK" "$AM_LOCAL/agent-state-prune.pgid"' EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  trap 'exit 129' HUP
  budget="$PRUNE_MAX" total=0 t0=$(now)
  # Deletion happens under the checkpoint lock, PRUNE_BATCH files at a time,
  # so a timer checkpoint skips at most one batch and a final one waits for
  # at most one batch.
  PRUNE_BATCH="${AGENT_STATE_PRUNE_BATCH:-2000}"
  rm_locked() {
    split -t '\0' -l "$PRUNE_BATCH" "$1" "$WORK/batch."
    for _b in "$WORK"/batch.*; do
      [ -e "$_b" ] || continue
      flock 9
      xargs -0 -r -n 64 -P 16 rm -f -- < "$_b"
      flock -u 9
      rm -f "$_b"
    done
  }
  prune_subtree() {
    _root="$1"
    [ -e "$_root" ] || [ -L "$_root" ] || return 0
    if [ -L "$_root" ]; then log "prune: left ${_root#"$DATA_DIR"/} alone (a symlink)"; return 0; fi
    [ -d "$_root" ] && [ "$budget" -gt 0 ] || return 0
    find "$_root" \( -type f -o -type l \) -print0 | head -z -n "$budget" > "$WORK/list"
    _n=$(tr -cd '\0' < "$WORK/list" | wc -c | tr -d ' ')
    [ "$_n" -gt 0 ] && rm_locked "$WORK/list"
    find "$_root" -depth -type d -empty -delete 2>/dev/null
    budget=$((budget - _n)); total=$((total + _n))
    [ "$_n" -gt 0 ] && log "prune: ${_root#"$DATA_DIR"/}: removed $_n files"
  }
  for rel in .tmp tmp cache mcp-oauth-locks plugins/cache plugins/.remote-plugin-install-staging; do
    prune_subtree "$CODEX_DURABLE/$rel"
  done
  # Claude config backups beyond the newest few. What to keep and what to
  # delete come from ONE listing, read and acted on while holding the
  # checkpoint lock, so a backup a checkpoint publishes is either in that
  # listing (and ranked) or arrives after the prune has let go.
  _bk="$CLAUDE_DURABLE/backups"
  if [ -d "$_bk" ] && [ ! -L "$_bk" ] && [ "$budget" -gt 0 ]; then
    flock 9
    ls -A "$_bk" | grep -E '^\.claude\.json\.backup\.[0-9]+$' | sort -t . -k 5,5n > "$WORK/backups"
    _all=$(wc -l < "$WORK/backups" | tr -d ' ')
    _drop=$((_all - KEEP_CLAUDE_BACKUPS))
    [ "$_drop" -gt "$budget" ] && _drop="$budget"
    n=0
    if [ "$_drop" -gt 0 ]; then
      head -n "$_drop" "$WORK/backups" | sed "s|^|$_bk/|" | tr '\n' '\0' > "$WORK/list"
      xargs -0 -r -n 64 -P 16 rm -f -- < "$WORK/list"
      n="$_drop"
    fi
    flock -u 9
    [ "$n" -gt 0 ] && log "prune: ${CLAUDE_DURABLE#"$DATA_DIR"/}/backups: removed $n old config backups, kept the newest $KEEP_CLAUDE_BACKUPS"
    total=$((total + n)); budget=$((budget - n))
  fi
  if [ "$total" -gt 0 ]; then
    log "prune: removed $total junk files from the durable state in $(elapsed "$t0")"
    [ "$budget" -le 0 ] && log "prune: stopped at $PRUNE_MAX files; the rest goes on the next boot"
  fi
  exit 0
fi

# Files some process holds open under the live roots. A restore replaces files
# by rename, so a process holding one keeps writing to an unlinked inode while
# the path holds the older copy — and that inode is never checkpointed. This
# happened (2026-10-15): a restore run from a shell inside a running Space
# (whose environment exports these very paths) orphaned six open Codex
# rollouts. At boot no agent runs yet, so the check costs nothing there.
open_in_live_roots() {
  ls -l /proc/[0-9]*/fd 2>/dev/null | awk -v roots="$CODEX_HOME|$CLAUDE_CONFIG_DIR|$GEMINI_LIVE|$OPENCLAW_STATE_DIR|$OPENCODE_LIVE|$HERMES_LIVE|$FX_LIVE" '
    BEGIN { n = split(roots, r, "|") }
    /^\/proc\/[0-9]+\/fd:$/ { pid = $0; sub(/^\/proc\//, "", pid); sub(/\/fd:$/, "", pid); next }
    / -> / { t = $0; sub(/^.* -> /, "", t)
      for (i = 1; i <= n; i++) if (r[i] != "" && index(t, r[i] "/") == 1) { print "pid " pid ": " t; break } }
  ' | head -n 20
}

if [ "$MODE" = restore ] && [ -z "$DRY_RUN" ]; then
  if [ -z "${AGENT_STATE_FROM_ENTRYPOINT:-}" ]; then
    log "WARNING: restore was not started by the entrypoint. It writes into $CODEX_HOME, $CLAUDE_CONFIG_DIR and the other live trees named by this environment."
  fi
  _open=$(open_in_live_roots)
  if [ -n "$_open" ] && [ -n "${AGENT_STATE_FROM_ENTRYPOINT:-}" ]; then
    # At boot nothing should hold these; if a restart ever left agents
    # running, refusing here would refuse to boot the Space at all. Say so
    # loudly and carry on, as the restore always has.
    echo "agent-state: WARNING: processes still have files open in the live trees; a file the restore replaces is left unlinked under them:" >&2
    echo "$_open" | sed 's/^/  /' >&2
  elif [ -n "$_open" ]; then
    echo "agent-state: refusing to restore: processes have files open in the live trees it would replace:" >&2
    echo "$_open" | sed 's/^/  /' >&2
    echo "agent-state: stop them first, or point every *_LIVE / *_HOME / *_DIR variable at a scratch tree." >&2
    exit 1
  fi
fi

if [ "$MODE" = restore ]; then
  # Every boot is a full restore from nothing: no mirror and no work directory
  # an earlier, killed restore left behind is ever reused. Holding the restore
  # lock, nothing else can be using them.
  rm -rf "${MIRROR_ROOT:?}" "${AM_LOCAL:?}"/agent-state-restore.*
  WORK=$(mktemp -d "$AM_LOCAL/agent-state-restore.XXXXXX")
  KEY=restore DEADLINE=$((START + BUDGET))
  t0=$(now)
  pids=""
  heartbeat $$ "$t0" &
  hb=$!
  watchdog $$ &
  wd=$!
  # Interrupted, stop every adapter's whole process group — its xargs, slice
  # shells, rsyncs and sleeps — and every bounded step's group, and reap them
  # before reporting failure: otherwise they go on changing the live trees
  # after the restore has said it failed. TERM first, KILL after five seconds.
  stop_workers() {
    trap '' INT TERM HUP USR1
    _groups=""
    for _f in "$WORK"/pgid.*; do [ -e "$_f" ] && _groups="$_groups $(cat "$_f")"; done
    for _g in $_groups; do kill -TERM "-$_g" 2>/dev/null; done
    kill -TERM $pids 2>/dev/null
    _i=0
    while [ "$_i" -lt 50 ]; do
      _alive=0
      for _g in $_groups; do kill -0 "-$_g" 2>/dev/null && _alive=1; done
      [ "$_alive" -eq 0 ] && break
      sleep 0.1; _i=$((_i + 1))
    done
    for _g in $_groups; do kill -KILL "-$_g" 2>/dev/null; done
    kill "$hb" "$wd" 2>/dev/null
    wait
  }
  # The watchdog's signal: the budget ran out and something is still running.
  out_of_time() {
    stop_workers
    for _a in $ADAPTERS; do
      [ -e "$WORK/done.$_a" ] || [ -e "$WORK/failed.$_a" ] && continue
      log "$_a FAILED: out of time — the restore budget (AGENT_STATE_BUDGET=${BUDGET}s) ran out during: $(cat "$WORK/step.$_a" 2>/dev/null || echo 'its start')" >&2
    done
    echo "agent-state: restore ran out of its ${BUDGET}s budget (AGENT_STATE_BUDGET); refusing to start rather than wait any longer" >&2
    exit 1
  }
  # The heartbeat and watchdog must not outlive the restore, however it ends.
  trap 'kill $hb $wd 2>/dev/null; rm -rf "$WORK" "$MIRROR_ROOT"' EXIT
  trap 'stop_workers; exit 130' INT
  trap 'stop_workers; exit 143' TERM
  trap 'stop_workers; exit 129' HUP
  trap 'out_of_time' USR1
  # The bucket, discovered once for every adapter.
  if [ -z "$DRY_RUN" ]; then
    if _b=$(bucket_id 2>"$WORK/bucket.err"); then
      printf '%s' "$_b" > "$WORK/bucket"
    elif [ -e "$WORK/exhausted.$KEY" ]; then
      echo "agent-state: restore ran out of its ${BUDGET}s budget (AGENT_STATE_BUDGET) during bucket discovery; refusing to start" >&2
      exit 1
    else
      _why=$(tail -n 1 "$WORK/bucket.err")
      echo "${_why:-bucket discovery failed}" > "$WORK/bucket.why"
    fi
  fi
  [ -n "$DRY_RUN" ] || log "restoring $ADAPTERS from ${DATA_DIR%/}/state, $JOBS rsyncs per large tree, within ${BUDGET}s"
  export AGENT_STATE_DEADLINE="$DEADLINE"
  for a in $ADAPTERS; do
    # Its own process group; -w so the restore waits on it and gets its status
    # even if setsid has to fork to make it a group leader.
    setsid -w sh "$SELF" _adapter "$WORK" "$a" &
    pids="$pids $!"
  done
  for p in $pids; do
    wait "$p" || failures=$((failures + 1))
  done
  kill "$hb" "$wd" 2>/dev/null
  # The last guard: a step that ran out of budget fails the restore, whatever
  # the adapter that ran it went on to report.
  if ls "$WORK"/exhausted.* >/dev/null 2>&1; then
    echo "agent-state: restore ran out of its ${BUDGET}s budget (AGENT_STATE_BUDGET); refusing to start rather than wait any longer" >&2
    [ "$failures" -eq 0 ] && failures=1
  fi
  [ "$failures" -eq 0 ] && log "restore finished in $(elapsed "$t0")"
  rm -rf "${MIRROR_ROOT:?}"
else
  checkpoint_tree codex "$CODEX_HOME" "$CODEX_DURABLE" || failures=$((failures + 1))
  checkpoint_tree claude "$CLAUDE_CONFIG_DIR" "$CLAUDE_DURABLE" || failures=$((failures + 1))
  checkpoint_tree gemini "$GEMINI_LIVE" "$GEMINI_DURABLE" || failures=$((failures + 1))
  checkpoint_tree openclaw "$OPENCLAW_STATE_DIR" "$OPENCLAW_DURABLE" || failures=$((failures + 1))
  checkpoint_sqlite_tree "$OPENCODE_LIVE" "$OPENCODE_DURABLE" opencode.db opencode.db || failures=$((failures + 1))
  checkpoint_sqlite_tree "$HERMES_LIVE" "$HERMES_DURABLE" state.db state.db || failures=$((failures + 1))
  checkpoint_tree fx "$FX_LIVE" "$FX_DURABLE" || failures=$((failures + 1))
fi

[ "$failures" -eq 0 ] || {
  echo "agent-state: $MODE completed with $failures failed adapter(s)" >&2
  exit 1
}
