# External webhook session triggers

Status: opt-in implementation, stacked on PR #189 (shared delivery recovery and native result evidence). No production activation is implied by installing the code.

## Design and threat model

A separate loopback-only HTTP listener accepts signed, bounded events. It has no AM routes, cookies, operator privileges, shell, filesystem or session discovery API. Publish **only this listener** behind a TLS reverse proxy; never publish AM's port. An explicit protected configuration binds each source to one existing AM session, engine, workspace and saved conversation identity. Codex additionally pins its shared binding revision and endpoint. External services have their own principal in the prompt and native receipt, never an agent/operator identity.

Standard Webhooks HMAC verification covers raw bytes, message ID and delivery timestamp before JSON parsing. Five-minute delivery tolerance, event-ID deduplication, conflicting-body rejection and a fixed activation cutoff prevent replay. Old event tombstones are retained. A compromised signing key can trigger the configured workflow within quotas; it cannot select another thread or supply prompt text. Revoke by disabling/removing the source (configuration reloaded on every receipt and delivery check); rotate its key file atomically. Pending events require the unchanged source policy and binding. Already accepted native input cannot be recalled by key revocation.

The public Internet can consume bounded connections/rate budget, but cannot discover session IDs, inspect journals or invoke AM. Proxy rate limiting and TLS are required. Forwarded headers are ignored. No URLs from events are fetched (SSRF), no supplied filenames are opened, and unexpected fields are rejected. Malicious meeting content remains untrusted data even after authentication. A local same-user compromise can read secrets/configuration and invoke the configured engines; this is outside the webhook isolation boundary. Root can also bypass it. Never store secrets in workspaces exposed by AM's file browser.

## Delivery semantics

Persist an event and stable request UUID with fsync before returning 202. Duplicate signed deliveries return the same opaque acknowledgement, even across restart. Per-source rate (60 requests/minute, including duplicates), 100 new events per rolling 24 hours, 100 pending events and 10,000 retained events bound resource use; reaching capacity returns 503, never evicts deduplication records. Provision retention/archival explicitly before reaching the limit.

The provider layer verifies events and builds a fixed workflow. `SessionEventInput` chooses the transport; providers never choose an engine or launch command. The common contract is context, status, prepare/observe native evidence, receipt lookup and attributed external submission. Sources and target identity are revalidated after awaits and immediately before effects. No service is disguised as an operator or another agent.

Codex uses its native queue/recovery. Local AI engines use AM's existing serialized terminal input, with a durable intent **before any bytes**, composer protection, and guards inside the send queue and before Enter. Remote agents use a disk-first durable log append; an offline peer can collect pending work. No terminal event payload can become a shell command: shell, files, trace, voice and unknown engine targets are refused. No generated conversation, `--continue`, fallback-to-fresh, model/permission change or daemon bootstrap is allowed. Only pinned Claude, OpenCode and fx conversations can be restarted automatically; other stopped engines wait for an operator resume.

`submitted` means terminal input was written or the remote log was persisted. It does **not** mean native acceptance or completion. `accepted` requires a native queue ACK or exact input in the pinned trace. Codex, Claude and OpenCode have correlated native completion observers; `completed` means a final native response was observed, not semantic success. Tool text and `waiting` alone never prove completion. Other engines remain `submitted` and eventually `uncertain` when no native final evidence is available. These are delivery adapters, not fabricated completion guarantees.

Every send has a stable durable receipt. A crash after intent and before confirmed submission can lose an event, but it cannot automatically type the same event twice. Unknown outcomes require inspection; there is no exactly-once execution claim for a PTY. A policy revoked during a paste suppresses Enter and leaves the text marked unsubmitted so the next send cannot concatenate onto it. Accepted/submitted input is never automatically replayed. Results remain in the destination conversation; this feature does not add callback notifications or broaden PR #189's shared-parent delegation support. Journals keep answer digests (the last observed native answer record), not private response text.

Jobs expire without dispatch after 24 hours; accepted observations expire to uncertain after 24 hours. A permanent/review error is held for operator review, not retried after an unsafe recovery. A transient busy condition stays queued. Configuration unavailable disables ingestion and delivery. The worker is owned by the AM process; a second listener cannot start a second worker on the same port. Do not configure two AM processes with different ports against the same journal.


## AM engine coverage

The mechanism is independent of Granola, engine name, project, model and client UI. Prepare a source with `node server/tools/webhook-config.mjs DATA_DIR AM_SESSION_ID OUTPUT_JSON standard` (the default), then set its event allowlist and fixed authorized workflow. Use `granola` explicitly for the meeting workflow. Several providers can target different existing sessions in one configuration; the same provider works with any supported engine.

| AM session | Delivery and stopped-session behavior | Native result evidence |
| --- | --- | --- |
| Codex shared: AM-created, Remote-imported, TUI-migrated; Reader/Terminal/iPhone | Existing queue; exact saved profile recovery; active/input-required stays queued | Exact user input, final response and matching turn-complete |
| Claude Code | Serialized terminal; exact UUID resume only with existing trace and no unresolved native turn | Exact user input and assistant end-turn |
| OpenCode | Serialized terminal; exact session-ID resume only with existing DB row and no unresolved native turn | Exact user message, matching parent ID and completed `stop`; tool steps are not final |
| fx | Serialized terminal; exact pinned ID resume with existing events file | Submission only in this version |
| Gemini, Hermes, OpenClaw | Existing running terminal; stopped session waits with `exact-resume-required` | Submission only in this version |
| Remote agent | Durable inbox; offline work retained; paused or known active peer waits | Local queue only; current remote protocol has no correlated final ACK |
| Shell, Files, Trace, Voice, unknown type | Explicitly refused; never execute a webhook as shell input | Not applicable |

Terminal admission uses AM activity and native approval signals, rechecked inside its send chain. Claude/OpenCode additionally inspect native records so a long silent tool call is still busy. The other terminal engines currently inherit AM's heuristic activity detection; their lack of a native lifecycle/acceptance protocol limits stronger guarantees. No adapter sends Ctrl-C, responds to approvals, or clears user input. For engines without reliable completion evidence, the journal can state delivery but cannot certify the job finished. Future native adapters can strengthen readiness, resume and observation without changing provider verification, source configuration or the queue.

Legacy standalone Codex still requires importing/migrating the **same** thread first; there is no separate writer fallback. Archived, deleted, repinned or moved targets stop delivery and require explicit reconfiguration. Unknown identity or trace format fails closed. Target stamps pin session UUID, engine, folder and the native pin available to that engine (remote name for remote agents); Codex retains its existing binding stamp. Engines without persisted native pins cannot automatically recover their exact conversation after a process restart.

## Configuration and installation

Set `AM_WEBHOOK_CONFIG` to an absolute file outside workspaces, owned by the AM OS user with mode 0600. All parent directories must be inaccessible to untrusted users. Signing secret files have the same restrictions; symlinks are rejected. Config is read fresh for revocation. Missing variable means no listener or worker. Configure a dedicated loopback port with `AM_WEBHOOK_PORT` (default 7861); no public bind setting exists.

Use `docs/examples/granola-webhook.json` as a **disabled** template. Before enabling:

1. Prepare a disabled configuration with `node server/tools/webhook-config.mjs DATA_DIR AM_SESSION_ID /private/am-secrets/webhooks.json granola`. This only reads the existing session/binding and creates a new mode-0600 file; it refuses overwrite and never starts a thread. Keep the directory outside workspaces with mode 0700. The captured `target.stamp` pins the engine-specific identity described above. Runtime rechecks it before sending; repinning/remigration requires deliberate rebinding.
2. In Granola Business/Enterprise, Settings → Connectors → Webhooks, create an endpoint for **note.generated only** and the minimum personal scope. Supply the public HTTPS `/hooks/granola-followups` URL. Store the one-time `whsec_…` secret privately; never paste it in a conversation, URL or repository. Do not enable public/workspace scope for this personal workflow. The MCP Plus plan alone is not proof of webhook eligibility.
3. Verify retrieval of the native `not_…` ID through an approved Granola connection. The current vault broker `granola.read_note` takes a vault path, not this ID. MCP compatibility must be tested; otherwise an approved native API connector is required. Do not scrape/extract an API key or silently search all historical notes. Set `noteLookupVerified:true` only after this works.
4. Set `ownerEmail`, an activation UTC timestamp and `enabled:true`. For Granola, the fixed workflow requires confirming owner and actual meeting creation/date after that cutoff before processing. Personal scope also includes shared notes; signature alone proves neither ownership nor a new meeting. Missing metadata/lookup causes a blocked report, not a historical sweep. This gate is enforced by the destination workflow, not by fetching note content in the ingress server.
5. Deploy the code during an authorized AM restart window; do not restart the shared Codex daemon. Enable the dedicated reverse-proxy route with request body ≤16 KiB, timeout <15 s, rate limiting and no body/signature logging. Test an invalid signature, the provider test, then a real new meeting and verify its exact destination and result. A provider test might use synthetic/non-retrievable IDs; it proves reception only.

Config changes apply without restart; changing the listener port requires a restart. Disable a source to revoke immediately at the next boundary. In-flight already accepted work may continue. There is no automatic retry action for ambiguous accepted work; inspect journal/receipt/native history first.

Private local diagnostics: `node server/tools/webhook-status.mjs DATA_DIR/webhook-events` shows source/event, request UUID, state, reason and timestamps (no note contents, signature or secret). Journal lives outside workspaces, with 0700 directory/0600 files. Audit transitions and native receipts identify the external principal. Back up `webhook-events/`, `session-event-receipts/` and `codex-input-receipts/` together; deleting them permits replay. No HTTP diagnostic endpoint is exposed on the public listener.

## Provider adapters

`granola` accepts only the four documented fields and `note.generated`. `standard` is a minimal reusable adapter accepting `{event_id,event_type,resource_id,occurred_at}` with a configured event allowlist and fixed local `instruction`. It accepts no remote prompt, URL, file or target. Adding another provider means implementing signature/schema verification and a fixed prompt adapter; never route arbitrary payload text to an operator prompt.

## Deployment boundaries

The example remains disabled. Activation requires verified Business/Enterprise webhook access, a provider endpoint/signing secret, restricted public HTTPS ingress, approved native note-ID lookup and an authorized deployment window. MCP access alone does not establish those prerequisites. Validate a real new meeting after activation before claiming the integration is operational. Unit/HTTP fixtures use synthetic events and fake native model responses; they do not prove the external connection.

References: https://docs.granola.ai/webhooks and https://docs.granola.ai/api-reference/get-note (checked 2026-10-17).

Example Nginx location on a **dedicated public HTTPS hostname**, after configuring its certificate and an HTTP-level `limit_req_zone $binary_remote_addr zone=am_hooks:10m rate=5r/s;`:

```nginx
location / { return 404; }
location ~ "^/hooks/[a-zA-Z0-9_-]{1,128}$" {
    limit_req zone=am_hooks burst=10 nodelay;
    limit_req_status 429;
    client_max_body_size 16k;
    client_body_timeout 10s;
    proxy_connect_timeout 2s;
    proxy_read_timeout 12s;
    proxy_pass http://127.0.0.1:7861;
}
```

Do not point this hostname at port 7860 or enable a wildcard AM proxy. Signature headers must reach the webhook listener unchanged; disable any custom request-body/header logging. Granola authenticates itself via its signing secret, not AM cookies or the public URL.
