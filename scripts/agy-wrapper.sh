#!/bin/sh
# `agy` for every process the manager starts, its children included: other
# agents' tool shells, `bash -lc`, cron jobs. Installed as $AM_LOCAL/agy-wrap/agy,
# which entrypoint.sh and /etc/profile.d/agent-manager.sh put first on PATH.
#
# agy keeps its SQLite under $HOME/.gemini, and HOME is the bucket, where a
# link does not reliably stay a link and SQLite corrupts. On 2026-11-20 a Codex
# agent running `agy models` from its own shell is what started writing agy's
# state onto hf-mount. So: run the real agy with HOME=$AGY_HOME, the local HOME
# server/src/agy-home.js lays out, and refuse rather than fall back to the
# bucket when that HOME is not there.

# The real agy: the first one on PATH that is not this wrapper. Compared as
# resolved FILES: a real `agy` that is (or became) a link to this script, or a
# second copy of the wrapper's directory on PATH, is skipped rather than exec'd
# into a loop.
self=$(realpath -e "$0" 2>/dev/null) || self=$0
real=""
_ifs=$IFS; IFS=:
for d in $PATH; do
  [ -n "$d" ] || continue
  c="$d/agy"
  [ -x "$c" ] && [ ! -d "$c" ] || continue
  [ "$(realpath -e "$c" 2>/dev/null)" = "$self" ] && continue
  real=$c; break
done
IFS=$_ifs
if [ -z "$real" ]; then
  echo "agy: no Antigravity CLI on PATH besides the manager's wrapper ($0)" >&2
  exit 127
fi

# The local HOME: $AGY_HOME, else where the manager puts it. Never the bucket
# HOME by default: without either, refuse when HOME is on the bucket.
home=${AGY_HOME:-${AM_LOCAL:+$AM_LOCAL/agy-home}}
if [ -z "$home" ]; then
  case "$HOME/" in
    "${DATA_DIR:-/data}"/*)
      echo "agy: HOME ($HOME) is on the bucket, where agy's databases corrupt, and neither" >&2
      echo "agy: AGY_HOME nor AM_LOCAL is set to say where its local HOME is. Not starting." >&2
      exit 1 ;;
  esac
else
  if [ ! -L "$home/.gemini/antigravity-cli" ] || [ ! -L "$home/.gemini/config" ]; then
    echo "agy: Antigravity's local HOME ($home) is not set up, and the bucket HOME would" >&2
    echo "agy: put its databases where they corrupt. Start an Antigravity session from the" >&2
    echo "agy: manager once (it sets it up), or restart the Space." >&2
    exit 1
  fi
  HOME=$home
  export HOME
fi
exec "$real" "$@"
