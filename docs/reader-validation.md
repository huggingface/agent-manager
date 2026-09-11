# Reader redesign: validation

Validated on 2026-09-04, based on main `705e32dc`.

## Regression coverage

| Problem / contract | Implementation | Evidence |
| --- | --- | --- |
| Opening an existing reader briefly shows working | Reader never mounts a terminal/WebSocket or claims/resizes the PTY; the working line uses transcript activity | Real TerminalPane fixture: no socket on mount or activation, no working line for a completed trace even when session state says working |
| Small tails miss lifecycle markers | Matching full summaries supply authoritative activity; newer revisions invalidate it | Null/carried window activity gives way to matching summary; newer waiting event overrides old summary; full Claude summaries report both working and waiting |
| A long-open reader stays loading | Shared store has deadlines, cancellation, retry/backoff, visibility and page-restore recovery | Hanging initial request times out at 12 seconds even when abort does not settle it; explicit retry succeeds; existing visibility/frozen-summary tests pass |
| Earlier paging competes with a refresh | Explicit backward paging cancels the lower-priority poll | Earlier stays enabled during a hung refresh; late canceled response cannot advance the cursor or overwrite history |
| One hung group pane blocks others | Removed focused-first readiness gate | Hung leader and independently readable follower render together; both retain usable composers |
| Terminal bleeds in from below | Mutually exclusive surfaces, clipped non-scrolling host, scroller-local navigation | Search + resize/zoom at 1000×300, 390×844 and 844×390; host scroll offset stays zero and the reader covers its bottom edge |
| A first prompt requires terminal mode | Composer is outside loading/empty/error branches | `no-trace` fixture sends its first prompt from reader without a terminal socket |
| Returning refetches/rebuilds everything | Retained store, incremental refresh, inactive LRU | Switching A/B/A preserves A's history and makes no second tail request; returning to manually read history restores the same row and offset within 2 px |
| Reading older text jumps on updates | Measured keyed row anchor; explicit latest action; pending targets survive programmatic scroll events until measurement | Varied-height answers preserve row and pixel offset within 2 px through append, prepend and remount |
| Clearing search loses the reading position | Capture the original anchor before the filtered list commits | A search excluding the original row restores that row and its offset within 2 px when cleared |
| Long history/search becomes expensive | Measured render window, cached text index, shared outcome index | 500 exchanges and an all-matching query each mount fewer than 60 rows; a 1,000-message outcome scan happens once across 500 exchanges |
| Tool results, native fragments and final markers split across requests | Pure immutable reconciliation by tool/message identity | Forward and backward split points converge on the same conversation; no duplicated answer; unresolved tool is not marked successful |
| Queue records split across pages or cause idle rendering churn | Replay enqueue/dequeue/remove events with stable derived blocks | Removed prompt retains enqueue position; consumed prompt does not reappear; unchanged queued history preserves array/turn identity |
| Codex catch-up loses a prior completion or skips a large backlog | v2 keeps lifecycle events and pages continuously | Prior task completion survives before next task; >8 MiB backlog is read continuously in requested 32 KiB pages, without gaps or duplicate messages |
| Trace replaced/truncated under cursor | Source generation and explicit reset notice | Replacement discards stale content and reports a reset |
| SQLite streaming remains stale | WAL-aware revisions, visible index polling, mutable replacement range | Real OpenCode WAL-only update leaves main DB mtime/size unchanged but refresh returns the updated same-index message |
| Whole-file reads repeat across readers | Bounded multi-entry cache and in-flight deduplication | Concurrent A reads parse once; A/B/A parses twice, not three times |
| Live windows repeatedly parse full summaries | Five-minute automatic revalidation floor; explicit refresh bypass | Ten simulated minutes of writes produce three full summaries; explicit refresh can request a fourth |
| Metadata-only touches throw away loaded history | Generation ignores ctime-only changes | Stable generation/revision under a metadata-only touch; rewrite/shrink detection still works |
| Child history stops at a fixed tail or includes inherited parent text | Shared store, child paging and logical fork boundary; child opens at top of a 2 MiB context window | Child task is visible on opening; larger children disclose missing context and support paging; server backward-page fixture stops at the handoff |
| Operator HTML/XML disappears as harness text | Named harness envelopes in parser and exchange grouping instead of every leading `<` | `<div>Please review this markup</div>` remains a user prompt and opens a prompt band |
| Existing UI contracts | Retained shared composer, attachment flow and info panel | Full-app reader-info, attachment-input and terminal UI integration suites pass |

## Initial history (issue #129)

Added 2026-09-09, on main `ef08e843`.

| Problem / contract | Implementation | Evidence |
| --- | --- | --- |
| A cold reader shows one or two exchanges | Bounded backward fill to ~20 exchanges after the first paint, counted in exchanges; indexed sources get a first-window floor | Tool-heavy JSONL fixture goes from 2 exchanges to 22 with no scrolling, search or summary; a 40-exchange OpenCode database goes from 1 to 20 in its first window |
| Counting records instead of conversation | `countExchanges` shares `isOperatorPrompt` with the grouping | Nine fixture shapes assert `countExchanges === splitExchanges().length`, including a transcript starting mid-exchange and harness envelopes that are not prompts |
| A fill that cannot finish keeps trying | Request/byte/time budgets, plus start-of-source, blocked and no-progress stops | 900 KiB answers stop on the byte budget at ≤6 backward reads; a blocked cursor and a cursor that answers without advancing each stop after one retry, and neither claims the beginning of the conversation |
| Preload competes with the reader | One request slot, 50 ms between steps, opt-in per consumer, cancelled on release | Composer and first text stay available under a 60 s hung summary; releasing a reader mid-fill stops it within one step; no child reader is created by a parent preload |
| A warm return re-runs the preload | Budget and target are per transcript, not per mount | Remount after a completed fill issues zero further backward reads and keeps its history |
| The first page does not fill the reader | The view raises the target while MEASURED rows have not covered the scroller's content box | 20 one-line exchanges leave a 2600 px reader uncovered; it continues to 94 and covers it, in one extra backward read |
| Covering the page is mistaken for having history | Coverage and the exchange target are separate criteria | One 140-line answer covers the reader at 2 exchanges; the fill still reaches 22 |
| Older history pushes visible text down | Position re-asserted in the same frame as the size change; transcript shorter than the window grows from the bottom | 0.69 px maximum anchor displacement over 110 frames while filling; 0.51 px across the underfilled→scrollable transition over 72 frames; a genuine live append still moves the view 77 px, which is Latest working |
| Latest quietly stops following mid-preload | Corrections land before the scroll event that reports them | Latest is claimed on every one of 110 frames during the fill |

### Review round (2026-09-09)

| Finding | Fix | Evidence |
| --- | --- | --- |
| The whole-conversation half of #129 was absent | Server scan endpoint, an explicit Reader action, and an old-hit window separate from the live store | A term in exchange 0 of a 120-exchange transcript, with 10 exchanges loaded: one click finds it, one read opens it, and the reader's place is restored on the way back |
| The first PRESENTED viewport was still the first response | Rows are laid out and measured but not painted until they cover the reader, bounded four ways | The frame the transcript first becomes visible on is asserted covered, on a fixture whose first window is two exchanges and whose older pages are slow |
| A forward read waited behind speculative history | A forward read cancels an in-flight speculative page instead of inheriting its promise; the abandoned step is uncharged and restartable | With a 300 ms backward page in flight, `loadNewer()` issues an `after` request rather than resolving with the backward one |
| The documented byte limit was not a limit | A speculative page asks for a floor of one message, so the server cannot grow it past one record; the step is charged before the next is scheduled | On 900 KiB answers: largest page 1.5 MiB (was 6), retained 4.4 MiB against a 3 MiB budget plus the page that crossed it, in four requests |

Two further defects surfaced while testing the fix, both fixed here: the virtual
list kept correcting the scroller while its own rows were hidden behind an old
window (every box measures zero, so it scrolled the borrower to the top), and
scrolling inside a borrowed window could make the live transcript page backward.

Removing each mechanism fails a named assertion: no fill → “only 2 exchanges
became available on their own”; no same-frame re-placement → “Latest is still
the bottom”; no bottom-growth → 454 px of displacement; no coverage request →
uncovered 2600 px reader; no indexed floor → “1 prompts in 2 messages”; a
counter that ignores a leading exchange → the grouping comparison; no
whole-history scan → the results never appear; a hit opened as a tail → “opened
with the locator the search handed back”; no run token → “the newest query owns
the results”; always claiming a complete scan → the partial-coverage line never
appears; no clipped disclosure → its line never appears; a server scan limited
to one page → “found the needle far outside the tail (0 hits)”; a database scan
that ignores the conversation id → the neighbouring conversation leaks in; the
virtual list not standing down while hidden → “the old window opens on its
match”; no remembered position → the row returns 704px away instead of 0.

### Measurements

Same fixtures, before and after, Chromium at 1000×760. “Before” is main's source
with the same tests.

| Fixture | Exchanges after settling | First viewport filled | Max anchor drift | Backward reads | Bytes | Composer ready |
| --- | --- | --- | --- | --- | --- | --- |
| Tool-heavy, 90 KiB/exchange | 2 → **22** | 28% → **100%** | 0 → 0.69 px | 0 → 5 | 128 KiB → 2.0 MiB | 68 → 61 ms |
| Large JSONL, 20 KiB answers | 50 → **200** | 100% → 100% | 0 → 0.13 px | 0 → 1 | 128 KiB → 509 KiB | 28 → 19 ms |
| Ordinary small turns | 200 → 200 | 100% → 100% | 0 → 0.31 px | 0 → 0 | 117 KiB → 117 KiB | 26 → 20 ms |
| OpenCode database, 40 exchanges | 1 → **20** (first window) | — | — | 0 → 0 | — | — |

Time to a usable composer and to the first transcript paint are unchanged: the
first window is the same request it always was. “Before” drift is zero because
nothing arrives to displace anything, not because the old path was stable — the
displacement this fixes is a property of prepending, which nothing did
automatically before. Regression budgets for the tool-heavy fixture: ≥20
exchanges, viewport covered, ≤2 px drift, ≤6 backward reads, ≤3 MiB.

## Runs

- Web: `npm run build`, `npm test` (23 suites), `npm run test:render`.
  For #129, re-run: `npm test` (26 suites), `npm run test:render`, `npm run build`.
- Server: all 27 non-cron default suites passed. This includes trace windows,
  queued prompts, child traces, protocol regressions, attachments, permissions,
  migration, resize and state checkpoint tests.
  For #129, re-run: every suite individually (the runner still stops at the cron
  failure below); 30 passed, `test/crons.test.mjs` failed, unchanged from main.
- Full-app browser integration: `reader-info.test.mjs`,
  `screenshot-input.test.mjs`, `terminal-ui.test.mjs`, using the production build.
- Final targeted rerun: reader model/browser/protocol, legacy trace windows and
  child traces; TypeScript and `git diff --check`.
- Browser fixtures use synthetic transcript/API data; integration suites use
  isolated test servers and fixture sessions. The regression fixtures prompted
  or restarted no production session, and the application was not deployed.

`npm test` in server is not fully green: `test/crons.test.mjs`, “run on restart
fires once for enabled running jobs, not stopped ones”, receives an extra
`schedule` trigger. The identical failure was reproduced on unchanged main
`705e32dc`; cron code is untouched. The suite runner stops at that failure, so
the remaining suites were run explicitly. The Vite build also retains its
existing large-chunk warning.

## Scope / follow-ups

The independent review and all dispositions are recorded in
[reader-review-followup.md](reader-review-followup.md).

See [bounds and tradeoffs](reader-architecture.md#bounds-and-tradeoffs). In
particular, SQLite still uses a synchronous full-conversation parser, search is
loaded-history search, and native browser Find/selection only sees mounted rows.
Testing used Chromium, not an actual long-suspended iOS Safari process. The tests
exercise the browser lifecycle events and frozen-request behavior deterministically.

This work overlaps with PR #80's WAL/polling/mutable-tail fixes. It implements
those requirements within the new v2/store contract rather than stacking another
polling path on the old hook. The PRs need coordinated merging; #80 was not
modified or closed by this change.
