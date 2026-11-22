# OpenCode trace schema

Checked against `opencode --version` **1.19.5**. The local database also holds
rows written by 1.17.13 through 1.19.4 (`session.version`); the tables AM reads
did not change across them. Line numbers are from the `docs/trace-schemas`
checkout.

The CLI-independent pipeline (screen-diff `state`, `digest.running`, reader
`activity`, Overview `atWork`) is in [README.md#state-pipeline](README.md#state-pipeline).
This page covers only what is specific to OpenCode.

## Where the trace lives

| What | Value |
|---|---|
| Path | `$XDG_DATA_HOME/opencode/opencode.db`, default `~/.local/share/opencode/opencode.db` (`opencodeDbPath`, `server/src/traces.js:574`; duplicated in `server/src/share.js:338`) |
| Format | One SQLite database for **every** conversation on the machine. `journal_mode=wal`, so writes land in `opencode.db-wal` and the main file's mtime only moves at a WAL checkpoint. |
| Per-conversation handle | A `session` row, id `ses_…`. There is no per-conversation file. |
| Other files | `log/`, `tool-output/`, `repos/` beside the db. AM reads none of them. |
| Secrets | The same db holds `account`/`credential` tables with OAuth tokens. AM never copies it (`server/src/traces.js:2395`, `server/src/share.js:344`). |

**Relocation on the Space.** `entrypoint.sh:66-67` sets
`OPENCODE_LIVE=$AM_LOCAL/opencode-share` (local disk) and
`OPENCODE_DURABLE=$DATA_DIR/state/opencode` (bucket). `entrypoint.sh:118-140`
makes `~/.local/share/opencode` a symlink to `OPENCODE_LIVE`; a real directory
left by an older layout is rsynced to durable and kept as `*.pre-agent-state`.
`XDG_DATA_HOME` is not set, so the symlink is what redirects OpenCode.

**Checkpointing.** Every 15 s (`AGENT_STATE_CHECKPOINT_SECONDS`,
`entrypoint.sh:223`) `scripts/agent-state.sh:1047` runs
`checkpoint_sqlite_tree` (`scripts/agent-state.sh:453`):

1. rsync the non-database files (`*.db`, `*.db-*`, `*-wal`, `*-shm` excluded, `scripts/agent-state.sh:223`);
2. skip if the stat signature of db + WAL is unchanged;
3. `sqlite3 .backup` (one consistent read transaction over db and WAL) to a local staging file;
4. `PRAGMA quick_check`, then rsync to `$OPENCODE_DURABLE/checkpoints/opencode.db`.

Restore is `restore_opencode` (`scripts/agent-state.sh:718`). See
[agent-state-checkpoints.md](../agent-state-checkpoints.md).

**Write timing (verified on the local db).** OpenCode writes incrementally,
mid-turn, not at turn end:

- `part` rows are upserted repeatedly while they stream. 1,078 tool parts had
  10,621 `message.part.updated` events in the `event` table: each tool part
  passes `pending` → `running` (many updates) → `completed`/`error`. 724 of
  1,613 text/reasoning parts have `time_updated` at least a second after
  `time_created`.
- The assistant `message` row is rewritten when a step ends (`time.completed`,
  `finish`, `tokens`, `cost`).
- In the sample, the WAL was 2 min newer than the main file. Anything that
  keys on the main file's mtime alone misses live writes; AM checks both
  (`dbChangeKey`, `server/src/traces.js:706`; `traceRevision`,
  `server/src/trace-revision.js:7`).

## Schema

Tables AM reads: `session`, `message`, `part`. Each `message` and `part` row
holds its payload as JSON in `data`. Times are epoch **milliseconds**.

Other tables present (not read by AM): `event` (append-only per-session event
log: `session.created.1`, `session.updated.1`, `message.updated.1`,
`message.part.updated.1`), `event_sequence`, `todo`, `permission`, `project`,
`workspace`, `session_share`, and three newer tables that were empty here
(`session_message`, `session_input`, `session_context_epoch`). Those three look
like a future storage model. If OpenCode moves to them, `readOpencode` will
silently find nothing new.

### `session` (columns)

```
id ses_XXXX  project_id  parent_id (null for a root; set for a task/subagent child)
directory /workspaces/<folder>  title  version 1.19.5  model '{"id":…,"providerID":…}'
tokens_input tokens_output tokens_reasoning tokens_cache_read tokens_cache_write cost
time_created time_updated time_compacting time_archived  (+ slug, path, summary_*, revert, permission, agent, metadata, share_url, workspace_id)
```

### `message.data`

User:

```json
{"role":"user","time":{"created":1700000000000},"agent":"build",
 "model":{"providerID":"<prov>","modelID":"<model>","variant":"<v>"},
 "summary":{"diffs":[]}}
```

Assistant (normal step):

```json
{"role":"assistant","parentID":"msg_<user msg>","mode":"build","agent":"build",
 "providerID":"<prov>","modelID":"<model>","path":{"cwd":"/w","root":"/w"},
 "time":{"created":1700000000100,"completed":1700000004000},
 "finish":"tool-calls","cost":0.01,
 "tokens":{"input":1,"output":1,"reasoning":0,"total":2,"cache":{"read":0,"write":0}}}
```

Variants seen: `finish` ∈ `stop`, `tool-calls`, `unknown`, or absent;
`error: {"name":"MessageAbortedError","data":{…}}` on an aborted step;
`time.completed` absent on a step that never finished (4 rows here, none with
an error: a killed process leaves them like that forever). The compaction
agent's summary is an assistant message with `"mode":"compaction"`,
`"agent":"compaction"`, `"summary":true`. Note: assistant `parentID` is the
**user message** it answers, not a parent session.

### `part.data` by `type`

| type | example (placeholder) | count here |
|---|---|---|
| `text` | `{"type":"text","text":"<text>","time":{"start":…,"end":…}}`; user side may add `"synthetic":true`; a compaction resume note has `"metadata":{"compaction_continue":true}` | 854 |
| `reasoning` | `{"type":"reasoning","text":"<thinking>","time":{"start":…,"end":…}}` | 759 |
| `tool` | `{"type":"tool","tool":"bash","callID":"<id>","state":{"status":"completed","input":{…},"output":"<out>","title":"<t>","metadata":{…},"time":{"start":…,"end":…},"attachments":[…]}}` | 1,078 |
| `step-start` | `{"type":"step-start"}` | 991 |
| `step-finish` | `{"type":"step-finish","reason":"tool-calls","cost":0.01,"tokens":{…,"total":2}}` | 990 |
| `compaction` | `{"type":"compaction","auto":true,"overflow":true,"tail_start_id":"msg_<id>"}` (in a user message) | 7 |

`state.status` ∈ `pending`, `running`, `completed`, `error`. `error` carries
`state.error` (a string) and **no** `state.output`. `file`, `patch`, `agent`,
`subtask`, `snapshot` parts exist in OpenCode's schema but did not occur in this
db; AM handles them only generically (below).

### Fields AM reads

| Record | Fields read | Used for |
|---|---|---|
| `session` | `id, directory, parent_id, time_created, time_updated, tokens_*` | attribution, capture, digest totals (`server/src/traces.js:752-760`, `:816`, `:848`) |
| `session` | `title, model` | reader header (`server/src/traces.js:2404-2408`) |
| `message.data` | `role` | prompt vs step (`server/src/traces.js:742`, `:2420`) |
| `message.data` | `mode, summary, finish, error` (only on rows mentioning "compaction") | summary detection, resume arming (`isOpencodeSummary` `:582`, `opencodeTurns` `:632`) |
| `part.data` | `type, text, metadata.compaction_continue, auto, overflow` | `opencodeShape` `:592`, compaction marker `:2424-2429` |
| `part.data` | `tool, state.input, state.output` | reader tool blocks (`:2464-2467`), tool counts (`:749`) |
| `part.data` | `tokens.total` on `step-finish` | `sinceTokens` (`:750`) |

Present but ignored, and useful: `state.status` and `state.error` (live tool
state, failures), assistant `time.completed`/`finish`/`error` (turn
completion), `session.time_compacting` (compaction in progress),
`session.parent_id` in the digest, part `time.start/end`, `synthetic`, and the
`event` table (an ordered change log).

## How AM maps it

### Reader: `normalizeOpencodeDb` (`server/src/traces.js:2397`)

Whole conversation, synchronous, on the main thread, reached through
`parseTraceFile` (`:2619`). OpenCode is not in `WINDOWABLE` (`:2679`), so a
window request normalizes everything and slices (`windowIndex`).

| Source | Reader block |
|---|---|
| user `text` part | `user` message, `text` block (synthetic parts included) |
| assistant `text` | `text` |
| `reasoning` | `thinking` |
| `tool` | `tool_use` (id = part row id, input = `state.input`) + `tool_result` if `state.output` exists |
| `tool` with `status: error` / `pending` / `running` | `tool_use` with **no** result; the three are indistinguishable |
| `step-start`, `step-finish` | dropped |
| `file`, `patch`, other | dropped from the reader (only used to compare replays in `opencodeShape`) |
| user msg with `compaction` part | `assistant`, `kind:'partial'`, one `compaction` block "Context compacted (automatic, context full)" |
| compaction summary (assistant, `summary:true`) | folded into that marker's text |
| resume message after an auto compaction | dropped (the turn above continues) |
| empty message (overflow cut it off) | dropped |
| assistant `error` | not shown |

`opencodeTurns` (`:632`) classifies each message as `compaction`, `summary`,
`empty`, `resume`, `prompt` or `step`. A user message is a `resume` only if an
**automatic** compaction's summary completed (`finish:'stop'`, text, no error)
and the message is the previous prompt replayed verbatim with the same
attachments, or a `compaction_continue` note. The reader and digest share this
walk, so they agree. History: `3397ee1`, `5dc297c`, `2f0b5ee`, `2742705`
(`git log -- server/src/traces.js`).

The header's `activity` is never set for OpenCode (`headOf`, `:2640`), so the
reader's working line (`web/src/components/conversation/ConversationView.tsx:176`)
never lights for an OpenCode pane. Subagent child sessions are not rendered;
only the parent's `task` tool call and its output appear.

### Digest: `readOpencode` (`server/src/traces.js:719`)

One pass over **all** sessions whenever the db/WAL signature changes, memoized
(`ocMemo`), with a per-session walk memo (`opencodeWalk`, `:673`). Per session:

| Digest field | Source |
|---|---|
| `stats.prompts` | user messages minus compaction records and resumes (`:775`) |
| `stats.turns`, `sinceTurns` | assistant messages excluding summaries (`qCount`, `NOT_SUMMARY` `:585`) |
| `lastPromptText/Raw/Ts` | text parts of the last real prompt, `message.time_created` (`:776-783`). Text starting with `<` is dropped **and so is its timestamp**. |
| `sinceTools`, `sinceToolCalls` | `tool` parts after that prompt (`:785-788`) |
| `sinceTokens` | sum of `step-finish.tokens.total` after it (`:789`) |
| `lastAssistantText/Md/Ts` | newest non-empty assistant `text` **part** after the prompt, summaries excluded (`:795-800`) |
| `lastAnswerTs` | `part.time_created` of the newest assistant text part in the session (`:793-794`) |
| `running` | **never set**: always `false` |
| `outSeq`, `outHash`, `turnsLog` | **never set**: `digestAssistant` is not called |

`agent-list.js:45` turns `lastPromptTs`/`lastAnswerTs` into
`lastPromptAt`/`lastAnswerAt`/`activityKind`; `index.js:1092` exposes
`lastPrompt`/`lastAnswer`. `digestFor` (`:1479`) returns `null` for OpenCode,
so its Overview tile always waits for the bulk build.

### Sharing

`findDbSession` (`server/src/share.js:350`) returns `(db, ses_id)`;
`scripts/share-session.mjs:71` (`fromOpencode`) exports STS. It does not use
`opencodeTurns`: every user message counts as a prompt (compaction records and
replays included), the summary is exported as an ordinary answer, and
reasoning is dropped.

## Which trace belongs to which pane

Pin: `session.opencodeSessionId` (`ses_…`). Three writers can set it.

| Writer | When | Guard |
|---|---|---|
| Plugin breadcrumb. `scripts/am-opencode-repin.js`, installed as `<config>/opencode/plugins/am-agent-manager.js` at server start (`installOpencodeRepinPlugin`, `server/src/runner.js:1449`, `server/src/index.js:110`) | `session.created` for a root session (`:86-89`) and `chat.message` (`:126`). Writes `$AM_REPIN_DIR/<amId>.opencode.json`. | Plugin is a no-op unless `process.pid == AM_PANE_PID` (`:11`; set at `server/src/runner.js:2028`). Runner checks amId/runId/cwd/pid/claimed (`breadcrumbVerdict`, `:1321`), then the db row: must exist, have no `parent_id`, and live under the folder (`:1528-1534`). Polled every 250 ms (`BREADCRUMB_MS`, `:1218`). |
| DB fallback. `scheduleOpencodeCapture` (`server/src/runner.js:1747`) | 3 s after launch, then every 20 s (`REPIN_MS`, `:754`) while running | Skipped while another **running** OpenCode pane shares the folder (`folderIsShared`, `:1180`). Otherwise takes the newest `session` row in the directory created since launch−2 s and not claimed (`captureOpencodeSession`, `server/src/traces.js:816`). **No `parent_id` filter.** |
| Launch | `commandFor` (`server/src/runner.js:1902-1930`) resumes `opencode --session <pin>` only if `opencodeSessionExists` (`server/src/traces.js:835`). Unpinned and alone: `opencode --continue \|\| exec opencode`. Unpinned and sharing: fresh `opencode`. | `SES_ID` shape check (`:1831`) before the id reaches the shell. |

Attribution in `buildImpl` (`server/src/traces.js:1387-1410`): pinned rows go
to their pane. Every other row goes by `session.directory` to the single
**unpinned** OpenCode pane in that folder, else to "other" (`'ambiguous'`
guard). Rows reserved by a pin never fall back. The freshest row by `lastTs`
wins the digest (`attribute`, `:1301`).

Consequences:

- **Two panes in one folder.** The plugin pins each exactly. Without the plugin
  (or before the first prompt), the DB fallback is disabled, and unpinned panes
  read as `ambiguous`: no digest, no reader.
- **`/new` (`/clear`).** `session.created` re-pins at once through the plugin.
  The DB fallback also follows it within 20 s when the folder is not shared.
- **Switching back to an older conversation** (session list). `chat.message`
  re-pins to it on the next prompt. In an unshared folder, the DB fallback then
  re-pins to the newest row created since launch. The two writers can flap.
- **Subagents (`task` tool).** A child row has `parent_id` set and the same
  `directory`. The plugin path rejects it. The DB fallback does not, so the pin
  can move to a child that was created after the root. Unpinned panes also
  absorb children by directory: tokens merge, and the child's digest wins when
  its `lastTs` is newer.
- **Compaction** stays in the same `session` row; the pin is unaffected.
- **Purged conversation.** Launch falls back to a fresh conversation instead of
  `opencode --session` exiting with "Session not found".

## State

| Signal | Computed in | OpenCode specifics |
|---|---|---|
| `state` (working/waiting/stopped) | `deriveState` `server/src/runner.js:214` | Screen diff only. `resizeMode:'repaint'` (`server/src/config.js:246`). |
| `inputRequired` | `server/src/input-required.js:10`, marker from plugin `syncInputRequired` (`scripts/am-opencode-repin.js:39`) | Paired `permission.asked`/`question.asked` → `*.replied`/`question.rejected`, plus completed/errored `question` tool parts. Operator keystrokes do not clear it (`input-required.js:139`). Ceiling 30 min. Includes subagent requests (all sessions' events reach the plugin). See [tui-input-required.md](../tui-input-required.md). |
| `digest.running` | not set | Always `false`. Overview `atWork` is screen-only for OpenCode. |
| reader `activity` | not set | Always `null`. The reader never shows "running". |
| `lastPromptAt` / `lastAnswerAt` / `activityKind` | `conversationActivity` `server/src/agent-list.js:45` | From the timestamps above. |
| unread (`output`) | `outputOf` `server/src/index.js:697` | `outSeq` is always 0, so `output` is always `null`. OpenCode replies never mark a tile unread. |

**Precedence.** There is nothing to arbitrate: the screen alone decides
working/waiting, the plugin marker decides needs-input, and the trace is not
consulted for liveness.

**Failure modes.**

1. **Busy without screen change.** A long `bash` tool or a slow first token
   with no animated element looks `waiting` after 4 s. The db already says
   otherwise: a tool part in `running`, or an assistant message without
   `time.completed`. AM reads neither.
2. **Narration flips `activityKind` to `answer` mid-turn.** `lastAnswerTs` is
   the `time_created` of any assistant text part, including "let me check…"
   before a tool call. It is also the time the part **started** streaming,
   not when it ended.
3. **Turn ends without text.** A turn that ends in a tool error, an abort
   (`MessageAbortedError`) or a crash has no newer text part, so
   `activityKind` stays `prompt` indefinitely.
4. **Prompts starting with `<`** (pasted XML/HTML) leave `lastPromptTs` at 0.
   The Overview shows the previous answer as the latest activity.
5. **Digest frozen while any OpenCode pane works.** `readOpencode` serves the
   previous rows while the db/WAL was written in the last 8 s
   (`server/src/traces.js:726`). The db is shared, so one busy pane freezes the
   digest of every OpenCode pane until 8 s of quiet. The comment cites the FUSE
   mount, but the db now lives on local disk.
6. **Crash mid-turn** leaves an assistant message with no `time.completed`
   forever. Any future "in progress" signal must also check that the process
   is alive.
7. **Compaction.** Handled for display and counts (shared walk). Not handled
   in the share exporter. `session.time_compacting` would flag "compacting
   now", but AM does not read it.
8. **Subagents.** See pinning above: DB-fallback re-pin to a child, and
   child-row merge for unpinned panes.
9. **Reader cost.** `readTrace` passes the db file size as the cache weight
   (`server/src/traces.js:3037`). The local db is 133 MB, over
   `MAX_BYTES` = 64 MB (`server/src/trace-revision.js:39`), so an OpenCode
   trace is never cached. Every WAL write changes the revision too. Each
   reader poll re-normalizes the whole conversation synchronously
   (`PHASE.readTrace`).
10. **Watchdog.** `readOpencode` breadcrumbs `PHASE.readOpencode`
    (`server/src/watchdog.js:21`) because synchronous `node:sqlite` reads have
    wedged the loop before. A wedge there blocks every pane's state, not only
    OpenCode's.

## Gaps

1. **No trace-derived liveness.** Set `digest.running` and reader `activity`
   from the db: running when the last assistant message lacks
   `time.completed` and `error`, or when any tool part is `pending`/`running`.
   Gate it on the pane process being alive (failure mode 6).
   Alternatively, have the plugin also forward `session.status` (busy/idle) or
   `session.idle` events as a marker. That is exact and cheap.
2. **8 s hot-db freeze across all panes** (`server/src/traces.js:726`). Drop it
   or bound it (for example, max 8 s staleness, not "8 s of quiet"), now that
   the db is on local disk.
3. **DB-fallback capture ignores `parent_id`.** Add `and parent_id is null` to
   `captureOpencodeSession` (`server/src/traces.js:819`) and to the share
   fallback (`server/src/share.js:360`). Skip child rows in the
   directory-fallback attribution (`server/src/traces.js:1407`). Once the plugin
   has proven itself for a run (`host.exactRepinProven`), do not let the DB
   fallback re-pin. That stops the flapping.
4. **No unread cursor.** Call `digestAssistant(dg, text, ts, partId)` in
   `readOpencode` so `outSeq`/`outHash` work. The part id is a stable key.
5. **`lastAnswerTs` semantics.** Use only text from the final step (message
   with `finish:'stop'`), or `time.end`/`time.completed`, so narration and
   streaming start do not read as an answer.
6. **Reader fidelity.** Render `state.error` as an error `tool_result`, mark
   `pending`/`running` tools as in progress, and show `file` attachments and
   assistant `error`. Drop or label `synthetic` user text.
7. **Reader cache weight.** Weigh the opencode cache entry by the normalized
   size, not the db size. Consider windowing by message `time_created`.
8. **Share exporter** should reuse `opencodeTurns` so compaction is not
   exported as a prompt plus answer.
9. **Schema drift watch.** `session_message`/`session_input` are empty today.
   Add a startup check that warns when they gain rows while `message` stops
   growing.
