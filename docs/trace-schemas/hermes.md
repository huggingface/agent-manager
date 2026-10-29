# Hermes

Hermes (Nous Research `hermes-agent`) keeps every conversation in one shared
SQLite database. AM reads it read-only for the Overview digest, the reader and
sharing. Hermes has no pin and no input-required signal. Attribution is by
recorded `cwd` only, and state comes from the screen diff alone.

Version checked: the install at `/home/node/.hermes/hermes-agent` is git tag
`v0.22.5` (commit dated 2026-10-22; `pyproject.toml` says `0.0.0`).
`hermes --version` did not print a version on this Space. It exited with
"no dependency environment is committed for this install; run `hermes pm
repair`", so the launcher may fail to start a pane as well. The schema below
was read from the live `state.db` (schema_version 30).

For the CLI-independent pipeline see [README.md#state-pipeline](README.md#state-pipeline).

## Where the trace lives

| What | Path | Notes |
| --- | --- | --- |
| Live DB | `$HERMES_LIVE/state.db` = `$AM_LOCAL/hermes/state.db` | `entrypoint.sh:68`, `scripts/agent-state.sh:42` |
| Path Hermes and AM open | `$HOME/.hermes/state.db` | `$HOME/.hermes` is a symlink to `$HERMES_LIVE` (`entrypoint.sh:119`, `entrypoint.sh:141`). Verified on this Space: `/data/home/.hermes -> /home/node/local/hermes`. |
| Durable checkpoint | `$HERMES_DURABLE` = `$DATA_DIR/state/hermes` | `entrypoint.sh:69`, `scripts/agent-state.sh:43` |
| Hermes install | `/home/node/.hermes/hermes-agent` | The image user's home, not `$HOME`. No `state.db` there. |

- Format: SQLite in WAL mode (`state.db`, `state.db-wal`, `state.db-shm`, plus
  `state.db.auto-maintenance.lock`). One DB for all conversations and all
  folders. A conversation is a row in `sessions` plus its rows in `messages`.
- Relocation: the DB must stay off the FUSE bucket. A real `~/.hermes` from an
  older layout is rsynced to the durable dir and kept as
  `~/.hermes.pre-agent-state`, then replaced by the symlink
  (`entrypoint.sh:115-141`).
- Restore and checkpoint: `restore_hermes` → `restore_sqlite_tree`
  (`scripts/agent-state.sh:719`, `:395`); `checkpoint_sqlite_tree`
  (`scripts/agent-state.sh:453`, called at `:1048`). A valid live DB wins on a
  hot restart; otherwise the last `.backup` checkpoint is restored and the WAL
  and SHM are dropped. Details: [agent-state-checkpoints.md](../agent-state-checkpoints.md).
- Every path in AM is hard-coded to `$HOME/.hermes/state.db`
  (`server/src/traces.js:899`, `server/src/share.js:340`). Nothing honours
  `HERMES_LIVE` or a `HERMES_HOME` override. On the Space this is correct only
  because of the symlink.
- `ccusage` also only finds `$HOME/.hermes/state.db`. `hermesEnv`
  (`server/src/usage.js:74`) gives it a shim `HOME` whose `.hermes` links to
  the live dir, but only when `$HOME/.hermes/state.db` does not already
  resolve. With the symlink in place it returns `process.env` unchanged.

Write timing (from Hermes source, not observed live): rows are flushed per
step, not at turn end. The user row is persisted in preflight
(`agent/turn_preflight.py:195`), assistant and tool rows after each tool round
(`agent/turn_tool_round.py:133`) and at the final response
(`agent/turn_final_response.py:278`). `sessions.last_activity_at` is a
heartbeat written at most every 60 s (`agent/session_activity.py:21`). A turn
that fails ends with a synthetic assistant row carrying `display_kind`
(`agent/conversation_loop.py:1925`). On this Space `state.db` had an old mtime
while `state.db-wal` was current, so any change detection must include the WAL
(AM's does: `dbChangeKey` `server/src/traces.js:706`,
`traceRevision` `server/src/trace-revision.js:7`).

## Schema

Inspected with `sqlite3 -readonly` (no content selected). Only the two tables
AM reads are listed. Other tables exist (`session_turn_leases`,
`compression_locks`, `conversation_generations`, `async_delegations`,
`session_model_usage`, FTS tables, gateway tables).

`sessions` (one row per conversation; a new row per fresh launch and per
compression):

```text
id                TEXT   "20260101_000000_ab12cd"   (22 chars here)
source            TEXT   "cli"                       (also gateway sources)
parent_session_id TEXT   <id of the pre-compression session, or null>
started_at        REAL   1767225600.123              (epoch SECONDS)
ended_at          REAL   null | seconds
end_reason        TEXT   null | "compression" | "agent_close" | "session_reset" | "startup_orphan_reap" | ...
cwd               TEXT   "/data/workspaces/<folder>"
git_repo_root     TEXT   "/data/workspaces/<folder>" | null
title             TEXT   "<title>"                    (unique when set)
input_tokens / output_tokens / cache_read_tokens / reasoning_tokens   INTEGER
message_count / tool_call_count / api_call_count                      INTEGER
last_activity_at  REAL   seconds;  last_activity_description TEXT
model, model_config, system_prompt, archived, hidden, pinned, ...     (ignored)
```

`messages` (roles seen: `user`, `assistant`, `tool`):

```text
id INTEGER, session_id TEXT, role TEXT, content TEXT, timestamp REAL (SECONDS)
assistant calling tools:  role=assistant, content="" , finish_reason="tool_calls",
                          tool_calls='[{"id":"call_x","call_id":"call_x","response_item_id":"…","type":"function",
                                        "function":{"name":"<tool>","arguments":"{…}"}}]'
tool result:              role=tool, tool_call_id="call_x", tool_name="<tool>", content="<output>"
final answer:             role=assistant, content="<answer>", finish_reason="stop" | "length"
also: reasoning, reasoning_content, reasoning_details, token_count, active (0 after rewind),
      compacted, display_kind, display_metadata, api_content, display_order
```

Note that `tool_name` is set on the `tool` row only. The assistant row that
made the call carries the name and arguments inside `tool_calls` JSON.

| Record | Fields AM reads | Used for | Code |
| --- | --- | --- | --- |
| `sessions` | `id`, `cwd`, `started_at`, `input_tokens`, `output_tokens`, `cache_read_tokens` | attribution, `firstTs`, token totals | `readHermes` `server/src/traces.js:908-934` |
| `sessions` | `title`, `cwd`, token columns | reader header, usage | `normalizeHermesDb` `server/src/traces.js:2474-2478` |
| `sessions` | `id`, `cwd`, `started_at` | pick newest conversation in the folder | `findDbSession` `server/src/share.js:363-368` |
| `messages` user | `content`, `timestamp`, `active` | `lastPromptText`, `lastPromptTs`, `since*` window start | `server/src/traces.js:910`, `:935-944` |
| `messages` assistant | `content`, `timestamp` | `lastAssistantText`, `lastAnswerTs`, turn counts | `server/src/traces.js:915`, `:952-959` |
| `messages` any | `tool_name`, `token_count`, `max(timestamp)` | tool counts, `sinceTokens`, `lastTs` | `server/src/traces.js:911-916`, `:924-933` |
| `messages` all | `role`, `content`, `tool_name`, `timestamp`, `id` | reader messages | `normalizeHermesDb` `server/src/traces.js:2479-2497` |

Present but ignored, and useful:

- `messages.tool_calls` (tool name + arguments on the calling row).
- `messages.reasoning*` (thinking text).
- `messages.finish_reason` (`tool_calls` = turn continues, `stop` = turn done).
- `messages.active`, `compacted` (rewound and compacted rows); only the
  last-prompt query filters `active = 1`.
- `messages.display_kind` (failed-turn notices).
- `sessions.parent_session_id`, `end_reason` (compression chain), `ended_at`,
  `last_activity_at`, `session_turn_leases` (a turn-in-progress lease).

## How AM maps it

Digest: `readHermes` (`server/src/traces.js:897`). It runs synchronously on
the main thread inside `buildImpl` (`server/src/traces.js:1418`), not on the
parse worker pool, under the `readHermes` watchdog phase
(`server/src/watchdog.js:22`). It reads every session row and runs a handful
of queries per session.

| Digest field | How it is set |
| --- | --- |
| `lastPromptText` / `Raw` / `Ts` | Newest `role='user' and active=1` row; skipped if empty or starts with `<` (`traces.js:935-944`) |
| `sinceTurns`, `sinceTools`, `sinceToolCalls`, `sinceTokens` | Rows with `timestamp >` that prompt (`traces.js:945-950`) |
| `lastAssistantText` / `Md` / `Ts` | Newest assistant row with non-empty content after the prompt (`traces.js:954-959`) |
| `lastAnswerTs` | Newest non-empty assistant row overall (`traces.js:952-953`) |
| `outSeq`, `outHash`, `turnsLog` | **Never set.** `digestPrompt`/`digestAssistant` are not called. |
| `running` | Never set. |
| `stats.cwd` | `sessions.cwd` |

Because `outSeq` stays 0, `outputOf` returns null for every Hermes pane
(`server/src/index.js:697-700`): the Overview has no unread cursor for Hermes.
`lastPromptAt` / `lastAnswerAt` / `activityKind` still work through
`conversationActivity` (`server/src/agent-list.js:46`), and `lastPrompt` /
`lastAnswer` through `server/src/index.js:1092`. `digestFor` and
`traceLocation` return null for Hermes (`server/src/traces.js:1479`, `:1513`),
so the Overview tile waits for the bulk pass and `/api/agents` gives no trace
path.

Reader: `findTrace` → `findDbSession` (`server/src/share.js:350`) returns
`{ src: state.db, sessionId }`; `readTrace` (`server/src/traces.js:3024`) →
`normalizeHermesDb` (`server/src/traces.js:2470`). Hermes is not in
`WINDOWABLE` (`server/src/traces.js:2679`), so every window request parses the
whole session and indexes it; the revision includes the WAL.

| Source rows | Reader blocks |
| --- | --- |
| user row, non-empty content | `{role:'user', blocks:[text]}` |
| assistant row, non-empty content | `{role:'assistant', blocks:[text]}`; `markFinalTurns` marks the answer |
| assistant row with `tool_calls`, empty content | **dropped** (`text.trim()` is empty) |
| tool row (`tool_name` set) | one assistant message with `tool_use {id:'t<rowid>', name, input:'{}'}` + `tool_result` (`traces.js:2483-2491`) |
| reasoning, images, compaction, errors | not represented; a failed-turn notice renders as ordinary assistant text |
| rewound (`active=0`) rows | rendered, no marker |

Rows are ordered by `timestamp`, not `id`. Rows written within the same
millisecond (seen in the live DB) have no stable order.

Images: AM types `/image "<path>"` before the prompt for image attachments
(`formatAttachmentPrelude` `server/src/attachments.js:377`, used at
`server/src/index.js:954-960`). How Hermes stores the image is not read by AM.

Sharing: `fromHermes` (`scripts/share-session.mjs:116`) mirrors the normalizer
and emits STS with `arguments: '{}'`.

## Which trace belongs to which pane

There is no pin. No session id is captured at launch, and no hook reports one.

| Path | Rule | Code |
| --- | --- | --- |
| Digest (`buildImpl`) | Each Hermes pane keys its folder `path.resolve(WORKSPACES_DIR, s.path ?? s.id)`. A second pane in the same folder makes the key `'ambiguous'`. Every `sessions` row whose `cwd` resolves to that key is attributed to the pane. | `server/src/traces.js:1412-1421` |
| Reader / share (`findDbSession`) | Refuse if another Hermes pane shares the folder; else the row with `cwd = <workdir>` and the newest `started_at`. | `server/src/share.js:350-369` |

Consequences:

- **All Hermes conversations ever held in a folder merge into the pane.**
  Stats sum over all of them; the digest comes from whichever has the newest
  `lastTs` (`attribute`, `server/src/traces.js:1301-1313`). Sessions started
  by hand in that folder, gateway sessions with that `cwd`, and the
  pre-compression parents are included.
- **Two Hermes panes in one folder:** both get no digest and no reader trace.
  Their conversations go to "other". A stopped pane still counts, since the
  filter is on `cli` only.
- **Exact string match on `cwd`.** A Hermes `cd` into a subfolder before the
  session row is written, a worktree, or a symlinked path breaks the match.
  Codex/Claude use a folder-tree check (`server/src/runner.js:718`); Hermes
  does not.
- **Launch and resume.** The first launch runs `hermes`; later launches run
  `hermes -c || exec hermes` (generic path, `server/src/runner.js:1968`; config
  `server/src/config.js:250`). Each fresh `hermes` creates a new `sessions`
  row. `hermes -c` resumes the most recent CLI session for the workspace key
  (git repo root, else cwd), skipping launch stubs, and **falls back to the
  global most-recent session** when the folder has none
  (`hermes_cli/main.py:1333`). A resumed session then `cd`s into its recorded
  cwd (`hermes_cli/main.py:1548`). So a pane whose folder has no real Hermes
  conversation yet can resume another folder's conversation and move there.
- **Shared folder + `-c`.** Unlike codex, opencode and fx, the Hermes launch
  path has no "folder is shared, start fresh" guard. Two Hermes panes in one
  folder both resume the same conversation.
- **`|| exec hermes`** also fires when a resumed Hermes exits non-zero, which
  starts a new conversation instead of ending the pane (the hazard the Claude
  launch path documents at `server/src/runner.js:1862`).
- **Compression** ends the old row (`end_reason='compression'`) and starts a
  child row with `parent_session_id`. Both have the same `cwd`, so both stay
  attributed; `findDbSession` picks the child by `started_at`.

## State

| Signal | Computed at | Hermes input |
| --- | --- | --- |
| Screen diff → `working` / `waiting` / `stopped` | `deriveState` `server/src/runner.js:214`, `sampleScreen` `:175` | yes, the only live signal |
| `digest.running` | parsers | never set for Hermes |
| Reader `activity` | `headOf` `server/src/traces.js:2633` | never set (`normalizeHermesDb` sets none) |
| Input-required | `server/src/input-required.js:8-10`, `:101` | none (no hook, no OSC 9) — see [tui-input-required.md](../tui-input-required.md) |
| `lastPromptAt` / `lastAnswerAt` / `activityKind` | `conversationActivity` `server/src/agent-list.js:46` | from `readHermes` timestamps |
| Unread cursor | `outputOf` `server/src/index.js:697` | always null |

Precedence: there is nothing to reconcile. Sidebar, Overview light,
`/wait`, the Overview `atWork` and the reader all reduce to the screen diff.
The reader never shows "running" for Hermes because `activity` is null.

Failure modes:

- **Approval or clarify dialog.** Hermes stops and waits for the operator. The
  screen goes static, so the pane reads `waiting` with no badge. Looks the same
  as "done".
- **Long tool call without animation.** If the TUI stops redrawing during a
  slow command, the pane reads `waiting` after 4 s while the turn is open.
  Nothing in the trace corrects it, although `finish_reason='tool_calls'` on
  the last assistant row, or an unexpired `session_turn_leases` row, would.
- **Digest lag during a turn.** `readHermes` serves the previous rows while
  the DB or WAL changed in the last 8 s (`server/src/traces.js:903`). Hermes
  writes per step, so during a busy turn the digest can stay frozen until
  writes pause.
- **Torn read or schema drift** keeps the previous rows silently
  (`server/src/traces.js:962`).
- **Crash mid-turn.** The pane's PTY ends (`stopped`) or, on a resume path,
  `|| exec hermes` starts a fresh session. The trace shows the last persisted
  step with no end marker; AM does not read `ended_at` / `end_reason`.
- **Rewind.** The prompt query respects `active=1`, the answer query does not,
  so a rewound answer can still be shown as the last answer.
- **Hermes broken install.** If the launcher fails (as `--version` does here),
  the pane exits and reads `stopped`, or `hermes -c` fails and the fallback
  `hermes` fails the same way.
- **Resize repaint** (`resizeMode: 'repaint'`, `server/src/config.js:250`):
  generic, see [README.md#state-pipeline](README.md#state-pipeline).

## Gaps

1. **No pin.** Capture the session id after launch (new `sessions` row with
   this `cwd` and `started_at` after the pane's start, as
   `scheduleOpencodeCapture` does) and launch with `hermes --resume <id>`.
   This fixes cross-folder `-c`, shared folders and merged stats at once.
2. **No turn-open signal.** Set `digest.running` and reader `activity` from
   the newest assistant row's `finish_reason` (`tool_calls` → working,
   `stop`/`length` → waiting) or from an unexpired `session_turn_leases` row.
3. **Unread cursor missing.** Call `digestAssistant(dg, text, ts, row.id)` for
   the newest answer so `outSeq` / `outHash` exist.
4. **Tool calls render without arguments.** Read `messages.tool_calls` on the
   assistant row and stitch to the `tool` row by `tool_call_id`, in
   `normalizeHermesDb` and `fromHermes`.
5. **Shared-folder `-c` hazard.** Add the codex/opencode "shared → fresh"
   guard to the Hermes launch path, or pass `--in <folder>` so the resume is
   at least scoped.
6. **Hard-coded `$HOME/.hermes`.** Derive the DB path from `HERMES_LIVE`
   (or `HERMES_HOME`) in one helper used by `traces.js` and `share.js`.
7. **Main-thread SQLite.** Move `readHermes` to the worker pool or restrict it
   to sessions whose `last_activity_at` moved.
8. **Reader fidelity.** Order by `id`, filter or mark `active=0` rows, render
   `reasoning` as thinking and `display_kind` failures as errors.
9. **No input-required.** No supported hook exists today; track upstream.
