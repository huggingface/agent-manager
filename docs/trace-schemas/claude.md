# Claude Code

Checked against `claude --version` = **2.1.312 (Claude Code)**. Real
transcripts on this Space were written by 2.1.211 through 2.1.312; where the
format changed across those versions it is noted. Line numbers are against the
current checkout of `docs/trace-schemas`.

The CLI-independent state pipeline (screen diff, `/wait`, Overview `atWork`,
input-required markers) is in [README.md#state-pipeline](README.md#state-pipeline).
This page covers only what is specific to Claude Code.

## Where the trace lives

| What | Path |
| --- | --- |
| Main transcript | `$CLAUDE_CONFIG_DIR/projects/<slug>/<uuid>.jsonl` |
| Sub-agent transcript | `$CLAUDE_CONFIG_DIR/projects/<slug>/<uuid>/subagents/agent-<agentId>.jsonl` |
| Sub-agent sidecar | `…/subagents/agent-<agentId>.meta.json` |
| Auto-memory (not read by AM) | `$CLAUDE_CONFIG_DIR/projects/<slug>/memory/` |
| File snapshots for `/rewind` (not read) | `$CLAUDE_CONFIG_DIR/file-history/` |

- `<slug>` is the absolute cwd with every non-alphanumeric character replaced
  by `-`, capped at 200 characters plus a base-36 hash
  (`projectDirName`, `server/src/claude-adopt.js:19`). Example:
  `/data/workspaces/my-proj` → `-data-workspaces-my-proj`.
- `<uuid>` is the conversation id. AM chooses it (see
  [Which trace belongs to which pane](#which-trace-belongs-to-which-pane)).
- On the Space `CLAUDE_CONFIG_DIR=$AM_LOCAL/agent-state/claude`
  (`entrypoint.sh:59`), local disk. The durable copy is
  `$DATA_DIR/state/claude` (`entrypoint.sh:58`), written by
  `scripts/agent-state.sh checkpoint` every 15 s with rsync and restored with
  `rsync --update` at boot (`restore_claude`, `scripts/agent-state.sh:713`;
  `projects` and `file-history` are restored as split slices). See
  [agent-state-checkpoints.md](../agent-state-checkpoints.md). Some comments in
  `runner.js` (around `claudeTranscriptsSince`) still say the config dir is on
  the FUSE bucket; that is no longer true.
- AM looks in `$CLAUDE_CONFIG_DIR`, `~/.claude` and `~/.config/claude`
  (`claudeFiles`, `server/src/traces.js:1217`; `claudeTranscripts`,
  `server/src/share.js:116`; `claudeProjectDirs` in `runner.js`). Only files
  directly under `projects/<slug>/` are listed. `subagents/` is never walked by
  the bulk pass.

**Format and write timing.** JSONL, one file per conversation, append-only.
Verified on a live session: records are appended as each content block
finishes streaming, not at turn end. One API response with thinking, text and
a tool call becomes three `assistant` lines with the same `message.id`,
timestamps 0.5–1 s apart, and the file mtime tracks the last record. The
`tool_result` lands as a separate `user` line when the tool returns. A batch of
metadata lines without `timestamp` (`last-prompt`, `ai-title`, `mode`,
`permission-mode`, `atis-latch`, `api-request-blob`, …) is appended around each
prompt. At turn end Claude appends `system/stop_hook_summary` and
`system/turn_duration`.

Two transcripts on this Space (both above 12 MiB) contain a line that starts in
the middle of a JSON record, mid-file. The cause is not known (crash, a
restore merge, or Claude itself). Every reader skips unparseable lines, but see
[`activity-incomplete`](#gaps).

## Schema

Record types counted over every main transcript on the Space (92 files):

| `type` (`subtype` / `attachment.type`) | Count | Read by AM? |
| --- | --- | --- |
| `assistant` | 46.8k | yes |
| `user` | 26.3k | yes |
| `attachment` (`total_tokens_reminder`, `queued_command`, `edited_text_file`, `task_reminder`, `skill_listing`, `deferred_tools_*`, `hook_non_blocking_error`, `file`, `date_change`, …, ~40 kinds) | 21k | only `queued_command`, reader only |
| `api-request-blob`, `api-request`, `api-request-shape` | 27k | no |
| `permission-mode`, `mode`, `last-prompt`, `ai-title`, `atis-latch`, `pr-link`, `frame-link`, `tools-used`, `cost-state`, `artifact-*` | 60k | no |
| `queue-operation` (`enqueue` / `dequeue` / `remove`) | 3.9k | yes, reader only |
| `system` (`turn_duration`, `stop_hook_summary`, `away_summary`, `scheduled_task_fire`, `compact_boundary`, `informational`, `local_command`, `model_refusal_no_fallback`, `model_consent_fallback`) | 6.8k | no |
| `file-history-snapshot`, `file-history-delta` | 2k | skipped explicitly |

Not present on this Space although older docs mention them: `summary`,
`progress`, `result`. No `isApiErrorMessage` record was found either; the field
is read but this Space has no example.

### `assistant`

```json
{"type":"assistant","uuid":"<uuid-a>","parentUuid":"<uuid-p>","sessionId":"<conv-uuid>",
 "timestamp":"2026-01-01T00:00:00.000Z","cwd":"/data/workspaces/<folder>","isSidechain":false,
 "version":"2.1.312","requestId":"req_<id>",
 "message":{"id":"msg_<id>","model":"claude-<model>","role":"assistant",
   "content":[{"type":"text","text":"<answer text>"}],
   "stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":2,
   "cache_read_input_tokens":3,"cache_creation_input_tokens":4,"server_tool_use":{"web_search_requests":0}}}}
```

- Exactly one content block per line in current versions. Blocks are
  `thinking` (`{thinking, signature}`), `text`, `tool_use` (`{id, name,
  input}`).
- `message.id` repeats across the lines of one API response; `usage` repeats
  on each of them.
- `stop_reason` in **main** transcripts on 2.1.3xx is already the final value
  on every line of the response, including the leading `thinking` line
  (10,087 ids all `tool_use`, 1,398 all `end_turn`; 14 ids had `null` then
  `tool_use`). In **sub-agent** transcripts of 2.1.300 and in older versions it
  is `null` on most lines. A main-transcript `null` that is never followed by a
  final value marks a response whose stream was cut (interrupt). Values seen:
  `tool_use`, `end_turn`, `stop_sequence`, `refusal`, `null`.
- Present, unread, useful: `requestId`, `effort`, `thinkingDurationMs`,
  `isSidechain`, `agentId` (sub-agents).

### `user`

Five shapes, told apart only by flags and content:

| Shape | Distinguishing fields | Count |
| --- | --- | --- |
| Typed prompt | `origin.kind:"human"`, `promptSource:"typed"` or `"queued"`, `content` is a string | ~1.6k |
| Tool result | `toolUseResult` (structured), `content:[{type:"tool_result",tool_use_id,content,is_error}]`, `sourceToolAssistantUUID` | 32.8k |
| Harness envelope | `isMeta:true` and/or `sourceToolUseID` (skill payloads, `<local-command-…>`, coordinator text) | ~880 |
| Task notification | `origin.kind:"task-notification"`, `promptSource:"system"`, text starts `<task-notification>` (sub-agent copies start `[SYSTEM NOTIFICATION - NOT USER INPUT]`) | ~1k |
| Compaction summary | `isCompactSummary:true`, `isVisibleInTranscriptOnly:true`, text starts "This session is being continued…" | 19 |

```json
{"type":"user","uuid":"<uuid>","parentUuid":"<uuid>","timestamp":"…","cwd":"…","isSidechain":false,
 "origin":{"kind":"human"},"promptSource":"typed","promptId":"<id>",
 "message":{"role":"user","content":"<prompt text>"}}
{"type":"user","toolUseResult":{"stdout":"…"},"sourceToolAssistantUUID":"<uuid>",
 "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_<id>","content":"<output>","is_error":false}]}}
```

- Interrupts are `user` text records: `[Request interrupted by user]` after a
  streamed answer, or a `tool_result` followed by
  `[Request interrupted by user for tool use]`.
- Images: 2,247 `tool_result` blocks carry `content:[{type:"image",source:{type:"base64",…}}]`
  (screenshots, `Read` of an image). No top-level `image` block in a `user`
  record was found on this Space.
- Pasted text is wrapped `<pasted_content id="…">…</pasted_content id="…">`.
- 50 `tool_result` records have no `toolUseResult`.
- Present, unread, useful: `origin.kind`, `promptSource`, `turnOrigin`,
  `isCompactSummary`, `permissionMode`.

### `system`

```json
{"type":"system","subtype":"turn_duration","durationMs":12345,"messageCount":42,
 "pendingBackgroundAgentCount":2,"isMeta":true,"timestamp":"…"}
{"type":"system","subtype":"stop_hook_summary","stopReason":"…","hookCount":1,"preventedContinuation":false,"timestamp":"…"}
{"type":"system","subtype":"compact_boundary","content":"Conversation compacted","logicalParentUuid":"<uuid>",
 "parentUuid":null,"compactMetadata":{"trigger":"auto","preTokens":1,"postTokens":2,"preservedSegment":{}}}
```

`turn_duration` is written once per finished turn, after the last assistant
line. `pendingBackgroundAgentCount` (present when background sub-agents are
still running) appeared in 2.1.3xx. AM reads none of these.

### `queue-operation`

```json
{"type":"queue-operation","operation":"enqueue","content":"<prompt typed while busy>","timestamp":"…"}
{"type":"queue-operation","operation":"dequeue","timestamp":"…"}
{"type":"queue-operation","operation":"remove","content":"<text>","reason":"absorbed_mid_turn","commandUuid":"<uuid>"}
```

### `attachment/queued_command`

```json
{"type":"attachment","attachment":{"type":"queued_command","prompt":"<text>","source_uuid":"<uuid>"},"timestamp":"…"}
```

### Sub-agent sidecar `agent-<id>.meta.json`

```json
{"agentType":"general-purpose","description":"<task>","toolUseId":"toolu_<id>","spawnDepth":1,
 "requestShape":"background","isBuiltIn":true,"finished":true}
```

`finished:true` is added when the sub-agent ends. AM reads `agentType`,
`description`, `toolUseId`, `parentAgentId`, `spawnDepth` and the file mtimes,
but not `finished` or `requestShape`.

### Fields AM reads

| Record | Fields read | Used for | Code |
| --- | --- | --- | --- |
| any | `timestamp` | `firstTs`/`lastTs`, digest timestamps | `server/src/traces.js:194` |
| `assistant` | `message.id` (fallback `uuid`) | dedupe turns/usage in the digest; merge blocks in the reader; Overview unread key `outKey` | `traces.js:197`, `traces.js:1839`, `traces.js:109` |
| `assistant` | `message.usage.*` | token stats, `sinceTokens`, reader usage | `traces.js:202`, `traces.js:1851` |
| `assistant` | `content[].tool_use` `id`,`name`,`input.file_path` | tool counts (dedupe by block id), `sinceFiles`, reader tool block | `traces.js:215`, `traces.js:1891` |
| `assistant` | `content[].text` | `lastAssistantText`, `outSeq`; reader text | `traces.js:223`, `traces.js:1866` |
| `assistant` | `content[].thinking` | reader thinking block; reader activity | `traces.js:1889` |
| `assistant` | `message.stop_reason` | reader `activity`, `kind:'final'`; delegation outcome | `traces.js:1908`, `server/src/delegations.js:44` |
| `assistant` | `isApiErrorMessage`, `error` | reader `msg.error`; delegation `failed` | `traces.js:1849`, `delegations.js:48` |
| `assistant` | `message.model` | reader model | `traces.js:1850` |
| `user` | `toolUseResult`, `isMeta`, `sourceToolUseID` | exclude from prompts | `traces.js:228`, `traces.js:1764` |
| `user` | `origin.kind === 'task-notification'` | keep despite `isMeta` (sub-agent strip) | `traces.js:1764` |
| `user` | `content` string / `text` blocks | prompt (digest, reader), harness-envelope test | `traces.js:232`, `traces.js:1735` |
| `user` | `content[].tool_result` `tool_use_id`,`content`,`is_error` | reader result stitched next to its call | `traces.js:1895` |
| `user` | `content[].image` `source.data`,`media_type` | reader image block | `traces.js:1902` |
| `user`/`assistant` | `cwd` | reader `cwd`; pin scan and `findTranscript` cwd fallback | `traces.js:1837`, `runner.js:1145`, `share.js:184` |
| `user` | `isSidechain` | delegation ignores sidechain records | `delegations.js:27` |
| `queue-operation` | `operation`, `content`, `reason`, `commandUuid` | reader queued prompts | `traces.js:1765` |
| `attachment` | `attachment.type==='queued_command'`, `prompt`, `source_uuid` | reader "delivered" queue event | `traces.js:1821` |
| `file-history-*` | `type` | skipped (embeds file contents) | `traces.js:1756`, `scripts/share-session.mjs:205` |

## How AM maps it

### Digest (`parseClaude`, `server/src/traces.js:186`)

Runs over the whole file (or its last 12 MiB, `readTraceFile`,
`traces.js:976`), on a worker (`server/src/trace-parse-worker.js`,
`statsFromFile` `traces.js:1035`).

- **Prompt**: a `user` record without `toolUseResult`, `isMeta` or
  `sourceToolUseID`, whose text (string or joined `text` blocks), after
  `unwrapPasted`, is non-empty and does not start with `<` or
  `[Request interrupted` (`traces.js:228-252`). A wrapped paste always counts.
  `digestPrompt` (`traces.js:87`) resets `since*`, `turnsLog` and the last
  answer.
- **Answer**: every `text` block of an `assistant` line goes through
  `digestAssistant` (`traces.js:109`) keyed by `message.id`, so two replies
  with the same words are two outputs, and a second text block of the same
  message is a revision, not a new reply.
- **Tools**: `tool_use` blocks deduped by block id, counted in `sinceTools`;
  `Edit|Write|MultiEdit|NotebookEdit` add `input.file_path` to `sinceFiles`.
- **Tokens/turns**: once per `message.id`.
- **Not set**: `digest.running`, `st.cwd`, `st.subagent`. Thinking, tool
  results, `system` records, queue operations, compaction and errors do not
  touch the digest.
- Files above 12 MiB get `lastPromptTs`/`lastAnswerTs` from the append-cursor
  scan in `server/src/trace-activity.js` (`traceActivity`), which feeds each
  complete line through `parseClaude` and keeps only the five cursor fields.
  A malformed line anywhere sets `activityError:'activity-incomplete'`.
- `/api/agents` exposes `lastPrompt`/`lastAnswer` (`server/src/index.js:1092`)
  and `lastPromptAt`/`lastAnswerAt`/`activityKind` (`conversationActivity`,
  `server/src/agent-list.js:45`).

### Reader (`normalizeClaude`, `server/src/traces.js:1739`)

| Source | Reader output |
| --- | --- |
| `assistant` lines with one `message.id` | one `assistant` message; first line owns `usage`/`model`; later lines append blocks (`traces.js:1839`) |
| `text` | `text` block; `thinking` → `thinking` block; `tool_use` → `tool_use` block with `input` JSON (capped 20,000 chars) |
| `tool_result` | `tool_result` block (`failed` = `is_error`) inserted after its call by `makeStitcher` (`traces.js:1600`); orphan results stay in the `user` message |
| `tool_result` content array | flattened by `flattenToolContent` (`traces.js:2515`): image items become their JSON, base64 included, cut at 20,000 chars |
| top-level `image` | `image` block with a data URL |
| user text matching `isHarnessText` (`traces.js:1735`: `<task-notification`, `<system-reminder`, `<environment_context`, `<fork-boilerplate`, `[Request interrupted`, `[SYSTEM NOTIFICATION`, …) | `system` message, not a prompt |
| `isMeta` / `sourceToolUseID` | dropped, except task notifications |
| `queue-operation` | reader windows: `system` message with `event:{type:'queue',…}`; full parse: queued `user` message kept only if `remove`d |
| `attachment/queued_command` with `source_uuid` | reader windows: `event:{type:'queue',operation:'delivered'}` |
| `isApiErrorMessage` | `msg.error` on the assistant message |
| `stop_reason` `end_turn`/`stop_sequence` | `kind:'final'` in reader windows; `markFinalTurns` (`traces.js:2595`) otherwise |
| fork sub-agent | messages before `<fork-boilerplate>` are cut (`traces.js:1750`) |
| `compact_boundary`, `isCompactSummary` | **not handled**: the boundary is ignored and the summary renders as an operator prompt |
| `turn_duration`, `stop_hook_summary`, `away_summary`, other `system` | ignored |

`activity` (`traces.js:1907-1914`) is decided per `user`/`assistant` line that
survives the filters, last one wins:

1. `stop_reason` is `end_turn` or `stop_sequence` → `waiting`.
2. else `stop_reason` is `tool_use`, or the line has a `thinking` or
   `tool_use` block → `working`.
3. else a `user` line with non-harness text → `working`.
4. else an `assistant` line with text → `waiting`.
5. else unchanged (tool results, harness text, interrupt markers, `refusal`).

Exposed through `headOf` (`traces.js:2633`).

### Sub-agents

`subagentRoster` (`traces.js:3146`) lists `<uuid>/subagents/*.meta.json` next
to the pinned transcript; `readSubagentTrace` (`traces.js:3194`) renders one
with the same normalizer. Sub-agent records are `isSidechain:true` and carry
`agentId`. Sub-agents add nothing to the parent's digest, token totals or
activity.

### Sharing

`scripts/share-session.mjs` ships the main transcript verbatim minus
`file-history-*` (`share-session.mjs:205`) and computes stats with its own
copy of the prompt rules (`claudeLine`, `share-session.mjs:225`). Sub-agent
files are not included.

## Which trace belongs to which pane

**Choosing the uuid.** Every session gets `sessionUuid = crypto.randomUUID()`
at creation (`server/src/sessions.js:71`). The launch line
(`commandFor`, `server/src/runner.js:1867`) is:

- never started: `claude --session-id <uuid> [prompt] || exec claude`;
- started before: `if <find projects -name '<uuid>*'>; then exec claude --resume <uuid>; else <fresh>; fi`.

`--resume` keeps writing the same `<uuid>.jsonl` in 2.1.3xx: every
`sessionId` inside every transcript on this Space equals its filename.

**Adoption.** An adopt request (`adoptSessionUuid`) sets the pin to an
existing conversation and `everStarted:true`, so the first open runs
`--resume` (`checkAdoption`, `server/src/claude-adopt.js:42`;
`POST /api/agents/adopt`, `server/src/index.js:1342`, applied at `server/src/index.js:3296`). The folder must match the transcript's slug.

**Keeping the pin right.** The uuid changes under AM in two cases: the fresh
`--session-id` invocation exits non-zero and `|| exec claude` starts a
conversation with its own id, and `/clear` starts a new conversation file.
Two mechanisms follow it:

1. **SessionStart hook** (`scripts/am-repin-hook.sh`), installed into
   `$CLAUDE_CONFIG_DIR/settings.json` at boot (`installClaudeRepinHook`,
   `runner.js:1383`, called from `server/src/index.js:99`). It writes
   `/tmp/am-repin/<AM_ID>.claude.json` with `AM_RUN_ID`, `CLAUDE_PID` and the
   hook payload (`session_id`, `transcript_path`, `cwd`, `source`) only when
   `CLAUDE_PID` is the pane root or its direct child. The server consumes it
   (`takeBreadcrumb` `runner.js:1226`, `scheduleBreadcrumbCapture`
   `runner.js:1581`) and re-pins after `breadcrumbVerdict` (`runner.js:1321`):
   same AM id, CLI, run id; `cwd` under the folder; pid trusted; id not claimed
   by another session.
2. **Transcript scan** (`scheduleClaudeCapture`, `runner.js:1634`), every
   20 s (`REPIN_MS`, `runner.js:754`), demoted to every 60 s once a breadcrumb
   proved the hook works (`SCAN_BACKSTOP_MS`, `runner.js:1619`).
   `claudeCandidate` (`runner.js:1145`) picks the newest transcript touched
   since launch, born in this launch window, whose first `cwd` is under the
   folder and that no other session pins. Skipped entirely while another live
   Claude pane shares or overlaps the folder (`folderIsShared`,
   `runner.js:1180`).

Compaction does **not** change the uuid: `compact_boundary` and the summary
are appended to the same file (19 auto compactions seen, all in place).

**Lookup.** Three different resolvers:

| Caller | Rule | Code |
| --- | --- | --- |
| Overview bulk digest | filename uuid == `sessionUuid`, else "other"; no cwd fallback | `buildImpl` `traces.js:1316` |
| Targeted digest, `traceLocation`, sub-agent roster | basename *includes* `sessionUuid`; newest `lastTs` / first hit | `digestFor` `traces.js:1484`, `traceLocation` `traces.js:1513` |
| Reader, sharing, delegations | basename *starts with* `sessionUuid`, newest mtime; else newest transcript whose first `cwd` equals the folder, only if no other Claude session uses that folder | `findTranscript` `server/src/share.js:206` |

**Two panes in one folder.** Each has its own `--session-id`, so attribution
by uuid is exact. The scan refuses to re-pin while both are live; only the
hook can follow a `/clear` there. `findTranscript`'s cwd fallback returns
nothing for a shared folder.

## State

Signals AM combines for a Claude pane:

| Signal | Source | Computed at | Consumers |
| --- | --- | --- | --- |
| PTY alive | host map | `deriveState` `server/src/runner.js:214` | everything |
| Screen changed in last 4 s | djb2 of visible text, 250 ms throttle | `sampleScreen` `runner.js:175`, `BUSY_SECS` `runner.js:85` | `state`, `/wait`, Overview `atWork` |
| Reader `activity` | last surviving `user`/`assistant` line | `normalizeClaude` `traces.js:1907` | reader running line (`web/src/components/conversation/ConversationView.tsx:176`) |
| Digest | prompt/answer/tool timestamps; **no** `running` | `parseClaude` `traces.js:186`, `trace-activity.js` | Overview cards, `/api/agents` `activityKind` |
| Input-required marker | `Notification` hook (`permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input` set; `agent_completed` clears); `PostToolBatch`, `Stop`, `SessionEnd`, `ElicitationResult`, `UserPromptSubmit` clear | `installClaudeRepinHook` `runner.js:1383`, `scripts/am-input-required-hook.sh`, `server/src/input-required.js` | badge, reader banner, delegation `blocked` |
| Composer busy text | `CLAUDE_CONFIRM.busy = /esc to interrupt/` on the visible screen | `server/src/config.js:215`, `submitConfirmed` `runner.js:2740` | only to confirm that an AM-sent Enter submitted the prompt; never feeds `state` |
| Delegation evidence | `stop_reason`, `isApiErrorMessage`, `AskUserQuestion` tool_use after the matched prompt | `consumeEvidence` `server/src/delegations.js:22` | `completion: notify` outcome |

The `Stop` hook fires at every turn end, but AM only uses it to delete an
input-required marker. Nothing records "turn ended" from it.

**Precedence.** As in [README.md#precedence-when-signals-disagree](README.md#precedence-when-signals-disagree):
`state` is screen diff only; the reader trusts `activity` and ignores the
screen; Overview `atWork` is screen-only for Claude because `digest.running`
is never set; input-required never changes `state`.

### Failure modes

| Scenario | Screen `state` | Reader `activity` | Why |
| --- | --- | --- | --- |
| Normal turn, spinner visible | `working` | `working` | spinner glyph and elapsed counter repaint |
| Turn finished | `waiting` after 4 s | `waiting` | `end_turn` line |
| Turn ended, background sub-agents running (observed live on the coordinating pane of this work) | `working` for as long as they run: the footer lists each agent with a ticking `7m 47s · ↓ 129k tokens` and `✻ Waiting for N background agents to finish` | `waiting` | `end_turn`, then `turn_duration` with `pendingBackgroundAgentCount`. The sidebar says working, the reader says idle, both "correct" |
| Background Bash / `Monitor` after `end_turn` | `waiting` unless a status row animates | `waiting` | the trace is quiet until the task's `<task-notification>` arrives; that record is harness text, so activity flips to `working` only on the next assistant line |
| Long tool call (build, `sleep`, long-poll) | `working` while Claude's spinner/elapsed counter runs; `waiting` if the screen is static | `working` | last line is `tool_use`. Not verified whether 2.1.312 keeps animating during every tool |
| Permission dialog | `waiting` (static) | `working` (last line `tool_use`) | input-required marker after ~6 s; reader hides its running line while the marker is set |
| `AskUserQuestion` | `waiting` | `working` | no Notification in some versions ([tui-input-required.md](../tui-input-required.md)); delegation marks `blocked` from the `tool_use` instead |
| Interrupt during a tool call | `waiting` | stays `working` | `tool_result` and `[Request interrupted by user for tool use]` do not change activity (rule 5); the reader shows a running line until the next prompt |
| Interrupt while streaming text | `waiting` | `waiting` | partial text line has `stop_reason:null`, rule 4 |
| Interrupt while thinking (nothing streamed) | `waiting` | stays `working` | last line is `thinking` |
| Refusal (`stop_reason:"refusal"`) | `waiting` | `working` if the line holds thinking/tool_use, else unchanged | `refusal` is not in rule 1 |
| API error / login expired | `waiting` | `waiting` (error text line) | `isApiErrorMessage` sets `msg.error`; no example on this Space |
| Auto-compaction mid-turn | `working` | `working` | the summary `user` line counts as a **prompt**: the digest's `lastPrompt` becomes "This session is being continued…", `since*` resets, `activityKind` flips to `prompt`; the reader shows it as an operator turn |
| `/clear` | brief `working` | the new file has no turns until the next prompt | pin follows via hook or 20–60 s scan; until then digest, reader and `--resume` target the old file |
| `--session-id` rejected, fallback `exec claude` | — | none | same as `/clear`; first breadcrumb has `source:"startup"` |
| Crash mid-turn, pane relaunched | `working` during replay, then `waiting` | `working` until the next line | resume replays; nothing writes a closing record |
| Prompt queued while busy | `working` | `working` | `queue-operation enqueue`; `dequeue` later produces the real `user` line |
| Sub-agent working, parent blocked on it (foreground) | `working` (spinner) | `working` (`tool_use` Agent) | correct; sub-agent detail only in the roster |
| Transcript > 12 MiB with one torn line | — | — | `activityError:'activity-incomplete'` on every `/api/agents` read, forever (two files on this Space) |

## Gaps

1. **No turn-boundary signal for `state`.** Claude writes
   `system/turn_duration` (and the `Stop` hook fires) exactly once per finished
   turn, and AM ignores both. Use the last of `user prompt` /
   `turn_duration` to set `digest.running` in `parseClaude`, as `parseCodex`
   does with `task_started`/`task_complete`. That also fixes the interrupted-
   and thinking-interrupt cases below.
2. **Compaction summary is treated as a prompt.** Skip `isCompactSummary`
   records in `parseClaude` (`traces.js:228`), `normalizeClaude`
   (`traces.js:1764`), `scripts/share-session.mjs:255` and delegations; render
   `compact_boundary` as a `compaction` block, which the block model already
   has.
3. **Interrupt leaves reader `activity` at `working`.** Treat a `user` line
   starting `[Request interrupted` (and a `tool_result` whose run was
   interrupted) as `waiting` in `traces.js:1907-1914`. Gap 1 covers it too.
4. **Background work is invisible to the trace signals and over-visible to
   the screen.** Read `turn_duration.pendingBackgroundAgentCount` and
   `subagents/*.meta.json` `finished` to report "turn done, N agents running"
   rather than letting the footer's ticking counters hold `state` at
   `working`.
5. **Prompt detection by text heuristics.** `origin.kind`, `promptSource` and
   `turnOrigin` say whether a line is human, queued, task-notification or
   system. Prefer them where present (2.1.2xx+), keep the `<`/`[Request
   interrupted` heuristic only as fallback.
6. **Three resolvers disagree.** `buildImpl` (exact uuid), `digestFor` /
   `traceLocation` (`includes`) and `findTranscript` (`startsWith` + cwd
   fallback) can name different files, so the Overview can show no digest
   while the reader shows a transcript. Route all three through
   `findTranscript`.
7. **Tool-result images become base64 text.** `flattenToolContent`
   (`traces.js:2515`) stringifies `image` items; 2,247 on this Space. Emit
   `image` blocks for them, as for top-level images.
8. **Torn lines poison `activityError` permanently.** `trace-activity.js`
   keeps `error` across appends once any line fails. Count bad lines, report
   `activity-incomplete` only when the bad line is the last one, or reset on
   the next good prompt/answer.
9. **Sub-agent usage is not counted.** `claudeFiles` skips `subagents/`, so
   token totals in `/api/traces` exclude every sub-agent. Add them to the
   parent session's stats.
10. **`refusal` and `null` stop reasons are unclassified.** Add `refusal` to
    the `waiting` rule; `delegations.js:46` already fails on it.
11. **`CLAUDE_CONFIRM.busy` is unverified on 2.1.312.** No working pane was
    available to confirm that "esc to interrupt" is still drawn. If the text
    changed, `submitConfirmed` only falls back to the empty-composer test,
    which still works, but the regex should be checked on each upgrade.
