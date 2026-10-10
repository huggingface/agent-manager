# Codex thread bindings and shared-client pilot

This implements the first execution slice of the [shared-session plan](proposals/codex-shared-next-steps.md).
An existing AM Codex session can be associated with its exact thread after that
thread has been handed off to the configured Codex server. A thread already on
that server can also be added as a new AM view. Opening its AM
terminal then launches a client of that server. A tool running inside the
thread can recover AM attribution from `CODEX_THREAD_ID`, including after AM
restarts. No `AM_ID` override is needed in the Codex server.

This is an **isolated pilot**, not automatic legacy migration or default shared
creation. Binding writes require `AM_CODEX_BINDINGS_PILOT=1`. The installation's
normal sessions retain their existing behavior. The read-only Settings preview
continues to report `launchEnabled: false` because default shared creation is
not implemented yet.

## Configure an isolated pilot

Use a separate AM `DATA_DIR`, port, HOME and Codex home. Configure the existing
pilot server through the same `AM_CODEX_SHARED_SOCKET` and
`AM_CODEX_SHARED_HOME` variables as the [observer](codex-shared-preview.md),
plus `AM_CODEX_BINDINGS_PILOT=1`. Do not point the test instance at production
AM data or migrate working sessions to exercise this feature.

The binding route below accepts only an **existing exact AM Codex pin**. The old AM
terminal must already be stopped, with no queued prompt or images. The thread
must already be loaded and idle on the verified server, in the exact same
resolved workspace. Ambiguous AM pins, a wrong server home, unsafe socket
permissions, changed sessions and failed persistence all refuse the operation.

```sh
curl --fail-with-body "http://127.0.0.1:7861/api/sessions/AM_SESSION_ID/codex/binding" \
  -H 'X-AM-Request: 1' -H 'X-AM-Origin: operator' \
  -H 'Content-Type: application/json' \
  --data '{"threadId":"EXACT_CODEX_UUID","expectedRevision":0}'
```

The API **does not release or resume the thread**. `/quit` and the initial
server-side resume remain manual for this slice, after verifying the specific
old TUI is idle. The ownership-bound preview/confirmation/release coordinator
is still planned; this endpoint is not a replacement for it. No process is
signalled and no Codex lock or history file is modified by the binding route.

After binding, opening the normal AM terminal runs the shared client. A TUI
can also be opened from tmux/mosh with the helper below. The helper looks up
an exact AM ID or an unambiguous display name, verifies the endpoint and
thread through AM, then launches `codex --remote unix://… resume EXACT_UUID`
without a shell. A changed or unavailable endpoint fails; it never falls back
to a standalone writer, `--last`, or a fresh thread.

## Add an existing shared task to AM

In Settings → Codex multi-device preview, check the server and use **Add to AM**
on an idle task. This adds a session-list entry without starting another agent,
copying its history or sending a prompt. Open the entry to join the same
conversation that is available from a phone or another terminal.

The equivalent API is:

```sh
curl --fail-with-body http://127.0.0.1:7861/api/codex/import \
  -H 'X-AM-Request: 1' -H 'X-AM-Origin: operator' \
  -H 'Content-Type: application/json' --data '{"threadId":"EXACT_CODEX_UUID"}'
```

It requires the same pilot flag, an idle loaded root thread accepting direct
input, and a resolved cwd within AM's configured workspace root. A legacy AM
pin refuses import and must follow the existing handoff path. Repeated imports
return the same AM view. Archived views are not reactivated automatically.

A new reference is durably saved with `codexSharedOnly` before binding. If the
second write fails, that pending reference cannot launch a standalone TUI,
receive managed prompt delivery or revive at boot. Retry the import after
resolving the failure; it completes the existing reference rather than creating
a duplicate. Shared views display a **Shared** label and support Reader in
interactive mode. The reader resolves the exact durable binding through a bounded
`thread/read` metadata call, validates the returned rollout header and path
inside the configured Codex home, and uses the existing paged transcript and
search APIs. It never loads a thread, attaches a TUI or falls back to a newer
conversation with the same working directory. An unavailable server or invalid
binding shows a retryable error. Live refresh follows the original rollout;
there is no copied history.

The Reader composer sends text to the bound native thread through `turn/start`.
It attaches only an already loaded task, passes no model, sandbox or approval
settings overrides, and refuses input while the task is busy. It never types
into or creates a terminal. Images and documents use the existing AM upload controls.
A message ID is saved before sending; private durable receipts prevent replay
after a lost response or AM restart. An uncertain acknowledgement requires
checking the transcript, rather than automatically submitting another turn.

Opening the interactive Reader subscribes to the loaded task. The backend adapts
server events to the existing Reader blocks and input-required controls; there
is no separate connection button or live response panel. Approval buttons allow only one-time accept/deny;
unsupported requests and persistent permission changes stay in Terminal/Remote.
Requests answered elsewhere disappear. Browser disconnection does not approve
anything or stop the task. These controls use the existing private deployment,
operator-intent, privacy-lock and exact-binding checks; they are not a new
public authentication boundary.

For an isolated host pilot, `AM_WORKSPACES_DIR` may select an existing absolute
project root without moving files or sharing production AM data. This is an
administrator setting, not an API input. All resolved workspace checks still
apply; escaping symlinks are refused. Skills remain under
`DATA_DIR/workspaces/skills`, so booting a pilot does not install generated
skills in the existing project. `AM_BIND_HOST=127.0.0.1` restricts the listener
to loopback; any private reverse proxy needs an exact `AM_ALLOWED_ORIGINS`
entry. Do not replace the existing AM listener or restart its live terminals
to run this pilot.

## AM attribution from any Codex client

Create `~/.config/agent-manager/codex-context.json` in the account running
Codex tools, with an administrator-chosen local AM address:

```json
{"baseUrl":"http://127.0.0.1:7861"}
```

From a Codex tool shell:

```sh
node /path/to/agent-manager/scripts/am-codex-context.mjs resolve
node /path/to/agent-manager/scripts/am-codex-context.mjs resolve --id-only
```

The helper reads `CODEX_THREAD_ID`; a missing/unmapped ID fails explicitly.
It does not fall back to an inherited `AM_ID`, title, current directory or
most-recent conversation. `--id-only` supplies the existing AM `?from=`
attribution; access still uses the ordinary private API admission/privacy
checks. Attribution is not authentication. The helper does not send any AM
mutation by itself. Configuration accepts loopback HTTP only; redirects are
refused. `--config FILE` selects another explicit configuration.

From a regular tmux/mosh shell:

```sh
node /path/to/agent-manager/scripts/am-codex-context.mjs tui microduck
```

AM invokes the same helper using its own explicit `--base-url`; no config file
is required for AM's terminal path. The child TUI drops inherited `AM_*` and
`CODEX_THREAD_ID` variables. The server supplies the native identity to tools.

## Persistence and lifecycle

`DATA_DIR/codex-bindings.json` is the authoritative versioned association file;
back it up together with `sessions.json` and the Codex home/history. It stores
AM ID and incarnation UUID, exact thread UUID, endpoint identity, resolved CWD,
revision and binding time. Endpoint identity hashes the OS UID, canonical
socket path and canonical Codex home. It survives socket inode replacement;
every client-target lookup repeats the live socket/home handshake.

Writes serialize with an exclusive file lock, validate uniqueness in both
directions, fsync a private temporary file, rename it atomically and fsync its
directory before acknowledging success. Exact retries are idempotent. A failed
write cannot be reported as a successful binding. Corrupt/unsupported state
fails closed. Filesystems must support these durability operations. A leftover
`.lock` after an AM crash blocks further binding writes but not context reads;
verify no AM writer is alive before an operator repairs it. No automatic lock
removal is implemented.

For bound sessions, standalone launch fallbacks and rollout-based repinning
are bypassed. AM boot does not revive their terminal clients. Closing a browser
view only detaches that view. Stopping AM closes its clients; the Codex server
is an independent process. Generic process stop/delete and managed agent/cron
prompt delivery refuse bound tasks. The existing operator input route selects
the shared adapter.

`POST /api/sessions/:id/interrupt` is operator-only and requires `{turnId}`.
It verifies the mapping, endpoint, workspace and currently active turn before
submitting that exact ID. Codex 0.162.1 also rejects a stale ID at submission,
closing the race with another client. It returns `{ok:true,requested:true,turnId}`;
completion is asynchronous. A refused/stale turn returns 409; uncertain transport
failure returns 503 with no automatic retry. It never kills a process.

Archive/unarchive atomically persist AM visibility only; neither calls native
thread/archive nor stops the TUI. The binding, native thread and conversation
remain intact. Archived tasks are read-only in AM; Restore re-enables interaction.
The sidebar hides destructive Delete for shared tasks. Explicitly closing a pane
evicts that browser view, while ordinary navigation retains the warm terminal.

`/new` and fork are not automatically associated with the old AM identity. A
new native ID is unmapped; the original durable mapping remains intact. The
Reader uses the verified shared transcript, and session/roster status is adapted from the server independently of the local terminal.
Overview digest content still relies on existing transcript extraction. Do not enable
this pilot as the production default yet.

## Validation

Run from `server/`:

```sh
node ../scripts/run-suites.mjs codex-reader codex-import codex-bindings codex-context codex-shared.test api-http api-boundary request-admission codex-repin revive
node test/codex-shared-pilot.test.mjs
node test/codex-reader-input-live.test.mjs
```

The manual pilot test requires the installed Codex CLI and local sockets. It
starts its own AM and Codex processes under fresh homes with a dummy provider,
creates a disposable thread, imports it idempotently, resolves AM identity from a native
Codex user-shell command, opens the actual AM terminal and checks the original
history. It then restarts only AM while a fixed shell command is running and
checks that server work completes and the binding survives. It cleans up only
its own children and files. No credentials, inference, Remote pairing or live
user threads are used.

Import was validated with Codex 0.162.1 (the earlier binding test used 0.162.0).
Ten targeted server suites, the web build and the Chromium mobile import test
passed. Import tests cover failed persistence, pending-reference recovery,
duplicates, archived views, outside-root paths, cancellation and privacy locks.
Reader input is additionally tested against a disposable Codex 0.162.1 server
and a local deterministic Responses fixture: real text turns, one-time command
approval, unchanged task settings, durable duplicate suppression and no TUI.
Browser tests cover mobile reply, draft recovery with the same message ID,
approval and question controls. No external inference calls are made.
The model-tool identity and cross-client approval checks are now covered by
`codex-reader-input-live.test.mjs`, including Reader questions and stale-answer
rejection. Concurrent AM submissions are serialized; an active external turn
rejects AM input. A simultaneous race to start an idle thread from different
native clients, actual phone approval routing, server crash recovery and
automatic shutdown of a legacy writer remain unproven. Those remain separate gates in the
plan; the test's active command is explicit `thread/shellCommand`, not a model
turn.

## Legacy handoff trial (Codex 0.162.0)

A separate VPS trial verified a legacy standalone TUI → graceful `/quit` →
`thread/resume` on the existing shared daemon → shared tmux client transition.
The disposable test used a fresh home, a dummy provider and a fixed shell
command, with no inference. Full paginated turn data matched before and after,
as did the explicitly supplied model, reasoning, approval and sandbox settings.
For this version, use **`--no-daemon`** when constructing a standalone fixture:
ordinary `codex` now defaults to the shared background server.

One eligible idle user task was subsequently transferred through the existing
external tmux handoff helper. Its root and child histories matched byte-for-byte
after canonical JSON serialization. The old shell pane survived; an adjacent
window joined the same UUID through `--remote`. Unrelated writer identities
were unchanged. This validates that standalone handoff boundary, not an AM
production rollout or phone-side approval handling.

Keep these gates for further migration:

- Verify the exact kernel writer PID and process start time, full owned-thread
  scope, idle turn state, pending inputs and an empty terminal composer.
- Read and explicitly preserve execution settings. An absent historical
  reasoning setting must not silently become a new server default; an ambiguous
  candidate was deferred in this trial.
- Hash all paginated history, release only the verified owner gracefully,
  resume the same UUID, then verify history, settings and shared ownership.
- Never restart an older production AM merely to activate bindings while it
  still owns live legacy TUIs. It does not know how to preserve their ownership
  or suppress standalone relaunch. AM migration still needs the integrated
  release/coordinator path and a nondisruptive rollout strategy.


See [conversation adapter and parity checks](conversation-adapter.md) for the
current UI-preserving integration and remaining on-device verification.


### Explicit recovery

`POST /api/sessions/:id/reconnect` requires operator origin and `{recoveryKey}`
from that session's presentation. It only reopens the already-bound saved task;
there is no daemon startup, new thread, input replay, or process signal. The
key covers binding identity and last persisted native settings. Archived,
changed, already-loaded, unsupported or ambiguous tasks are refused.

The installed 0.162.1 daemon does **not** reliably preserve a loaded thread's
sandbox through a bare cold resume: the disposable test changes read-only to
the workspace default. Recovery therefore restores the verified last-turn
settings explicitly and checks the result. A complete allowlist compares the
resolved restricted permission profile against the supported standard presets;
it does not reduce arbitrary permission profiles to a sandbox label. Loaded
resume ignores configuration overrides in this tested version, so a competing
client that already loaded the task is not reconfigured by the recovery RPC.
A mismatched returned configuration is rejected, without model input.

The existing transcript resolver first verifies the rollout path and header.
Recovery reads at most its last 8 MiB and requires a genuine `turn_context`
record for the native latest turn. Text containing JSON is not a context.
Missing context, partial writes and unsupported profiles fail closed. No
conversation or configuration is copied to a new thread.

The crash integration test kills only a disposable daemon. A local WebSocket
proxy drops the input acknowledgement after acceptance, then both daemon and
AM restart. The same request ID remains uncertain and cannot replay; a fresh
explicit prompt succeeds after reconnecting the same thread. Both supported
permission presets and unchanged bindings are verified with local inference.

### Pilot shared creation

With both `AM_CODEX_BINDINGS_PILOT=1` and `AM_CODEX_SHARED_CREATE=1`, the existing
operator New session and quick-start actions create Codex tasks through the
configured daemon. Other CLIs and installations without the flags keep their
existing creation path. Agent/cron Codex creation is explicitly refused in this
pilot, rather than silently launching a standalone writer.

The browser persists a request UUID under a content hash, without storing the
prompt. The server fsyncs intent before `thread/start`, saves the returned exact
ID, names the thread (materializing even an empty rollout on 0.162.1), and saves
the protected AM reference and binding before any prompt or TUI attachment.
Only cwd and `ephemeral:false` are passed at creation; daemon/project defaults
are preserved. Empty creation makes no model call. An initial prompt goes
through the existing durable input receipts, with the same request UUID.

Codex 0.162.1 has no creation idempotency parameter. If its acknowledgement is
lost, the receipt stays uncertain and retries cannot start another thread or
send the prompt, including after AM restarts. Inspect Shared Codex tasks and
import the exact ID after identifying it; never adopt a task by name, cwd or
recency automatically. A known returned ID survives later naming/binding errors.
The task and all originals are retained; there is no automatic deletion.

A never-used empty task has no last-turn settings record. Its name and native
identity survive daemon restart, but AM's restricted recovery does not guess
its configuration: reopen it through the native client after reviewing settings.
Once it has a supported persisted turn context, normal explicit AM recovery
applies. Production-wide defaults, agent/cron semantics and further migration
remain outside this pilot.

`codex-creation-live.test.mjs` uses isolated homes, a real Codex daemon and a
local deterministic provider. It covers empty creation, exact mapping, lost
native creation acknowledgement, AM restart/retry, one-time quick-start and
Reader → independent native client → Reader ordering. No user tasks or external
inference are used. This exercises the shared protocol, not the actual iPhone app.

### Reader ordering across clients

Live replacements retain their persisted native turn position instead of being
appended at the end. Persisted completion wins over an older live snapshot;
completion on any fetched history page retires its live cache. During cold
hydration, native item order is restored while preserving newer event values,
so a streamed answer cannot precede its own question. Regression fixtures cover
both reversed live turn arrival and deltas received during hydration. No
conversation files, timestamps or native histories are rewritten.

### Migrate an already stopped legacy AM session

This slice adds an explicit migration coordinator behind
`AM_CODEX_BINDINGS_PILOT=1` **and** `AM_CODEX_MIGRATION=1`. It runs in the AM that
owns the session record. It never edits another running manager's data files,
stops a TUI, signals a process, removes a lock, or starts a model turn.

```sh
node scripts/am-codex-migrate.mjs http://localhost:7862 preview 'Exact session name'
node scripts/am-codex-migrate.mjs http://localhost:7862 apply 'Exact session name' PREVIEW_KEY
```

Names must match exactly (case-insensitive) and uniquely; an AM session ID also
works. Preview uses `GET /api/sessions/:id/codex/migration`. Apply is the same
route with operator-origin POST and `{key}` from the current preview. A changed
session, history, endpoint or saved settings invalidates that key.

Requirements: the AM terminal is already closed, the exact native writer lock
is free, no queued AM or native input, no active goal, no ambiguous AM pin,
no active turn, and a supported complete persisted execution profile. Linux
`/proc/locks`, the owner's PID/start ticks and a nonblocking flock probe verify
ownership; Python's standard library reads discovered queue/goal schemas with
SQLite read-only mode. Unknown schemas/owners fail closed. No lock is created
or deleted. The native resume also arbitrates a competing writer atomically.

Before resume, AM durably marks the **existing row** shared-only, preserving its
ID, incarnation, name, path and native pin. This blocks revival/terminal launch
as a standalone process even after a crash or failed binding. The coordinator
resumes the same UUID with verified saved settings, compares the entire native
paged parent-turn history hash before/after (bounded at 5,000 turns), checks
returned settings and commits the existing binding. It does not copy or rewrite
rollouts or child threads. All future clients use that exact mapping.

A failed acknowledgement or binding leaves the guard in place. Refresh the
preview; if the same thread is now loaded with unchanged history/settings, the
coordinator verifies it before retrying the binding. It never replays input.
If work/settings changed, leave the guard and review the exact thread manually.
The stored `prepared` receipt records intent; a committed binding is the source
of truth for a completed migration. No automatic rollback launches a legacy TUI.

The real Codex 0.162.1 fixture verifies free-owner migration, unchanged AM
identity and full native turn data, restored settings, stale preview rejection,
and an AM restart with no TUI or inference during migration. Unit tests cover
persistence failure, uncertain resume acknowledgement, failed binding, native
queue races and retained guards. Kernel lock tests use only temporary locks.

**Remaining deployment boundary:** production AM predating the guard cannot be
replaced/restarted underneath its live legacy TUIs. The current coordinator
requires an already stopped view on a compatible AM. Integrating graceful quit
for server-owned PTYs and deploying without terminating those existing PTYs
remain separate work. A stopped-looking row on an older manager is not permission
to edit its files externally or import a duplicate into the pilot.


### Production cutover from legacy AM

Deploy the shared-capable backend against the existing AM data directory; do
not concurrently run two managers against that directory. Preserve its binding
host, workspace root, session IDs, groups and native thread pins. Before boot,
place launch guards on candidate Codex rows and disable their automatic legacy
revival. Run the migration preview/apply for each stopped, verified TUI, then
restore legacy launch only for explicitly excluded, still-unbound rows.

The 0.162.1 TUI stores its built-in Default collaboration prompt rather than
null. Recovery recognizes only the exact prompt verified against that binary;
custom instructions remain refused. Full migration-history pages have a 64 MiB
transport bound; the ordinary Reader observation limit remains unchanged.

An isolated live test now starts a real standalone Codex TUI against a local
provider, exits it with `/quit`, and transfers its same thread and AM identity.
It checks complete history, settings and persistence through an AM restart.
No inference occurs during migration (fixture initialization is counted
separately). Older permission layouts and unresolved reasoning defaults remain
legacy until their equivalence can be verified; never silently broaden them.

For systemd deployments, inspect cgroup membership before restarting AM:
processes started from its terminals may share its service cgroup. Keep the
Codex daemon and any independent pilot outside it. A migration controller
running inside the old AM must finish its turn before an independent, audited
worker closes it. A partial failure keeps exact native IDs and launch guards;
never roll back to an old backend that ignores those guards.
