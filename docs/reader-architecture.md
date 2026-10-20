# Reader architecture

The reader is a conversation client, not a terminal overlay. Opening it must not
start, focus, claim, resize, or otherwise interact with a PTY. The composer is
available before a transcript exists and survives transcript failures.

## Ownership

- The server owns source identity and bounded, continuous transport windows.
  Version 2 windows retain cross-window message identities and lifecycle events;
  independently parsed fragments are not assumed to be complete messages.
- `ReaderStore` owns retained transcript fragments, reconciliation, requests,
  deadlines, retries, metadata and change notifications. React mounting is not
  the lifetime of the conversation. A bounded inactive-store cache makes return
  navigation warm; no inactive store polls.
- The hook is a React subscription and visibility adapter, shared by session,
  file and child readers. Transport freshness is not agent task activity.
- The conversation view owns selection, search, disclosure and a semantic scroll
  anchor. Only its reading area scrolls. The composer and recovery controls are
  outside that area. Long histories have a bounded rendered window.

## Contracts

1. A first read can be loading, empty, ready or failed. All four have a usable
   writable composer. `no-trace` is empty, not a broken session.
2. Every request has a deadline, cancellation and generation guard. Cancellation
   cannot leave a busy latch behind. Retry retains the last successful content.
3. Forward catch-up is paginated; it never silently jumps to the tail. Source
   replacement is explicit and disclosed. Byte cursors include source generation.
4. Reconcile message fragments and tool results by identity across both prepend
   and append. Queue and final-answer events can refer to earlier windows.
5. Poll visible database readers too. Their mutable tail is a replacement range,
   and cache revisions include the WAL, not just the main database file.
6. Compute conversation-wide outcomes once per data version, not once per row.
   Search indexes plain text separately from mounted Markdown highlights.
7. Preserve manual reading intent. Appends offer a jump-to-latest action; they do
   not pull a reader away from older content. Search scrolls the reader, never an
   ancestor. Terminal and reader are mutually exclusive rendering surfaces.
8. A redraw is not model work. The reader's activity indicator uses transcript
   evidence; transport state and terminal-derived session state stay distinct.
9. A cold reader loads a useful amount of recent conversation on its own, in
   bounded background steps after the first paint, counted in exchanges rather
   than transport records. It is opt-in per consumer: children and previews keep
   their own policy. A count is a target, not a promise — budgets, the start of
   the conversation, or a cursor that cannot advance end the fill, and the
   remaining history stays disclosed behind `Load earlier turns`.
10. History arriving must not move text that is already on screen. The reading
   position is re-asserted in the same frame as the size change that would
   otherwise displace it, and a transcript shorter than the window grows upward
   from the bottom rather than downward from the top. The first transcript a
   cold reader PRESENTS is held back — laid out and measured, not painted —
   until it covers the reader or until one of four bounds ends the wait.
11. Search has two scopes. Typing filters the loaded stretch, instantly and
   locally, as it always has. Searching the whole conversation is a separate,
   explicit action, because it reads the transcript: nothing scans on a
   keystroke or on mount. Both search the same content, so they cannot disagree
   about what counts as conversation.
12. Opening an old result is a read, not a move. It fetches one bounded window
   named by the result itself and shows it beside the live history rather than
   inside it: the live cursor does not advance, nothing is spliced, the reader's
   place is remembered before the window opens and restored when it closes, and
   nothing about it starts, claims, resizes or types into a terminal.
13. Speculative work yields. A forward read — Latest, refresh, the live poll —
   never waits behind an automatic backward page.

## Verification

Regression fixtures cover empty first send, hanging and failed requests, source
switches and replacement, warm remount, cross-window tool/message/queue/final
events, mutable SQLite records, bounded forward catch-up, child refresh, long
history rendering/search, and outer-scroll containment. Initial history has its
own two suites: `web/test/readerHistory.test.mjs` drives the store against a
source that honours `bytes`/`min` (budgets, blocked and stalled cursors, warm
return, release), and `web/test/readerFirstViewport.test.mjs` drives the real
reader in a browser and measures viewport coverage and per-frame anchor
displacement. `server/test/trace-index-history.test.mjs` covers the indexed
first window and conversation isolation inside one database. Existing trace, Markdown,
attachment, input-required, and terminal tests remain part of the contract.

No transcript contents are emitted as diagnostics. No new runtime framework is
needed: the store uses immutable snapshots and React's external-store adapter.

## Bounds and tradeoffs

- Initial history: about 20 recent exchanges, or all of a shorter conversation,
  paged in after the first response at one backward page per 50 ms. Bounded by
  six backward requests, ~3 MiB RETAINED (indexed rows charged at an assumed
  4 KiB each) and 20 seconds per continuous run, whichever comes first. Retained
  rather than read: a page's size is not knowable before fetching it, so the
  request that crosses the budget is the last one. What bounds a single read is
  the message floor a speculative page asks for — one, the smallest that still
  guarantees progress — which stops the server growing a response beyond a
  single oversized record. Left to the server's own default of twelve, one page
  of 900 KiB answers grew to six megabytes.
- First paint holds until the transcript is worth showing, for at most two
  seconds, and ends earlier on coverage, the start of the conversation, an
  unusable source or an exhausted fill. The composer is never part of the wait
  and a warm store is never hidden.
- Whole-conversation search: 256 KiB scan pages, at most 40 pages, 12 MiB or
  four seconds per request, 50 matching messages per page, and a 200-character
  query. Longer conversations are more bounded requests, continued with a cursor
  that is a page boundary, so continuing can neither repeat nor skip a match. The
  scan runs newest-first from the size read when the request started, so output
  appended while it runs is outside that request rather than something it chases.
  Results carry the window that opens them; opening one is a single read.
  Matching is literal and case-insensitive over the text the reader displays —
  prompts, assistant text, thinking, tool names, tool input and output, shell
  commands and their streams — and never image data or transport metadata. Where
  a parser clipped a long block, the scan says so instead of implying it read
  what was cut. The view may raise the target, up
  to 60 exchanges, while a page of MEASURED conversation has not yet covered the
  scroller — twenty one-line exchanges do not fill a tall window, and one long
  answer fills it without providing any history, so the two criteria run
  separately. Estimated row heights and spacer divs do not count as coverage.
  The budget is spent once per transcript: a warm remount finishes an unfinished
  fill and does not restart a completed or exhausted one.
- Initial read: 128 KiB / two transport messages. Ordinary pages: 384 KiB;
  the server can extend a page to finish a record, up to its existing 8 MiB
  ceiling. Forward catch-up preserves every intervening page, including backlogs
  larger than that ceiling. Oversized records produce an explicit recovery state.
  Child readers use a bounded 2 MiB initial window, open at its top, and disclose
  when earlier context (including the task) still needs paging. Latest opts into
  following the child tail. They do not take part in automatic history fill.
  An INDEXED source treats the first-paint floor as a floor rather than an exact
  count: it has no span to grow and has already parsed the whole conversation, so
  returning two rows of it saved nothing and showed one exchange. Backward paging
  from an indexed source still honours the requested page size exactly.
- Window and summary requests time out after 12 seconds. Failed reads back off
  to 30 seconds. Visible readers poll every 3–10 seconds; SQLite uses 10 seconds.
  Hidden/inactive readers cancel outstanding requests and do not poll. A browser
  visibility return, persisted page restore or network return recovers the read.
  Explicit backward paging takes priority over a background forward poll.
  Summaries load after the first paint, then revalidate at most once every five
  minutes automatically; explicit refresh bypasses that floor.
- Retain up to eight stores / approximately 32 MiB of inactive transcript data.
  Active history grows only as pages are requested. This is not an on-disk
  transcript cache. A cold reload still restores a remembered position by paging
  up to six times; failure to locate it is disclosed instead of silent.
- Server full-parse cache: eight entries / 64 MiB of source bytes, with concurrent
  requests for the same revision sharing one parse. This is a source-size budget,
  not an exact JavaScript heap limit. Database reads still use the existing
  synchronous full-conversation parser; moving that work into query-level paging
  or a worker is a separate optimization.
- SQLite replaces the last 100 loaded message positions during refresh, catching
  mutable streaming messages without duplicating them. Arbitrary edits to older
  database rows are outside that live-tail contract. JSONL generations detect
  inode/header changes, observed shrinking and same-size rewrites with a changed
  mtime. Metadata-only ctime changes do not reset the reader. Bucket-backed
  filesystems may preserve timestamps across writes, making a same-size rewrite
  undetectable from stats alone. An unobserved
  truncate-and-regrow with the same header/inode can still require a full browser
  reload; this is not a content-addressed log protocol.
- Search has the two scopes above. The instant filter still means loaded content,
  and still says so. The explicit scope reads the whole transcript on the server
  and returns places to jump to, not a second transcript: it navigates matching
  messages, not every highlighted word, and a result opens roughly thirty
  exchanges of context ending on the match. Bundle and child surfaces keep their
  existing behaviour; no new search entry point was added to them. Virtualization
  still means native browser Find, selection and accessibility traversal see the
  mounted stretch.
- Working is based on Codex task events and Claude message/stop-reason evidence,
  gated by the session process still being alive. Unknown activity is not promoted
  to working from a terminal repaint. Other formats can add explicit activity
  adapters without changing the store or view.
  Retained activity is unconfirmed after leaving the reader or a failed read;
  returning does not animate old working state before a successful refresh.
- Switching back to terminal reconnects to the backend's preserved canonical
  output. Local terminal selection and scroll position are not retained across a
  mode switch. Existing terminal-to-terminal warm navigation is unchanged.
