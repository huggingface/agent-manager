# Agent state checkpoints

## Problem

The Space's `/data` volume is an hf-mount FUSE view over mutable object
storage, not a POSIX disk. Its default streaming writer buffers an open file in
memory and uploads it on close. That is a bad match for Codex, which holds one
rollout open for an entire resumed session: an unclean process/container stop
can discard every append since the previous open epoch closed.

The old layout also copied opencode and Hermes SQLite databases, WALs, and SHMs
with `rsync`. Those files can be observed at different transaction boundaries;
having all three files is not proof that the copy is a consistent database.

## Invariants

1. An agent only mutates ordinary files on `$AM_LOCAL`.
2. The bucket only receives writes from a short-lived checkpoint operation.
3. A published SQLite checkpoint comes from SQLite's online backup API and
   passes `PRAGMA quick_check` before upload.
4. The previous durable checkpoint remains authoritative until its replacement
   has been completely written and closed.
5. A hot/dev restart never restores an older bucket copy over newer local
   state (`rsync --update`).
6. A normal shutdown stops the server and performs a final checkpoint. An
   ungraceful stop loses at most the checkpoint interval (15 seconds by
   default), not the lifetime of an open transcript.

## Layout

| Harness | Live state | Durable checkpoint | Adapter |
| --- | --- | --- | --- |
| Codex | `$AM_LOCAL/codex-home` | `/data/state/codex` | file tree; local SQLite cache excluded |
| Claude Code | `$AM_LOCAL/agent-state/claude` | `/data/state/claude` | file tree |
| Gemini CLI | `$AM_LOCAL/agent-state/gemini-home/.gemini` | `/data/state/gemini` | file tree |
| OpenClaw | `$AM_LOCAL/oc-home/.openclaw` | `/data/state/openclaw-backup` | file tree |
| opencode | `$AM_LOCAL/opencode-share` | `/data/state/opencode` | file tree plus online `opencode.db` backup |
| Hermes | `$AM_LOCAL/hermes` | `/data/state/hermes` | file tree plus online `state.db` backup |

Remote agents already use a good object-store pattern: one closed, immutable
Markdown file per message. Shell sessions have no model transcript; workspace
files remain durable but live process state and terminal scrollback are outside
this checkpoint mechanism.

## Lifecycle

`scripts/agent-state.sh restore` runs after legacy-path migration and before the
server starts. For file trees, durable files fill an empty local tree but do
not overwrite newer local files left by an in-container dev restart. For
SQLite harnesses, a valid existing local database is authoritative on a hot
restart; otherwise a verified checkpoint database is preferred. The previous
raw DB/WAL layout is accepted only as a one-release migration fallback. The
server refuses to start if restore is incomplete, avoiding a new lineage from
being written over partially restored state.

While the server is running, one supervisor loop calls
`scripts/agent-state.sh checkpoint` every
`$AGENT_STATE_CHECKPOINT_SECONDS` (default 15). A local `flock` prevents a
timer checkpoint from overlapping the shutdown checkpoint.

Ordinary trees use rsync's temporary-destination/rename behavior. The FUSE
writer therefore closes the replacement before it becomes the canonical
object. A local per-adapter timestamp selects changed paths and feeds those
paths to `rsync --files-from`; periodic checkpoints walk only the fast local
tree and never enumerate the remote bucket tree. Files modified while a
checkpoint is running are deliberately selected again on the next pass.
When their database or WAL changed, opencode and Hermes run `.backup` to a
local staging DB, validate that DB, then publish the closed result under
`checkpoints/`; idle databases do not generate bucket writes.

The first version does not propagate deletions from live trees. A stale durable
file is safer than deleting history based on a transient or partially restored
local view, but it can reappear after a fresh-container restore. Retention and
garbage collection should be a separate, explicit operation with tombstones or
a verified manifest rather than `rsync --delete` in the hot checkpoint loop.

PID 1 remains a small shell supervisor instead of `exec`-ing Node. On
`SIGTERM`, `SIGINT`, or `SIGHUP`, it forwards the signal to the server, waits
up to one second for the held PTYs to stop and flush their local files, and
takes a final checkpoint. The final checkpoint waits for any in-flight timer
checkpoint's lock before reading the quiet state.

## Migration and rollback

- Codex's old `$CODEX_HOME/sessions -> /data/state/codex/sessions` symlink is
  unlinked only at the known local path. Its durable target is never removed.
- Existing Gemini state under `/data/home/.gemini` is copied into the new
  durable checkpoint and retained as a rollback copy.
- Existing real opencode/Hermes directories are copied to the durable store and
  renamed to `*.pre-agent-state`; if that rollback name already exists, a
  timestamped name is used. They are not deleted by this proposal.
- Existing Codex SQLite remnants stay quarantined. They are caches; rollouts,
  history, auth, and config are the restored source of truth.

Before the first production deployment, any currently open Codex rollout must
be copied to a new closed migration object and verified through the bucket API.
Restarting first would repeat the loss mode this change is intended to fix.

Rollback is configuration-only: point each harness back at its retained
durable/legacy path. No migration step deletes the previous state.

## Guarantees and remaining work

This proposal bounds ungraceful loss to the checkpoint interval. It does not
claim synchronous per-token durability. If that is required later, JSONL
checkpoints can be replaced by immutable complete-line segments without
changing the live layout or SQLite adapters.

Gemini state becomes durable here, but Agent Manager still needs a separate
conversation-identity change before it can safely resume an exact Gemini
session in a folder shared by multiple Gemini panes. Using `--resume latest`
without pinning would risk cross-session pickup, so this branch deliberately
does not enable that shortcut.

A future harness-independent input journal should write one immutable object
per submitted prompt before delivery. That would preserve the operator's input
even if a CLI fails before recording it, while transcript checkpoints remain
the source for assistant/tool events.

## Verification

`server/state-checkpoint.test.mjs` exercises the failure boundaries without
touching `/data`:

- restores each file-backed harness to local storage;
- preserves newer local state across a hot restart;
- checkpoints a Codex rollout while another process holds its FD open;
- kills that writer and reconstructs the rollout from the checkpoint;
- snapshots committed opencode data while a WAL-mode writer remains alive;
- validates opencode and Hermes checkpoint databases;
- proves a corrupt live DB cannot replace the previous durable snapshot; and
- restores SQLite without stale WAL/SHM companions.
