# Local monitor wakeups

Depends on the durable event transport in PR #193. This is a local filesystem
source, not an agent self-message, a public webhook or an operator input bypass.
A private operator configuration pins each source to one existing session and
identity stamp. Only opaque incident batch UUIDs cross the source boundary;
fixed instructions are operator configuration, never supplied in an event.
The same transport adapters support shared Codex and other supported AM CLIs.
Busy targets wait; archive, remapping or policy changes revoke pending work.
An ambiguous native ACK is held for review, never replayed automatically.

## Trust boundary

The producer and AM run under the same Unix account. A 0700 inbox and 0600
regular files exclude other Unix users. This is NOT isolation against a malicious
process under that account, which already controls AM's state/configuration.
No listening port, bearer token, remote shell or additional Internet access.
The producer cannot select a target, prompt, permission or agent identity through
an event. All event contents remain untrusted. Existing approval policies apply.
No device push is generated. Native completion is not proof of repaired documents.

## Configuration and producer contract

Add a source to the private AM_EVENT_CONFIG (outside workspaces):

```json
{"id":"docs-failures","provider":"local-monitor","transport":"spool",
 "enabled":true,"revision":1,
 "inbox":"/absolute/private/0700/inbox",
 "target":{"sessionId":"EXACT_AM_ID","threadId":"EXACT_NATIVE_ID","stamp":"CURRENT_BINDING_STAMP"},
 "instructions":"Read the incident batch identified by event.id using the maintained local tool. Verify current state and the existing operator authorization before acting. Preserve approval and uncertain-write protections."}
```

Provision the inbox before enabling. Persist a producer batch UUID and its incident
membership transactionally BEFORE publishing. Publish `<uuid>.json` atomically as
0600 (write/fsync temp, rename, fsync directory), with exactly:

```json
{"id":"UUID","type":"incident.ready","occurredAt":"ISO_TIMESTAMP"}
```

Retain the same UUID/time on retries. AM imports into its fsynced journal before
removing the inbox file; crash replay deduplicates. Reusing an ID with changed
content is rejected. Producer publication is not native acceptance or repair.
Keep at most one outstanding diagnostic batch in the producer. Do not retry
unresolved incidents under new IDs. The existing journal tracks native results;
the repair workflow must explicitly close the producer batch with verified results.
Malformed files are retained and source status reports blocked. Event backlog is
bounded to 100 per source; events expire after 24 hours rather than firing stale
repairs. Disable/revise the source to revoke pending work.

## Scope and deployment

This does not enable the old name-based cron delivery path. Such a job can create
replacement sessions and lacks the pinned-target semantics required here. The
Google Docs minute timer should publish a batch only when actionable incidents
exist; it need not wake a model every minute. AM checks the local inbox every
three seconds without model calls. Activation requires both this AM version and
the producer adapter. Do not mark active until native receipt and a controlled
end-to-end run are verified. No production restart is part of this patch.
