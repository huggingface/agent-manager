# Reader redesign: validation

Validated on 2026-09-04, based on main `705e32dc`.

## Regression coverage

| Problem / contract | Implementation | Evidence |
| --- | --- | --- |
| Opening an existing reader briefly shows working | Reader never mounts a terminal/WebSocket or claims/resizes the PTY; the working line uses transcript activity | Real TerminalPane fixture: no socket on mount or activation, no working line for a completed trace even when session state says working |
| A long-open reader stays loading | Shared store has deadlines, cancellation, retry/backoff, visibility and page-restore recovery | Hanging initial request times out at 12 seconds even when abort does not settle it; explicit retry succeeds; existing visibility/frozen-summary tests pass |
| One hung group pane blocks others | Removed focused-first readiness gate | Hung leader and independently readable follower render together; both retain usable composers |
| Terminal bleeds in from below | Mutually exclusive surfaces, clipped non-scrolling host, scroller-local navigation | Search + resize/zoom at 1000×300, 390×844 and 844×390; host scroll offset stays zero and the reader covers its bottom edge |
| A first prompt requires terminal mode | Composer is outside loading/empty/error branches | `no-trace` fixture sends its first prompt from reader without a terminal socket |
| Returning refetches/rebuilds everything | Retained store, incremental refresh, inactive LRU | Switching A/B/A preserves A's history and makes no second tail request |
| Reading older text jumps on updates | Measured keyed row anchor; explicit latest action | Append and prepend preserve the same row and its pixel offset within 2 px |
| Long history/search becomes expensive | Measured render window, cached text index, shared outcome index | 500 exchanges and an all-matching query each mount fewer than 60 rows; a 1,000-message outcome scan happens once across 500 exchanges |
| Tool results, native fragments and final markers split across requests | Pure immutable reconciliation by tool/message identity | Forward and backward split points converge on the same conversation; no duplicated answer; unresolved tool is not marked successful |
| Queue records split across pages | Replay enqueue/dequeue/remove events | Removed prompt retains enqueue position; consumed prompt does not reappear |
| Codex catch-up loses a prior completion or skips a large backlog | v2 keeps lifecycle events and pages continuously | Prior task completion survives before next task; >8 MiB backlog is read continuously in requested 32 KiB pages, without gaps or duplicate messages |
| Trace replaced/truncated under cursor | Source generation and explicit reset notice | Replacement discards stale content and reports a reset |
| SQLite streaming remains stale | WAL-aware revisions, visible index polling, mutable replacement range | Real OpenCode WAL-only update leaves main DB mtime/size unchanged but refresh returns the updated same-index message |
| Whole-file reads repeat across readers | Bounded multi-entry cache and in-flight deduplication | Concurrent A reads parse once; A/B/A parses twice, not three times |
| Child history stops at a fixed tail or includes inherited parent text | Shared store, child paging and logical fork boundary | Server backward-page fixture stops at the child handoff; existing Claude/Codex fork tests pass |
| Operator HTML/XML disappears as harness text | Named harness envelopes instead of every leading `<` | `<div>Please review this markup</div>` remains a user prompt |
| Existing UI contracts | Retained shared composer, attachment flow and info panel | Full-app reader-info, attachment-input and terminal UI integration suites pass |

## Runs

- Web: `npm run build`, `npm test` (23 suites), `npm run test:render`.
- Server: all 27 non-cron default suites passed. This includes trace windows,
  queued prompts, child traces, protocol regressions, attachments, permissions,
  migration, resize and state checkpoint tests.
- Full-app browser integration: `reader-info.test.mjs`,
  `screenshot-input.test.mjs`, `terminal-ui.test.mjs`, using the production build.
- Final targeted rerun: reader model/browser/protocol, legacy trace windows and
  child traces; TypeScript and `git diff --check`.
- Browser fixtures use synthetic transcript/API data; integration suites use
  isolated test servers and fixture sessions. No production session was prompted
  or restarted, and the application was not deployed.

`npm test` in server is not fully green: `test/crons.test.mjs`, “run on restart
fires once for enabled running jobs, not stopped ones”, receives an extra
`schedule` trigger. The identical failure was reproduced on unchanged main
`705e32dc`; cron code is untouched. The suite runner stops at that failure, so
the remaining suites were run explicitly. The Vite build also retains its
existing large-chunk warning.

## Scope / follow-ups

See [bounds and tradeoffs](reader-architecture.md#bounds-and-tradeoffs). In
particular, SQLite still uses a synchronous full-conversation parser, search is
loaded-history search, and native browser Find/selection only sees mounted rows.
Testing used Chromium, not an actual long-suspended iOS Safari process. The tests
exercise the browser lifecycle events and frozen-request behavior deterministically.

This work overlaps with PR #80's WAL/polling/mutable-tail fixes. It implements
those requirements within the new v2/store contract rather than stacking another
polling path on the old hook. The PRs need coordinated merging; #80 was not
modified or closed by this change.
