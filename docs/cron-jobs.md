# Cron jobs

Cron jobs send ordinary Agent Manager prompts on a five-field cron schedule.
They are durable configuration, not terminal processes: definitions and their
last delivery result live in `DATA_DIR/crons.json` (the mounted bucket in a
Space), while timers exist only in the current server process.

The same feature is available in **Settings → Cron** and over HTTP. As with
other mutating APIs, an agent passes `?from=$AM_ID`; the browser supplies the
operator origin automatically.

## Create and list

```sh
curl -sS --fail -X POST \
  "http://localhost:${AM_PORT:-7860}/api/crons?from=$AM_ID" \
  -H 'content-type: application/json' -d '{
    "name": "nightly deploy check",
    "agent": { "name": "nightly-index", "cli": "claude" },
    "prompt": "Check last night’s deploy log and report regressions.",
    "schedule": { "cron": "0 9 * * *", "tz": "Europe/Zurich" },
    "runOnRestart": true
  }'
```

The response is the stored job, including a generated `cron_…` id, `state`
(`running` initially), and `next` as an ISO UTC instant. `schedule.tz` is a
required IANA timezone; it is applied when calculating occurrences, including
daylight-saving transitions. Expressions use exactly the conventional five
fields: minute, hour, day of month, month, day of week.

```sh
curl -s "http://localhost:${AM_PORT:-7860}/api/crons" | jq .crons
```

Each listed job includes:

```json
{
  "id": "cron_7f3a…",
  "name": "nightly deploy check",
  "agent": { "name": "nightly-index", "cli": "claude" },
  "prompt": "…",
  "schedule": { "cron": "0 9 * * *", "tz": "Europe/Zurich" },
  "runOnRestart": true,
  "state": "running",
  "next": "2026-08-20T07:00:00.000Z",
  "last": {
    "at": "2026-08-19T07:00:00.000Z",
    "status": "ok",
    "durationMs": 83,
    "trigger": "schedule"
  }
}
```

`last.status` reports whether Agent Manager delivered the prompt, or why it
could not (for example, a CLI no longer installed on the Space). Its duration
is delivery time, **not the agent task's runtime**. The supported CLIs do not
provide one shared, trustworthy task-success signal, and an agent can accept
overlapping prompts, so claiming task success here would be false.

## Run, edit, stop, and delete

```sh
# Fire outside the schedule. 202 means accepted for delivery.
curl -sS --fail -X POST \
  "http://localhost:${AM_PORT:-7860}/api/crons/$ID/run?from=$AM_ID"

# Stop keeps the definition and last result, but removes its next occurrence.
curl -sS --fail -X PUT \
  "http://localhost:${AM_PORT:-7860}/api/crons/$ID?from=$AM_ID" \
  -H 'content-type: application/json' -d '{"state":"stopped"}'

# Start again. PUT also accepts any of the create fields for editing.
curl -sS --fail -X PUT \
  "http://localhost:${AM_PORT:-7860}/api/crons/$ID?from=$AM_ID" \
  -H 'content-type: application/json' -d '{"state":"running"}'

curl -sS --fail -X DELETE \
  "http://localhost:${AM_PORT:-7860}/api/crons/$ID?from=$AM_ID"
```

Manual Run now works for stopped jobs too; stopped governs future schedule
fires, not whether the definition may be invoked explicitly.

## Agent creation and identity

At fire time Agent Manager looks for an existing session with the exact agent
name. If found, it reuses that session; the job's `agent.cli` is only the type
to use when creation is needed. If absent, the server synchronously creates one
session in `workspaces/<slugged-agent-name>` before prompt delivery. Because
lookup and creation happen without an asynchronous gap, two jobs firing for the
same missing name cannot create two agents in this server process.

The target sees a normal prompt prefixed with:

```text
[message from cron "nightly deploy check":]
```

Scheduled and restart fires enter the durable operations log with origin
`{id: "cron:<job-id>", type: "cron", name: "<job-name>"}`. API calls that
create, edit, manually run, or delete jobs retain the operator/agent identity
that made the call.

## Restart and overlap semantics

On server start, every running job gets a newly calculated future occurrence.
Persisted times that passed while the Space was asleep are not replayed. A
running job with `runOnRestart: true` also fires once shortly after the server
starts. If its next scheduled occurrence falls in that same short startup
window, the scheduled occurrence substitutes for the restart fire so one boot
cannot send the prompt twice. Stopped jobs do not run on restart.

There is deliberately no overlap guard and no spend ceiling. If a target is
already working, another prompt may land in its input and be handled mid-task.
Use Stop or Delete when a schedule should no longer spend tokens.
