# Codex shared server preview

This experimental preview adds a read-only task inspector in **Settings →
General → Codex multi-device preview**. It is the first implementation slice of
[the shared-session proposal](proposals/codex-shared-sessions.md). It does not
change how AM launches Codex, migrate threads, pair devices, or stop processes.

The intended destination is shared execution by default for new Codex sessions
once compatibility and lifecycle tests pass, without a per-session checkbox.
Existing standalone sessions still need individual, verified migration.

## Configure the inspector

On an isolated AM development instance, set both administrator-controlled values:

```sh
export AM_CODEX_SHARED_SOCKET=/absolute/path/to/existing/control.sock
export AM_CODEX_SHARED_HOME=/absolute/path/to/codex-home
```

Use the actual socket exposed by the independently managed daemon; this preview
neither guesses its location nor starts a replacement. The resolved socket must
belong to AM's OS user and have no group/other permission bits. The daemon must
report the configured Codex home during initialization. Incompatible servers
are reported as unavailable, with no fallback execution.

Open the settings panel and select **Check server**. Each page contains at most
20 recent interactive tasks, their runtime state, and exact AM pin matches.
A matching name or directory does not associate a task with an AM session.
Names, directories and thread IDs are visible only inside the existing private
AM boundary. Transcript previews and full conversation payloads are omitted.

The API is `GET /api/codex/shared`, with an optional opaque `cursor` query value.
It returns one page and an observation timestamp, not a live subscription.
Refresh to update statuses. A failed refresh clears the displayed snapshot;
unknown state is never presented as idle. `launchEnabled` is always `false`
in this implementation, including when the connection succeeds.

The transport only allows initialization, metadata-only `thread/read`, and
bounded `thread/list` with `useStateDbOnly: true`. That list option avoids rollout
scan/repair. It never resumes or subscribes to a thread and never answers an
approval request. Socket connections, requests, message sizes and concurrency
are bounded. AM's privacy lock and request admission still protect the route.

## Compatibility experiment

Run from the repository root with Codex on PATH:

```sh
node scripts/probe-codex-shared.mjs
```

The script creates a temporary Codex home and two synthetic threads on its own
stdio app-server. It sets distinct `AM_ID` values using thread configuration,
checks them with a fixed `printf` user-shell command, then restarts only its own
server and resumes both exact thread IDs without configuration overrides.
It also checks working directories, approval policy and sandbox policy.

There is no model inference, credential loading from the operator's Codex home,
Remote pairing, or access to existing threads. The user-shell RPC runs the fixed
command unsandboxed; this experiment does **not** verify model-tool sandbox
enforcement. It deletes only its temporary fixture directory and stops only the
child servers it spawned. It never searches for or signals existing daemons.

Exit codes: `0` means these tested invariants held; `2` means the experiment
observed context loss; `1` means it could not complete. A zero exit is necessary
but not sufficient to enable shared execution: model tools, TUI reattachment,
Remote approvals and active-turn survival still need separate tests.

### Result on Codex 0.162.0

The experiment on 2026-10-09 returned exit **2**:

| Check | Initially | After server restart and resume |
| --- | --- | --- |
| Per-thread AM identity | Correct and isolated across both threads | Lost; both inherit the synthetic server identity |
| Exact thread ID | Recorded | Preserved |
| Working directory | Correct | Preserved |
| Explicit approval policy | `never` | Reverts to server default `on-request` |
| Read-only sandbox | Correct | Preserved |

The approval change in this fixture is more restrictive, but demonstrates that
an override is not reliably sticky across cold resumption. The identity loss
could cause a session to attribute AM operations to the wrong agent. Therefore
this PR exposes observation only; there is no switch that bypasses the gate.

The next integration must either establish durable thread-scoped context that
all clients honor, or introduce a reliable restoration mechanism covering every
resume path, including Remote and server recovery. Restoring values only when
AM attaches does not cover a task resumed directly from a phone. After that,
implement exact binding and task/view lifecycle semantics before enabling the
shared default. Do not use global environment rewrites or session-directory
heuristics to bridge this gap.

## Validation

Automated transport tests use temporary Unix WebSocket servers and assert that
execution, interruption, pairing and full-history calls cannot be issued. HTTP
integration tests cover the actual route stack, cursor validation and privacy
lock. Browser tests exercise manual inspection, pagination, stale-state removal,
escaped task titles and a 390-pixel mobile layout.

```sh
cd server
node --test test/codex-shared.test.mjs
node test/api-http.test.mjs
cd ../web
npm run build
node test/codexShared.render.test.mjs
```

The browser test requires Chromium; use the repository's
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` override if needed. No running AM deployment
needs to be restarted for these tests. A read-only check against a configured
0.162.0 daemon also returned a bounded page of 20 tasks successfully.

Protocol references: [app-server](https://learn.chatgpt.com/docs/app-server) and
[CLI](https://learn.chatgpt.com/docs/cli/reference). The protocol remains
experimental; the executable compatibility probe is the evidence for the
specific cold-resume behavior above.
