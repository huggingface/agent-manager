# Reader review follow-up

The `reader-traces` agent independently reviewed PR #119 at `88c44f5` against
`705e32d`. Its original report is retained in the shared workspace at
`/data/workspaces/agent-manager/reader-pr119-review.md`. This table records the
decisions and regression coverage added to the PR, including additional defects
found while integrating the review.

| Finding | Decision / change | Regression evidence |
| --- | --- | --- |
| H1: Metadata-only file changes reset readers | Fixed. Revisions ignore ctime; shrinking and same-size mtime rewrites remain distinct replacement signals. | Synthetic stat changes preserve generation/revision for a ctime-only touch, but reset on rewrite/shrink and preserve generation on append. |
| M1: Whole-file summaries repeat every 30 seconds | Reduced. Automatic revalidation has a five-minute floor after the first successful summary. Explicit refresh bypasses that floor. The full-parser cost remains a follow-up, not a claim of incremental parsing. | Simulated ten minutes of continuous revision changes make three summary requests, not twenty; explicit refresh makes the fourth immediately. |
| M2: Backward paging is swallowed by an in-flight poll | Fixed. Explicit backward paging cancels the lower-priority forward request; controls remain usable during refresh. Accepted cursors never advance from canceled responses. | Model test resolves the canceled poll late without importing it; browser test loads earlier history while refresh hangs. |
| M3: Child expansion opens at the tail, hiding the task | Adjusted. Children open at the top of a bounded 2 MiB initial context window. Following the tail is an explicit Latest action. Larger children disclose unloaded history and offer backward paging. | Actual child expansion starts at scrollTop 0 with the task rendered; a larger-child fixture discloses the missing context and can page back to its task. |
| L1: Warm return can animate stale working state | Fixed. Retained transcript activity is unconfirmed after release and on failed reads; a successful forward read reaching the end confirms it again. | A reader left working, then reopened with a hung refresh, keeps its text but displays no working line. |
| L2: Metadata equality serializes the full prompt index | Fixed. Top-level field comparison replaces JSON serialization in metadata merging/head publication. | A 10,000-entry summary index is never serialized during head comparison. |
| L3: Active readers consume the inactive cache's entry budget | Fixed. Both eviction count and byte budget apply only to inactive stores. | Eight active stores do not evict a warm inactive store; excess inactive entries still evict oldest first. |
| L4: Positional fallback keys are fragile under prepending | Clarified. v2 reader records always carry stable IDs. The fallback is documented as legacy snapshot behavior, not a paging contract. | Existing byte/index identity and prepend tests remain the live-path coverage. |
| Unchanged queued prompts rebuild derived turns | Fixed. Reconciliation reuses unchanged queued text blocks and turn identities. | Replaying the same queue history returns the same array and turns. |
| A small tail masks complete lifecycle metadata | Fixed. Matching-revision summaries supply authoritative activity; full Claude summaries compute it too. | Null/carried window activity yields to matching summary; newer revisions invalidate old activity. |
| Search overwrites the original reading anchor | Fixed. Capture the anchor before filtering commits, not in a post-filter effect. | Clearing a query that excludes the original row restores that row and pixel offset. |
| Restoring inside a tall answer lands in the next answer | Fixed. Programmatic scroll events no longer cancel an unmeasured semantic target; fresh user input still can. | Varied-height browser fixture restores the same manually read row and pixel offset after remount. |
| Frontend still rejects every `<`-leading prompt | Fixed. Exchange grouping recognizes the same named harness envelopes as the parser. | Operator HTML becomes a prompt band; a task-notification does not. |

## Remaining boundaries

- The five-minute summary floor reduces background CPU, but JSONL summaries and
  database reads still use full parsers. A source larger than the server cache's
  64 MiB budget is not retained there. Query-level paging/incremental summaries
  or worker offload remain separate work.
- A 2 MiB child window is not guaranteed to include the task in a larger child.
  Automatically finding a fork's true beginning requires safe boundary discovery
  through inherited history. This change keeps reads bounded, discloses the gap,
  and supports explicit paging instead of scanning that prelude before opening.
- Same-size rewrites are detectable only when the filesystem exposes a changed
  mtime. Bucket-backed filesystems can preserve timestamps across writes; the
  generation protocol is not content-addressed. Metadata-only changes must not
  be treated as proof that content was replaced.
- Retained working indicators wait for fresh confirmation on return. This may
  briefly omit a still-working indicator, deliberately favoring no stale work
  animation over an optimistic status guess. Retained text remains available.

## Validation

The follow-up extends `readerModel.test.mjs`, `readerRedesign.test.mjs`, and
`reader-protocol.test.mjs`. The browser fixture now uses varied-height answers
throughout its search, paging and remount checks, rather than uniform rows.
See [reader-validation.md](reader-validation.md) for the broader PR coverage and
the unrelated baseline cron-suite failure.

Final follow-up run: production build, all 23 web suites, four render suites,
six trace-related server suites, full-app `reader-info.test.mjs`, and
`git diff --check` passed. The build retains its existing large-chunk warning.
