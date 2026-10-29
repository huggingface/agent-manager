# Gemini CLI trace schema

Checked against `gemini --version` **0.66.0** (`@google/gemini-cli`, installed
from npm by `Dockerfile:64`).

**Summary.** AM has **no trace reader and no digest for Gemini CLI.** Nothing in
`server/`, `scripts/` or `web/` opens a Gemini chat file. `findTrace` has no
`gemini` case, so it returns `null` (`server/src/share.js:426`). The trace
normalizer switch throws `unsupported-harness` (`server/src/traces.js:2621`).
`buildImpl`, `digestFor` and `traceLocation` skip the CLI
(`server/src/traces.js:1291`, `:1479`, `:1513`). State comes from the screen
diff and from input-required signals only.

This page documents the file Gemini *does* write, so a parser can be added
later. No real Gemini conversation exists on this machine: every
`tmp/<project>/` folder under `$GEMINI_LIVE` and the legacy `~/.gemini` has no
`chats/`, and `logs.json` is `[]`. So the schema below comes from the 0.66.0
bundle source, `bundle/chunk-RZ3ZVTZB.js` (`ChatRecordingService` at line
287040), and not from captured files. Bundle line numbers are cited as
`gemini@0.66.0 chunk-RZ3ZVTZB.js:<line>`. The chunk file name is a build hash
and changes between releases.

## Where the trace lives

| What | Path |
| --- | --- |
| Gemini home (`GEMINI_CLI_HOME`) | `$AM_LOCAL/agent-state/gemini-home` (`entrypoint.sh:61`, default in `scripts/agent-state.sh:35`) |
| Live state dir (`GEMINI_LIVE`) | `$GEMINI_CLI_HOME/.gemini` (`entrypoint.sh:62`, `scripts/agent-state.sh:36`) |
| Durable copy | `$DATA_DIR/state/gemini` (`entrypoint.sh:60`, `scripts/agent-state.sh:37`) |
| Project registry | `$GEMINI_LIVE/projects.json`: `{"projects": {"<abs cwd>": "<slug>"}}` |
| Per-project temp dir | `$GEMINI_LIVE/tmp/<slug>/`, with `.project_root` holding the cwd |
| Conversation (main) | `$GEMINI_LIVE/tmp/<slug>/chats/session-<YYYY-MM-DDTHH-MM>-<first 8 chars of sessionId>.jsonl` |
| Conversation (subagent) | `$GEMINI_LIVE/tmp/<slug>/chats/<parentSessionId>/<sessionId>.jsonl` |
| Prompt log | `$GEMINI_LIVE/tmp/<slug>/logs.json` (JSON array, user inputs only) |
| Shadow-git checkpoints (`/restore`, off by default) | `$GEMINI_LIVE/history/<slug>/` |
| System settings layer AM ships | `/etc/gemini-cli/system-defaults.json` (`Dockerfile:68`, from `gemini-system-defaults.json`) |

**Project folder.** 0.66.0 no longer names the folder after a hash. It names it
with a slug from `projects.json`. The slug is the cwd basename, lowercased, with
non-alphanumerics turned into `-`. Collisions get `-1`, `-2`, ...
(`gemini@0.66.0 chunk-RZ3ZVTZB.js:253050-253075`, `slugify` at `:253126`). On
first use, Gemini migrates an old `tmp/<sha256(cwd)>/` folder to the slug
(`performMigration`, `:253378`). The **sha256 of the project root is still
stored** in each chat file as `projectHash` (`getProjectHash`, `:252198`).

**Relocation on the Space.** `entrypoint.sh:96-101` copies any legacy
`$HOME/.gemini` into the durable dir once (`rsync --update`) and leaves the
original as a rollback copy. `restore_gemini` (`scripts/agent-state.sh:716`)
restores the tree to local disk. The periodic `checkpoint_tree gemini`
(`scripts/agent-state.sh:1045`, function at `:333`) rsyncs every file newer
than the last stamp back to the bucket. Gemini writes no SQLite, so a plain
file copy is enough. A partially appended last line can be copied, and the
next pass fixes it. See [../agent-state-checkpoints.md](../agent-state-checkpoints.md).

**Format and write timing (0.66.0).** One **append-only JSONL** file per
session. The writes are:

- `appendRecord` uses `appendFileSync`, one JSON object per line
  (`chunk-RZ3ZVTZB.js:287244`).
- A whole-file rewrite (temp file + rename) happens only when an old `.json`
  session is resumed (it becomes `.jsonl`), or when a resumed file cannot be
  read (`rewriteConversationFile`, `:287267`).
- An **updated message is appended again with the same `id`**. Readers keep
  the last copy per `id` (`pushMessage`, `:287321`, and the loader's
  `messagesMap`).

When each record is written:

| Event | When it is appended |
| --- | --- |
| Session header | When the session initializes, before the first prompt (`:287168`) |
| `user` message | At submit, before the model call (`:334006`) |
| `gemini` message | **At the end of each model stream**, not token by token. Text, thoughts and tokens arrive together (`:334774`) |
| Tool calls | **After the tools finish**. The previous `gemini` message is re-appended with `toolCalls` filled in (`recordCompletedToolCalls`, `:334800`). Nothing is written while a tool runs or while an approval dialog is open |
| `$set` | After every message (`lastUpdated`), and for `summary` or `directories` |
| `$rewindTo` | `/rewind` |
| `$patch` | Context-management edits: content changes, tool results, `removeIds`, `orderIds` (`updateMessagesFromHistory`, `:287605`) |

A startup-only session with no resumable content is **deleted on exit**
(`deleteCurrentSessionIfNotResumableAsync`, `:287544`). Older Gemini versions
(before JSONL) wrote one `session-*.json` and rewrote the whole file each
time. The loader still reads that format (`parseLegacyRecordFallback`).

## Schema

Every line is one of five shapes. The 0.66.0 loader tells them apart in this
order (`chunk-RZ3ZVTZB.js:286607-286621`, `processLine` at `:286747`).

| Line shape | Test | Meaning |
| --- | --- | --- |
| Rewind | has string `$rewindTo` | Drop that message id and everything after it |
| Patch | has object `$patch` | Patch messages by id, remove ids, or reorder |
| Message | has string `id`, no `$patch` | Upsert by `id` (last wins) |
| Metadata update | has object `$set` | Shallow-merge into the header. `$set.messages` replaces the whole list |
| Header | has string `sessionId` and `projectHash` | Session metadata. Written first, and again after a `.json` to `.jsonl` resume |

Anonymized examples (structure only):

```jsonl
{"sessionId":"00000000-0000-4000-8000-000000000001","projectHash":"<sha256 of cwd>","startTime":"2026-01-01T00:00:00.000Z","lastUpdated":"2026-01-01T00:00:00.000Z","kind":"main"}
{"id":"<uuid>","timestamp":"2026-01-01T00:00:01.000Z","type":"user","content":[{"text":"<prompt text>"}]}
{"$set":{"lastUpdated":"2026-01-01T00:00:01.000Z"}}
{"id":"<uuid2>","timestamp":"…","type":"gemini","content":"","thoughts":[{"subject":"<subject>","description":"<thought>","timestamp":"…"}],"tokens":{"input":0,"output":0,"cached":0,"thoughts":0,"tool":0,"total":0},"model":"<model id>"}
{"id":"<uuid2>","timestamp":"…","type":"gemini","content":"","thoughts":[…],"tokens":{…},"model":"<model id>","toolCalls":[{"id":"<call id>","name":"run_shell_command","args":{"command":"<cmd>"},"result":[{"functionResponse":{"id":"<call id>","name":"run_shell_command","response":{"output":"<output>"}}}],"status":"success","timestamp":"…","resultDisplay":"<display>","description":"<desc>","displayName":"Shell","renderOutputAsMarkdown":false}]}
{"id":"<uuid3>","timestamp":"…","type":"gemini","content":"<answer text>","thoughts":[],"tokens":{…},"model":"<model id>"}
{"id":"<uuid4>","timestamp":"…","type":"info","content":[{"text":"<binary injection note>"}]}
{"$rewindTo":"<uuid3>"}
{"$patch":{"id":"<uuid2>","toolCalls":[{"id":"<call id>","result":[…]}]}}
```

Message fields (0.66.0):

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | UUID. Repeated on update |
| `timestamp` | ISO string | Set when the message is created, not on update |
| `type` | `user`, `gemini`, `info` | Only these three are written by 0.66.0 code paths (`:334006-334052`, `:334774-334780`). `info` = binary content injected into the prompt. `error`/`warning` are display-only UI items and are not recorded |
| `content` | `Part[]` (user, info) or string (gemini) | A synthetic `gemini` message (no text, no tools, no thoughts) carries `Part[]` instead of a string (`:334780`) |
| `displayContent` | `Part[]` | User only, when it differs from what was sent (for example `@file` expansion) |
| `thoughts[]` | `{subject, description, timestamp}` | Gemini only. Parsed from `**subject**` in the thought text |
| `tokens` | `{input, output, cached, thoughts, tool, total}` | Gemini only. Can be `null` |
| `model` | string | Gemini only |
| `toolCalls[]` | see below | Gemini only. Present only after the tools complete |

Tool call fields (`recordCompletedToolCalls`, `:334800`, enriched at
`:287411`): `id`, `name`, `args`, `result` (the `functionResponse` parts, or
`null`), `status` (the scheduler's final status, e.g. `success`, `error`,
`cancelled`), `timestamp`, `agentId` (subagent tools), `resultDisplay`,
`description`, `displayName`, `renderOutputAsMarkdown`.

User messages starting with `/`, `?`, `<session_context>` or `<hook_context>`
are recorded but count as "not resumable" (`isIgnoredUserContent`,
`:286425`). A parser should treat them as commands, not prompts.

`logs.json` is a separate JSON array of
`{sessionId, messageId, type:"user", message, timestamp}` (`Logger.logMessage`,
`:387244`). It holds only what the user typed, and it is rewritten whole on
every entry.

**Fields AM reads: none.** There is no Gemini row in any reader table. Fields
that a parser would want: `type`/`content` (prompt and answer text),
`timestamp` (prompt/answer times), `toolCalls[].status` and `result`, `tokens`
(usage), `thoughts`, the header's `sessionId` (pinning) and `projectHash`
(cwd check), and `$set.summary` (title).

## How AM maps it

Nothing is mapped. Concretely:

| AM surface | What it shows for a Gemini pane | Why |
| --- | --- | --- |
| Reader / Trace panel | Empty state: "No transcript yet." (`web/src/components/TracePane.tsx:521`) | `readTrace` throws `no-trace` because `findTrace` returns `null` (`server/src/traces.js:3024-3026`, `server/src/share.js:426`). `web/src/lib/readerStore.ts:497-498` turns `no-trace` into `phase: 'empty'` |
| Agent list `lastPrompt` / `lastAnswer` | `null` | No digest (`server/src/index.js:1092-1093`) |
| `lastPromptAt` / `lastAnswerAt` / `activityKind` | `null` | `conversationActivity(undefined)` (`server/src/agent-list.js:45`) |
| `digest.running` | Never set | No parser. Overview's `atWork` is the screen state alone (`web/src/components/Overview.tsx:66-68`) |
| Usage page | Only through the separate usage path (`server/src/usage.js:272`, `:292`). Not from the chat file | |
| Share / export | Not offered | `gemini` is not in `SHAREABLE_CLIS` (`server/src/share.js:432`) |
| `traceLocation` (agent API) | `null` | No case (`server/src/traces.js:1513`) |

The pane is terminal-only. The operator reads the conversation in the PTY
scrollback (terminal history checkpoint, `server/src/runner.js:2104`).

## Which trace belongs to which pane

AM does not pin anything for Gemini. What exists today:

- **Launch** (`server/src/config.js:242-245`). `run: 'gemini'` and
  `cont: null`. The first launch with a queued prompt is `gemini -i '<prompt>'`.
  Every later launch is plain `exec gemini` (`server/src/runner.js:1968-1970`).
  So **every restart starts a new session file**, and the earlier conversation
  is not resumed.
- **No session id is captured.** No hook, no env var and no screen scrape
  records Gemini's `sessionId`.

How a parser could map pane to file, from what 0.66.0 offers:

1. **Best: pin by id.** `gemini --session-id <uuid>` ("Start a new session
   with a manually provided UUID", `gemini --help`) sets `sessionId`. The file
   name then contains the first 8 chars of that uuid, and the header has the
   full id. This is the same pattern Claude uses (`--session-id`, then
   `--resume`). Resume would be `gemini --resume <id or index>`. Whether
   `--resume` takes a full uuid is **unverified**.
2. **Fallback: by cwd.** Look up `projects.json[cwd]` to get the slug. List
   `tmp/<slug>/chats/session-*.jsonl` and take the newest whose header
   `projectHash == sha256(cwd)`. This has the same ambiguity as every
   cwd-based CLI. Two Gemini panes in one folder write side by side into the
   same `chats/` dir, and nothing on disk says which pane owns which file. The
   `'ambiguous'` guard in `buildImpl` (`server/src/traces.js:1291`) would have
   to refuse.
3. **Hook route.** Gemini hook payloads include `session_id`. AM already runs
   a hook on `Notification`/`AfterAgent`/`SessionEnd`
   (`gemini-system-defaults.json`). A `SessionStart` entry could write the id
   to a breadcrumb, like `am-repin-hook.sh` does for Claude. This is
   **unverified for 0.66.0**: the `SessionStart` event name and the payload
   field were not checked.

Things that create a new file: every launch, `/clear` (new session id),
`/chat resume` or `--resume` of an old `.json` (rewritten as `.jsonl`), and
subagents (a separate file under `chats/<parentSessionId>/`).

## State

Gemini gets the CLI-independent pipeline only. See
[README.md#state-pipeline](README.md#state-pipeline).

| Signal | Source | Where computed | Effect |
| --- | --- | --- | --- |
| Screen diff | djb2 of visible text, sampled at most every 250 ms | `server/src/runner.js:175` (`sampleScreen`), `BUSY_SECS=4` at `:85` | `working` if the screen changed in the last 4 s, else `waiting` (`deriveState`, `:214`) |
| Pane alive | PTY host present | `server/src/runner.js:217-220` | `stopped` when there is no host |
| Input required: marker | `Notification` hook with `notification_type == "ToolPermission"`. `details.type == "ask_user"` means `question`, otherwise `permission` | `scripts/am-input-required-hook.sh:45-69`, read by `readMarker` in `server/src/input-required.js:24` | `inputRequired` on the row (`server/src/index.js:1084`) |
| Input required: OSC 9 | `ESC]9;Gemini CLI needs your attention…BEL`. `Answer requested by agent` means `question`, otherwise `confirmation` | `server/src/input-required.js:120-122`, fed by `term.onData` (`server/src/runner.js:2128`) | Same |
| Input required: clear | Hook `AfterAgent`/`SessionEnd` deletes the marker. OSC 9 `Gemini CLI session complete` clears both. Any typed input clears both. 30 min expiry | Hook `:65`, `server/src/input-required.js:123-125`, `:132-142`, `:83-96` | Clears `inputRequired` |
| `digest.running`, trace `activity` | — | Not computed for Gemini | — |

What AM installs:

- `gemini-system-defaults.json` (copied to `/etc/gemini-cli/system-defaults.json`
  at `Dockerfile:68`) sets `general.enableNotifications: true` and
  `notificationMethod: "osc9"`. It also adds three observation-only hooks that
  all run `/app/scripts/am-input-required-hook.sh`: `Notification` (matcher
  `ToolPermission`), `AfterAgent` and `SessionEnd`. This is the lowest settings
  layer, so a user or project setting can override the notification settings.
  Hook arrays merge across layers.
- The hook keeps only the pane's own Gemini. The hook's parent (or
  grandparent) must be `AM_PANE_PID` (`scripts/am-input-required-hook.sh:50-59`).
  It writes `{amId, runId, cli, kind, source:"gemini-notification", at}` to
  `$AM_INPUT_REQUIRED_DIR/<AM_ID>.json`, or deletes that file on a clear event
  when `runId` matches.

Gemini emits OSC 9 from `useRunEventNotifications`
(`gemini@0.66.0 interactiveCli-PCUQVB2U.js:32880-32965`):

- "needs your attention" fires when a pending confirmation appears: tool,
  command, auth, extension update or loop detection.
- "session complete" fires on every turn end, when `streamingState` goes from
  `responding` to `idle`.
- Both are **suppressed while the terminal reports focus**
  (`hasReceivedFocusEvent && isFocused`).

Details: [../tui-input-required.md](../tui-input-required.md).

**Precedence.** `inputRequired` is shown next to the screen state and does not
replace it (`server/src/index.js:1081-1084`). A Gemini pane can be
`waiting` + input-required, or `working` + input-required while the dialog
repaints. Nothing from the trace takes part.

**How the screen diff behaves for Gemini.** While `streamingState` is
`responding`, Gemini draws `(esc to cancel, Ns)` and redraws it every second
(`interactiveCli-PCUQVB2U.js:23014`). So model streaming, thinking and **tool
execution (including long shell commands)** all show as `working`. When a
confirmation dialog is open the timer is not drawn, so the pane falls to
`waiting` about 4 s later. That is the right answer, and the marker/OSC adds
the reason.

Known failure modes:

1. **Turn end is never recorded.** AM receives two exact "turn finished"
   signals and uses them only to *clear* input-required: the `AfterAgent` hook
   and the "session complete" OSC 9. `done` vs `waiting` cannot be told apart,
   and the list has no `lastAnswerAt`.
2. **Focus clears and suppresses signals.** Gemini enables focus reporting
   (`ESC[?1004h`, replayed to viewers by `server/src/terminal-modes.js:33`,
   `:87`). A focus-in report (`ESC[I`) from the browser is not a terminal reply
   (`server/src/runstate.js:94`). It goes through `write` and calls
   `observeInput()` (`server/src/runner.js:2245`), which **clears an open
   input-required flag** just because someone clicked into the pane. Gemini
   then suppresses further OSC 9 while focused. The `ToolPermission` marker is
   not re-sent either. Result: the Overview loses the flag for every other
   viewer while the dialog is still open.
3. **Non-tool dialogs depend on OSC 9 only.** Auth consent, extension update
   and loop detection have no hook. If a user/project setting turns
   notifications off, or the pane is focused, they show as plain `waiting`.
4. **Stuck "working" from repaints.** `resizeMode: 'repaint'`
   (`server/src/config.js:242`). A resize or a viewer joining forces a full
   repaint, so an idle pane shows `working` for about 4 s. Any animated element
   on an idle screen (for example a tip or update banner) would do the same.
5. **Quiet thinking with no timer.** If `showCancelAndTimer` is off (a UI
   setting), streaming without new text can leave the screen static, and a
   busy pane shows `waiting`. Not observed. It follows from the code above.
6. **Crash or exit mid-turn.** The PTY exits and the state becomes `stopped`.
   The next launch is a fresh session (`cont: null`). The half-finished turn
   stays in the old file, which nothing reads.
7. **Two Gemini panes in one folder** share `tmp/<slug>/chats/`. This does not
   matter today because nothing reads it, but it blocks a cwd-based parser
   (see above).

## Gaps

Ranked by impact on state and reader quality.

1. **No parser or reader for Gemini.** Add `parseGemini` (digest) and
   `normalizeGemini` (reader) for the JSONL above. Dedupe by `id` (last wins).
   Apply `$rewindTo`, `$patch` and `$set`. Map `user` to a prompt, `gemini`
   `content` to an answer, `thoughts` to thinking blocks, `toolCalls` to
   tool-use/result pairs, and `tokens` to usage. Add a `findTrace` case and a
   `traceLocation` case.
2. **No pinning.** Launch with `gemini --session-id <uuid>` (stored on the
   session like `sessionUuid` for Claude) and resume with `--resume`, after
   checking that `--resume` takes a uuid. This gives a deterministic file and
   fixes restarts losing the conversation (`cont: null`).
3. **Turn end is ignored.** Use the existing `AfterAgent` hook (or the "session
   complete" OSC 9) to stamp `lastAnswerAt` and a trace-free `activity: idle`
   (and `UserPromptSubmit`/`BeforeAgent` for `lastPromptAt`). The hook already
   runs in the right process. It only needs to record a timestamp instead of
   only deleting the marker.
4. **Focus input clears input-required.** In the `write` path, skip
   `observeInput()` for `NOT_TYPING` reports (focus, mouse), as
   `isTypedInput` already does for the line guard (`server/src/runner.js:2540`).
   This affects every CLI, but Gemini is the one that also stops re-notifying
   on focus.
5. **Running state from the trace.** Once parsed: the last record is `user`,
   or the last `gemini` record has a function call but no `toolCalls` yet. Both
   mean a tool is pending or running, so `digest.running = true`. A `gemini`
   record with text and no tool calls means idle. Note that nothing is written
   *during* a tool run or an approval, so this still needs the screen and
   input-required signals.
6. **Non-tool dialogs without OSC 9.** Consider a hook for the other
   confirmation types if Gemini exposes them, or document that they are
   best-effort.
