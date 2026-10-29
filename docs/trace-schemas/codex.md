# Codex

Version checked: `codex --version` → `codex-cli 0.165.0`. The rollouts on this
Space were written by 0.142.3 through 0.164.0 (`session_meta.payload.cli_version`
is the version that *created* the file; a resumed file keeps growing under
whatever version resumes it). No rollout created by 0.165 existed yet, so the
0.165 on-disk shape is assumed equal to 0.164.

Codex has two execution modes in AM:

- **Standalone** (the default): AM runs `codex` in a PTY, reads its rollout
  file and diffs its screen. Most of this page.
- **Shared / bound** (pilot, `AM_CODEX_BINDINGS_PILOT=1`): the thread lives on a
  Codex app-server, and AM reads state from that server. Summarized in
  [Shared sessions](#shared-sessions); details in
  [codex-shared-bindings.md](../codex-shared-bindings.md),
  [codex-shared-preview.md](../codex-shared-preview.md) and
  [codex-agent-reconnect.md](../codex-agent-reconnect.md).

The CLI-independent pipeline (screen diff, `digest.running`, reader
`activity`, input-required) is in [README.md#state-pipeline](README.md#state-pipeline).
This page covers only what is specific to Codex.

## Where the trace lives

| | |
| --- | --- |
| Path | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local-ts>-<thread-uuid>.jsonl` |
| `CODEX_HOME` on the Space | `$AM_LOCAL/codex-home` (`entrypoint.sh:57`); default `~/.codex` |
| Durable copy | `$DATA_DIR/state/codex` (`entrypoint.sh:56`), checkpointed by `scripts/agent-state.sh` (`checkpoint_tree codex`, `:1043`; filters `:213`). See [agent-state-checkpoints.md](../agent-state-checkpoints.md). |
| Format | JSONL, one record per line, every record `{timestamp, ordinal?, type, payload}` |
| Granularity | One file per thread. Sub-agents get their own rollout in the same tree. |
| Write timing | Appended live, one line per event. Checked: the mtime of the two files written in the last two hours equals the `timestamp` of their last record to within 20 ms. |
| Creation | **Lazy.** The file appears when the first turn starts, not at launch. `session_meta.payload.timestamp` is the thread's creation time (launch); the `session_meta` line's own `timestamp` equals the first `task_started`. One file here shows a 52 s gap between the two. |
| Resume | `codex resume <id>` appends to the **same** file. Checked: a file created on 10-27 under 0.164 received turns on 10-28 and 10-29 across restarts, with one `session_meta`. |
| Compaction | In place. A `compacted` record is written into the same file; no new rollout. |
| New file | Thread reset (`/new`, `/clear`), `/fork`, picking another thread in `/resume`, a sub-agent, `codex exec`. |

`$CODEX_HOME/sessions` used to be a symlink onto the bucket. It is now a plain
local directory; `entrypoint.sh:84` removes an old symlink. The comment at
`server/src/runner.js:765` still describes the symlink.

Codex also keeps SQLite state (`state_*.sqlite`, `logs_*.sqlite`) in
`CODEX_HOME`. AM never reads it, and the checkpoint excludes it
(`scripts/agent-state.sh:213`).

## Schema

### Records

Anonymized, structure only. Long fields elided.

`session_meta` (always line 1; 18–44 KB because of `base_instructions`):

```json
{"timestamp":"2026-01-01T10:00:01.400Z","type":"session_meta","payload":{
  "id":"00000000-0000-7000-8000-000000000001","session_id":"00000000-0000-7000-8000-000000000001",
  "timestamp":"2026-01-01T10:00:00.100Z","cwd":"/data/workspaces/<folder>",
  "originator":"codex-tui","cli_version":"0.164.0","source":"cli","thread_source":"user",
  "model_provider":"openai","history_mode":"paginated","base_instructions":{"text":"<…>"},
  "runtime_workspace_roots":["<path>"],"context_window":{"window_id":"<uuid>"}}}
```

A sub-agent's header instead has `"thread_source":"subagent"` and
`"source":{"subagent":{"thread_spawn":{"parent_thread_id":"<parent uuid>","depth":1,"agent_path":"/root/<task>","agent_nickname":"<Name>","agent_role":null}}}`.
`codex exec` writes `"source":"exec"`.

`turn_context` (one per turn):

```json
{"type":"turn_context","payload":{"turn_id":"<uuid>","root_turn_id":"<uuid>","cwd":"<path>",
  "model":"<model>","effort":"high","approval_policy":"<…>","sandbox_policy":{"type":"<…>"},
  "collaboration_mode":{"mode":"default","settings":{}},"summary":"<…>"}}
```

`response_item` (what went to and came from the model):

```json
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<prompt>"}]}}
{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<harness text>"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"<progress note>"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"<answer>"}]}}
{"type":"response_item","payload":{"type":"reasoning","summary":[],"content":null,"encrypted_content":"<opaque>"}}
{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"<id>","input":"<JS script>"}}
{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"<id>","output":[{"type":"input_text","text":"Script …"}]}}
{"type":"response_item","payload":{"type":"function_call","name":"wait","call_id":"<id>","arguments":"{…}"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"<id>","output":"<text>"}}
{"type":"response_item","payload":{"type":"agent_message","author":"/root/<task>","recipient":"/root","content":[{"text":"Message Type: FINAL_ANSWER\n…"}]}}
{"type":"response_item","payload":{"type":"additional_tools","role":"developer","tools":[…]}}
```

`event_msg` (what the TUI saw):

```json
{"type":"event_msg","payload":{"type":"task_started","turn_id":"<uuid>","root_turn_id":"<uuid>","started_at":1700000000,"model_context_window":272000,"collaboration_mode_kind":"default","turn_attribution":{…}}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"<uuid>","last_agent_message":"<answer>","started_at":…,"completed_at":…,"duration_ms":…,"time_to_first_token_ms":…}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"<uuid>","error":{"message":"<…>","codex_error_info":…},…}}
{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"<uuid>","reason":"interrupted","duration_ms":…}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":…,"cached_input_tokens":…,"output_tokens":…,"total_tokens":…},"last_token_usage":{…},"model_context_window":…},"rate_limits":{…}}}
{"type":"event_msg","payload":{"type":"item_completed","thread_id":"<uuid>","turn_id":"<uuid>","item":{"type":"CommandExecution","command":["…"],"cwd":"<path>","status":"completed","exit_code":0,"duration":{"secs":1,"nanos":0},"aggregated_output":"<…>"},"started_at_ms":…,"completed_at_ms":…}}
{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"<…>","approval_policy":"<…>","cwd":"<path>",…}}}
{"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}
```

`item_completed.item.type` values seen: `AgentMessage` (with `phase`),
`UserMessage` (with `client_id`), `Reasoning`, `CommandExecution`,
`FileChange`, `ImageView`, `ContextCompaction`, `Extension`, `McpToolCall`,
`CollabAgentToolCall`, `SubAgentActivity`.

Other top-level types: `compacted` (`payload.message`,
`payload.replacement_history[]`), `world_state` (environment snapshot),
`token_usage_record` (per-response usage), `inter_agent_communication_metadata`
(sub-agents).

### The 0.147 format change

Codex 0.147 stopped persisting most TUI `event_msg` types. Checked over all 91
rollouts on this Space:

| `event_msg` type | ≤ 0.146 | ≥ 0.147 |
| --- | --- | --- |
| `agent_message`, `user_message` | yes | **no** |
| `web_search_end` | yes | **no** |
| `exec_command_end`, `agent_reasoning` | not seen | not seen |
| `item_completed` | no | yes |
| `task_started`, `task_complete`, `token_count`, `turn_aborted` | yes | yes |

AM's comments still describe the old stream (`server/src/traces.js:1938-1962`).
The parser branches for `agent_message`, `agent_reasoning` and
`web_search_end` are dead on current rollouts. Nothing is lost for prompts or
answers, because the `response_item` stream carries both. Web searches are:
current Codex writes no `web_search_call` response item either, so a search
made today is invisible to AM. (None appear in the rollouts here, so the
replacement record is not confirmed.)

### Fields AM reads

| Record | Fields read | Used for | Where |
| --- | --- | --- | --- |
| `session_meta` | `payload.cwd` | cwd attribution fallback | `server/src/traces.js:283`, `server/src/share.js:280`, `server/src/runner.js:870` |
| `session_meta` | `thread_source`, `source.subagent` | skip sub-agent/guardian rollouts | `server/src/traces.js:289`, `:2004`, `:2967`; `server/src/runner.js:879`, `:931` |
| `session_meta` | `source.subagent.thread_spawn.{parent_thread_id,depth,agent_path,agent_nickname}`, `id` | sub-agent roster | `server/src/traces.js:3063` |
| `session_meta` | `payload.timestamp` | "created after launch" capture guard | `server/src/runner.js:874` |
| `turn_context` | `model`, `turn_id`, `cwd` | reader header | `server/src/traces.js:2014` |
| `response_item/message` role `user` | `content[].text` | prompt (digest, reader) | `server/src/traces.js:299`, `:2032` |
| `response_item/message` role `developer` | `content[].text` | reader `system` row | `server/src/traces.js:2034` |
| `response_item/message` role `assistant` | `content[].text` | answer (digest, reader) | `server/src/traces.js:294`, `:2025` |
| `response_item/reasoning` | `summary[].text`, `text` | `thinking` blocks; encrypted ones counted | `server/src/traces.js:2037` |
| `response_item/custom_tool_call` `exec` | `input`, `call_id` | code-mode script unpacked into tool calls | `server/src/traces.js:315`, `:2080` |
| `response_item/{function_call,custom_tool_call,local_shell_call,web_search_call}` | `name`, `arguments`/`input`, `call_id` | tool use, counts, `apply_patch` file | `server/src/traces.js:309-337`, `:2096` |
| `response_item/{function_call_output,custom_tool_call_output}` | `call_id`, `output` | tool result | `server/src/traces.js:2101`, `:2151` |
| `response_item/agent_message` | `content[].text`, `author` | sub-agent post / fork boundary | `server/src/traces.js:2051` |
| `event_msg/task_started` | `turn_id` | `digest.running = true`; reader `activity = 'working'` | `server/src/traces.js:348`, `:2159`, `:2238` |
| `event_msg/task_complete` | `last_agent_message`, `turn_id` | `digest.running = false`; marks the final answer; `activity = 'waiting'` | `server/src/traces.js:354`, `:2197`, `:2239` |
| `event_msg/turn_aborted` | type only | reader `activity = 'waiting'`. **Not** read by the digest. | `server/src/traces.js:2233`, `:2239` |
| `event_msg/thread_rolled_back` | type only | closes the open reader turn | `server/src/traces.js:2233` |
| `event_msg/token_count` | `info.total_token_usage`, `info.last_token_usage` | tokens (session total, per turn, `sinceTokens`) | `server/src/traces.js:345`, `:2163` |
| `event_msg/agent_message` (≤ 0.146) | `message` | digest answer | `server/src/traces.js:351` |
| `event_msg/agent_reasoning`, `web_search_end` (≤ 0.146) | text, `query`, `results` | thinking, web search | `server/src/traces.js:2182`, `:2189` |

Present but ignored, and useful:

- `response_item/message.phase` (`commentary` / `final_answer`): the model's
  own label for the final answer. The shared live view already uses the
  app-server equivalent (`server/src/codex-view.js:29`); the rollout path
  infers it from `task_complete` instead.
- `task_complete.error`: a failed turn. Shown as an ordinary completion.
- `turn_aborted.reason` (`interrupted`, …).
- `task_started.started_at`, `task_complete.duration_ms`.
- `item_completed` `CommandExecution` (`exit_code`, `duration`, `status`),
  `FileChange`, `ContextCompaction`, `UserMessage.client_id`.
- `compacted`: no compaction marker reaches the reader or the digest.
- `response_item/message` content of type `input_image`: AM reads only `.text`,
  so an image in a prompt is dropped (none in current rollouts).

## How AM maps it

Codex writes the same content in two streams. `response_item` is the model
transcript. `event_msg` is the TUI's view. AM takes prompts, answers and tools
from `response_item`, and lifecycle and tokens from `event_msg`.

### Digest (`parseCodex`, `server/src/traces.js:273`)

Runs over the whole file (last 12 MB for bigger files, `server/src/traces.js:975`;
an append-cursor scan in `server/src/trace-activity.js` then recomputes
`lastPromptTs`/`lastAnswerTs` over the full file, `server/src/traces.js:1040`).
Runs on a worker (`server/src/trace-parse-worker.js`).

| Input | Digest effect |
| --- | --- |
| user `message` not starting with `<` or `# AGENTS.md instructions` | `digestPrompt` (`server/src/traces.js:87`): new `lastPrompt*`, clears answer, `turnsLog`, `since*` |
| assistant `message` | `sinceTurns++`; `digestAssistant` (`:109`) |
| tool calls | `digestTool` (`:156`); code-mode `exec` counts each tool inside the script |
| `task_started` | `running = true` |
| `task_complete` | `running = false`; `digestAssistant(last_agent_message)` |
| `event_msg/agent_message` (≤ 0.146) | `digestAssistant` |
| `token_count` | last cumulative total kept; `sinceTokens` = total − total at last prompt |
| `turn_aborted`, `compacted`, `item_completed` | nothing |

`digestAssistant` is called without a message key. The same text arriving as
the assistant `message` and again as `task_complete.last_agent_message` is
deduplicated by text (`server/src/traces.js:111`), so one answer is one
`outSeq`.

`agent-list.js` `conversationActivity` turns `lastPromptTs`/`lastAnswerTs` into
`lastPromptAt`/`lastAnswerAt`/`activityKind`; see
[agent-activity.md](../agent-activity.md).

### Reader (`normalizeCodex`, `server/src/traces.js:1963`)

| Rollout | Reader |
| --- | --- |
| user `message` | `user` row, or `system` if `isHarnessText` (`:1735`) or role `developer` |
| assistant `message` | `text` block in the open assistant turn; a second text opens a new turn |
| `reasoning` with summary | one `thinking` block per summary entry, deduped |
| `reasoning` encrypted | counted into `out.note` ("N reasoning steps were encrypted…") |
| `custom_tool_call` `exec` | unpacked into the tool calls the script made (`codex-code-mode.js`), else a `script` block |
| other tool calls / outputs | `tool_use` / `tool_result`, stitched by `call_id` |
| `response_item/agent_message` | `system` row ("Sender: /root/<task>"); used by the sub-agent strip |
| `task_started` | closes the turn; reader mode adds a `task-start` event |
| `task_complete` | marks the matching assistant turn `kind: 'final'`; if the text is not found, emits it as a new final turn, unless the window cut the task (`danglingTaskComplete`) |
| `turn_aborted`, `thread_rolled_back` | close the turn; rolled-back turns stay visible |
| `token_count` | `out.usage` (cumulative) and per-turn `usage` |
| `compacted`, `item_completed`, `world_state`, `token_usage_record` | ignored |

Reader `activity` (`server/src/traces.js:2238`): `task_started` sets
`'working'`, `task_complete` and `turn_aborted` set `'waiting'`. It is the
state of the **last lifecycle event inside the window that was read**, exposed
by `headOf` (`:2633`). A window with no lifecycle event has `activity: null`.

Windowing: a byte window starting mid-file is moved forward to the first
`task_started` line it holds (`codexTaskStart`, `server/src/traces.js:2760`,
used at `:2787`). If it holds none, `task_complete` inside it is treated as a
marker only. A window whose last task is still open does not mark a final
answer (`:2823`). Before serving any window, the first line is checked so a
sub-agent rollout is refused as a session view (`refuseCodexSubagent`,
`:2955`).

### Sub-agents

A sub-agent is spawned with the parent's history forked in. Its rollout is a
normal rollout with a sub-agent header.

- Roster: `codexSubagentRoster` (`server/src/traces.js:3093`) reads the first
  line of **every** rollout (memoized by mtime+size, `:3063`) and keeps those
  whose `parent_thread_id` is this pane's `codexSessionId`. The join to the
  parent's records is `agent_path` (`/root/<task>`), which the parent's
  `spawn_agent` call and the child's `FINAL_ANSWER` post also carry.
- Child view: `readSubagentTrace` (`:3194`) with `allowSubagent`; the forked
  prelude is cut at the `NEW_TASK` `agent_message` (`:2051`).
- Digest and attribution skip sub-agent rollouts (`:1334`, `:1495`).
- Guardian (safety-judge) threads are matched by the same
  `thread_source`/`source.subagent` test. None are on disk here, so that shape
  is not re-verified on 0.165.

### Sharing

`scripts/share-session.mjs` ships a Codex rollout as-is (`NATIVE`, line 35)
and computes its own token totals (`codexLine`, line 262).

## Which trace belongs to which pane

Session fields: `codexSessionId` (thread uuid) and `codexRollout` (absolute
path). Shared sessions use a binding instead (below).

### Capture

Two mechanisms, both armed at launch for unshared panes
(`server/src/runner.js:2199-2200`):

1. **Exact: managed SessionStart hook.** `codex-requirements.toml` is installed
   as `/etc/codex/requirements.toml` (`Dockerfile:59`). It enables hooks and
   runs `/etc/codex/hooks/am-codex-repin-hook.sh` on `startup|resume|clear`.
   The hook walks `/proc` to prove it is the pane's own Codex (pane root, its
   child, or the npm `node` launcher's child), then writes
   `$AM_REPIN_DIR/<AM_ID>.codex.json` with the hook's stdin
   (`session_id`, `transcript_path`, `cwd`, `source`). The server polls it
   every 250 ms (`scheduleBreadcrumbCapture`, `server/src/runner.js:1581`),
   re-checks the PID tree (`codexProcessPidTrusted`, `:1301`) and the path
   (`codexRolloutForBreadcrumb`, `:1346`: inside `$CODEX_HOME/sessions` and
   ending in `-<session_id>.jsonl`), then writes both fields
   (`applyBreadcrumb`, `:1481`). A `null` `transcript_path` is resolved by
   filename (`codexRolloutForId`, `:1371`) with up to 20 retries 500 ms apart.
2. **Fallback: rollout scan.** `scheduleCodexCapture` (`:940`) runs 5 s after
   launch and then every 20 s for the life of the pane. `tryCaptureCodexId`
   (`:860`) takes the newest-by-mtime rollout that: was modified since launch,
   has `cwd` under the pane folder, was created no earlier than 15 s before
   launch, is not a sub-agent, and is not pinned by another session. It
   re-pins when the answer changes. It does nothing while another live Codex
   pane shares the folder (`folderIsShared`, `:1180`). The first tick also
   clears a pin whose rollout is gone or is a sub-agent (`pinIsStale`, `:924`).

Because rollouts are lazy, both the pin and the trace may be absent until the
first prompt. `transcript_path` may name a file that does not exist yet; the
hook path accepts that, and readers check existence.

### Lookup

| Consumer | Order | Where |
| --- | --- | --- |
| Reader, sharing, dispatch (`findTrace` → `findRollout`) | shared binding → `codexRollout` if it exists → newest non-sub-agent rollout whose `cwd` **equals** the folder, only if no other Codex session uses the folder | `server/src/share.js:250` |
| Targeted digest (`digestFor`), `/api/meta/:id`, `/api/agents` | `codexRollout` only | `server/src/traces.js:1493`; `server/src/index.js:1111` |
| Bulk digest (`buildImpl`), Overview `/api/meta` | every rollout: by filename uuid = `codexSessionId`, else `cwd` equal to the folder when exactly one Codex session uses it (pinned or not). Digest = file with the newest `lastTs`. | `server/src/traces.js:1329-1345` |
| `traceLocation` | `codexRollout` if it exists | `server/src/traces.js:1521` |
| Sub-agent roster | `codexSessionId`, else uuid from `codexRollout` | `server/src/traces.js:3094` |

### Relaunch

`commandFor` (`server/src/runner.js:1892`): pinned and file exists →
`codex resume <id>`; pinned but file missing → fresh `codex`. Unpinned: in a
folder shared with another Codex session → fresh `codex` (`:1959`); otherwise
`codex resume --last || codex`. `resume --last` picks the newest thread for
the cwd, which is not necessarily this pane's.

### Two panes in one folder

- Exact hook pins work. The scan does not run.
- `findRollout` returns `null` for an unpinned pane (ambiguous).
- Bulk digest: cwd fallback is marked ambiguous, so only pinned files attach.
- An unpinned pane in a shared folder relaunches fresh.

## Shared sessions

When a session has a binding (`codex-bindings.js`) or `codexSharedOnly`, the
thread is owned by a Codex app-server, not by AM's PTY.

- Trace: `sharedCodexRollout` (`server/src/codex-reader.js:13`) asks the
  server for `thread.path` via `thread/read`, and verifies the header id, cwd
  and location before handing it to the normal reader. It runs before the
  pinned/cwd paths in `findRollout` and never falls back to them.
- State: `SessionRuntime.presentation` (`server/src/session-runtime.js:27`)
  maps the server's thread status (`taskStatus`,
  `server/src/codex-shared.js:129`): `active` → `working`, or `needs-input`
  when `activeFlags` has `waitingOnApproval`/`waitingOnUserInput`; `idle` →
  `waiting`; `notLoaded` → `stopped`; anything else → `stopped`. It also sets
  `running` and `inputRequired`. Spread last in `sessionsWithState`
  (`server/src/index.js:3134`), it **overrides** the screen-diff state.
  Refreshed in the background at most every 3 s.
- `/api/agents/:id/wait` and `/tail` use `coordinationState`
  (`server/src/session-runtime.js:22`), which awaits a fresh status and maps
  unknown to `unknown` rather than `stopped`.
- Reader: `SessionRuntime.trace` (`:42`) replaces `activity` with the server
  status and adds live turns from app-server notifications
  (`server/src/codex-view.js`, `server/src/codex-interactive.js`) and pending
  approvals as typed requests.
- Recovery of an unloaded thread: `server/src/codex-recovery.js`; see
  [codex-agent-reconnect.md](../codex-agent-reconnect.md).

## State

### Signals

| Signal | Source | Computed | Consumers |
| --- | --- | --- | --- |
| Screen diff | djb2 of `vt.getVisibleText()`, sampled on PTY output, ≥ 250 ms apart; `working` if changed in the last 4 s | `sampleScreen` `server/src/runner.js:175`, `deriveState` `:214` | sidebar, roster, `/wait`, Overview `atWork` |
| `digest.running` | last of `task_started` / `task_complete` in the file | `server/src/traces.js:348-356` | Overview `atWork` (`web/src/components/Overview.tsx:66`) |
| Reader `activity` | last of `task_started` / `task_complete` / `turn_aborted` in the window | `server/src/traces.js:2238` | ConversationView "running" line (`web/src/components/conversation/ConversationView.tsx:176`) |
| OSC 9 input-required | `\e]9;Approval requested: …`, `Codex wants to edit …`, `Approval requested by …` → permission; `Plan mode prompt: …` → question | `observeOutput` `server/src/input-required.js:100`, enabled per launch by `CODEX_INPUT_SIGNALS` `server/src/config.js:192` | `inputRequired` on rows, reader banner |
| Input-required clear | any operator key, paste or AM prompt (`observeInput`, `server/src/input-required.js:132`; called at `server/src/runner.js:2245`, `:2653`, `:2819`); 30 min expiry | | |
| Native status (shared only) | app-server `thread.status` | `server/src/session-runtime.js:27`, `server/src/codex-shared.js:129` | overrides all of the above for state, `running`, `inputRequired` |
| Submit confirmation | `esc to interrupt` busy marker, `Waiting for startup` notice, elapsed-time mask | `CODEX_CONFIRM` `server/src/config.js:210`; `submitConfirmed` `server/src/runner.js:2740`, `stillText` `:2806` | prompt delivery only; not state |

### The elapsed counter

While a turn runs, Codex's status row reads `Working (1m 05s • esc to
interrupt)` and redraws every second. `deriveState` hashes the raw visible
text (`server/src/runner.js:181`). The spinner glyph and elapsed-time mask in
`stillText` (`:2806`) are applied **only** in `submitConfirmed`, never in
`sampleScreen`. So yes: the counter changes the hash every second, and
`deriveState` reports `working` for as long as that row is on screen, including
during a long command whose own output is silent and during `wait` calls on a
background terminal. For Codex the screen diff is therefore a fairly direct
proxy for "a turn is open". It fails when the row is not on the visible grid,
or when something else animates (see failure modes).

### Precedence

1. Shared session: native status wins for `state`, `running` and
   `inputRequired` (`server/src/index.js:1081-1084`, `:3134`).
2. Otherwise `state` is screen diff only. Trace signals never change it.
3. `inputRequired` is a separate field. Rows keep `state` as computed;
   `delegationState` (`server/src/index.js:475`) reports `input-required`
   instead.
4. Overview "at work" = `state === 'working'` OR (not stopped AND
   `digest.running`). The trace can turn it on; it cannot turn it off.
5. Reader "running" needs `session.running` AND `activity === 'working'` AND no
   input-required. Here the trace can turn it off.

### Failure modes

| Scenario | What AM shows | Why |
| --- | --- | --- |
| Crash, kill or Space restart mid-turn | Overview card says running whenever the pane is up again and idle; reader says working | No `task_complete` is written. `digest.running` stays `true` until the next turn completes. The roster recovers (screen goes static). One rollout here ends on an open `task_started`. |
| Turn interrupted (Esc) | Overview "at work" stays on while the pane lives | `parseCodex` ignores `turn_aborted` (`server/src/traces.js:343-359`), so `running` stays `true`. The reader handles it. 3 of 91 rollouts here end on `turn_aborted`; 17 aborts in total, all `reason: "interrupted"`. |
| Turn fails (`task_complete` with `error`) | Ended normally; no error shown; answer is the previous text | `error` is not read. |
| Long `exec` / `wait` with no output | `working` (correct) | The elapsed counter keeps the screen changing. |
| Background terminal left running after the turn | `waiting` (correct for the turn) | Turn ends with `task_complete`; the footer note is static. No signal says a process is still running. |
| Transcript overlay (Ctrl+T), pager or a full-screen view over the status row | `waiting` while the turn runs | The counter is not on the visible grid. `digest.running` keeps the Overview card right; the sidebar is wrong. |
| Approval or plan-mode prompt | `waiting` + input-required | OSC 9. Whether the elapsed counter keeps drawing under the approval view was not verified; if it does, the row also says `working`. |
| Approval resolved without a keystroke in the pane (auto-review, guardian, or another client) | input-required badge stays up to 30 min or until next key | Codex sends no close event (`server/src/input-required.js:132`). |
| Approval kinds that do not call Codex's notifier (`RequestPermissionsEvent`, queued approvals) | `waiting`, no badge | See [tui-input-required.md](../tui-input-required.md). |
| Something on screen animates while idle | `working` forever | Hash covers the whole grid. Codex 0.165 has a configurable status line, terminal title items and a "terminal pet" (`/pet`); if any of these redraws on a timer, an idle pane reads as working. Not verified. The title is not in the visible text, so title-only updates are safe. |
| Resize / repaint | `working` for ~4 s | Any text change counts (`server/src/runner.js:519`, `:693`). |
| Compaction | No marker anywhere; turn continues | `compacted` and `ContextCompaction` are ignored. Same file, so the pin holds. |
| Resume of a pinned thread | Same file, digest continuous | Verified: resume appends. |
| `/new`, `/clear`, `/resume <other>` | New pin within ~250 ms (hook) or ≤ 20 s (scan) | Hook covers `startup|resume|clear`. `/fork` is not in the matcher (its `source` is not verified); the scan covers it in an unshared folder only. |
| First prompt not yet sent | No trace, no digest, `findRollout` may fall back to an older rollout in the folder | Lazy file. With no pin, `findRollout` takes the newest rollout with that cwd, which is the previous conversation. |
| The agent runs `codex exec` (or a nested `codex`) in its own folder | Pin can flip to the nested rollout, then back | The scan takes the newest-by-mtime rollout under the folder and does not check `source`/`originator` (`server/src/runner.js:864-899`). The hook rejects nested Codex by PID; the scan does not. Next relaunch resumes whichever was pinned last. 15 `source: "exec"` rollouts exist here. |
| Same, in the bulk digest | Overview card shows the nested run's prompt, answer and `running` | Bulk cwd fallback applies to pinned sessions too (`server/src/traces.js:1324-1342`), and the freshest file wins the digest. `/api/agents` uses `digestFor` (pin only), so the two can disagree. |
| Rollout > 12 MB | Digest built from the last 12 MB; `running` correct; old prompt text may be missing | `readTraceFile` (`server/src/traces.js:976`). Timestamps are recomputed in full. |
| Heavy rollout being written | Digest up to 60 s stale | Duty cycle in `statsFor` (`server/src/traces.js:1016`). |
| Task larger than the reader window with no `task_started` inside | Reader `activity: null`, so no "running" line | `activity` comes from the window only. |
| Shared session, app-server unreachable | `stopped` in the sidebar; `unknown` in `/wait` | `presentation` maps unknown to stopped (`server/src/session-runtime.js:38`). |
| A real prompt starting with `<` | Missing from the digest; shown in the reader | `parseCodex` drops every user text starting with `<` (`:303`); the reader uses the narrower `isHarnessText`. |

## Gaps

Ranked by how often they mislead the operator.

1. **`turn_aborted` does not clear `digest.running`.** Every Esc leaves the
   Overview card "running" until the next completed turn. Fix: treat
   `turn_aborted` like `task_complete` in `parseCodex` (`server/src/traces.js:354`).
2. **A crash mid-turn leaves `digest.running` true.** Fix: in the Overview,
   ignore `digest.running` when the pane's `startedAt` is newer than the open
   `task_started` (the process that opened the task is gone), or have the
   digest expose the open task's timestamp so the caller can compare.
3. **Bulk digest borrows rollouts by cwd for pinned panes.** A nested
   `codex exec` or an old non-AM run in the same folder can take over the
   Overview card. Fix: like fx, use the cwd fallback only for unpinned
   sessions (`server/src/traces.js:1325`), and make `buildImpl` and `digestFor`
   pick the same file.
4. **The rollout scan can re-pin to a nested Codex.** Fix: skip
   `source: "exec"` and non-`codex-tui` originators in `tryCaptureCodexId`, and
   once the hook has proven itself (`host.exactRepinProven`) run the scan only
   as a slow backstop, as Claude does (`claudeScanDue`, `server/src/runner.js:1629`).
5. **The parser follows the pre-0.147 event stream.** `agent_message`,
   `agent_reasoning` and `web_search_end` are dead branches; web searches are
   no longer counted or shown; `item_completed` is ignored. Fix: read
   `item_completed` (`CommandExecution` exit code and duration, `FileChange`,
   `ContextCompaction`, web search if it appears there) and update the
   comments at `server/src/traces.js:1938`.
6. **Use `phase: "final_answer"`** to mark the final answer instead of matching
   `last_agent_message` text, as the shared live view does. Removes the
   text-equality fallback and the "emit a copy" path in `normalizeCodex`.
7. **Show compaction and failed turns.** Map `compacted` to a `compaction`
   block (the shared view already has one, `server/src/codex-view.js:8`) and
   `task_complete.error` / `turn_aborted.reason` to a visible event.
8. **Screen diff has no Codex-specific busy test.** For Codex,
   `CODEX_CONFIRM.busy` (`esc to interrupt`) already identifies the busy row.
   `deriveState` could report `working` when that row is present and `waiting`
   when it is absent, instead of "anything changed". This removes false
   `working` from idle animations and repaints, and false `waiting` only when
   an overlay hides the row (where `digest.running` still helps).
9. **Input-required has no close.** Fix: clear the Codex OSC 9 signal on the
   next `task_complete`/`turn_aborted` or `item_completed` in the pinned rollout,
   not only on a keystroke.
10. **`findRollout` falls back to an older rollout before the first prompt.**
    Fix: if the pane has a pin whose file does not exist yet, return `null`
    rather than the cwd fallback.
11. **Shared `presentation` maps unknown to `stopped`.** A transient daemon
    error turns a working task grey. Fix: keep the last known state for a short
    grace period, or return `unknown` as `coordinationState` does.
12. **Stale comment.** `server/src/runner.js:765` describes
    `CODEX_HOME/sessions` as a symlink onto the bucket; it is local since the
    entrypoint change.
