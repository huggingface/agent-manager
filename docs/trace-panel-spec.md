# Trace panel — implementation spec

Status: **built** (2026-07-29) · Branch: `worktree-session-sharing` · PR: huggingface/agent-manager#8

A handoff document. Everything here was verified against this codebase and the live Hub on
2026-07-27/28. Read `docs/session-sharing.md` for the wider design; this file is only the
panel, and is written to be self-contained.

**§11 records what actually shipped**, including four places where the implementation
departed from this spec on purpose. Sections 1–10 are the brief as written; where they
disagree with §11, §11 is the code.

## 1. What to build

A read-only panel inside Agent Manager that renders one agent session as a readable
conversation — turns, tool calls, thinking blocks, token counts — close in spirit to the
**Hugging Face agent trace viewer** (Data Studio's session modal).

Two sources, same component:

1. **A local session of your own** — the immediate value, and the only way to exercise all
   five readers against real data. Ship this first.
2. **An accepted incoming trace** — a bundle downloaded from a Hub dataset, landing in
   `DATA_DIR/traces/<envelope-id>/`. The receive half is not built yet.

The panel also hosts **Fork** and **Handoff** buttons (see §8 of the design doc), but those
are not required for a first version.

## 2. Hard constraints

These are not style preferences; each one has already caused an incident in this repo.

- **No LLM calls, anywhere.** The whole feature is deterministic parsing. The operator has
  explicitly ruled out inline model calls in Agent Manager.
- **Nothing heavy on the event loop.** A single session here is **6.15 MB**. This app has
  wedged on synchronous work before — see `server/src/watchdog.js`, a worker thread that
  exists solely to report main-thread stalls, with breadcrumbs (`mark`/`tracked`) around the
  known-heavy paths. Parse off the request path, or in a child process as
  `server/src/share.js` does.
- **Virtualize the message list from the start.** The Hub's own session modal fails to
  render our 2.13 MB single-row dataset. Do not assume a session fits in the DOM.
- **Do not extend the Overview's memoized parse.** `traces.js` parses *every* session on a
  poll and memoizes by mtime; making those parsers also retain every turn would balloon
  memory across all sessions. Add a **separate on-demand function for one session** — put it
  in `traces.js` so the line-shape knowledge stays in one file and drift is visible in
  review, but keep it out of `buildTraces()`/`traceDigests()`.
- **The filesystem is a FUSE bucket and it lies.** Stale directory listings (a file written
  seconds earlier reading as absent), exec bits stripped from `node_modules/.bin` and git
  hooks, and paths occasionally materialised as *directories* (`.git/hooks/pre-commit`,
  `~/.gemini/projects.json`, and historically `opencode.json` — see the guard at
  `runner.js:415`). Retry before concluding a file is missing.

## 3. Where it plugs in — already done

| Piece | State |
|---|---|
| `trace` in the CLI catalog | ✅ `server/src/config.js:69` — `bin: null, run: null`, colour `#7c8cf8` |
| Treated as a passive panel, never launched | ✅ `server/src/runner.js:135` returns `'idle'` for `files` and `trace` |
| Pane dispatch | ⬜ `web/src/App.tsx:423` — currently `s.cli === 'files' ? <FilesPane/> : <TerminalPane/>`; add a branch |
| Component | ⬜ new `web/src/components/TracePane.tsx` |
| Reader endpoint | ⬜ new, see §5 |

**Model your component on `web/src/components/FilesPane.tsx`** (181 lines) — the existing
passive, non-process pane. It shows the house style: plain `fetch` through `web/src/api.ts`,
no state library, CSS appended to `web/src/styles.css` with flat `.kebab-case` class names.
There is no modal/dialog framework; `.welcome-backdrop` + `.welcome-card` in `styles.css` is
the established overlay pattern (`ShareDialog.tsx` uses it).

## 4. Why the digest is NOT enough

The operator initially expected the existing digest would do. It will not, and here is the
precise reason so nobody re-litigates it:

`traces.js` `emptyDigest()` (line 48) returns `lastPromptText`, `lastAssistantText`,
`sinceTurns`, `sinceToolCalls`, `sinceTools` (tool **names** and counts only), `sinceFiles`,
`sinceTokens`, `running`, and `turnsLog`. And `turnsLog`:

- is **reset at the start of every request** — `traces.js:60`, commented "arrows only walk
  the current request's turns";
- is **capped** at `MAX_TURNS_LOG` (24, `traces.js:56`);
- holds only `{ answer, answerMd, ts }` — assistant text, with no paired user prompt.

So the digest is a "what did this agent just do" summary that powers the Overview card. It
carries no conversation history, no tool arguments, no tool results and no thinking blocks —
exactly what a viewer needs. A full parse is required.

## 5. The reader

Suggested shape — one function, one session, on demand:

```js
// server/src/traces.js  (NOT part of buildTraces/traceDigests)
export async function readTrace(session, { offset = 0, limit = 200 } = {}) → {
  harness, sessionId, model, cwd, firstTs, lastTs, total,
  turns: [ Turn, … ]   // ordered oldest→newest, sliced by offset/limit
}
```

```ts
type Turn = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;             // rendered as markdown for assistant/user
  thinking?: string;        // collapsed by default
  ts?: number;              // epoch ms
  model?: string;
  usage?: { in: number; out: number; cacheRead: number };
  toolCalls?: { id: string; name: string; args: unknown }[];
  toolResult?: { id: string; content: string; isError?: boolean };
};
```

Paginate at the API rather than sending 6 MB. Endpoint suggestion:
`GET /api/trace/:sessionId?offset=&limit=` for a live session, and
`GET /api/trace/bundle/:envelopeId?offset=&limit=` for an accepted one.

**Locating the file is already solved** — reuse `findTrace(session, allSessions)` exported
from `server/src/share.js`. It returns `{ src, sessionId? }`, handles all five harnesses,
prefers the per-session pin where one exists (`sessionUuid`, `codexSessionId`,
`opencodeSessionId`), falls back to attribution by recorded working directory, and refuses to
guess when two sessions of the same harness share a folder. It also skips codex's
guardian/subagent rollouts. Do not reimplement this.

## 6. The five formats — verified line shapes

`scripts/share-session.mjs` already contains **working readers for all five**, written and
tested against real and faithful-synthetic data. Read it before writing anything: the
knowledge below is what it encodes, and reusing it avoids a second source of truth.

### Claude Code — `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<uuid>.jsonl`
One JSON object per line; the **filename is the session id**.
- `{type:'user', timestamp, cwd, gitBranch, message:{role:'user', content: string | [{type:'text',text}]}}`
- `{type:'assistant', timestamp, uuid, message:{id, model, role:'assistant', content:[{type:'text',text} | {type:'thinking',thinking} | {type:'tool_use',id,name,input}], usage:{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}}}`
- Tool **results** come back as `type:'user'` lines carrying `toolUseResult` and a
  `content:[{type:'tool_result',tool_use_id,content}]`.
- **Dedupe assistant lines by `message.id`** — streaming writes the same message id more
  than once, and counting naively double-counts turns and tokens.
- Skip `isMeta` and `sourceToolUseID` user lines; they are not prompts.
- **`file-history-snapshot` / `file-history-delta` lines embed whole file contents.** The
  share pipeline drops them outright. A viewer should ignore them too.

### Codex — `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
Everything is wrapped in `payload`.
- `{type:'session_meta', payload:{cwd, timestamp, thread_source?, source?}}` — if
  `thread_source === 'subagent'` or `source.subagent`, this is an internal guardian rollout,
  **not the user's conversation**. Refuse it.
- `{type:'response_item', payload:{type:'message', role, content:[{text}]}}` — codex wraps
  environment/instruction blobs as `role:'user'` items whose text starts with `<`; skip those
  or your prompt count is wrong.
- `{type:'response_item', payload:{type:'function_call'|'custom_tool_call'|'local_shell_call'|'web_search_call', name, arguments}}` —
  `apply_patch` carries touched paths in its patch header:
  `/\*\*\* (?:Update|Add|Delete) File: ([^\n"]+)/`.
- `{type:'event_msg', payload:{type:'token_count', info:{total_token_usage:{input_tokens, cached_input_tokens, output_tokens, total_tokens}}}}` —
  **cumulative per run**, so keep the last one, and subtract `cached_input_tokens` from
  `input_tokens` to match Claude's "fresh input" convention.
- `{type:'event_msg', payload:{type:'task_complete', last_agent_message}}` — the
  authoritative final answer for a task.

### OpenClaw — `$OPENCLAW_HOME/.openclaw/agents/<agent>/sessions/<uuid>.jsonl`
Already close to the Hub's STS shape:
`{type:'message', timestamp, message:{role, content: string | [{type,text|name|input}], usage:{input,output,cacheRead}}}`.
Content blocks whose `type` matches `/tool/i` are tool calls.

### opencode — **SQLite**, `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`
A session is a *query*, not a file.
- `session(id, directory, title, time_created, time_updated, tokens_input, tokens_output, tokens_cache_read)`
- `message(id, session_id, time_created, data)` — `data` is JSON with `role`
- `part(id, message_id, session_id, time_created, data)` — `data` is JSON with
  `type: 'text' | 'tool' | 'step-finish'`, plus `text`, `tool`, `state.input`, `state.output`
- **Never copy or ship this database**: `account.access_token`, `account.refresh_token` and a
  `credential` table live in it. Select one conversation.
- Live data is on **local disk via a symlink**. Durable state is a verified
  SQLite online-backup checkpoint; copying a live DB/WAL/SHM set with `rsync`
  is not transactionally safe. This layout also prevents a synchronous read of
  FUSE-backed SQLite from freezing the whole server. Open **read-only**, and
  never on a hot path.

### Hermes — **SQLite**, `~/.hermes/state.db`
- `sessions(id, cwd, title, started_at, input_tokens, output_tokens, cache_read_tokens)`
- `messages(id, session_id, role, content, timestamp, tool_name, token_count, active)` —
  flat `content`; a row with `tool_name` set is a tool interaction. `timestamp` is **seconds**
  (multiply by 1000). Same local-live/online-checkpoint note as opencode.
- Hermes has **no per-session pin** in Agent Manager, so it is attributed by `cwd`.
- Alternative worth knowing: `hermes sessions export --format trace` emits Claude-Code JSONL
  specifically for the HF viewer, and `--redact` exists. We chose direct SQLite reads for one
  code path with opencode; either is defensible.

## 7. What the Hub's viewer does, for reference

Verified live. A dataset containing raw session `.jsonl` files gets auto-tagged
`format:agent-traces`, and the Hub aggregates **one file into one row**, deriving columns:
`harness`, `session_id`, `prompt`, `messages`, `tools`, `metadata`, `sent_at`,
`num_user_messages`, `num_tool_calls`, `trace`, `file_path`.

Clicking the row opens a **Session modal** showing: user/assistant turns with role badges and
timestamps, the model name as a chip, per-turn token counts (`491↓ 520↑ (1,408 cached)`), a
collapsible **Thinking** block with a one-line preview, collapsed `N tool call (bash)`
summaries, rendered markdown including tables, and a Collapsed/Expanded toggle.

It is embeddable and deep-linkable — `…/embed/viewer/default/train?row=0` renders the modal
inside an iframe. **We deliberately do not use it**: it cannot render a *gated* repo (the
private path), and a brand-new dataset took **~50 minutes** to become viewable. Both are
recorded in the design doc. It remains the visual reference, and it is what a public share
gets for free in a browser.

Live examples to look at:
`thomwolf/am-session-sharing-design` (public, renders),
`thomwolf/am-session-sharing-design-gated` (gated, shows the gate).

## 8. Suggested v1 scope

Ordered by value. The operator asked for full fidelity with everything collapsed by default.

1. Ordered turns with role, timestamp, markdown-rendered text
2. Thinking blocks — collapsed, one-line preview
3. Tool calls — collapsed, showing name and a short argument summary; expand for full args
4. Tool results — collapsed, truncated with an expand
5. Per-turn token counts and the model chip
6. Search / filter within the session
7. Header: harness, model, window, totals — reuse the stats the share manifest already computes

Skip: statistics panels, prev/next row navigation, editing anything. The panel is read-only.

## 9. Traps that cost me time

- **`const` does not hoist.** Twice I put helpers or accumulators after the loop that used
  them and got a temporal-dead-zone crash on the first line parsed. Declare state above.
- **Verify your success checks.** I once printed "ok" from a grep that matched a comment, and
  another time from `head`'s exit status rather than the compiler's. Both hid real failures.
- `tsc`/`vite` cannot execute from `node_modules/.bin` on the FUSE mount (exec bit stripped).
  Run them as `node node_modules/typescript/bin/tsc …`, or install into `/tmp`.
- `web/` and `server/` have **no `node_modules` in the repo** — deps live at `/app/*/node_modules`
  in the container. Symlink them for local runs.
- Test the server on a spare port with `PORT=… DATA_DIR=/tmp/… node src/index.js`, and
  `PUBLIC_DIR=<worktree>/web/dist` to serve a locally built UI. **Never `pkill -f` a pattern
  that could match `/app/server/src/index.js`** — that is the live Space at PID 1.
- The app has **no authentication at all**; it only serves a usable backend while the Space is
  private (`visibility.js`, `index.js:142`). A fresh `DATA_DIR` starts with the Welcome
  overlay, which intercepts clicks — `POST /api/welcome/seen` to dismiss it in tests.

## 10. Open questions for whoever builds this

1. **Where does "open the trace" live?** A button on the session row next to Share, an item
   in the pane header, or an entry in the Overview card? A `trace` session needs creating and
   pointing at a source, and the session record has no field for that yet — suggest
   `traceSource: { kind: 'session' | 'bundle', ref: string }`.
2. **Does one panel follow a live session as it grows**, or is it a frozen snapshot? Following
   means re-polling and appending; frozen is simpler and matches "trace".
3. **How much tool output to retain in memory** once expanded — a single `Bash` result here
   can be hundreds of KB.

## 11. As built (2026-07-29)

Landed. Files: `server/src/traces.js` (reader appended at the bottom),
`server/src/index.js` (two routes), `web/src/components/TracePane.tsx` (new),
`web/src/api.ts`, `web/src/types.ts`, `web/src/styles.css`, plus the entry point in
`App.tsx` / `Sidebar.tsx`.

### Four deliberate departures from §5–§8

1. **Blocks, not a `Turn` with a single `toolResult`.** §5's shape can't represent the
   transcripts. Claude emits tool *results* on a separate `type:'user'` line, and parallel
   calls finish out of order, so one `toolResult` slot per turn silently drops all but one.
   `readTrace()` returns `{ role, kind?, ts?, model?, usage?, blocks: [...] }` with a
   `makeStitcher()` that files each result next to its own call by `tool_use_id` — which is
   also what makes the collapsed `3 tool calls (Bash, Read)` row possible at all.
2. **`kind: 'final'`** on the last assistant turn before each prompt. **Corrected
   2026-07-29:** the original claim here — that codex's `task_complete` is an authoritative
   answer separate from the `response_item` text, and that non-final text should render
   dimmed — was wrong on both counts. `task_complete.last_agent_message` is byte-identical
   to the preceding assistant message in every task of the rollout checked, so treating it
   as separate rendered all 8 answers twice; and the Hub *emphasises* the final turn with an
   accent rule rather than dimming the others. `markFinalTurns()` now derives the final turn
   for every harness in one reverse pass, and `task_complete` only marks it.
3. **Codex gets a stitcher too.** Codex writes a call and its output as two separate
   top-level items, so before this every call and every result was its own row and nothing
   ever folded. Caught in testing: `0 paired, 1 standalone` → `1 paired, 0 standalone`.
4. **Environment blobs become `role:'system'`, not dropped.** Claude's `<system-reminder>`,
   codex's `<`-prefixed user items, and codex's whole `role:'developer'` stream are context,
   not prompts. Dimmed and collapsed behind their own tag name rather than hidden, because
   removing them makes the conversation read wrong — but one of them here is 27 KB, so
   expanded they bury the session before it starts. The Hub instead labels these "User" and
   expands them, or omits them entirely; this is a deliberate divergence.

### The three open questions in §10, as answered

1. **Entry point:** a Trace button on the session row, next to Share. `traceSource` was kept
   verbatim, and is only needed for a pane pointed at something *else* — a plain agent
   session reads its own transcript, so `GET /api/trace/<agent-session-id>` works with no new
   record. Panes are reused per source rather than piling up.
2. **Frozen per read**, cheap to follow: the memo key includes `mtimeMs`+`size`, so
   re-requesting after the file grows reparses and `total` climbs. No incremental machinery.
3. **Capped at parse time**, 20 000 chars per block, with `more` reported so the UI says
   "+412 KB not retained" instead of pretending.

### `trace` is a passive pane, like `files`

`PASSIVE_CLIS = ['files', 'trace']` in `server/src/config.js`, mirrored as `isPassive()` in
`web/src/types.ts`. It gates: the agent list in `/api/meta`, `buildTraces()`, the input route
(a trace pane refuses keystrokes), the Overview cards, archiving, the quickstart picker, the
group cart, and a group's agent count. Adding a third passive pane type now means one array.

### Verified against real data

- **9.46 MB live Claude transcript** (this session): 634 ms full parse, **worst event-loop
  block 2 ms**, 82 MB RSS; second call 3 ms off the memo. Counts reconciled against an
  independent pass over the raw file — 259 text blocks = 228 assistant + 28 prompts + 3
  reminders, exactly; 466/467 tool results filed next to their call.
- **Real opencode db** (3.4 MB): 79 turns, 57 thinking blocks, 98/101 results paired. The two
  guesses flagged in the drop were both confirmed against the live schema (`state.input` /
  `state.output`, `reasoning.text`) — and `session.model` is a JSON blob, not a string.
- **A real STS bundle** produced by `scripts/share-session.mjs` and read back through
  `readTraceBundle()` — which is how an accepted trace will arrive.
- **codex / openclaw / hermes fixtures** built from the shapes in `parseCodex` and
  `share-session.mjs`'s converters. Hermes's seconds-not-milliseconds timestamps render as
  correct dates; codex guardian rollouts are refused with `trace-not-user-conversation`.
- **Headless Chromium over CDP** (no playwright in this image) against the built bundle, for
  each harness: pane mounts, header reads
  `Claude Code | claude-opus-5 | 555 turns | 1,840,279↓ 398,440↑ (138,147,880 cached)`,
  **14 rows in the DOM for 555 turns**, folds open, scrolling to 70 % pages in with no
  placeholders left, search reports what it searched, zero JS exceptions.
- Refusals render as sentences, not failures: an unsupported CLI, a missing transcript, a
  guardian rollout, a missing bundle. Bad bundle refs are rejected at write *and* read.

### Two bugs this testing caught that a curl check would not

- A bundle manifest stores `harness` as an **object** (`{id,name,version}`) while an STS
  session line stores a **string**. Both reach `harnessLabel`, which the header renders
  directly — React throws on an object child. Hence `label()`.
- Claude sessions had **no token total** in the header: usage is per-message there, so the
  session sum has to be accumulated (`usageSum`), while codex and the db-backed harnesses
  keep their own authoritative total.

### Not done

- Fork / Handoff are header slots only (design doc §8).
- Search is client-side over fetched turns and says so; server-side wants a `?q=` returning
  matching offsets — a small addition to `pageOf()`.
- No `compaction` block is ever produced; Claude's `type:'summary'` / `system` lines and
  `attachment` lines are ignored. The block type exists for when that's wired up.
- The incoming half (accept/decline on an inbox PR) is **out of scope** as of 2026-07-29 —
  see the scope note at the top of `docs/session-sharing.md`. A `bundle` source is populated
  by pasting a dataset URL into the sidebar's **Trace** button, which is the intended flow.

## 12. Comparison against the Hub's own viewer (2026-07-29)

Done on a real private share, `thomwolf/codex-session-019fac81`, by rendering the Hub's
Trace tab in headless Chromium and scraping it in document order, then taking an
independent census of the 393-line file so the arbiter was the data rather than either
renderer. Reproduce with `Network.setExtraHTTPHeaders` carrying a bearer token — the Hub
serves the blob page and its viewer with one.

Findings are in §11's list and in commit `08714a5`. What is worth keeping here:

**Both agree on totals, not on attribution.** The Hub's first assistant row claims
`16 tool calls (exec_command, apply_patch, write_stdin)` and then exactly `1 tool call`
for each of the next five turns. The file has 2, 2, 1, 3, 6, 7 between successive
assistant texts. Both sum to 21, so nothing is lost — but the per-turn attribution
differs, and the file backs ours. Its first row's token figure (`354↑`, `31,488 cached`)
is likewise the *last* model call of that task shown on the task's *first* row.

**The Hub has no System or Developer row type.** Measured: `System: 0, Developer: 0`
across the rendered window. It shows `<recommended_plugins>` as a User turn, expanded as
markdown, and omits codex's seven `role:'developer'` messages entirely.

**Two streams, and the same content in both.** This is the single most important thing
about the codex format and it is documented at `normalizeCodex` in `traces.js`:
`response_item` is what went to and from the model, `event_msg` is what the TUI showed.
`agent_message` duplicates the assistant `response_item`s exactly; `agent_reasoning`
arrives *first* and repeats what a later `reasoning` item's summary entries contain, so
dedupe per ENTRY, not per joined string; and web searches exist ONLY as `web_search_end`.

**Encrypted reasoning is normal.** 49 of 56 reasoning items carried only
`encrypted_content`. Say so in the UI; do not leave the impression the model didn't think.
