# Session sharing — design

Status: **decisions locked, ready to build** · Scope: phase 1 = traces only · Last updated: 2026-07-26

Share one agent session with a teammate: they get a banner, accept it, read it in a panel,
then *fork* it into their own Agent Manager and keep working.

## 1. Decisions (locked)

| Question | Decision |
|---|---|
| Share unit | **One HF dataset repo per session.** |
| Payload | **Trace only.** No workspace files, no harness context (skills/CLAUDE.md/MCP) in phase 1. |
| Harnesses | **All five.** Claude Code and Codex ship *verbatim* (Hub-native). Hermes, opencode and OpenClaw are converted to the Hub's documented **STS-Format**. |
| **Transport** | **Hub-mediated mailbox.** Delivery is a pull request on the recipient's public `am-inbox` dataset. Direct Space→Space HTTP is ruled out — see §5. |
| **Access control** | **One code path.** Always a payload dataset; `public` or `gated` is a flag. Gated + `grant_access` is the ACL for private shares. |
| **Sender allowlist** | **Whitelist, empty by default.** Nobody can send you anything until you add them. |
| Viewer | **Our own trace panel** (`cli: 'trace'`), visually inspired by the Hub viewer, built on `traces.js`. *Reverses an earlier decision — see §5.* |
| Cross-harness | **Briefing handoff**, not transcript translation, wrapped in a data envelope that is never auto-fed to an agent. |
| Recipient | **A teammate with their own Agent Manager Space.** |

The access-control decision collapses what used to be two flows into one: a share **always**
produces a payload dataset and the only difference between public and private is that
repo's visibility. Delivery to a recipient is an independent, optional step using the same
mechanism either way.

## 2. What we already have

`server/src/traces.js` already reads every harness we support, in production, with
mtime memoization, WAL awareness and torn-read tolerance:

| Harness | Store | Session identity | Parser |
|---|---|---|---|
| Claude Code | JSONL, append-only | `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<uuid>.jsonl` — filename **is** the id | `parseClaude` (`traces.js:88`) |
| Codex | JSONL rollout | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | `parseCodex` (`traces.js:150`) |
| OpenClaw | JSONL | `~/.openclaw/agents/<agent>/sessions/<uuid>.jsonl` | `parseOpenClaw` (`traces.js:250`) |
| opencode | **SQLite (WAL)** | `session`/`message`/`part` tables, `ses_…` ids | `readOpencode` (`traces.js:337`) |
| Hermes | **SQLite (WAL)** | `~/.hermes/state.db`, `sessions`/`messages` | `readHermes` (`traces.js:436`) |

The **file vs database** split drives most of the design:

- **JSONL harnesses**: a session *is* a file. Freezing = copy. Import = place the file.
- **SQLite harnesses**: a session is a *query*, and the DB is shared by every session
  on the machine. It must be **extracted**, never copied wholesale — `opencode.db`
  contains `account.access_token`, `account.refresh_token` and a `credential` table.
  **Shipping the raw DB would ship the user's OAuth tokens.** Hard rule, no exceptions.

`sessions.js` and `runner.js` already do most of what import needs, for free:

- `sessions.create()` mints a per-session `sessionUuid` (`sessions.js:70`) — the same
  id Claude uses for its transcript filename.
- `commandFor()` decides resume-vs-fresh by **whether the transcript exists on disk**
  (`runner.js:294-300`), not by a stored flag. Drop an imported transcript into place,
  set `sessionUuid`, and the existing launch path resumes it with no new code.
- Codex is the same shape via `codexSessionId` + `codexRollout` (`runner.js:319-321`), and
  as of `1dfb753` **opencode too**, via `opencodeSessionId`. Three of the five harnesses now
  carry a per-session conversation pin that import can simply set.
- opencode's and Hermes' SQLite live on **local disk via symlink** (also `1dfb753`), with a
  durable copy synced to the bucket every 60s — because a synchronous read of a FUSE-backed
  sqlite could stall the event loop and freeze the whole server. Extraction still goes
  through `opencodeDbPath()`, so §6 is unaffected, but **never** read these DBs
  synchronously on a request path.

## 3. Verified Hub behaviour

Everything below was checked against the live Hub on 2026-07-26, not inferred from docs.

**Format detection is automatic.** Upload raw session `.jsonl` files and the Hub tags
the dataset `format:agent-traces` and shows a `Traces` badge. Natively understood
harnesses: Claude Code, Codex, Pi, Hermes, Factory Droid. Custom harnesses can emit
[STS-Format](https://huggingface.co/docs/hub/session-traces-format).

**One `.jsonl` file becomes one row.** The Hub aggregates a whole session file into a
single row and derives columns: `harness`, `session_id`, `prompt`, `messages`, `tools`,
`metadata`, `sent_at`, `num_user_messages`, `num_tool_calls`, `trace`, `file_path`.
One repo per session therefore yields exactly **one row, always `row=0`**.

**The trace viewer is embeddable and deep-linkable.** No longer load-bearing for us — the
panel is ours (§8) — but this is what a public share gets for free in a browser:

```
https://huggingface.co/datasets/<ns>/<name>/embed/viewer/default/train?row=0
```

in an iframe renders the **full session viewer** — user/assistant turns, model name,
token counts (in/out/cached), collapsible thinking blocks, rendered markdown and
tables, plus prev/next navigation. Not just the tabular grid; the actual trace UI.

Reference layout that works (`TeichAI/DeepSeek-v4-Pro-Agent`): raw `*.jsonl` at repo
root plus a `configs` pin in the card:

```yaml
configs:
  - config_name: default
    data_files:
      - split: train
        path: "*.jsonl"
```

**Two constraints that shape the access model:**

1. **You cannot add a collaborator to a user-owned private dataset.** Private repos
   under a personal namespace are single-user. Sharing privately *requires an
   organization* (or gating a public repo). See
   [access control in organizations](https://huggingface.co/docs/hub/en/organizations-security).
2. **The dataset viewer on private datasets requires PRO, Team or Enterprise.** A
   free-tier teammate looking at a private session dataset gets no viewer at all.

## 4. Share unit: one dataset repo per session

```
<namespace>/am-session-<slug>-<shortid>
├── README.md            # dataset card: YAML (configs, tags, pretty_name) + human summary
├── <session-uuid>.jsonl # the session, in a Hub-native trace format
└── meta/
    ├── manifest.json    # machine-readable provenance + lineage
    ├── briefing.md      # generated handoff summary (see §8)
    └── redaction.json   # what was stripped, by which rule
```

**Keep the harness's native filename** — `<uuid>.jsonl` for Claude,
`rollout-<ts>-<uuid>.jsonl` for Codex — and glob it with `data_files: "*.jsonl"`. Every
working trace dataset in the wild does this (`armand0e/claude-fable-5-claude-code` holds
2 MB Claude transcripts named `<uuid>.jsonl` and renders fine). A generic `trace.jsonl`
was the first thing we tried and it is not the ecosystem convention; the filename is also
the only place the session id survives if the manifest is ever lost.

Non-trace files live under `meta/`, which the `*.jsonl` glob cannot reach, so nothing else
can be pulled into the data config and collide on schema.

The trace file is **whatever Hub-native format the source harness produces**:

| Source | Trace file contents | Fidelity |
|---|---|---|
| Claude Code | the original transcript, verbatim | lossless |
| Codex | the original rollout, verbatim | lossless |
| Hermes | `hermes sessions export --format trace` (already emits Claude-Code JSONL for this exact viewer) | near-lossless |
| opencode | extracted from SQLite → Claude-Code-shaped JSONL | lossy |
| OpenClaw | converted → Claude-Code-shaped JSONL | lossy |

Claude Code JSONL is the de facto lingua franca — Hermes already converts *to* it
rather than to STS-Format. We follow that precedent.

`meta/manifest.json`:

```json
{
  "schema": "am-session-share/1",
  "harness": { "id": "claude", "version": "2.1.220" },
  "session": { "id": "<am session id>", "uuid": "<sessionUuid>", "name": "…", "model": "…" },
  "origin": { "user": "thomwolf", "space": "<space id>", "cwdSlug": "-data-workspaces-Agent-manager" },
  "trace": { "path": "trace.jsonl", "nativePath": "projects/<cwd-slug>/<uuid>.jsonl",
             "sha256": "…", "lines": 1234, "converted": false },
  "stats": { "turns": 0, "prompts": 0, "toolCalls": 0, "tokensIn": 0, "tokensOut": 0,
             "firstTs": 0, "lastTs": 0 },
  "redaction": { "ruleset": "1", "hits": 0, "blocked": false },
  "lineage": { "parent": null }
}
```

`nativePath` is what makes import mechanical: it says exactly where the file belongs in
the target harness's store. `lineage.parent` records `<repo>@<sha>` when this session was
itself forked from a share — giving a lineage graph across people, for free.

**Freezing** is the git commit sha. A share link pins it; the dataset is never rewritten
in place. Re-sharing a session that has since advanced creates a **new commit**, so the
old link keeps showing exactly what the recipient was told to look at.

## 5. Transport and access model

### Why not direct Space-to-Space HTTP

The obvious design — AM A `POST`s a trace to AM B — is ruled out by this app's own security
model, not by convenience:

- `visibility.js` states it plainly: the app "has no authentication, so it must only run a
  usable terminal backend when BOTH the Space and its mounted bucket(s) are PRIVATE."
  `index.js:140` 403s every `/api/*` when the Space is public, and `/ws` refuses too.
- So **a usable AM is always private**, and its API is unreachable from the internet.
- And anyone who *could* reach `/api/*` would have `POST /api/sessions/:id/input` —
  **a shell**. Granting a sender enough Space access to deliver a trace grants them the
  machine. There is no narrow version of that permission.

A private Space can only make **outbound** calls. So the mailbox is Hub-mediated, and both
sides only ever talk to huggingface.co.

### Delivery: a pull request on the recipient's inbox

| Piece | What it is |
|---|---|
| **Inbox** | `<recipient>/am-inbox`, a small **public** dataset. Its existence *is* the opt-in — no repo, nobody can send you anything, enforced by the Hub. |
| **Delivery** | The sender opens a **pull request** adding `incoming/<envelope-id>.json`. Anyone HF-authenticated can open a PR without write access; the author is Hub-authenticated identity that cannot be forged. ✅ **Implemented** — `notifyRecipients()` in `share.js`, via `POST /api/datasets/<inbox>/commit/main?create_pr=1` with an NDJSON body. Verified end to end. |
| **Accept** | `merge_pull_request` |
| **Decline** | `change_discussion_status(..., 'closed')` with a comment |
| **Payload** | A separate dataset owned by the **sender**, `public` or `gated`. |

The recipient polls `get_repo_discussions(repo_id, discussion_type='pull_request',
discussion_status='open')` and matches authors against the whitelist.

Recipients apply to **both** visibilities, meaning different things: a gated share grants
them access *and* notifies; a public share has nothing to grant, so it only notifies. That
is why the username box stays visible in public mode.

**Envelope metadata is minimized** because the inbox is public: sender, timestamp, payload
repo id, size, and `kind`. No session title, no stats, no prompts — those live inside the
payload and surface only after accept. Payload repos get opaque names (`am-trace-<uuid>`).

> **Deferred fallback.** If the residual leak (who sent whom, when) proves too much, the
> alternative is a shared public relay Space holding the mailbox. Explicitly **not** doing
> this now: it is another piece of infrastructure to build, secure and keep running.

### One path for public and private

A share always produces a payload dataset; visibility is a flag on it.

| Mode | Payload repo | Who can read it |
|---|---|---|
| Public | public dataset | anyone; the Hub trace viewer also renders it |
| Private | **gated** dataset + `grant_access(recipient)` | only granted users, via authenticated download |

Gating is used here as a **transport ACL, not a viewer entry point.** It does block the Hub
dataset viewer — the anonymous datasets-server reports a gated repo as *"does not exist, or
is not accessible without authentication"* — but authenticated `hf_hub_download` works
fine, and the private path renders in our own panel anyway (§9). Rejecting gated for its
viewer behaviour and then using it for access control is deliberate, not a contradiction.

This is also why we don't use org-owned private repos: they'd need a second code path, and
org membership can't be granted from here (below).

### Pre-authorizing a teammate (the part we can automate)

`HfApi.grant_access` adds a user straight to the **accepted** list — they never have to
request anything, and never see the gate form:

```python
api.update_repo_settings(repo_id=REPO, repo_type="dataset", gated="manual")
api.grant_access(REPO, "teammate-username", repo_type="dataset")
```

Verified against `thomwolf/am-session-sharing-design-gated` on 2026-07-26: the endpoint is
`POST /api/datasets/<repo>/user-access-request/grant` with `{"user": …}`; a probe for a
nonexistent user returns **404** (not 403), confirming the Space token has write rights to
drive this. Errors are usefully specific — 400 not-gated, 400 already-has-access,
403 read-only token, 404 no-such-user.

Use `gated="manual"`, not `"auto"`. Under `"auto"` anyone who accepts the terms gets in, so
pre-granting is pointless; under `"manual"` the accepted list *is* the ACL. Revoke with
`cancel_access_request` / `reject_access_request`, and audit with
`list_accepted_access_requests` / `list_pending_access_requests` — the latter is how the
share dialog can show "3 people have access, 1 waiting".

**This is the asymmetry that should drive the default.** The Hub exposes
`list_organization_members` but **no API to add one** — org membership is an out-of-band
human invite. So:

| Mode | Can Agent Manager grant access itself? |
|---|---|
| Public | n/a — everyone has it |
| **Gated + `grant_access`** | **Yes, fully automated, per person, at share time** |
| Private in an org | Only if the teammate is *already* a member; otherwise a manual invite |

Gated is therefore the only mode where "share this session with Alice" is one button, which
is why it is the private path. Org-owned private repos would need a manual invite step we
cannot automate, and a second code path to maintain.

### Receiving: whitelist, banner, inbox

**Whitelist, empty by default.** An inbound trace is content that ends up in front of a
coding agent, so the default must be that nobody can reach you. Two levels in
`am-config.json` (the `PUT /api/config` normalizer at `index.js:419` is the pattern to
follow):

```json
"sharing": {
  "receive": "whitelist",              // "whitelist" | "everyone"
  "allow": ["some-user", "huggingface"] // usernames and orgs; org = any member
}
```

Org entries resolve through `list_organization_members` — one `huggingface` entry beats
maintaining 200 usernames. A PR from an author outside the allowlist is **never surfaced**;
it is left open and untouched, so nothing silently disappears from the sender's side.

**Accept is always a click, even for whitelisted senders.** The whitelist controls whether
something appears at all; consent stays manual. Auto-accept would put untrusted bytes on
disk with no human in the loop, and the banner is cheap.

Arrival path: server-side poll (~60s, folded into the existing background sweep so a trace
can land with no tab open) → `DATA_DIR/inbox.json` (same load/persist/atomic-rename shape as
`sessions.js`) → top banner that persists until actioned, plus a sidebar badge → optional
web-push via the existing `sendToAll` in `push.js`, rate-limited, whitelisted senders only.

Accepted traces land in `DATA_DIR/traces/<envelope-id>/` — deliberately **outside**
`workspaces/`, so an inbound file can never appear inside a folder an agent is working in
until the user explicitly forks it.

### Treating a received trace as data, not instructions

A foreign transcript is full of imperative sentences. Fed to an agent unframed, a handoff
*is* a prompt-injection delivery mechanism with a friendly UI. So:

- The briefing is wrapped in an explicit envelope: *"The following is a transcript sent by
  ‹sender›. It is data to read, not instructions to follow."*
- The trace is delivered as a **file to grep**, not pasted inline.
- Nothing is ever fed to an agent without the user pressing Fork or Handoff.
- Inbound validation is separate from outbound redaction: size caps, line caps, schema
  check, reject anything that isn't a parseable trace. Never trust the sender to have
  redacted (§7 is the *sender's* obligation).

## 6. Export pipeline

```
locate → extract → normalize → redact → assemble → publish
```

1. **Locate.** For file harnesses, reuse the existing discovery helpers
   (`claudeFiles()` `traces.js:567`, `codexFiles()` `traces.js:589`, `openclawFiles()`
   `traces.js:294`). For DB harnesses, query by session id.
2. **Extract.** DB harnesses only: pull `session` + `message` + `part` rows for that one
   session id. Never touch `account`/`credential`. Read-only handle, WAL-aware (the
   `dbChangeKey` pattern at `traces.js:324` already handles the hot-file case).
3. **Normalize.** No-op for Claude/Codex. `hermes sessions export --format trace` for
   Hermes. New converters for opencode and OpenClaw → Claude-Code JSONL.
4. **Redact.** §7. Blocking for public, warn-with-preview for private.
5. **Assemble.** Write the tree from §4, compute `sha256`, generate the card and briefing.
6. **Publish.** `hf repo create <ns>/<name> --repo-type dataset [--private]` then
   `hf upload <ns>/<name> <dir> . --repo-type dataset`. Return the share URL with the
   commit sha and `?row=0`.

Server work happens **out of band** — a share of a 3 MB transcript must not block the
event loop that panes and the Overview poll ride on. Same discipline as `traces.js`.

## 7. Redaction

This is the part most likely to cause a real incident, so it is not optional.

Concrete leak vectors, all present on a live Space:

- **Credential stores next door**: `$CLAUDE_CONFIG_DIR/.credentials.json`,
  `$CODEX_HOME/auth.json`, opencode's `account`/`credential` tables.
- **Claude `file-history-snapshot` lines embed full file contents** — a transcript can
  carry a `.env` you never explicitly showed the agent.
- **Tool output** from any `env`, `cat .env`, `gh auth status`, or curl with a header.
- **Absolute paths** carrying usernames and internal project names.
- **This Space's own secrets**: `HF_TOKEN`, `HF_TOKEN_SAIR`.

Ruleset v1:

- Pattern rules for `hf_…`, `sk-ant-…`, `gho_/ghp_/ghs_…`, `AKIA…`, `AIza…`, JWTs,
  `-----BEGIN … PRIVATE KEY-----`.
- **Value rules**: every non-empty env var whose name matches
  `/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/`, matched by *value* against the trace.
  This catches secrets that don't look like secrets.
- Drop `file-history-snapshot` lines entirely in phase 1. They are large, they are the
  worst leak vector, and the viewer does not render them.
- Replace hits with `«redacted:RULE»` and count them in `meta/redaction.json`.
- **Run every derived artifact through the same pass.** `meta/briefing.md` quotes user
  prompts verbatim and the card quotes the session title, so redacting only the trace
  leaks precisely what the trace hid. The first run of the prototype did exactly this: the
  trace was clean while the briefing still carried a personal email address.

Gate: **public share blocks on any hit.** Private share warns and shows a diff preview
before publishing. Prior art worth copying: Hermes' `--redact`, and
[`pi-share-hf`](https://github.com/badlogic/pi-share-hf) (TruffleHog + LLM review,
upload only if clean). An optional LLM review pass is a natural phase-3 addition.

## 8. Import: view, fork, handoff

Recipient pastes a dataset URL or `<ns>/<name>` into Agent Manager. Three outcomes,
labelled honestly so nobody is surprised by fidelity:

**View** — a new pane type `cli: 'trace'`, modelled on the existing passive `files` pane
(already a non-process pane: `config.js:66` registers it with `bin: null, run: null`,
`runner.js:135` short-circuits its state, `App.tsx:420` dispatches it with one ternary,
and `FilesPane.tsx` is 181 lines). Rendering is **ours**, built on the `traces.js` parsers,
visually inspired by the Hub viewer.

**This reverses the earlier "lean on the HF viewer" decision.** Two findings forced it:

1. The Hub viewer **will not render a gated repo** — and gated is the private path (§5).
2. Viewer processing on a fresh dataset took **~50 minutes** (§11 risk 5). An inbox that
   shows nothing for an hour is not an inbox.

v1 scope: turns, tool calls collapsed by default, thinking blocks collapsed, token counts,
search. Skip statistics and prev/next. **Virtualize the message list from the start** — the
one-repo-per-session choice concentrates a whole session into a single 2.13 MB row, and the
Hub's own viewer failed to render ours at that size (§11 risk 7).

The Hub viewer stays useful for *public* shares opened in a browser by someone without an
Agent Manager. It is no longer load-bearing for us.

**Fork (same harness)** — faithful, and mostly already built:

| Harness | Import | Launch |
|---|---|---|
| Claude | rewrite `cwd`/`gitBranch` per line → write to `projects/<slug(new cwd)>/<newuuid>.jsonl` | existing `--resume` branch (`runner.js:299`) |
| Codex | place rollout under `$CODEX_HOME/sessions/<Y>/<M>/<D>/` | `codex fork <id>` — prefer **fork** over resume so the shared original stays pristine |
| opencode | `opencode import <file or URL>` — accepts a URL directly | `--session <id> --fork`, then pin `opencodeSessionId` |
| Hermes | `hermes import` | `--resume <id>` |
| OpenClaw | place under `agents/<agent>/sessions/<uuid>.jsonl` | — |

Import **always copies**; it never resumes a file in place. `claude --resume` *appends to
the transcript*, so resuming the shared artifact would mutate the thing that was supposed
to be frozen.

Path rewriting is best-effort: `cwd` and `gitBranch` are per-line fields we can rewrite
cleanly, but absolute paths inside tool inputs and outputs cannot be. Leave them and say
so in the briefing — the agent reads them as history, not as instructions.

**Handoff (cross-harness)** — deliberately *not* transcript translation. Prompts,
answers and tool names would survive a format conversion, but tool namespaces don't
(`Edit`/`Bash`/`TodoWrite` vs `apply_patch`/`local_shell_call` vs opencode's set), and
neither do reasoning blocks, permission modes, available skills/MCP, or the system prompt.
The result is a plausible history the target agent cannot act on coherently, because it
"remembers" calling tools it does not have.

Instead: generate `meta/briefing.md` at export time — task, decisions made, files
touched, current state, open threads — and on import feed it as the opening prompt while
placing the full trace in the workspace as a greppable file. The agent gets an accurate
summary plus the ability to look up any detail on demand.

We already have the machinery. The digest builder in `traces.js` (`digestPrompt`,
`digestTool`, `sinceFiles`, `turnsLog`, `digestFor()` at `traces.js:765`) is a briefing
generator wearing a different hat.

## 9. UI surface

- **Share** — session context menu → dialog: visibility (public / private-gated), recipients,
  redaction report, publish. On success: copyable link, and the session records
  `lastShare: { repo, sha, sentTo[] }`.
- **Inbox banner** — persists until actioned, with Accept / Decline and the sender's name.
  Sidebar carries a badge.
- **Trace panel** — `cli: 'trace'`, our renderer, with Fork and Handoff buttons in it.
- **Settings → Sharing** — receive level (`whitelist` | `everyone`), the allowlist, and an
  "enable receiving" toggle that creates or deletes the `am-inbox` repo.

## 10. Server API sketch

```
POST /api/sessions/:id/share      { visibility: 'public'|'gated', name?, sendTo?: string[] }
                                  → { repo, sha, url, redaction, granted[], delivered[] }
GET  /api/share/preview?repo=…    → manifest + stats (no download of the full trace)
POST /api/share/access            { repo, grant?: string[], revoke?: string[] }
                                  → { accepted[], pending[] }
GET  /api/inbox                   → [{ id, from, ts, repo, size, status }]
POST /api/inbox/:id/accept        → { sessionId }   # merge PR, download, create trace panel
POST /api/inbox/:id/decline       → { ok }          # close PR with a comment
POST /api/share/import            { repo, sha?, mode: view|fork|handoff, path, cli? } → { sessionId }
```

`sendTo` makes sharing one action: publish gated, `grant_access` each recipient, then open
the delivery PR on each of their inboxes — in one request. `/api/share/access` backs a "who
can see this" panel on an existing share.

Auth uses the Space's existing `HF_TOKEN`. Note `visibility.js` already deals with a stale
`HF_TOKEN` wedging a private Space (commit `4567fd6`) — reuse that hardening rather than
adding a second token path.

## 11. Risks and open questions

1. ~~Can a non-collaborator open a PR on someone else's dataset?~~ **Confirmed possible**
   (manually verified by @thomwolf, 2026-07-26). The transport assumption holds; the API is
   `create_discussion(pull_request=True)` / `create_commit(create_pr=True)`.
2. **Does the receiving user's `HF_TOKEN` see PRs on their own repo?** `get_repo_discussions`
   must list PRs opened by others. Very likely fine given (1); confirm in Phase 3 when the
   poll is written, not as a blocker.
3. **Repo sprawl** — one dataset per session could mean hundreds of repos, now multiplied by
   recipients. Mitigation: a naming convention plus a Collection per project. Revisit if it
   bites.
4. ~~Inbox spam~~ — **not a design risk.** Anti-abuse for PRs is the Hub's job, and the
   whitelist means a non-whitelisted flood never reaches the banner, the sidebar badge or
   web-push; it just sits in the repo. A *whitelisted* sender abusing the channel is a
   social problem, solved by removing them from the allowlist.
   The one thing this leaves us is an **implementation** requirement: bound the poll.
   `get_repo_discussions` pays for pagination on every cycle, so scan only PRs newer than a
   stored last-seen cursor, with a page cap — wanted anyway at a 60s cadence.
5. ~~Viewer processing latency~~ — **no longer blocking**, since the panel is ours. Kept for
   the record because it is why: **viewer processing on a fresh repo is not instant.**
   Measured 2026-07-26: three brand-new dataset repos sat at *"the response is not ready
   yet"* for **>30 minutes**, while established trace datasets return
   `{"viewer":true}` immediately. Ruled out as causes: file naming (renaming to
   `<uuid>.jsonl` changed nothing) and inline base64 images (a stripped 1.23 MB variant
   behaved identically). So the share flow **must not hand the user a link and claim it is
   readable.** It needs a "viewer still processing" state, and should point at the *Files*
   tab as the immediate fallback — that works from the first second.
6. **Large transcripts** — a 3.5 MB transcript exists on this Space today. Fine for upload;
   our panel must virtualize.
7. **One session per repo makes one very fat row.** Ours is **2.13 MB** in a single row, and
   the Hub's own session modal never rendered it (it renders `TeichAI`'s smaller rows fine).
   Cheap mitigations at export: strip inline base64 images and cap oversized tool results.
   Confirm against the `-noimg` control before deciding whether this is a real limit.
8. **Gemini CLI is unsupported** by both the Hub's detection and our own parsers, and is
   currently broken here anyway (§12). Out of scope.

## 12. Adjacent bug found while surveying

Gemini CLI is broken on this Space: `/data/home/.gemini/projects.json` is a **directory**
(containing `home`), so the CLI dies with
`Critical failure reading project registry: EISDIR: illegal operation on a directory, read`.
Same failure class as the opencode `opencode.json` bug that `runner.js:329-332` already
guards against — the FUSE bucket turning an atomic write into a directory. The existing
guard pattern (clear a directory-shaped entry, occupy the path with a real file) fixes it.
Unrelated to sharing; worth its own commit.

## 13. Phasing

**Phase 0 — verify the transport assumption.** ✅ Done — cross-account PRs confirmed
possible, so the mailbox design is cleared to build.

**Phase 1 — public sharing, Claude only.** Bundle assembler, redaction v1, publish, share
dialog. Exporter prototyped and working (§14, `scripts/share-session.mjs`); the share dialog
is the remaining piece. Ends with: a link you can hand anyone.

**Phase 2 — the trace panel.** `cli: 'trace'` reading a local bundle, built on `traces.js`.
Independently useful for reviewing your *own* archived sessions, and it lands before the
transport that needs it.

**Phase 3 — inbox and transport.** `am-inbox` repo, gated payload + `grant_access`, delivery
PR, server-side poll, banner, whitelist settings, accept/decline.

**Phase 4 — fork and handoff** from the panel. Path rewriting, session creation pinned to
the imported uuid, briefing generator on the existing digest code, envelope framing.

**Phase 5 — the other harnesses.** ✅ **Done, all five.** Claude and Codex ship verbatim.
Hermes, opencode and OpenClaw are converted to
[STS-Format](https://huggingface.co/docs/hub/session-traces-format) — the documented path
for a custom harness, and a much smaller target than hand-rolling Claude JSONL. The two
SQLite harnesses are read by selecting **one conversation**, never by copying the db
(opencode's holds OAuth tokens, §2). Hermes has no per-session pin, so it is attributed by
recorded cwd with the usual ambiguity guard; opencode uses the `opencodeSessionId` pin
runner.js captures, falling back to cwd.

Phases 1 and 2 are each shippable alone. Phase 3 is the one that needs Phase 0 to pass.

## 14. Reference examples

Published 2026-07-26 from *this* session by the phase-1 prototype
(`share-session.mjs`: locate → redact → assemble, then `huggingface_hub` publish).

| Repo | Access | Notes |
|---|---|---|
| [`thomwolf/am-session-sharing-design`](https://huggingface.co/datasets/thomwolf/am-session-sharing-design) | public | the reference public share |
| [`thomwolf/am-session-sharing-design-gated`](https://huggingface.co/datasets/thomwolf/am-session-sharing-design-gated) | `gated="auto"` | gate UI verified logged-out |
| [`thomwolf/am-session-sharing-design-noimg`](https://huggingface.co/datasets/thomwolf/am-session-sharing-design-noimg) | public | images stripped; a control for risk (5) |

What the run established:

- **The export pipeline works end to end.** 221 transcript lines → 213 published, 8
  `file-history-*` lines dropped, 7 email redactions, **zero secret matches** (pattern rules
  and env-value rules both clean). Card, manifest, briefing and redaction report generated.
- **Gating works and looks right.** A logged-out visitor gets *"This repository is publicly
  accessible, but you have to accept the conditions to access its files and content"* with
  our `extra_gated_prompt`, above a fully visible card. Contents protected, metadata public
  — exactly the trade-off §5 describes.
- **The trace viewer had not finished processing** any of the three at time of writing; see
  risk (5). The gated one additionally is invisible to the anonymous datasets-server.
- **Publishing internal-looking content needs a provenance check, not a vibe.** This
  transcript quotes ~1,200 lines of `server/src`, which looked like an INTERNAL-repo leak
  until the files were diffed against the public template Space and found byte-identical.
  The export flow should make that check explicit rather than leaving it to judgement.
