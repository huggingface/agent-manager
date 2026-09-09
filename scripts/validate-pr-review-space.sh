#!/usr/bin/env bash
# Run each reviewed PR's regressions in isolated checkouts on the test Space.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
result_dir="$(mktemp -d /tmp/am-pr-validation-results-XXXXXX)"
printf 'Results: %s\n' "$result_dir"
cd "$root/server"
npm ci --no-audit --no-fund > "$result_dir/install-server.log" 2>&1
cd "$root/web"
npm ci --no-audit --no-fund > "$result_dir/install-web.log" 2>&1
cd "$root"
failed=0
run_suite() {
  local label="$1" directory="$2"; shift 2
  if (cd "$directory" && "$@") > "$result_dir/$label.log" 2>&1; then
    printf 'PASS %s\n' "$label"
  else
    printf 'FAIL %s\n' "$label"
    tail -35 "$result_dir/$label.log"
    failed=1
  fi
}
for pair in \
  '80 agent/fix-live-reader-updates' \
  '108 agent/support-local-installations' \
  '109 feat/workspace-context-files' \
  '112 fix/case-insensitive-session-lookup' \
  '113 feat/fx-cli'; do
  read -r number branch <<< "$pair"
  git fetch --quiet origin "$branch"
  checkout="$result_dir/pr-$number"
  git worktree add --quiet --detach "$checkout" FETCH_HEAD
  ln -s "$root/server/node_modules" "$checkout/server/node_modules"
  ln -s "$root/web/node_modules" "$checkout/web/node_modules"
  printf 'PR %s commit %s\n' "$number" "$(git -C "$checkout" rev-parse HEAD)"
  case "$number" in
    80)
      run_suite pr80-server "$checkout/server" node test/trace-window.test.mjs
      run_suite pr80-model "$checkout/web" node test/readerModel.test.mjs
      run_suite pr80-browser "$checkout/web" node test/traceWindows.test.mjs
      ;;
    108)
      run_suite pr108-local "$checkout/server" node test/local-install.test.mjs
      run_suite pr108-opencode "$checkout/server" node test/opencode-resume.test.mjs
      ;;
    109) run_suite pr109-context "$checkout/server" node test/context-files.test.mjs ;;
    112)
      run_suite pr112-names "$checkout/server" node test/agent-list.test.mjs
      run_suite pr112-groups "$checkout/server" node test/spawn-group.test.mjs
      run_suite pr112-crons "$checkout/server" node test/crons.test.mjs
      run_suite pr112-api "$checkout/server" node test/cron-api.test.mjs
      ;;
    113)
      run_suite pr113-process "$checkout/server" node test/fx-process.test.mjs
      run_suite pr113-digest "$checkout/server" node test/fx-digest.test.mjs
      run_suite pr113-resume "$checkout/server" node test/fx-resume.test.mjs
      run_suite pr113-checkpoint "$checkout/server" node state-checkpoint.test.mjs
      ;;
  esac
done
run_suite integration-server "$root/server" npm test
run_suite integration-web "$root/web" npm test
run_suite integration-build "$root/web" npm run build
printf 'AM_PR_VALIDATION_EXIT=%s RESULTS=%s\n' "$failed" "$result_dir"
exit "$failed"
