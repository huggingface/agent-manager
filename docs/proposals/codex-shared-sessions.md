# Shared Codex sessions in Agent Manager

Status: **Draft proposal**. This change adds documentation only. The runtime,
launch commands, session records, and deployed services remain unchanged.

Agent Manager should let an operator follow the same Codex thread in an AM
terminal, a terminal over tmux/mosh, and Codex Remote. Today an independently
running TUI can retain the thread's writer lock, preventing Remote from opening
it. The proposed destination is one independently supervised Codex app-server
per OS user and Codex home, with AM and the TUIs acting as clients. Existing
standalone sessions continue until explicitly migrated, one at a time.

## Current behavior and why a launch flag is insufficient

The baseline is repository commit `487a32e`:

- [config.js](../../server/src/config.js) builds standalone Codex commands,
  including `resume --last`, with per-invocation TUI notification settings.
- [runner.js](../../server/src/runner.js), `commandFor`, resumes an exact
  `codexSessionId` only when its recorded rollout file exists. The capture
  watcher can clear a pin when that file disappears. File existence must not
  decide whether a shared server's thread still exists.
- The same runner's `stop` and `stopAll` kill AM's PTYs. A terminal is currently
  part of the agent's execution lifecycle, not merely a view of it.
- [runstate.js](../../server/src/runstate.js) snapshots running PTYs for revival.
  Reusing this unchanged could reopen a standalone writer after handoff.
- [index.js](../../server/src/index.js) exposes generic stop and input routes;
  input can wake a stopped pane. Neither is a verified, task-specific handoff.

Consequently, changing every launch to `codex --remote` is not the first rollout
step. Ownership, state, identity, input routing, and restart behavior must change
together for the sessions that opt in.

## Target ownership and compatibility

The shared server owns Codex execution and persistence. AM owns its session
labels, grouping, workspace association, terminal views, and presentation of
runtime state. It does not own the shared daemon's lifecycle. Pairing and Remote
credentials stay with Codex; AM does not copy them into session records or logs.

An existing daemon is discovered and checked, never implicitly replaced,
upgraded, stopped, or started on a different endpoint. The initial integration
supports a local Unix socket under the same OS user. Daemon supervision must
survive an AM-only restart; a container or host restart can still stop execution.
A remote-machine transport and automatic daemon provisioning are separate work.

The CLI supports `--remote` with an explicit Unix endpoint and an exact resume
ID. A local inspection of CLI 0.161.0 confirmed those options; this is not a
claim that every daemon version behaves identically. Capability checks must
cover the running server as well as the installed CLI.
[Official CLI reference](https://learn.chatgpt.com/docs/cli/reference)

Suggested terminal command, after verifying the endpoint and thread binding:

```sh
codex --remote unix:///absolute/path/to/verified.sock resume THREAD_ID
```

tmux and mosh continue to host ordinary terminals. Existing standalone Codex
sessions, other agent CLIs, and shell panes keep their current behavior. Ordinary
ChatGPT web conversations are outside this integration.

## Session identity and state

Keep `cli: codex`; add a versioned runtime binding rather than a second CLI type.
The following fields are proposed, not an existing API:

| Persisted field | Meaning |
| --- | --- |
| `codexRuntime.mode` | `standalone` or `shared`; missing means legacy standalone |
| `codexRuntime.endpointId` | Reference to administrator-configured local endpoint |
| `codexRuntime.threadId` | Exact server thread identifier; never chosen by recency |
| `codexRuntime.revision` | Incremented when the binding or handoff phase changes |
| `codexRuntime.viewPolicy` | Reopen the AM view, or leave it detached |
| `codexRuntime.handoff` | Durable operation ID and phase, when a migration is in progress |

Validate the endpoint against server-side configuration; a session request must
not choose an arbitrary socket or URL. Bind an endpoint to the verified OS user,
Codex home, and available server identity. Socket replacement requires renewed
identity checks. Store observations separately from this durable binding:

| Observation | Possible values or evidence |
| --- | --- |
| Server connection | connected, unavailable, incompatible |
| Task activity | idle, working, waiting for input/approval, unloaded, error, unknown |
| AM terminal view | attached, detached, exited |
| Writer ownership | standalone process, shared server, none observed, unknown |
| Freshness | observation time and connection generation |

An exited TUI does not prove that a task finished. An unloaded thread is not a
missing thread, and a disconnected server is not an idle task. Unknown or stale
observations disable mutations until reconciled. User-facing labels must show
when work continues elsewhere.

The app-server provides `thread/read` for inspection without resuming,
`thread/status/changed` notifications, and `turn/interrupt` for a specific turn.
Unsubscribing only removes the current connection's subscription; it is not a
way to release another TUI's writer or stop the shared daemon.
[Official app-server protocol](https://learn.chatgpt.com/docs/app-server)

AM should inspect before subscribing and reconcile after reconnecting. Avoid
loading every saved thread merely to list it. Use bounded pagination for history;
keep legacy rollout readers for standalone sessions.

## First opt-in integration

Start with newly created, explicitly opted-in AM sessions. The default remains
standalone. Before offering creation, check protocol compatibility, endpoint
identity, and the required per-thread configuration capabilities.

1. Create a durable pending binding with an operation ID and validated workspace.
2. Create one persistent server thread with the intended configuration, obtain
   its exact ID, and durably save the binding before launching a view or prompt.
3. Launch the TUI as a client resuming that ID. Do not use `resume --last`, a
   newest-file heuristic, or a fallback that silently starts a standalone TUI.
4. Disable legacy rollout repinning for this binding. If `/new`, a fork, or a
   TUI picker changes its thread, require an authenticated exact association
   before changing the AM binding or accepting managed input. Otherwise report
   the mismatch and require reattachment to the pinned thread.

Thread creation is not assumed to be idempotent. If its response is lost, keep
the operation indeterminate and reconcile using a verified correlation facility
if the server provides one. Otherwise require explicit recovery; do not retry
creation or adopt the newest thread in the folder. A failed durable binding write
must likewise stop before any prompt is sent.

**Per-thread context is a prerequisite.** A long-lived daemon does not inherit
each connecting TUI's environment. Validate workspace confinement, instructions,
sandbox and approval policy, attachments, model selection, and AM identity
(`AM_ID`, `AM_SESSION`, and related context) at the execution side. Determine
which settings are actually thread-scoped in the supported server schema. If
AM identity or required isolation cannot be preserved without changing the
daemon's global environment, keep this mode unavailable. Never weaken the
sandbox to make the connection work.

Initially retain native TUI input and approval UI. Managed prompts and scheduled
prompts must have one delivery path with operation receipts, and must refuse
when exact binding or approval routing cannot be established. After an ambiguous
send, do not replay automatically. An approval resolved by another client must
be reconciled before AM offers or submits a second answer.

## Actions and legacy handoff

Use distinct UI actions and backend operations:

| Action | Required behavior |
| --- | --- |
| Open terminal | Attach a client to the exact bound thread |
| Close terminal view | Disconnect only AM's client after warning about any unsaved composer text |
| Interrupt current turn | Show the target and require explicit confirmation bound to its current turn ID |
| Use in Remote | For a shared binding, show its identity and Remote instructions; no writer release is needed |
| Migrate standalone task | Run the verified handoff below |

Existing generic stop routes must not accidentally interrupt shared work or
stop the daemon. Reject ambiguous stop requests for shared sessions with a
clear explanation of the supported actions. Keep legacy behavior for other
session types. Archiving, deleting history, and stopping the server are never
part of handoff.

For a standalone task, use a preview followed by a separately confirmed commit:

1. Resolve an exact thread ID or an unambiguous project/task name. On ambiguity,
   return candidates. Verify the binding rather than trusting a matching title.
2. Discover the actual writer mechanism for the supported Codex version. On
   Linux, verify kernel lock ownership by device/inode, PID, UID and process
   start time, then associate the process with the exact AM PTY or tmux pane.
   A lock filename is not proof of ownership. Unavailable evidence means refuse.
3. Check current work, pending input/approvals, queued work, active goals and
   related threads. Unknown ownership or unrelated tasks in the same process
   means refuse. Protect the manager's own process and ancestors.
4. Record a short-lived confirmation tied to the thread, owner identity,
   operation scope, turn ID, and binding revision. Active work requires an
   explicit interrupt confirmation. Idle migration still needs a fresh check
   immediately before acting; a change invalidates the preview.
5. Persist a migration phase that suppresses automatic revival and queued
   delivery. Ask only the verified owning TUI to exit gracefully. Check for an
   unsent draft first. Never send blind keys or use the generic PTY-kill route.
   If this cannot be proved safe for that TUI version, require manual `/quit`.
6. Verify the original writer released the task. A timeout or a new writer is
   an unresolved handoff, not permission to force-kill or delete a lock file.
7. Resume the same thread on the verified server, confirm its identity/history,
   persist shared mode, and finish the operation. If resumption fails, retain
   the original ID and a detached recovery state; never silently start fresh.

No lock deletion is needed in the proposed first implementation. A stale-lock
repair, if ever necessary for a particular storage backend, belongs in a
separate diagnostic flow. Serialize operations per thread and revalidate after
awaits. AM's serialization does not exclude external clients, so writer and
activity checks must remain conservative at each boundary.

After a crash, reconcile the persisted phase against actual ownership. Never
replay keystrokes or interruptions, nor report success from a stale preview.
Returning from Remote normally just opens a TUI client on the same shared
server. It does not restore a competing standalone writer.

## Delivery stages and acceptance gates

Each stage should be a reviewable implementation PR with a default-off feature
flag. This proposal does not implement these stages.

1. **Observe:** add a bounded local protocol adapter, capability checks, exact
   binding storage and read-only status. Test reconnects and unknown states.
2. **Create and attach:** support new opted-in threads, verified execution
   context, exact-ID TUI attachment, and separate view/task status. Handle
   ambiguous creation, `/new`, approvals and prompt delivery before rollout.
3. **Lifecycle:** add close-view and confirmed interrupt actions; update stop,
   runstate revival, Reader/history and queued/scheduled delivery consistently.
   Demonstrate an AM-only restart while disposable server work continues.
4. **Migrate:** add the ownership-bound preview/commit flow and name selection
   for legacy AM and tmux sessions. Unknown external terminals stay manual.
5. **Pilot:** enable one disposable session, then one operator-selected idle
   task. Existing working tasks remain untouched. Broader enablement follows
   successful round trips and restart recovery.

Tests must exercise safety boundaries, not only command formatting:

| Scenario | Required result |
| --- | --- |
| Two sessions share a folder or task name | Never adopt each other's thread |
| Missing/rotated rollout, paginated history | Preserve the exact shared binding |
| Unavailable socket, replaced server, version mismatch | No standalone fallback or new thread |
| Lost create/send response or failed persistence | Indeterminate state; no automatic duplicate |
| AM restart after detachment or partial migration | Reconcile; no competing writer or replay |
| Work starts between preview and commit | Reject the stale confirmation |
| PID reuse, hidden locks, unrelated child or writer | Refuse release |
| Active goal, queued prompt, approval, unsent draft | No automatic interruption or draft loss |
| Close-view during a disposable active turn | Work and history survive |
| Remote and AM send/approve concurrently | Defined delivery and stale-response handling |
| `/new` or picker switches the TUI thread | Managed input cannot target the old binding silently |
| Per-session identity, sandbox and attachments | Execution uses the intended session context |
| AM to Remote to tmux to Remote | Same thread and messages throughout |
| Unrelated Codex, tmux/mosh and other CLIs | No signals, lock removal or state changes |

Run process and end-to-end tests in an isolated data directory with synthetic
threads. Inspect pre-existing user sessions read-only. Do not restart the live
AM instance to validate this proposal or its initial implementation.

Disabling new shared-session creation must preserve existing bindings. A
rollback keeps shared tasks on their server and exposes a manual exact-ID
attachment path. It must never reinterpret them as standalone. Deployments of
older AM versions that do not understand these bindings require a documented
compatibility strategy rather than an in-place downgrade.

## Decisions for review

The recommended first scope is a local Unix endpoint and explicit opt-in for
new sessions. Review should settle the initial supported CLI/server versions,
how per-thread AM context is represented, and which server-supported facility
can correlate creation and TUI thread changes. These determine whether the
first usable slice is safe; they are not reasons to migrate live sessions
experimentally.
