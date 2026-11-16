# OpenClaw

AM launches OpenClaw as `openclaw chat`, the local TUI with an embedded agent.
Every pane talks to the same agent (`main`). Its transcripts are JSONL files,
one per OpenClaw session, under the agent's `sessions/` directory. AM has no
pin, no cwd match and no input-required signal for OpenClaw. It attributes
transcripts only when exactly one OpenClaw pane exists, and state comes from
the screen diff alone.

Version checked: `openclaw --version` → `OpenClaw 2026.10.8 (dc2523e)`.
Record shapes below come from the three transcripts on this Space (written
by an earlier OpenClaw version and restored from the checkpoint; all three
files have the restore mtime).

For the CLI-independent pipeline see [README.md#state-pipeline](README.md#state-pipeline).

## Where the trace lives

| What | Path | Set by |
| --- | --- | --- |
| OpenClaw's `HOME` | `$OPENCLAW_HOME` = `$AM_LOCAL/oc-home` | `entrypoint.sh:63` |
| State root | `$OPENCLAW_STATE_DIR` = `$OPENCLAW_HOME/.openclaw` | `entrypoint.sh:64`, default in `scripts/agent-state.sh:38` |
| Transcripts | `$OPENCLAW_STATE_DIR/agents/<agent>/sessions/<uuid>.jsonl` | OpenClaw |
| Run trace (not read by AM) | `…/sessions/<uuid>.trajectory.jsonl` and `<uuid>.trajectory-path.json` | OpenClaw |
| Session index (not read by AM) | `…/sessions/sessions.json` | OpenClaw |
| Durable checkpoint | `$OPENCLAW_DURABLE` = `$DATA_DIR/state/openclaw-backup` | `entrypoint.sh:65`, `scripts/agent-state.sh:39` |

- Local disk, no symlink: OpenClaw rejects a symlinked `HOME` or state path,
  so `entrypoint.sh:103-113` deletes a `~/.openclaw` symlink and rsyncs any
  legacy real `~/.openclaw` (or `~/.openclaw.pre-symlink`) into the durable
  dir. On this Space `~/.openclaw` does not exist.
- The pane runs `HOME="${OPENCLAW_HOME:-$HOME}"; export HOME; …exec openclaw
  chat` (`server/src/runner.js:1878-1885`); onboarding runs first when
  `openclaw.json` is missing. `cont` is null (`server/src/config.js:254`), so
  every launch, including a restart, is `openclaw chat`.
- Restore: `restore_openclaw` → `restore_tree` (`scripts/agent-state.sh:717`).
  Checkpoint: `checkpoint_tree openclaw` (`scripts/agent-state.sh:1046`),
  every 15 s by default. A plain file tree, see
  [agent-state-checkpoints.md](../agent-state-checkpoints.md). Restore keeps
  mtimes, so after a fresh-container restore all transcripts can share one
  mtime (seen here).
- Write timing (verified from record timestamps): one JSON object per line,
  appended per message. The line's ISO `timestamp` is the write time;
  `message.timestamp` (epoch ms) is the message's own time. `user` and
  `toolResult` lines are written within 100 ms of their message time.
  `assistant` lines are written when the model call completes, up to tens of
  seconds after `message.timestamp`. There are no partial or streaming
  assistant records.
- `sessions.json` maps a session key to its file. Keys seen:
  `agent:main:main` and `agent:main:tui-<uuid>`. Values carry `sessionId`,
  `sessionFile` (absolute path; stale paths from older layouts remain),
  `updatedAt`, `lastInteractionAt`, `abortedLastRun`, token totals, `model`.
  Whether each `openclaw chat` launch gets its own `tui-<uuid>` key was not
  verified.

`traces.js` uses `OPENCLAW_STATE_DIR || $HOME/.openclaw`
(`server/src/traces.js:424`). `findOpenClaw` uses
`(OPENCLAW_HOME || HOME)/.openclaw` (`server/src/share.js:390-391`). On the
Space these resolve to the same directory because `entrypoint.sh` defines the
state dir as `$OPENCLAW_HOME/.openclaw`. They diverge when only
`OPENCLAW_STATE_DIR` is set (local dev), and then the digest and the reader
read different trees. `ccusage` is pointed at `OPENCLAW_STATE_DIR` with
`--open-claw-path` (`server/src/usage.js:106-108`).

## Schema

Line types seen (`jq -r .type`): `session`, `model_change`,
`thinking_level_change`, `custom`, `message`. Every line has `type`, `id`,
`timestamp` (ISO); all but `session` have `parentId` (lines form a tree).

```jsonc
{"type":"session","version":3,"id":"<uuid>","timestamp":"2026-01-01T00:00:00.000Z","cwd":"<openclaw workspace dir>"}
{"type":"model_change","id":"…","parentId":null,"timestamp":"…","provider":"<provider>","modelId":"<model>"}
{"type":"thinking_level_change","id":"…","parentId":"…","timestamp":"…","thinkingLevel":"<level>"}
{"type":"custom","customType":"model-snapshot" | "openclaw:bootstrap-context:full","data":{"runId":"…","sessionId":"…","timestamp":…}, …}
{"type":"message","id":"…","parentId":"…","timestamp":"…",
 "message":{"role":"user","content":[{"type":"text","text":"<prompt>"}],"timestamp":1767225600000}}
{"type":"message", …,
 "message":{"role":"assistant","content":[{"type":"text","text":"<narration>"},
            {"type":"toolCall","id":"call_1","name":"<tool>","arguments":{"command":"<cmd>"},"partialArgs":"{…}"}],
            "api":"…","provider":"…","model":"…","responseId":"…","stopReason":"toolUse",
            "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"reasoningTokens":0,"totalTokens":0,"cost":{…}},
            "timestamp":1767225600000}}
{"type":"message", …,
 "message":{"role":"toolResult","toolCallId":"call_1","toolName":"<tool>","content":[{"type":"text","text":"<output>"}],
            "isError":false,"details":{"status":"completed","exitCode":0,"durationMs":0,"cwd":"<dir>"},"timestamp":1767225600000}}
{"type":"message", …, "message":{"role":"assistant","content":[{"type":"text","text":"<answer>"}],"stopReason":"stop", …}}
```

Observed `message.role` × content: `user`/`text`; `assistant`/`toolCall`
(`stopReason:"toolUse"`); `assistant`/`text,toolCall` (`toolUse`);
`assistant`/`text` (`stop`); `assistant` with empty content (`length`);
`toolResult`/`text`. No `thinking` or image blocks were present in these
files.

The trajectory file is a different stream: `session.started`,
`prompt.submitted`, `context.compiled`, `model.completed` (with `aborted`,
`timedOut`, `idleTimedOut`, `terminalError`, `compactionCount`),
`trace.artifacts`, `session.ended` (`status`, `aborted`, …), all keyed by
`runId`. AM skips it in the digest (`!f.includes('.trajectory')`,
`server/src/traces.js:434`).

| Record | Fields AM reads | Used for | Code |
| --- | --- | --- | --- |
| any line | `timestamp` (ISO) | `firstTs` / `lastTs` | `parseOpenClaw` `server/src/traces.js:386` |
| `message` user | `message.content[].text` | prompt count, `lastPromptText`/`Ts` (skips text starting `<`) | `server/src/traces.js:390-392` |
| `message` assistant | `content[].text`, `usage.input/output/cacheRead` | turns, `lastAssistantText`, tokens | `server/src/traces.js:393-403` |
| `message` assistant | `content[]` where `type` matches `/tool/i`, `name` | tool counts, `sinceTools` | `server/src/traces.js:404-413` |
| `message` any role | `role`, `content` (string or blocks), `usage` | reader messages | `normalizeOpenClaw` `server/src/traces.js:2254` |
| `toolCall` block | `id`, `name`, `input` | reader `tool_use` | `server/src/traces.js:2273-2276` |

Present but ignored, and useful:

- `message.stopReason` (`toolUse` = turn continues, `stop`/`length` = turn
  ended): the obvious turn-state signal.
- `toolCall.arguments`: AM reads `input`, which OpenClaw does not write.
- `toolResult` messages: `toolCallId`, `toolName`, `isError`, `details`.
- `message.timestamp` (message time, versus write time).
- `session.cwd`, `parentId`, `model_change`, `thinking_level_change`.
- `sessions.json` (`sessionKey` → file, `abortedLastRun`, `updatedAt`) and the
  trajectory stream (`session.started` / `session.ended`, `aborted`,
  `timedOut`, `terminalError`).

## How AM maps it

Digest: `parseOpenClaw` (`server/src/traces.js:379`) on the parse worker
pool, via `statsFor(p, parseOpenClaw, 10_000)` (`server/src/traces.js:1380`).

| Digest field | Source |
| --- | --- |
| `lastPromptText` / `Raw` / `Ts` | last `user` message text (`digestPrompt`) |
| `lastAssistantText` / `Md` / `Ts`, `lastAnswerTs`, `outSeq`, `outHash`, `turnsLog` | each assistant text (`digestAssistant`, no `key`, so identity falls back to text hash + prompt in between) |
| `sinceTurns` | every assistant message, including tool-call-only ones |
| `sinceTools`, `sinceToolCalls` | `toolCall` blocks (`digestTool(dg, name, null)`, no files) |
| `sinceTokens` | `usage.input + usage.output` per assistant message |
| `running` | never set |

Files over 12 MiB are tail-read and get `activityError:
'activity-incomplete'`; the append-cursor scan in `trace-activity.js` is used
for Claude and Codex only (`server/src/traces.js:1039-1043`). `digestFor` and
`traceLocation` return null for OpenClaw (`server/src/traces.js:1479`,
`:1513`).

Reader: `findTrace` → `findOpenClaw` (`server/src/share.js:387`) →
`readTrace` → `normalizeOpenClaw` (`server/src/traces.js:2254`). OpenClaw is
`WINDOWABLE` (`server/src/traces.js:2679`), so the reader reads byte windows.
`sniffHarnessUncached` recognises it by `type:'message'` + `message`
(`server/src/traces.js:2553`).

| Source | Reader blocks | Notes |
| --- | --- | --- |
| `user` message | `{role:'user', blocks:[text]}` | |
| `assistant` text | `{role:'assistant', blocks:[text]}` | `markFinalTurns` marks the last before a user turn |
| `assistant` `toolCall` | `tool_use {id, name, input}` | `input` is empty: OpenClaw writes `arguments` |
| `toolResult` message | **`{role:'user', blocks:[text]}`** | role maps to `user` (`traces.js:2260`); its blocks are `text`, so no `tool_result` is produced and nothing is stitched |
| `thinking` block | `thinking` | not observed in these files |
| `usage` | per-message `usage`, summed into the session total | |
| `session`, `custom`, `model_change`, `thinking_level_change` | dropped | |
| errors, aborts, compaction | not represented | |

The `toolResult` → `user` mapping has two effects: tool output shows as if
the operator typed it, and `markFinalTurns` (`server/src/traces.js:2595`)
treats every tool result as a turn boundary, so the narration before each
tool call is marked as a final answer. `fromOpenClaw`
(`scripts/share-session.mjs:148`) has the same mapping and emits
`arguments: '{}'`.

## Which trace belongs to which pane

There is no pin and no usable cwd: `session.cwd` is OpenClaw's own agent
workspace (`agents.defaults.workspace` in `openclaw.json`), not the pane's
folder, and every pane shares agent `main`.

| Path | Rule | Code |
| --- | --- | --- |
| Digest (`buildImpl`) | If exactly one session record has `cli === 'openclaw'`, every `*.jsonl` (not `.trajectory`) under every agent is attributed to it. Otherwise all go to "other". | `server/src/traces.js:1371-1382` |
| Reader / share (`findOpenClaw`) | Refuse if another OpenClaw pane uses the same folder. Otherwise walk `agents/` up to depth 4 and return the `.jsonl` with the newest mtime. | `server/src/share.js:387-405` |

Consequences:

- **One pane:** all OpenClaw history ever written (earlier panes, onboarding,
  anything run outside AM) sums into its stats. The digest comes from the
  file with the newest `lastTs` (`attribute`, `server/src/traces.js:1301`).
- **Two panes, any folders:** the digest goes to nobody. The check counts
  session records, so a stopped pane still counts.
- **Two panes, different folders:** `findOpenClaw` does not refuse. Both
  readers show the same newest file, whichever pane wrote it. The digest and
  the reader disagree on who owns what.
- **`findOpenClaw` includes `.trajectory.jsonl`.** The walk accepts any
  `.jsonl`. If the trajectory file is written after the transcript (it gets
  `session.ended` / `trace.artifacts` at run end), it wins on mtime, and
  `normalizeOpenClaw` finds no `message` lines in it: an empty reader. With
  equal mtimes (after a restore) the first in `readdir` order wins; here that
  was the transcript. Not observed live.
- **New file per OpenClaw session.** A new session (new key or `/new`) starts
  a new `<uuid>.jsonl`. With one pane that is fine for the digest (newest
  wins) and for the reader (newest mtime wins).
- **Restart:** `cont` is null, so AM always launches `openclaw chat`. Which
  session OpenClaw reopens is OpenClaw's choice; AM neither knows nor pins it.

## State

| Signal | Computed at | OpenClaw input |
| --- | --- | --- |
| Screen diff → `working` / `waiting` / `stopped` | `deriveState` `server/src/runner.js:214` | yes, the only live signal |
| `digest.running` | parsers | never set |
| Reader `activity` | `headOf` `server/src/traces.js:2633` | never set |
| Input-required | `server/src/input-required.js:8-10`, `:101` | none — see [tui-input-required.md](../tui-input-required.md) |
| `lastPromptAt` / `lastAnswerAt` / `activityKind` | `conversationActivity` `server/src/agent-list.js:46` | from the digest, single-pane only |
| Unread cursor | `outputOf` `server/src/index.js:697` | `outSeq` from `digestAssistant`, single-pane only |

Precedence: nothing to reconcile. Everything reduces to the screen diff;
trace-derived fields exist only with a single OpenClaw pane.

The 10 s quiet margin: `statsFor` returns the previous parse while the file's
mtime is under 10 s old and a previous parse exists
(`server/src/traces.js:1003`). The comment says it protects OpenClaw's
session fence from reads on FUSE; state is now on local disk and the margin
was kept. Effect: during a turn that appends a line at least every 10 s
(tool-heavy runs), the digest freezes on the pre-turn parse until the file
goes quiet. The first parse is always allowed.

Failure modes:

- **Approval dialog.** The embedded TUI waits, the screen is static, the pane
  reads `waiting` with no badge. Same as "done".
- **Long model call.** Assistant lines are written only on completion. If the
  TUI shows no ticking spinner while the model works, the pane reads
  `waiting` after 4 s, and the trace has nothing newer than the prompt or the
  last tool result.
- **Long tool call.** Same: `stopReason:"toolUse"` on the last assistant line
  says the turn is open, but AM does not read it.
- **Turn ending without an answer.** An assistant line with empty content and
  `stopReason:"length"` exists in the sample. The digest keeps the previous
  text; nothing marks the turn as cut off.
- **Crash or abort.** The transcript just stops; `abortedLastRun` in
  `sessions.json` and `session.ended` in the trajectory are not read.
- **Second pane.** Adding a second OpenClaw pane anywhere blanks the first
  pane's Overview digest, last prompt / answer, and unread state.
- **Resize repaint** (`resizeMode: 'repaint'`, `server/src/config.js:254`):
  generic, see [README.md#state-pipeline](README.md#state-pipeline).

## Gaps

1. **Reader mis-renders tool results.** Map `role:'toolResult'` to a
   `tool_result` block stitched by `toolCallId`, and read
   `toolCall.arguments`. Same fix in `fromOpenClaw`.
2. **No turn-open signal.** Set `digest.running` and reader `activity` from
   the last assistant `stopReason` (`toolUse` → working; `stop`, `length`,
   `error`, `aborted` → waiting), and from the last line being a `user` or
   `toolResult` message (working).
3. **No per-pane pin.** Capture the session file a pane creates (new
   `sessions.json` entry or new `.jsonl` after launch) and store it on the
   session; fall back to single-pane only when unpinned. This removes the
   "second pane blanks the first" behaviour.
4. **`findOpenClaw` disagrees with `buildImpl`.** Use `openclawFiles()` (skips
   `.trajectory`), `OPENCLAW_STATE_DIR`, and the same single-pane rule in one
   helper.
5. **10 s quiet margin.** Re-evaluate now that state is local; at minimum cap
   the staleness (serve the cached parse for at most N seconds while hot).
6. **Digest identity.** Pass `responseId` (or line `id`) as the `key` to
   `digestAssistant` so two identical replies count as two.
7. **Reader ignores the tree.** `parentId` branches render as one linear
   stream; follow the leaf chain if OpenClaw starts writing branches.
8. **No input-required.** Needs a gateway approval adapter
   ([tui-input-required.md](../tui-input-required.md)).
