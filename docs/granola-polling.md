# Outbound Granola polling and session events

This branch builds on PR #189. It reuses internal delivery adapters developed for
closed PR #190 but includes no webhook receiver, signature secret, public ingress
or relay. It does not reopen that PR. External observations have their own poller
identity, never an invented operator or agent identity.

## Setup

Provision the optional read-only Granola profile in thomas-api-proxy, then install
the Personal notes API key with its interactive root-owned ttb-add-key helper.
Credentials remain inside that service. AM talks to the fixed local Unix socket
/run/thomas-api-proxy/proxy.sock. It cannot select an arbitrary host or URL.

Prepare an exact destination from existing AM state (does not resume anything):

```sh
node server/tools/granola-config.mjs DATA_DIR SESSION_ID /absolute/private/events.json OWNER_EMAIL
```

The generated file is disabled. For an initial review it can be kept in a workspace,
but the active file must be outside WORKSPACES_DIR, mode 0600, owned by the AM user,
with a protected parent. Do not place credentials in it. Set AM_EVENT_CONFIG to that
absolute path when deploying this branch using the normal safe AM rollout. A
production copy with local changes needs a reviewed backport, not a reset. No
Codex server restart is required. Until deployed and explicitly enabled there is
no polling. Do not enable during a test using a real destination.

Verify the proxy with one bounded read, then set enabled:true and increment
revision atomically. Activation time is durably recorded before the first request.
Only this exact existing session/thread binding is eligible; stale or changed
bindings require review. Disable with enabled:false and an incremented revision.
This stops new polling/delivery, but does not interrupt a turn already accepted.
Settings > Triggers edits instructions and action mode, not credentials or routing.
Changing instructions invalidates pending events under the previous policy rather
than silently granting them new permissions. An administrator must explicitly
review any desired reprocessing; never delete dedupe records to retry blindly.

## Behavior and limits

- One incremental list read every 30 seconds (2/minute before pagination), no
  browser and no model call unless a new eligible note is found. Execution, network
  delay, backoff and session occupancy can make latency longer than 30 seconds.
- Strict owner filter, deleted-note exclusion, new-note activation cutoff. The API
  documents listing notes only once summary/transcript generation is complete.
  Pre-created notes older than activation are intentionally excluded even if their
  meeting occurs later. The recipient additionally verifies the actual meeting
  date, owner and exact note before acting; imported old meetings are not follow-ups.
- Five-minute overlap and hourly reconciliation since activation; up to 20 pages
  of 30 notes per scan, bounded bodies/timeouts, backoff for 429/network failures.
  Authentication errors block until an operator fixes access and changes revision.
  Saturation or page-budget failure never advances the checkpoint. Status appears
  at GET /api/event-sources/status; jobs/audit in DATA_DIR/source-events. No content
  or credential is included in the polling status.
- Durable event keyed by source ID + note ID: edits/retries/restart do not re-trigger.
  Durable enqueue precedes cursor advance. Busy sessions wait without interruption;
  unsupported or unknown states fail closed. Observation expires after 24 hours.
- Delivery uses native shared Codex queue with stable request ID, exact terminal
  resume/readiness guards for supported CLIs, or durable Remote append. Legacy
  unbound Codex is refused, never independently launched. Other CLIs: Claude,
  OpenCode, Gemini, Hermes, OpenClaw, fx, Remote; plain shells/Voice are unsupported.
- Receipt distinguishes submitted, accepted, completed, blocked, failed, uncertain
  and review. Terminal text submission alone is not completion. Correlated native
  evidence is required. Ambiguous acknowledgements are never blindly replayed.
  Completion means a correlated final response, not proof that its claims are true.
- Settings modes restrict workflow instructions to research; research + unsent
  drafts; or research + unsent drafts + personal calendar. Existing broker tool
  policies remain authoritative. No sending, external publication, contacts/tasks
  writes or permission changes. Personal events have no guests or invitations.
  Calendar write capability is currently unavailable on the target VPS; proposals
  must be used instead. No permission expansion is included in this branch.

## Security and validation

Local service/AM administrator and same-UID processes are trusted, as for existing
AM settings. External API content remains untrusted. No SSRF configuration or
public endpoint exists. Private configuration and state reject symlinks, wrong
ownership and broad permissions; file persistence is atomic and fsynced. Workflows
are operator-only, revision checked. Sources bind to the exact native identity.

Tests use synthetic notes and mock sockets/native servers, never a real model,
meeting or draft. They cover disabled zero-traffic, 30-second cadence, owner/date
filters, pagination, overlapping scans, restarts, disk failures, duplicates,
backoff, disabled credentials, active revocation, ambiguous receipts, busy targets,
all delivery adapters and UI/API authorization. The complete HTTP fixture boots
AM and follows a fake proxy note through durable queue to native final evidence.
Proxy regression tests are separate in trusted-token-broker-linux. Real API access
and first new-meeting end-to-end validation remain activation requirements.

Native shared crons are still explicitly unsupported in the PR #189 base; polling
uses the general external-source delivery primitive without borrowing an agent
identity. This branch does not silently change scheduled-cron semantics.
