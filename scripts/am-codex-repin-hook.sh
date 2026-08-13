#!/bin/sh
# Managed Codex SessionStart hook. stdin contains the exact session_id,
# transcript_path, cwd and source (startup/resume/clear/compact).
[ "$AM_CLI" = "codex" ] || exit 0
[ -n "$AM_ID" ] || exit 0
case "$AM_ID" in *[!a-zA-Z0-9_-]*) exit 0 ;; esac
[ -n "$AM_RUN_ID" ] || exit 0
case "$AM_RUN_ID" in *[!a-zA-Z0-9_-]*) exit 0 ;; esac
case "$AM_PANE_PID" in '' | *[!0-9]*) exit 0 ;; esac

# Usually the pane root is Codex's npm launcher and native Codex is its direct
# child. The resume compatibility command retains bash, making the node launcher
# a direct child and native Codex a grandchild. Accept that one known layer; a
# nested Codex has a tool shell above its launcher and cannot pass this check.
p=$$
trusted=0
codex_pid=0
hops=0
while [ "$p" -gt 1 ] 2>/dev/null && [ "$hops" -lt 64 ]; do
  stat=$(cat "/proc/$p/stat" 2>/dev/null) || break
  comm=${stat#*(}
  comm=${comm%)*}
  rest=${stat##*) }
  rest=${rest#* }
  ppid=${rest%% *}
  case "$comm" in
    codex*)
      if [ "$p" = "$AM_PANE_PID" ] || [ "$ppid" = "$AM_PANE_PID" ]; then
        trusted=1
      else
        parent_stat=$(cat "/proc/$ppid/stat" 2>/dev/null) || parent_stat=
        parent_comm=${parent_stat#*(}
        parent_comm=${parent_comm%)*}
        parent_rest=${parent_stat##*) }
        parent_rest=${parent_rest#* }
        grandparent=${parent_rest%% *}
        if [ "$parent_comm" = "node" ] && [ "$grandparent" = "$AM_PANE_PID" ]; then trusted=1; fi
      fi
      codex_pid=$p
      break
      ;;
  esac
  p=$ppid
  hops=$((hops + 1))
done
[ "$trusted" -eq 1 ] || exit 0

d="${AM_REPIN_DIR:-/tmp/am-repin}"
mkdir -p "$d" 2>/dev/null || exit 0
{
  printf '{"amId":"%s","runId":"%s","cli":"codex","codexPid":%d,"payload":' "$AM_ID" "$AM_RUN_ID" "$codex_pid"
  cat
  printf '}'
} > "$d/$AM_ID.codex.json.$$.tmp" 2>/dev/null && mv -f "$d/$AM_ID.codex.json.$$.tmp" "$d/$AM_ID.codex.json"
exit 0
