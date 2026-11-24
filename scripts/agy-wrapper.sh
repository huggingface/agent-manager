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

# The real agy: the first one on PATH that is not this wrapper.
self_dir=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)
real=""
_ifs=$IFS; IFS=:
for d in $PATH; do
  [ -n "$d" ] || continue
  [ "$(cd "$d" 2>/dev/null && pwd -P)" = "$self_dir" ] && continue
  if [ -x "$d/agy" ] && [ ! -d "$d/agy" ]; then real="$d/agy"; break; fi
done
IFS=$_ifs
if [ -z "$real" ]; then
  echo "agy: no Antigravity CLI on PATH besides the manager's wrapper ($0)" >&2
  exit 127
fi

if [ -n "${AGY_HOME:-}" ]; then
  if [ ! -L "$AGY_HOME/.gemini/antigravity-cli" ] || [ ! -L "$AGY_HOME/.gemini/config" ]; then
    echo "agy: Antigravity's local HOME ($AGY_HOME) is not set up, and the bucket HOME would" >&2
    echo "agy: put its databases where they corrupt. Start an Antigravity session from the" >&2
    echo "agy: manager once (it sets it up), or restart the Space." >&2
    exit 1
  fi
  HOME=$AGY_HOME
  export HOME
fi
exec "$real" "$@"
