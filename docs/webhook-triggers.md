# External webhook session triggers

Status: opt-in implementation, stacked on PR #189 (shared delivery recovery and native result evidence). No production activation is implied by installing the code.

## Design and threat model

A separate loopback-only HTTP listener accepts signed, bounded events. It has no AM routes, cookies, operator privileges, shell, filesystem or session discovery API. Publish **only this listener** behind a TLS reverse proxy; never publish AM's port. An explicit protected configuration binds each source to one existing shared thread, binding revision and session UUID. External services have their own principal in the prompt and native receipt, never an agent/operator identity.

Standard Webhooks HMAC verification covers raw bytes, message ID and delivery timestamp before JSON parsing. Five-minute delivery tolerance, event-ID deduplication, conflicting-body rejection and a fixed activation cutoff prevent replay. Old event tombstones are retained. A compromised signing key can trigger the configured workflow within quotas; it cannot select another thread or supply prompt text. Revoke by disabling/removing the source (configuration reloaded on every receipt and delivery check); rotate its key file atomically. Pending events require the unchanged source policy and binding. Already accepted native input cannot be recalled by key revocation.

The public Internet can consume bounded connections/rate budget, but cannot discover session IDs, inspect journals or invoke AM. Proxy rate limiting and TLS are required. Forwarded headers are ignored. No URLs from events are fetched (SSRF), no supplied filenames are opened, and unexpected fields are rejected. Malicious meeting content remains untrusted data even after authentication. A local same-user compromise can read secrets/configuration and invoke Codex; this is outside the webhook isolation boundary. Root can also bypass it. Never store secrets in workspaces exposed by AM's file browser.

## Delivery semantics

Persist an event and stable request UUID with fsync before returning 202. Duplicate signed deliveries return the same opaque acknowledgement, even across restart. Per-source rate (60 requests/minute, including duplicates), 100 new events per rolling 24 hours, 100 pending events and 10,000 retained events bound resource use; reaching capacity returns 503, never evicts deduplication records. Provision retention/archival explicitly before reaching the limit.

One worker uses the existing CodexInput native queue and recovery, without creating threads, PTYs, daemon bootstrap, permission changes or interruptions. Busy sessions retain pending events for a later turn. After native acknowledgement, record `accepted`; this is **not** work completion. Observe only the exact native input and final/turn-complete pair to record `completed` (a final response exists), `failed`, `blocked`, or `uncertain`. This does not establish semantic success of the requested work. Distinct operator input, missing/rotated traces and uncertain acknowledgements fail closed. `waiting` alone is not success. Accepted events are never automatically replayed. A crash after sending but before acknowledgement does not resend without a durable accepted receipt; uncertain cases require inspection. No automatic callback/ping-pong: the result is in the destination conversation.

Jobs expire without dispatch after 24 hours; accepted observations expire to uncertain after 24 hours. A permanent/review error is held for operator review, not retried after an unsafe recovery. A transient busy condition stays queued. Configuration unavailable disables ingestion and delivery. The worker is owned by the AM process; a second listener cannot start a second worker on the same port. Do not configure two AM processes with different ports against the same journal.

## Configuration and installation

Set `AM_WEBHOOK_CONFIG` to an absolute file outside workspaces, owned by the AM OS user with mode 0600. All parent directories must be inaccessible to untrusted users. Signing secret files have the same restrictions; symlinks are rejected. Config is read fresh for revocation. Missing variable means no listener or worker. Configure a dedicated loopback port with `AM_WEBHOOK_PORT` (default 7861); no public bind setting exists.

Use `docs/examples/granola-webhook.json` as a **disabled** template. Before enabling:

1. Prepare a disabled configuration with `node server/tools/webhook-config.mjs DATA_DIR AM_SESSION_ID /private/am-secrets/webhooks.json`. This only reads the existing session/binding and creates a new mode-0600 file; it refuses overwrite and never starts a thread. Keep the directory outside workspaces with mode 0700. The captured `target.stamp` pins session UUID, endpoint, binding revision and cwd. Runtime checks the current server binding too; remigration requires deliberate rebinding.
2. In Granola Business/Enterprise, Settings → Connectors → Webhooks, create an endpoint for **note.generated only** and the minimum personal scope. Supply the public HTTPS `/hooks/granola-followups` URL. Store the one-time `whsec_…` secret privately; never paste it in a conversation, URL or repository. Do not enable public/workspace scope for this personal workflow. The MCP Plus plan alone is not proof of webhook eligibility.
3. Verify retrieval of the native `not_…` ID through an approved Granola connection. The current vault broker `granola.read_note` takes a vault path, not this ID. MCP compatibility must be tested; otherwise an approved native API connector is required. Do not scrape/extract an API key or silently search all historical notes. Set `noteLookupVerified:true` only after this works.
4. Set `ownerEmail`, an activation UTC timestamp and `enabled:true`. For Granola, the fixed workflow requires confirming owner and actual meeting creation/date after that cutoff before processing. Personal scope also includes shared notes; signature alone proves neither ownership nor a new meeting. Missing metadata/lookup causes a blocked report, not a historical sweep. This gate is enforced by the destination workflow, not by fetching note content in the ingress server.
5. Deploy the code during an authorized AM restart window; do not restart the shared Codex daemon. Enable the dedicated reverse-proxy route with request body ≤16 KiB, timeout <15 s, rate limiting and no body/signature logging. Test an invalid signature, the provider test, then a real new meeting and verify its exact destination and result. A provider test might use synthetic/non-retrievable IDs; it proves reception only.

Config changes apply without restart; changing the listener port requires a restart. Disable a source to revoke immediately at the next boundary. In-flight already accepted work may continue. There is no automatic retry action for ambiguous accepted work; inspect journal/receipt/native history first.

Private local diagnostics: `node server/tools/webhook-status.mjs DATA_DIR/webhook-events` shows source/event, request UUID, state, reason and timestamps (no note contents, signature or secret). Journal lives outside workspaces, with 0700 directory/0600 files. Audit transitions and native receipts identify the external principal. Back up journal and receipts together; deleting them permits replay. No HTTP diagnostic endpoint is exposed on the public listener.

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
