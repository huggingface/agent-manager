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
a duplicate. Imported views display a **Shared** label and use the terminal
even when the global Reader preference is selected; API-backed Reader support
is still a separate rollout gate.

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
is an independent process. Generic stop/archive actions and managed prompt
delivery refuse bound tasks in this pilot: these need explicit shared-task
semantics, server-driven activity/history and approval routing before rollout.
Use the Codex terminal or Remote itself for input in the meantime.

`/new` and fork are not automatically associated with the old AM identity. A
new native ID is unmapped; the original durable mapping remains intact. The
current AM Reader/activity indicators still use the legacy implementation and
are not authoritative for work performed from other clients. Do not enable
this pilot as the production default yet.

## Validation

Run from `server/`:

```sh
node ../scripts/run-suites.mjs codex-import codex-bindings codex-context codex-shared.test api-http api-boundary request-admission codex-repin revive
node test/codex-shared-pilot.test.mjs
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
This does not yet prove phone-side approval
routing, model-tool identity, concurrent prompt delivery, server crash recovery
or automatic shutdown of a legacy writer. Those remain separate gates in the
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
