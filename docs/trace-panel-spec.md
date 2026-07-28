# Trace panel — implementation spec

Status: **ready to build** · Branch: `worktree-session-sharing` · PR: huggingface/agent-manager#8

A handoff document. Everything here was verified against this codebase and the live Hub on
2026-07-27/28. Read `docs/session-sharing.md` for the wider design; this file is only the
panel, and is written to be self-contained.

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
- Live data is on **local disk via a symlink** with a durable copy synced to the bucket
  (commit `1dfb753`), precisely because a synchronous read of a FUSE-backed sqlite froze the
  whole server. Open **read-only**, and never on a hot path.

### Hermes — **SQLite**, `~/.hermes/state.db`
- `sessions(id, cwd, title, started_at, input_tokens, output_tokens, cache_read_tokens)`
- `messages(id, session_id, role, content, timestamp, tool_name, token_count, active)` —
  flat `content`; a row with `tool_name` set is a tool interaction. `timestamp` is **seconds**
  (multiply by 1000). Same FUSE/symlink note as opencode.
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
