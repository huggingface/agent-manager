# Antigravity CLI (`agy`) trace schema

> **Status: pending.** `agy` is being added in open PR #227 (branch
> `feat/antigravity-cli`). This page was written against
> **`feat/antigravity-cli@8c287ea`** (`8c287ea87f356aab39d4f5a103772a9946cdccf6`,
> 2026-10-29). Branch references use the form `feat/antigravity-cli@8c287ea:path:line`.
> They will move as the branch changes. `agy` is not installed in this image,
> and `main` has no `antigravity` code at all. The branch pins `agy` 1.4.10
> (`feat/antigravity-cli@8c287ea:Dockerfile:93`).

> **Update, `feat/antigravity-cli@5004047`** ("Antigravity: conversation
> reader, digest and pin", pushed after the rest of this page was written).
> The branch now reads the SQLite `steps`, not `transcript.jsonl`
> (`server/src/antigravity.js` on the branch): step types `USER_INPUT` 14,
> `PLANNER_RESPONSE` 15, `ERROR_MESSAGE` 17, `SYSTEM_MESSAGE` 101, `GENERIC`
> 132 (tool result); status `DONE` 3, `ERROR` 7, `WAITING` 9 (tool awaiting
> permission), and 1/2/8/11 (pending/running/generating/queued) treated as
> in flight. It adds `parseAgy` (digest, `running` = last step in flight),
> `normalizeAgyDb` (reader blocks, `activity` from the last step), bulk
> attribution by the pinned `antigravityConversationId` then by cwd for an
> unpinned pane alone in its folder, a `findTrace` case, and a pin captured
> after launch (`scheduleAgyCapture`) with resume by id. Still absent:
> input-required (status 9 is decoded but not wired to the badge), and the
> branch is unmerged. The sections below describe `8c287ea` and are kept for
> the storage details; read them with this note in mind.

**Summary (at `8c287ea`).** The branch adds launch, credentials and durable state for `agy`.
It adds **no trace reader, no digest, no pinning and no input-required
signal**. `traces.js`, `share.js` and `input-required.js` have no change on the
branch. The PR body lists "conversation pinning by id, the reader / trace
panel, input-required hooks … and usage" as follow-ups. So, like Gemini CLI,
an `agy` pane is terminal-only and its state is the screen diff.

Everything under **Schema** below comes from inspecting a scratch `agy` home on
this machine read-only (two conversations, created 2026-10-29). AM's own
`~/.gemini/antigravity-cli` does not exist here. Version strings were not
readable from that home, so the samples are **assumed** to be 1.4.10. Treat
everything below as observed structure, not a documented contract.

## Where the trace lives

From the branch:

| What | Path | Branch ref |
| --- | --- | --- |
| State roots used by `agy` | `~/.gemini/antigravity-cli/` and `~/.gemini/config/`. There is no env override, and it ignores `GEMINI_CLI_HOME` | `entrypoint.sh:76-80` |
| Live (local disk) | `$AM_LOCAL/antigravity-home/{antigravity-cli,config}`. The two `~/.gemini/*` paths are **symlinks** to it | `entrypoint.sh:79`, `:129-130`, `:154-155` |
| Durable | `$DATA_DIR/state/antigravity` | `entrypoint.sh:80`, `scripts/agent-state.sh:59-60` |
| Gemini migration skips them | `rsync --exclude '/antigravity-cli' --exclude '/config'` | `entrypoint.sh:104` |
| Checkpoint | The file tree **without `*.db`**, then `sqlite3 .backup` plus `PRAGMA quick_check` for each `*.db` whose file **or `-wal`** changed since the last stamp | `checkpoint_antigravity`, `scripts/agent-state.sh:532-563`, called at `:1106` |
| Excluded from checkpoint/restore | `*-wal`, `*-shm`, `*.lock`, `bin/`, `log/`, `crashes/`, `updater/`, `presence/` | `scripts/agent-state.sh:230-236`, `:647-649` |
| Restore | Plain tree copy | `restore_antigravity`, `scripts/agent-state.sh:776` |

Layout observed under `antigravity-cli/` (names anonymized):

| Path | Kind | What it appears to be |
| --- | --- | --- |
| `conversations/<conversation-uuid>.db` (+ `-wal`, `-shm`) | SQLite, **WAL mode**, one per conversation | The authoritative step log. The `-wal` stays after exit, so committed rows can live only in the WAL |
| `conversation_summaries.db` | SQLite, shared | One row per conversation: title, cwd, run status, step count |
| `brain/<conversation-uuid>/.system_generated/logs/transcript.jsonl` | **JSONL**, one per conversation | A readable copy of the steps (see below) |
| `brain/<uuid>/.system_generated/logs/transcript_full.jsonl` | JSONL | Same records. Presumably not truncated (**unverified**; identical in the samples) |
| `brain/<uuid>/.system_generated/logs/chunks/{transcript,transcript_full}/00000000.jsonl` | JSONL | Chunked copies |
| `brain/<uuid>/.system_generated/messages/<uuid>.json`, `read.json` | JSON | System/agent messages `{id, sender, recipient, content, priority, hideFromUser, timestamp}` and a read-id list |
| `brain/<uuid>/.system_generated/steps/<n>/output.txt` | text | Spilled tool output for step `n` |
| `brain/<uuid>/scratch/`, `.user_uploaded/` | dirs | Agent scratch space and uploads |
| `annotations/<uuid>.pbtxt` | protobuf text | Per-conversation `title:` |
| `cache/last_conversations.json` | JSON | `{"<cwd>": "<conversation-uuid>"}`: the newest conversation per folder |
| `presence/<uuid>.lock` | lock | Presumably "this conversation is open in a process" (**unverified**) |
| `implicit/*.pb`, `jetbox_summaries_proto.pb`, `jetski_state.pbtxt` | protobuf | Not conversation content (onboarding, migrations, summaries) |

**Write timing (observed, weak).** SQLite rows are committed through the WAL
as steps complete. `transcript.jsonl` mtimes were 2-12 s after the last step's
`created_at`, and `conversation_summaries.last_modified_time` was 2 s after it.
This fits "written per step or at turn end". The samples are too small to
tell which. **Unverified.**

## Schema

### `conversations/<uuid>.db`

```sql
CREATE TABLE trajectory_meta (trajectory_id text PRIMARY KEY, cascade_id text, trajectory_type integer, source integer);
CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0,
  has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob,
  task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0);
CREATE INDEX idx_steps_status ON steps(status);
CREATE INDEX idx_steps_step_type ON steps(step_type);
CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0);
CREATE TABLE executor_metadata (idx integer PRIMARY KEY, data blob);
CREATE TABLE parent_references (idx integer PRIMARY KEY, data blob);
CREATE TABLE trajectory_metadata_blob (id text PRIMARY KEY DEFAULT "main", data blob);
CREATE TABLE battle_mode_infos (idx integer PRIMARY KEY, data blob);
```

The `step_type` and `status` codes below were matched against the
`transcript.jsonl` lines that have the same index:

| `step_type` | JSONL `type` | JSONL `source` | Seen with |
| --- | --- | --- | --- |
| 14 | `USER_INPUT` | `USER_EXPLICIT` | `content` = prompt |
| 15 | `PLANNER_RESPONSE` | `MODEL` | `content` = answer text, `tool_calls[]`, token counts |
| 132 | `GENERIC` | `MODEL` | Tool execution result. `content` = output. `error` and a non-null `error_details` blob when it fails. `render_info` present |
| 101 | `SYSTEM_MESSAGE` | `SYSTEM` | Injected system text |

| `status` | JSONL `status` |
| --- | --- |
| 3 | `DONE` |
| 7 | `ERROR` |

No other codes were seen. A running or pending step status (presumably a lower
value) was never captured, because both conversations had finished.
`step_format` was 0 and `has_subtrajectory` was false on every row.
`trajectory_meta.trajectory_type=4`, `source=17`, and
`trajectory_id == cascade_id`.

**`step_payload` is protobuf.** Its first fields repeat the columns:

- field 1 (varint) = `step_type`. Example: `08 0E` = 14, `08 84 01` = 132.
- field 4 (varint) = `status`. Example: `20 03`.
- field 5 is length-delimited and holds the body.

The body was **not decoded**. `metadata`, `error_details`, `render_info`,
`gen_metadata.data` and `trajectory_metadata_blob.data` are also opaque blobs.
**A reader should parse `transcript.jsonl`, not the protobuf, unless that file
turns out to lag or to be lossy.**

### `brain/<uuid>/.system_generated/logs/transcript.jsonl`

One JSON object per step. Anonymized:

```jsonl
{"step_index":0,"type":"USER_INPUT","status":"DONE","source":"USER_EXPLICIT","created_at":"2026-01-01T00:00:00Z","content":"<prompt text>"}
{"step_index":1,"type":"PLANNER_RESPONSE","status":"DONE","source":"MODEL","created_at":"…","content":"<answer or empty>","tool_calls":[{"name":"run_command","args":{"CommandLine":"<cmd>","WaitMsBeforeAsync":0,"toolSummary":"<summary>"}},{"name":"read_file","args":{"Path":"<path>","toolSummary":"<summary>"}}],"input_tokens":0,"output_tokens":0,"cache_read_tokens":0}
{"step_index":2,"type":"GENERIC","status":"DONE","source":"MODEL","created_at":"…","content":"<tool output>"}
{"step_index":3,"type":"GENERIC","status":"ERROR","source":"MODEL","created_at":"…","content":"<tool output>","error":"<error>"}
{"step_index":5,"type":"SYSTEM_MESSAGE","status":"DONE","source":"SYSTEM","created_at":"…","content":"<system text>"}
```

Notes:

- `created_at` has **second resolution**.
- Tool calls carry **no id**. A result is linked to its call only by order
  (the `GENERIC` steps after a `PLANNER_RESPONSE`).
- Thinking was not seen as a separate field or step.

### `conversation_summaries.db`

```sql
CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, preview text, step_count integer,
  last_modified_time datetime NOT NULL, workspace_uris text NOT NULL, status text, source text, project_id text,
  agent_name text, parent_conversation_id text, nesting_depth integer, battle_id text, winning_conversation_id text,
  not_fully_idle numeric, killed numeric, last_user_input_time datetime NOT NULL,
  last_user_input_step_index integer, app_data_dir text, raw_summary blob, group_id text);
```

Observed values:

| Column | Observed |
| --- | --- |
| `workspace_uris` | A JSON array of `file:///<cwd>` |
| `status` | `CASCADE_RUN_STATUS_IDLE` |
| `not_fully_idle` | 0 |
| `killed` | 0 |
| `nesting_depth` | 0 |
| `parent_conversation_id` | empty |
| `last_modified_time` | Text timestamps with nanoseconds |
| `last_user_input_time` | Text timestamps with nanoseconds |

`step_count` matched the rows in `steps` in one sample but not the other.

**Fields AM reads: none.** There is no reader on the branch.

**Read-only caveat for a future parser.** Opening a WAL database with
`sqlite3 -readonly` still maps and touches `-shm`. During this inspection the
`-shm`/`-wal` mtimes changed, though no content was written. Use `node:sqlite`
with `readOnly`. Do not rely on mtimes of `-shm` as an activity signal. Use the
`.db` and `-wal` sizes, or `PRAGMA data_version`.

## How AM maps it

On `feat/antigravity-cli@8c287ea` nothing is mapped. `findTrace` has no
`antigravity` case, so the reader shows "No transcript yet.". There is no
digest, so `lastPrompt`/`lastAnswer` are `null`. It is not shareable. Usage
is not collected. This is the same as Gemini; see [gemini.md](gemini.md#how-am-maps-it).

A future mapping (not implemented):

| Source | Reader block / digest field |
| --- | --- |
| `USER_INPUT.content` | user text, `lastPromptText`, `lastPromptTs` (`created_at`) |
| `PLANNER_RESPONSE.content` | assistant text, `lastAssistantText`, `lastAnswerTs` |
| `PLANNER_RESPONSE.tool_calls[]` | `tool_use` blocks. There is no call id, so pair them by order with the following `GENERIC` steps |
| `GENERIC.content` / `error` | `tool_result` (error flag from `status=ERROR`) |
| `SYSTEM_MESSAGE` | meta / system block |
| `input_tokens` / `output_tokens` / `cache_read_tokens` | usage |
| `annotations/<uuid>.pbtxt` `title`, or `conversation_summaries.title` | title |
| `parent_conversation_id` / `nesting_depth` / `has_subtrajectory` | subagents (never seen non-empty) |

## Which trace belongs to which pane

On the branch:

- **Launch** (`feat/antigravity-cli@8c287ea:server/src/config.js:254`):
  - First launch with a queued prompt: `agy [--settings '{"modelProvider":"gemini"}'] -i '<prompt>'`.
  - Plain launch: `agy [...]`.
  - Restart: `agy [...] -c || exec agy [...]`. `-c` means "newest conversation
    **in the cwd**, or a fresh one".
  - The `--settings` part is added only when `GEMINI_API_KEY` is set (`:216`).
- **Shared-folder guard.** When another `antigravity` pane uses the same
  folder, a restart starts fresh instead of `-c`
  (`feat/antigravity-cli@8c287ea:server/src/runner.js:1960`). The comment there
  says "nothing pins its conversations yet".
- **No pinning, no capture.** AM records no conversation id for an `agy` pane.

Pinning options visible from the storage and PR notes (all **unverified as AM
code**):

1. `--conversation <id>` (listed in the PR body) to resume an exact
   conversation. This only works once the id is known.
2. **Capture after launch.** Read `cache/last_conversations.json[cwd]`, which
   maps a folder to its newest conversation. Or take the newest
   `conversation_summaries` row whose `workspace_uris` contains `file://<cwd>`.
   Both are cwd-based, so they share the two-panes-one-folder ambiguity, the
   same as codex `resume --last`. Pin at once, and refuse when another
   `antigravity` pane in the folder was launched in the same window.
3. **A hook.** The PR notes that `agy` has plugin `hooks.json` with
   `PreToolUse`/`PostToolUse`/`Stop`. Whether a hook payload carries the
   conversation id is unknown.

## State

On the branch, `agy` gets only the CLI-independent pipeline. See
[README.md#state-pipeline](README.md#state-pipeline).

| Signal | Status on `feat/antigravity-cli@8c287ea` | Where |
| --- | --- | --- |
| Screen diff → `working`/`waiting` | Active (generic) | `server/src/runner.js:214` (`deriveState`), unchanged on the branch |
| Pane alive → `stopped` | Active (generic) | same |
| Input-required marker | **None.** `MARKER_SOURCES` has no `antigravity` entry | `server/src/input-required.js:7-11` |
| Input-required OSC 9 | **None.** `observeOutput` returns early for anything except `codex`/`gemini` | `server/src/input-required.js:101` |
| `digest.running` / trace `activity` | **None** | — |
| Elapsed-counter masking | None. `resizeMode: 'repaint'`, no `confirmSubmit`/`elapsed` regex | `feat/antigravity-cli@8c287ea:server/src/config.js:254` |

Candidate trace signals (observed columns, semantics **unverified**):

- `conversation_summaries.status`: only `CASCADE_RUN_STATUS_IDLE` was seen.
  Other values (running) are presumed to exist.
- `not_fully_idle` and `killed`.
- The last `steps.status` (DONE=3, ERROR=7; a running code was not captured).
- `presence/<uuid>.lock` existence.

Known and expected failure modes:

1. **Dialogs look like `waiting` with no reason.** These include the
   permission prompts (`ask_permission`, `ask_question` appear in the tool
   list) and the three first-run dialogs (color scheme, terms/data use, folder
   trust; PR body). No signal tells AM they are dialogs.
2. **Whether agy's busy UI redraws on its own is unknown.** If `agy` draws no
   ticking timer or spinner while a tool runs or the model thinks, a busy pane
   drops to `waiting` after 4 s. Not checked: the branch has no `busy`/
   `elapsed` pattern for it, and its TUI was not inspected here.
3. **Repaint on resize** (`resizeMode: 'repaint'`) gives about 4 s of false
   `working`.
4. **`-c` in a shared folder.** Guarded at `runner.js:1960`. But a pane that
   was alone at restart can still adopt a conversation that a since-deleted
   sibling started in the same folder.
5. **WAL-only commits.** A reader that copies the `.db` without its `-wal` will
   miss recent steps. The branch's checkpoint handles this for durability
   (`.backup`); a reader must open the database in place.

## Gaps

1. **No reader or digest.** Parse
   `brain/<uuid>/.system_generated/logs/transcript.jsonl` (plain JSON, already
   carries type, status, content, tool calls and tokens). Fall back to
   `conversations/<uuid>.db` `steps` only if the JSONL turns out to lag.
   Before relying on it, confirm that the JSONL is written per step and not at
   turn end.
2. **No pinning.** Capture the conversation id right after launch (from
   `last_conversations.json` or `conversation_summaries`, refusing when
   ambiguous). Resume with `--conversation <id>` instead of `-c`.
3. **No input-required.** Find out whether `agy` emits OSC 9/777 or BEL on an
   approval. If it does, extend `observeOutput`. Otherwise add a `PreToolUse`
   or permission hook through its plugin `hooks.json`, modelled on
   `am-input-required-hook.sh`.
4. **No trace-based running/idle.** Once pinned, read
   `conversation_summaries.status`/`not_fully_idle` (after capturing a running
   value) or the last step's `status` as `activity`. Use the `Stop` hook as the
   turn-end stamp.
5. **Decode the remaining step types and statuses.** Capture a conversation
   mid-turn, with a pending approval and with a subagent, to learn the running
   status code and the `has_subtrajectory`/`parent_conversation_id` shapes.
6. **Usage.** `input_tokens`/`output_tokens`/`cache_read_tokens` per
   `PLANNER_RESPONSE` are enough for the Usage page.
