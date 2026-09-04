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

## Verification

Regression fixtures cover empty first send, hanging and failed requests, source
switches and replacement, warm remount, cross-window tool/message/queue/final
events, mutable SQLite records, bounded forward catch-up, child refresh, long
history rendering/search, and outer-scroll containment. Existing trace, Markdown,
attachment, input-required, and terminal tests remain part of the contract.

No transcript contents are emitted as diagnostics. No new runtime framework is
needed: the store uses immutable snapshots and React's external-store adapter.

## Bounds and tradeoffs

- Initial read: 128 KiB / two transport messages. Ordinary pages: 384 KiB;
  the server can extend a page to finish a record, up to its existing 8 MiB
  ceiling. Forward catch-up preserves every intervening page, including backlogs
  larger than that ceiling. Oversized records produce an explicit recovery state.
- Window and summary requests time out after 12 seconds. Failed reads back off
  to 30 seconds. Visible readers poll every 3–10 seconds; SQLite uses 10 seconds.
  Hidden/inactive readers cancel outstanding requests and do not poll. A browser
  visibility return, persisted page restore or network return recovers the read.
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
  inode/header changes, observed shrinking and same-size rewrites. An unobserved
  truncate-and-regrow with the same header/inode can still require a full browser
  reload; this is not a content-addressed log protocol.
- Search means loaded content, not a server-side search of the entire trace. It
  navigates matching turns, not every individual highlighted word. Virtualization
  also means native browser Find, selection and accessibility traversal see the
  mounted stretch; use reader search or the raw download for full-history work.
- Working is based on Codex task events and Claude message/stop-reason evidence,
  gated by the session process still being alive. Unknown activity is not promoted
  to working from a terminal repaint. Other formats can add explicit activity
  adapters without changing the store or view.
- Switching back to terminal reconnects to the backend's preserved canonical
  output. Local terminal selection and scroll position are not retained across a
  mode switch. Existing terminal-to-terminal warm navigation is unchanged.
