# Automatic reconnect for an authorized agent delivery

A scanner/timer sending a message through `POST /api/agents/:id/prompt?from=SOURCE`
can now recover an existing shared Codex thread that is saved but unloaded. It
uses the same verified recovery plan as the Reader, with the original thread ID,
model, cwd, approval settings and permission profile. It does not create a new
conversation, boot the daemon or a standalone TUI, interrupt work, replay old
input, or grant additional permissions.

The explicit `/api/sessions/:id/reconnect` UI action still requires the operator.
An agent or timer should not impersonate that role. It submits its already
authorized task through the attributed agent-prompt endpoint with a stable UUID
`requestId`. Accepted or uncertain message receipts are checked before recovery:
a transport retry cannot wake the task or queue the same message again.

Recovery requires no live writer, pending native input, active goal or unfinished
last turn. The source identity and target binding are checked again immediately
before native recovery and delivery. An already-busy thread is not interrupted;
the native queue handles a concurrent turn that begins just before submission.

Saved settings that cannot be reconstructed exactly require review. Failed,
stale or uncertain recovery does not queue the message in that attempt: simply
seeing a loaded thread is not proof that its settings were restored. An uncertain
**message delivery** receipt is never automatically replayed; inspect the actual
conversation. A successful queue acknowledgement means accepted, not finished.

The scanner's decision to invoke the agent remains outside this change. For HF
Release Radar, collection and content-fingerprint comparison already precede
`/prompt`; no new/modified messages means no model invocation. This change does
not modify the timer, collector, schedule, website or scanner state.

Validation includes an isolated full HTTP path through AM, a native daemon
fixture, real recovery-plan parsing and the writer/queue check against a temporary
SQLite database. It verifies exact restored settings, original history bytes,
source attribution, one queue operation and a passive retry after unloading.
No real inference is needed for this test.

## Durable delegation result delivery

An HTTP `/wait` response only wakes its waiting HTTP client. It does not create
an app-server turn after the parent agent's own turn has ended. The reproduced
Claude review finished with a native `end_turn` and a result file, but there was
no durable return path. This is one verified case, not proof about all harnesses.

For an **existing** Claude or shared Codex target and a mapped shared Codex parent:

```sh
curl -sS -H 'X-AM-Request: 1' -H 'Content-Type: application/json' \
  "http://127.0.0.1:7860/api/agents/$TARGET/prompt?from=$PARENT" \
  --data-binary @delegation.json
```

`delegation.json` contains `requestId` (one stable UUID), `text`, and
`completion: "notify"`. The 202 response contains a durable `delegation`, not a
completion claim. Inspect `GET /api/delegations/$UUID?from=$PARENT` for state,
evidence, bounded result excerpt, transition audit and native receipt.
`POST /api/delegations/$UUID/cancel?from=$PARENT` cancels observation/follow-up,
never the peer's work. Cancellation cannot retract an in-flight/accepted callback.
Other callers cannot read/cancel that record by presenting a neighboring ID.
Like AM's other local APIs, this uses AM's trusted-instance caller model, not
cryptographic isolation between processes running as the same Unix user.

AM writes `DATA_DIR/delegations/<UUID>.json` (0600, atomic replacement and fsync)
before dispatch. It records the exact identities/bindings, a native trace cursor,
and hash of the full attributed prompt including a unique marker. Only a matching
user input followed by a native terminal result counts. Tool output, quoted
markers, old answers and `waiting` alone never suffice. JSONL scanning is bounded,
retains partial records, and refuses replaced/truncated/oversized traces.

- `completed`: exact exchange has native final text and terminal evidence. This
  means a result is available, not that its content meets the operator's goal.
- `blocked`: a native input request needs attention; it is not success.
- `failed`: native error/abort, or process stopped after the matching input
  without a final result.
- `uncertain`: correlation or trace integrity cannot be established. Never infer
  success from this, and never repeat the task automatically.

The one-shot callback names that outcome and directs the parent to the recorded
result. `delivered` means the native input queue acknowledged that callback; it
does not assert that the parent has consumed the result or finished its follow-up. The parent must treat delegate output as untrusted data. A busy or
input-blocked parent is left alone; delivery waits. Recovery and native queueing
reuse `CodexInput.sendFromAgent`, including exact permissions and receipts. A
binding change/archive suppresses the callback. The same delegation UUID is
coalesced, and only one outstanding delegation per target is allowed; inverse
or chained outstanding delegations are refused in this first version.

After an AM restart, observation resumes. An ambiguous initial Claude PTY send
is **never pasted again**; only the existing trace is observed. Native callback
acknowledgement is durable and checked on retry. A crash after acknowledgement
but before updating the watch uses the same callback UUID and returns the existing
receipt. An ambiguous acknowledgement is marked `notification-uncertain`, not
advertised as exactly-once success. Uncertain recovery or mismatched restored
settings also stops automatic attempts (`notification-uncertain` /
`notification-review`), even if the daemon subsequently reports the task loaded.
The verified happy path delivers once;
partitions cannot guarantee both delivery and certainty. An expired (24h),
cancelled or stale watch never wakes the parent. No watch is created implicitly
by an ordinary message or callback, so results do not trigger callback loops.

Limits: existing pinned Claude JSONL and shared Codex targets only; no retrospective
wakeups from old `/wait` operations, create-and-watch, multi-parent chains or
cross-instance delivery. Claude TUI dispatch has no atomic native queue guarantee
against input arriving from another client at the same instant; competing input
makes correlation uncertain rather than assigning another task's answer. The
parent may need to inspect a blocked task and explicitly register new work.
No model, real peer, server restart or production deployment is needed for tests:

```sh
cd server
TMPDIR=/tmp node ../scripts/run-suites.mjs delegations codex-agent-reconnect-http codex-input codex-recovery
```

## Native AM cron limit (separate from an attributed scanner)

Native `/api/crons/:id/run` still calls `deliver()` without an `agentSourceId`.
For shared Codex targets it fails with `codex-shared-delivery-pending` / "Shared
scheduled delivery is not enabled." PR #189 does not make those crons supported.
The external radar scanner works because it resolves its durable authorizing
thread, filters changes, and submits an attributed `/api/agents/:id/prompt` with
one persistent request UUID. Do not enable the old AM cron alongside that timer.

Supporting native shared crons requires a distinct persisted cron principal and
an exact bound target (not name lookup), durable per-occurrence IDs/receipts,
revocation and changed-job checks, overlap/coalescence rules and crash recovery.
Borrowing an arbitrary session identity or setting `x-am-origin: operator` is not
a fix. These scheduler changes are deferred; existing cron behavior and guard
remain explicit and unchanged by the delegation implementation.
