# Trace schemas and agent state

What each CLI writes, what Agent Manager (AM) reads from it, and how AM decides
whether a pane is working, waiting for the operator, blocked on a dialog or
stopped. This is a map of the current code, not a design: where the code and a
comment disagree, the code is described. Line numbers are against `main` at
the time of writing.

One page per CLI:

| CLI | Page | Version checked |
| --- | --- | --- |
| Claude Code | [claude.md](claude.md) | 2.1.312 |
| Codex | [codex.md](codex.md) | codex-cli 0.165.0 |
| Gemini CLI | [gemini.md](gemini.md) | 0.66.0 |
| OpenCode | [opencode.md](opencode.md) | 1.19.5 |
| Hermes | [hermes.md](hermes.md) | see page |
| OpenClaw | [openclaw.md](openclaw.md) | 2026.10.8 |
| fx | [fx.md](fx.md) | 0.0.5 |
| Antigravity `agy` | [agy.md](agy.md) | in flight, PR #227 |

Related: [reader-architecture.md](../reader-architecture.md) (reader transport
contracts), [conversation-adapter.md](../conversation-adapter.md),
[trace-panel-spec.md](../trace-panel-spec.md) (the normalized message/block
model), [agent-activity.md](../agent-activity.md) (`lastPromptAt` and friends),
[tui-input-required.md](../tui-input-required.md) (dialog detection),
[agent-state-checkpoints.md](../agent-state-checkpoints.md) (live vs durable
state directories), the `codex-*.md` pages (shared Codex).

## At a glance

| CLI | Format | One file per conversation? | Digest parser | Reader normalizer | Pane pin | `digest.running` | Reader `activity` | Input-required signal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | JSONL | yes, plus `subagents/` | `parseClaude` | `normalizeClaude` | `sessionUuid` | no | yes | Notification hook → marker |
| codex | JSONL rollout | yes, plus subagent rollouts | `parseCodex` | `normalizeCodex` | `codexSessionId` / `codexRollout`, or a shared binding | yes (`task_started` → `task_complete`) | yes | OSC 9; shared: app-server status |
| gemini | JSON/JSONL chat files | yes | **none** | **none** | **none** | no | no | Notification hook → marker; OSC 9 |
| opencode | SQLite (WAL), shared | no, one DB for all | `readOpencode` | `normalizeOpencodeDb` | `opencodeSessionId` | see page | no | plugin events → marker |
| hermes | SQLite, shared | no, one DB for all | `readHermes` | `normalizeHermesDb` | none (cwd only) | no | no | none |
| openclaw | JSONL | yes, but one agent shared by every pane | `parseOpenClaw` | `normalizeOpenClaw` | none (single-pane only) | no | no | none |
| fx | JSONL `events.jsonl` | yes | `parseFx` | `normalizeFx` | `fxSessionId` | yes | no | none |
| agy | SQLite + protobuf | yes | PR #227 | PR #227 | PR #227 | — | — | — |

All parsers and normalizers live in `server/src/traces.js`. The CLI-specific
pages give exact lines. Locating a pane's trace for the reader, sharing and
dispatch tracking goes through `findTrace` (`server/src/share.js:413`); the
Overview digests come from the bulk pass `buildImpl`
(`server/src/traces.js:1291`) and the targeted `digestFor`
(`server/src/traces.js:1479`). These are two separate attribution
implementations with different fallbacks (see [Gaps](#gaps)).

## Digest fields

The digest is the per-session summary the Overview, `/api/agents` and the
agent inventory read. It is built by the CLI's `parse*` function over the whole
file (`emptyDigest`, `server/src/traces.js:58`).

| Field | Meaning | Set by |
| --- | --- | --- |
| `lastPromptText` / `lastPromptRaw` / `lastPromptTs` | Last operator prompt, clipped to 280 / 6000 chars | `digestPrompt` `traces.js:87` |
| `lastAssistantText` / `lastAssistantMd` / `lastAssistantTs` | Newest assistant text since that prompt; cleared by a new prompt | `digestAssistant` `traces.js:109` |
| `lastAnswerTs` | When the newest *distinct* reply appeared | `digestAssistant` |
| `outSeq` / `outHash` / `outKey` / `outFresh` / `outClipped` | Unread cursor for the Overview | `digestAssistant` |
| `sinceTurns` / `sinceToolCalls` / `sinceTools` / `sinceFiles` / `sinceTokens` | Work since the last prompt | `digestTool` `traces.js:156`, parsers |
| `turnsLog` | Up to 24 earlier assistant texts of the current request | `digestAssistant` |
| `running` | The CLI's own task lifecycle says a turn is open | `parseCodex`, `parseFx` only |
| `activityError` | `activity-incomplete` / `activity-unavailable` | `statsFromFile` `traces.js:1035`, `trace-activity.js` |

`/api/agents` turns the digest into `lastPrompt`, `lastAnswer`
(`server/src/index.js:1092`) and `lastPromptAt`, `lastAnswerAt`,
`lastActivityAt`, `activityKind` (`conversationActivity`,
`server/src/agent-list.js:46`). For Claude and Codex the two timestamps come
from the bounded append-cursor scan in `server/src/trace-activity.js`, not from
the 12 MiB display digest ([agent-activity.md](../agent-activity.md)).

## State pipeline

There is no single state model. Six consumers each derive "is this agent
working / done" from a different subset of signals:

| # | Consumer | Signals | Code |
| --- | --- | --- | --- |
| 1 | Sidebar, Overview light, `/api/tree`, `/api/agents` `state`, `/api/agents/:id/wait`, `/tail`, dispatch "ended" | PTY alive + screen text changed in the last 4 s | `deriveState` `server/src/runner.js:214` |
| 2 | Shared Codex panes (same fields as 1) | Native app-server thread status | `SessionRuntime.presentation` `server/src/session-runtime.js:28` |
| 3 | Overview "running now" / card running line | 1, or `digest.running` when not stopped | `atWork` `web/src/components/Overview.tsx:67` |
| 4 | Reader "working" indicator | Reader `activity` from the trace, gated on `session.running` and no input-required | `web/src/components/conversation/ConversationView.tsx:176`, `traces.js:1910`, `traces.js:2201`, `traces.js:2238` |
| 5 | Delegation outcome (`completion: notify`) | Trace records after the dispatched prompt (Claude `stop_reason`, Codex `task_complete`), then 1 + input-required | `consumeEvidence` `server/src/delegations.js:22`, `tick` `delegations.js:144` |
| 6 | Input-required badge | Hook marker files and OSC 9 per launch | `createInputRequiredTracker` `server/src/input-required.js:71` |

### 1. Screen diff (all local PTY CLIs)

`term.onData` (`server/src/runner.js:2124`) feeds every PTY chunk into the
headless terminal and calls `sampleScreen` (`runner.js:175`). At most every
250 ms it hashes `vt.getVisibleText()` (djb2) and records `screenChangedAt`
when the hash changes. `agentInfo` (`runner.js:192`) reports
`age = now - screenChangedAt`; `deriveState` (`runner.js:214`) maps:

| Condition | State |
| --- | --- |
| `cli` is `files` or `trace` | `idle` |
| remote CLI | `remoteState` (`server/src/remote.js:485`) |
| no PTY host | `stopped` |
| host exists, `age <= 4` s (`BUSY_SECS`, `runner.js:85`) | `working` |
| otherwise | `waiting` (`idle` for `shell`) |

Consequences that hold for every CLI:

- **Working means "the visible text changed", not "a turn is open".** A turn
  shows as working only while the CLI animates something on screen: Claude's
  and Codex's spinners with an elapsed-seconds counter, OpenCode's spinner,
  streamed text. A turn whose screen is static for more than 4 s (a CLI that
  stops animating during a long tool call, a hung network request without a
  ticking counter) reads `waiting`.
- **Anything that animates without a turn reads `working`**: a clock or
  counter in a status line, a background-task indicator, the operator's own
  typing echoed in the composer, a resize that changes wrapped text, the
  startup banner.
- Visible text only. Scrollback, colours, cursor position and title changes
  are ignored; output that scrolls off screen without changing the visible
  rows is invisible.
- The 250 ms throttle drops samples, it does not defer them. If the last chunk
  of a burst falls inside the throttle window, its change is picked up only by
  the next chunk. This can make the final change of a turn invisible until the
  next output.
- `bells` (BEL count) is collected (`runner.js:2143`) and exported by
  `agentInfo`, but nothing reads it.
- `/api/agents/:id/wait` (`server/src/index.js:1230`) papers over the 4 s
  window with a caller-chosen `settle` (default 4 s, the generated skill
  suggests 15 s): the target state must hold that long. It says so itself:
  `taskCorrelated:false`.

### 2. Native status (shared Codex only)

A Codex pane bound to a shared app-server thread takes its `state`,
`running` and `inputRequired` from `SessionRuntime.presentation`, which maps
the daemon's `working` / `idle` / `needs-input` / `unloaded` to
`working` / `waiting` / `waiting` / `stopped`, refreshed at most every 3 s.
This is the only place AM has an authoritative turn state. See
[codex.md](codex.md) and [codex-shared-bindings.md](../codex-shared-bindings.md).

### 3. `digest.running`

Only `parseCodex` (from `task_started` / `task_complete` / `turn_aborted`) and
`parseFx` set it. The Overview uses it to keep a quietly thinking agent in the
"running now" block, but only while the pane is not `stopped`, because a crash
mid-turn leaves it `true` forever (comment at
`web/src/components/Overview.tsx:48`).

### 4. Reader `activity`

Set by `normalizeClaude` and `normalizeCodex` only and exposed through
`headOf` (`traces.js:2633`). The reader shows its running indicator only when
`session.running`, the activity read is confirmed fresh, `activity ===
'working'` and there is no input-required signal. For every other CLI the
reader has no running indicator.

### 5. Delegations

`POST /api/agents/:id/prompt` with `completion: notify` is the one consumer
that ties completion to *this* prompt. It requires a shared Codex *parent*
and a Claude or shared Codex *target* (`server/src/index.js:486`), and a
pinned trace file. It
reads the trace forward from a byte checkpoint and decides `completed` /
`failed` / `uncertain` from harness records, then falls back to the pane
state: `input-required` → `blocked`, `stopped` → `failed`.

### 6. Input-required

Per launch, advisory, no screen scraping. Covered by
[tui-input-required.md](../tui-input-required.md). Sources: Claude, Gemini and
OpenCode write marker files in `$AM_INPUT_REQUIRED_DIR` (default
`/tmp/am-input-required`) through `scripts/am-input-required-hook.sh` or the
OpenCode plugin; Codex and Gemini emit OSC 9, parsed in `observeOutput`
(`input-required.js:100`). Markers expire after 30 minutes; operator input
clears unpaired signals.

### Precedence when signals disagree

| Surface | Rule |
| --- | --- |
| `/api/tree`, `/api/agents` `state` | shared Codex native status, else screen diff. Input-required is a separate field, it never changes `state`: a pane on a dialog reads `waiting` (static screen) or `working` (animated dialog). |
| Delegation target state (`delegationState`, `server/src/index.js:470`) | shared Codex status, else `input-required` if a signal is active, else screen diff. |
| Overview "running now" | screen `working` OR (`digest.running` AND not `stopped`). |
| Reader indicator | trace `activity`, gated on PTY alive and no input-required. Screen diff is ignored. |
| `/wait` | shared Codex status, else screen diff, held for `settle` seconds. Input-required is not visible to `/wait`; a blocked agent matches `waiting`. |

So the sidebar can say `working` while the reader says idle (an animated
status line after the turn ended), or `waiting` while the reader says working
(a long tool call with a static screen). Both are the designed behaviour of
their own signal, and nothing reconciles them.

## Gaps

Ranked by how often they produce a wrong state for the operator or a
coordinating agent. CLI-specific gaps are on each page.

<!-- GAPS -->
