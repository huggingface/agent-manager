#!/bin/sh
# Managed Codex SessionStart hook. stdin contains the exact session_id,
# transcript_path, cwd and source (startup/resume/clear/compact).
[ "$AM_CLI" = "codex" ] || exit 0
[ -n "$AM_ID" ] || exit 0
case "$AM_ID" in *[!a-zA-Z0-9_-]*) exit 0 ;; esac
[ -n "$AM_RUN_ID" ] || exit 0
case "$AM_RUN_ID" in *[!a-zA-Z0-9_-]*) exit 0 ;; esac
d="${AM_REPIN_DIR:-/tmp/am-repin}"
mkdir -p "$d" 2>/dev/null || exit 0
{
  printf '{"amId":"%s","runId":"%s","cli":"codex","payload":' "$AM_ID" "$AM_RUN_ID"
  cat
  printf '}'
} > "$d/$AM_ID.codex.json.tmp" 2>/dev/null && mv -f "$d/$AM_ID.codex.json.tmp" "$d/$AM_ID.codex.json"
exit 0
