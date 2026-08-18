#!/bin/sh
# Observation-only hook for native CLI "this dialog is actually open" events.
# It never approves, rejects or otherwise participates in the decision.

[ -n "$AM_ID" ] || exit 0
case "$AM_ID" in *[!a-zA-Z0-9_-]*) exit 0 ;; esac
[ -n "$AM_RUN_ID" ] || exit 0
case "$AM_RUN_ID" in *[!a-zA-Z0-9_-]*) exit 0 ;; esac
case "$AM_PANE_PID" in '' | *[!0-9]*) exit 0 ;; esac
command -v jq >/dev/null 2>&1 || exit 0

payload=$(mktemp "${TMPDIR:-/tmp}/am-input-hook.XXXXXX") || exit 0
trap 'rm -f "$payload"' EXIT HUP INT TERM
cat > "$payload" || exit 0

kind=
source=
clear=
case "$AM_CLI" in
  claude)
    # A global Claude config is inherited by nested Claude processes. Its
    # official entrypoint/pid fields let us keep only this pane's root CLI.
    [ "$CLAUDE_CODE_ENTRYPOINT" = "cli" ] || exit 0
    case "$CLAUDE_PID" in '' | *[!0-9]*) exit 0 ;; esac
    if [ "$CLAUDE_PID" != "$AM_PANE_PID" ]; then
      stat=$(cat "/proc/$CLAUDE_PID/stat" 2>/dev/null) || exit 0
      rest=${stat##*) }
      rest=${rest#* }
      [ "${rest%% *}" = "$AM_PANE_PID" ] || exit 0
    fi
    case "$(jq -r '.hook_event_name // empty' "$payload")" in
      Notification)
        case "$(jq -r '.notification_type // empty' "$payload")" in
          permission_prompt) kind=permission ;;
          elicitation_dialog | elicitation_url_dialog | agent_needs_input) kind=question ;;
          agent_completed) clear=1 ;;
          *) exit 0 ;;
        esac
        ;;
      PostToolBatch | Stop | SessionEnd | ElicitationResult | UserPromptSubmit) clear=1 ;;
      *) exit 0 ;;
    esac
    source=claude-notification
    ;;
  gemini)
    # Gemini spawns `bash -c` for command hooks. Bash normally execs this
    # single-command script, but allowing that one runner process keeps the
    # attribution correct if it forks instead. A Gemini started by an agent
    # tool still has its own CLI and tool shell between here and the pane root.
    stat=$(cat "/proc/$$/stat" 2>/dev/null) || exit 0
    rest=${stat##*) }
    rest=${rest#* }
    parent=${rest%% *}
    if [ "$parent" != "$AM_PANE_PID" ]; then
      stat=$(cat "/proc/$parent/stat" 2>/dev/null) || exit 0
      rest=${stat##*) }
      rest=${rest#* }
      [ "${rest%% *}" = "$AM_PANE_PID" ] || exit 0
    fi
    case "$(jq -r '.hook_event_name // empty' "$payload")" in
      Notification)
        [ "$(jq -r '.notification_type // empty' "$payload")" = "ToolPermission" ] || exit 0
        if [ "$(jq -r '.details.type // empty' "$payload")" = "ask_user" ]; then kind=question; else kind=permission; fi
        ;;
      AfterAgent | SessionEnd) clear=1 ;;
      *) exit 0 ;;
    esac
    source=gemini-notification
    ;;
  *) exit 0 ;;
esac

d=${AM_INPUT_REQUIRED_DIR:-/tmp/am-input-required}
mkdir -p "$d" 2>/dev/null || exit 0
if [ -n "$clear" ]; then
  file="$d/$AM_ID.json"
  [ "$(jq -r '.runId // empty' "$file" 2>/dev/null)" = "$AM_RUN_ID" ] || exit 0
  [ "$(jq -r '.cli // empty' "$file" 2>/dev/null)" = "$AM_CLI" ] || exit 0
  rm -f "$file"
  exit 0
fi
at=$(( $(date +%s) * 1000 ))
tmp="$d/$AM_ID.json.$$.tmp"
jq -n --arg amId "$AM_ID" --arg runId "$AM_RUN_ID" --arg cli "$AM_CLI" \
  --arg kind "$kind" --arg source "$source" --argjson at "$at" \
  '{amId:$amId,runId:$runId,cli:$cli,kind:$kind,source:$source,at:$at}' > "$tmp" 2>/dev/null \
  && mv -f "$tmp" "$d/$AM_ID.json"
exit 0
