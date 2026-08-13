#!/bin/sh
# SessionStart breadcrumb for the manager's conversation re-pin (runner.js).
#
# Claude Code runs this inside the pane's process tree, so $AM_ID — set by the
# manager on the PTY — says WHICH pane the new conversation belongs
# to. That attribution is the one thing the server cannot work out on its own
# when several claude panes share a folder, and it is why a /clear there could
# not be followed before (the folderIsShared refusal in runner.js).
#
# stdin is the hook payload: {session_id, transcript_path, cwd, source, ...}.
# $CLAUDE_PID is the claude process that fired the event. Only the pane root or
# its direct child is the managed interactive Claude; a nested Claude started
# by a tool is deeper in the process tree. Filter it here so it cannot overwrite
# the top-level crumb, then runner.js independently repeats the same check.
#
# Breadcrumbs live on LOCAL disk on purpose: losing them at a restart is
# harmless (the pin itself persists in sessions.json), and the relaunch's own
# source:"resume" event immediately writes a fresh one.
[ -n "$AM_ID" ] || exit 0
case "$AM_ID" in *[!a-zA-Z0-9_-]*) exit 0 ;; esac
[ -n "$AM_RUN_ID" ] || exit 0
case "$AM_RUN_ID" in *[!a-zA-Z0-9_-]*) exit 0 ;; esac
[ "$AM_CLI" = "claude" ] || exit 0
[ "$CLAUDE_CODE_ENTRYPOINT" = "cli" ] || exit 0
case "$CLAUDE_PID" in '' | *[!0-9]*) exit 0 ;; esac
case "$AM_PANE_PID" in '' | *[!0-9]*) exit 0 ;; esac
if [ "$CLAUDE_PID" != "$AM_PANE_PID" ]; then
  stat=$(cat "/proc/$CLAUDE_PID/stat" 2>/dev/null) || exit 0
  rest=${stat##*) }
  rest=${rest#* }
  ppid=${rest%% *}
  [ "$ppid" = "$AM_PANE_PID" ] || exit 0
fi
d="${AM_REPIN_DIR:-/tmp/am-repin}"
mkdir -p "$d" 2>/dev/null || exit 0
{
  printf '{"amId":"%s","runId":"%s","cli":"claude","claudePid":%d,"payload":' "$AM_ID" "$AM_RUN_ID" "$CLAUDE_PID"
  cat
  printf '}'
} > "$d/$AM_ID.claude.json.$$.tmp" 2>/dev/null && mv -f "$d/$AM_ID.claude.json.$$.tmp" "$d/$AM_ID.claude.json"
exit 0
