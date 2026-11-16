# fx trace schema

Checked against `fx --version` **0.0.5** (`/usr/local/bin/fx`, a statically
linked binary from releases.fx.sh). Line numbers are from the
`docs/trace-schemas` checkout.

**Evidence caveat.** This machine has no real fx session: `~/.fx` is empty,
and fx refuses to run without an AI Gateway key, so none could be produced
without writing to `~/.fx`. The schema below comes from AM's parser and
normalizer, the fixtures in `server/test/fx-digest.test.mjs`, the stub in
`server/test/fx-live.test.mjs`, and strings in the binary. Statements about
fx's own behaviour that rest only on AM's code comments are marked
*unverified*. Verify them against a real session before changing state logic.

The CLI-independent pipeline (screen-diff `state`, `digest.running`, reader
`activity`, Overview `atWork`) is in [README.md#state-pipeline](README.md#state-pipeline).
This page covers only what is specific to fx.

## Where the trace lives

| What | Value |
|---|---|
| Root | `~/.fx/sessions/`, hardcoded. fx has no env or config-dir override (`server/src/config.js:257-259`). |
| Per conversation | `~/.fx/sessions/<id>/` holding `events.jsonl` (the trace), `session.json` (manifest), `session.lock` (held open by the owning process), and sometimes `commit.lock`, `subagent/*.lock`, `index.pending` |
| Other | `~/.fx/sessions/latest` holds per-workspace pointers. It has no `events.jsonl`, so `fxFilesUncached` skips it (`server/src/traces.js:1268`). |
| Id | fx-minted, for example `<ms>-<pid-ish>-<hex16>`. AM accepts `[A-Za-z0-9._-]{1,255}` (`FX_ID`, `server/src/runner.js:1835`). |
| Format | JSONL, one event per line, one file per conversation, appended. |

**Relocation on the Space.** Because there is no override, `entrypoint.sh:120,142`
symlinks `~/.fx` to `FX_LIVE=$AM_LOCAL/fx-home` (local disk;
`entrypoint.sh:74`, `scripts/agent-state.sh:51`). A real directory left by an
older layout is rsynced to `FX_DURABLE=$DATA_DIR/state/fx` and kept as
`*.pre-agent-state` (`entrypoint.sh:122-138`).

**Checkpointing.** Every 15 s, `checkpoint_tree fx` (`scripts/agent-state.sh:1049`)
rsyncs the whole tree to `FX_DURABLE`, excluding `*.lock` and `index.pending`
in both directions (`scripts/agent-state.sh:221`, `:594`). A restored lock
would name a process that no longer exists. Restore is `restore_fx`
(`:720`). See [agent-state-checkpoints.md](../agent-state-checkpoints.md).

**Write timing (unverified).** Per `server/src/traces.js:441-447`, fx writes a
whole exchange as **one** `history_turn_committed` line when the turn ends.
Mid-turn, the only durable record is `recovery_checkpoint_set`. The fixture
gives that record `cause: 'network_interrupted', action: 'retrying_request'`,
which suggests a recovery-only record, not one written at every turn start.
If so, a normal turn writes nothing until it commits.

## Schema

Envelope (every line, from the fixture):

```json
{"schema_version":1,"log_generation":"<32 hex>","seq":7,"event_id":"<32 hex>",
 "timestamp_ms":1700000000000,"kind":"<kind>","payload":{…}}
```

AM reads `kind`, `payload` and `timestamp_ms`. It ignores `seq`,
`log_generation` and `event_id`, which could detect a rewritten log.

| kind | payload (placeholder) | AM reads |
|---|---|---|
| `session_started` | `{"id":"<id>","created_at_ms":…,"workspace_root":"/w","origin_workspace_root":"/w","conversation_language":"und-Latn"}` | `workspace_root` → cwd (`server/src/traces.js:486-492`, `:2334-2338`), `id` (reader) |
| `workspace_rebound` | `{"workspace_root":"/w2",…}` | `workspace_root` (current binding) |
| `recovery_checkpoint_set` | `{"checkpoint":{"version":1,"turn_id":2,"user":{"text":"<prompt>","images":[]},"assistant_source":"<partial>","cause":"network_interrupted","action":"retrying_request"}}` | `checkpoint.user.text`, `turn_id` → prompt; sets `running` (`:493-505`). The reader ignores this kind. |
| `recovery_checkpoint_cleared` | (not in fixtures) | clears `running` (`:506-511`) |
| `history_turn_committed` | see below | everything else (`:512-560`, `:2340-2389`) |

`history_turn_committed` payload:

```json
{"total_input_tokens":120,"total_output_tokens":30,"conversation_language":"und-Latn",
 "turn":{"kind":"assistant",
   "user":{"text":"<prompt>","images":[]},
   "assistant":"<final answer>",
   "execution":{"schema_version":3,
     "tool_steps":[{"assistant":"<narration>",
       "tool_calls":[{"id":"c1","name":"read_file","arguments_json":"{…}","provider_result":null}],
       "tool_results":[{"tool_call_id":"c1","tool_name":"read_file","status":"ok","output":"<out>"}]}],
     "files":[{"path":"/w/a.js","tool_name":"edit_file","action":"modified","status":"ok"}]}}}
```

`turn.kind` ∈ `assistant` (completed), `interrupted`, `background_command`
(both may carry partial `assistant` text), and `compacted_summary`
(`{"kind":"compacted_summary","summary":"<summary>","removed_turn_count":9}`,
no `user`). Token totals are cumulative for the session and are reassigned,
not summed.

Text fields may be `{"encoding":"base64","data":"…"}` for invalid UTF-8.
`fxText`/`fxValue` (`server/src/traces.js:457-469`) decode them.

`session.json` (manifest, read by capture and share):
`{"schema_version":3,"id":…,"workspace_root":…,"origin_workspace_root":…,"created_at_ms":…,"updated_at_ms":…}`.

Present but ignored: `user.images`, `tool_results[].status`,
`files[].action/status`, `provider_result`, `removed_turn_count`.
The binary also contains names such as `session_reset`,
`state_replacement_committed`, `queue_review_committed` and
`retain_committed`. Whether any of them are `events.jsonl` kinds is unknown.
`parseFx` ignores unknown kinds, so a `/reset` inside one session would not
reset the digest.

## How AM maps it

### Digest: `parseFx` (`server/src/traces.js:470`)

Runs off-thread via `statsFor` → `trace-parse-worker.js` (`PARSERS.fx`,
`server/src/traces.js:1029`). Files over 12 MB are read from the tail only
(`readTraceFile`, `:976`) and flagged `activityError:'activity-incomplete'`
(`:1043`). The tail loses `session_started`, so cwd fallback fails for such a
file.

| Digest field | Source |
|---|---|
| `lastPromptText/Ts` | `recovery_checkpoint_set` (once per `turn_id`), re-anchored by the commit's `turn.user.text` at commit time (`:496-500`, `:524-532`) |
| `lastAssistantText/Md/Ts`, `lastAnswerTs`, `outSeq/outHash` | `turn.assistant` of `kind:'assistant'` turns only, via `digestAssistant` without a key (`:538-541`) |
| `sinceTools`, `stats.tools` | `execution.tool_steps[].tool_calls[].name` (`:542-550`) |
| `sinceFiles` | `execution.files[].path` (`:553-556`) |
| `sinceTokens`, `tokensIn/Out` | cumulative totals; delta since the prompt (`:519-522`, `:563-565`) |
| `running` | `true` on `recovery_checkpoint_set`; `false` on `recovery_checkpoint_cleared` or any commit (`:503`, `:510`, `:514`) |

`turnsLog` holds earlier answers, as for other harnesses. `digestFor`
(`:1497`) parses the pinned file directly, so fx tiles fill without waiting
for the bulk build.

### Reader: `normalizeFx` (`server/src/traces.js:2328`)

Each committed line becomes a `user` message (prompt) followed by one
`assistant` message containing, in order: per step, narration `text`, then
`tool_use` blocks (`arguments_json`), then each `tool_result` filed beside its
own call (`makeStitcher`). The final `turn.assistant` text comes last. Non-`assistant`
turns get `kind:'partial'`, so `markFinalTurns` does not mark them as an
answer. `compacted_summary` becomes a `partial` assistant text message, not a
`compaction` block (OpenCode and Codex use a marker). `recovery_checkpoint_set`
is not shown, so an in-flight turn is invisible in the reader until it
commits. Thinking is not recorded by fx (none in the schema). Images are
dropped.

fx is not in `WINDOWABLE` (`:2679`), so the reader always normalizes the whole
file. `headOf` `activity` is never set (`:2640`), so the reader never shows
"running" for fx.

### Sharing

Not shareable. `SHAREABLE_CLIS` omits fx (`server/src/share.js:428-432`)
because `scripts/share-session.mjs` has no fx exporter. `findFxEvents`
(`server/src/share.js:311`) still locates the file for the reader.

## Which trace belongs to which pane

Pin: `session.fxSessionId`, which is the directory name. `scheduleFxCapture`
(`server/src/runner.js:1784`) runs 3 s after launch, then every 20 s:

1. **Exact owner.** `fxSessionForPid(paneRootPid)` (`server/src/fx-process.js:5`)
   reads `/proc/<pid>/fd` for a `sessions/<id>/session.lock` link. If the pane
   root is a shell, it checks the shell's direct `fx` child. It succeeds only
   with exactly one lock. Subagent locks (`<id>/subagent/*.lock`) are one level
   deeper and do not count. If the id is unclaimed, AM pins it and clears
   `fxCaptureSince`.
2. **Folder shared** with another running fx pane: never adopt by folder.
   Raise the floor `since = now` and persist it as `fxCaptureSince`, so a
   rival's conversation is never adopted later.
3. **Fallback.** `captureFxSession` (`server/src/traces.js:864`) picks the newest
   `session.json` whose current `workspace_root` equals the folder, created at
   or after `since`, and not claimed.

Launch (`commandFor`, `server/src/runner.js:1938-1953`): with a pin,
`if [ -f …/events.jsonl ]; then exec fx --resume <id>; else exec fx; fi`. That
avoids "saved session not found." killing the pane. Unpinned in a shared
folder (or with `fxCaptureSince` set), it starts plain `fx`. Otherwise it uses
`fx --continue` (latest session for the workspace).

Attribution in `buildImpl` (`server/src/traces.js:1343-1366`): a pin matches by
directory name. Only **unpinned** panes may claim a log by `workspace_root`,
with the `ambiguous` guard. `findFxEvents` applies the same rules, picking the
newest manifest by `updated_at_ms` (`server/src/share.js:311-336`).

Cases:

- **Two panes, one folder.** The lock is exact per process, so each pane pins
  its own conversation once fx holds the lock.
- **New conversation in the same pane.** The lock moves; step 1 re-pins on the
  next 20 s beat.
- **Rebound workspace.** `workspace_root` follows; `origin_workspace_root` is
  deliberately ignored.
- **Compaction** stays in the same file; no new session.
- **Subagents.** Whether fx writes child sessions as separate `sessions/<id>`
  directories is unknown. If it does, with the same `workspace_root`, the
  step 3 fallback and unpinned attribution could pick one up.

## State

| Signal | Computed in | fx specifics |
|---|---|---|
| `state` (working/waiting/stopped) | `deriveState` `server/src/runner.js:214` | Screen diff only. `resizeMode:'repaint'` (`server/src/config.js:260`). |
| `inputRequired` | `server/src/input-required.js` | **None.** fx has no marker source (`:7-11`) and no OSC parsing (`:101`). Approval dialogs are never surfaced. |
| `digest.running` | `parseFx` `server/src/traces.js:503-514` | Only from recovery checkpoints. Feeds Overview `atWork` (`web/src/components/Overview.tsx:66`). |
| reader `activity` | not set | Always `null`. |
| `lastPromptAt` / `lastAnswerAt` / `activityKind` | `server/src/agent-list.js:45` | Both anchored to the commit time for a normal turn. |
| unread (`output`) | `server/src/index.js:697` | Works: `outSeq` advances per committed answer. |

**Precedence.** Overview `atWork` = screen `working` OR (not stopped AND
`digest.running`). The sidebar uses only the screen. The reader uses neither.

**Failure modes.**

1. **A normal turn is invisible to the trace until it ends** (if the write
   timing above holds). During the turn, `lastPrompt` still shows the previous
   prompt, `running` is false, and `activityKind` stays `answer`. Liveness
   rests entirely on the screen diff.
2. **Stuck `running`.** fx dies mid-turn after a `recovery_checkpoint_set`
   (crash, kill, Space restart). No commit or clear follows, so `running`
   stays true. Overview `atWork` holds while the pane is `waiting`. A restored
   session that fx recovers on resume would fix it; this is unverified.
3. **Interrupted / background turns.** The prompt is re-anchored at commit
   time, but no answer is recorded, so `activityKind` reads `prompt` (looks
   unanswered) after the turn is over. `recovery_checkpoint_cleared` leaves the
   same state.
4. **`background_command` turns** commit (`running:false`) while the command
   keeps running. The screen may stay static.
5. **Dialogs.** An fx approval prompt leaves a static screen, so it reads
   `waiting` with no needs-input badge.
6. **Large logs (>12 MB)** lose `session_started` (cwd) and get only an
   `activity-incomplete` flag. Codex and Claude get the `traceActivity` scan;
   fx does not.
7. **Pin lag.** Re-pin runs every 20 s (no breadcrumb hook), so after a new
   conversation the tile shows the old one for up to 20 s.

## Gaps

1. **Verify the write model on a real session** (turn start, mid-turn, abort,
   crash, `/reset`, subagent). Log `kind` counts with
   `jq -r .kind events.jsonl | sort | uniq -c`. Everything below depends on it.
2. **Use the lock as liveness.** `session.lock` held by a live pid tells AM the
   conversation is open, but not whether it is mid-turn. If fx writes nothing
   mid-turn, look for another durable mid-turn signal (`commit.lock`, the
   `display_sidecar`/`usage_sidecar` files the binary mentions), or ask
   upstream for a turn-start event.
3. **Clear stale `running`.** Ignore `running` when `fxSessionForPid` finds no
   live owner for that session (`server/src/fx-process.js:5`). That covers
   crash mid-turn.
4. **Input-required.** Find whether fx emits an OSC 9/777 notification or has
   a hook for approvals, and add an `fx` source to `server/src/input-required.js`.
5. **Prompt-only activity after interruption.** Record the partial text of
   `interrupted` turns as the turn's end time (`lastAnswerTs`, without marking
   it final), so `activityKind` does not suggest an unanswered prompt.
6. **Reader parity.** Show an in-flight `recovery_checkpoint_set` prompt as a
   pending user turn. Render `compacted_summary` as a `compaction` block. Set
   `activity` from the same `running` flag.
7. **Large files.** Add fx to the `traceActivity` path and keep the first
   `session_started` (it is the first line) when reading a tail.
8. **Share exporter.** Add an fx → STS converter so fx can join
   `SHAREABLE_CLIS`.
