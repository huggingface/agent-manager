# Private VPS ↔ laptop federation (experimental)

Opt-in, one pair per AM process. No deployment, tailnet changes or migration is
performed automatically. Session creation is still **local**, and filesystem,
terminal, approvals, credentials and admin APIs are never federated. A laptop
remains the owner of its sessions, including while asleep.

Read the [design and threat model](design/federation.md) first. The first slice
exports selected sessions of any CLI and sends text tasks to **already-loaded
shared Codex sessions only**. No terminal injection or legacy TUI wake-up. The
local `/api/federation` endpoint is the manager-facing inventory; existing local
`/api/agents` and the sidebar are unchanged. A UI for pairing and merged rosters
is future work. Do not mistake an `accepted` native-queue receipt for task completion.

## Prerequisites and network policy

- Node >=24.16, an existing AM installation on each machine and local POSIX disk.
- Tailscale installed/signed in on both devices; `tailscale whois --json IP`
  must return `Node.StableID`. On macOS use the absolute path to the official
  Tailscale CLI for your installation (e.g. the application bundle's binary).
  The CLI handles the GUI variant's LocalAPI credentials; AM never reads them.
- Normal AM must bind `127.0.0.1` or `::1`; federation refuses startup with any
  other AM bind. Existing operator access can use a separately secured proxy,
  which must not grant the paired device access to AM.
- Tailnet policy permitting only the laptop device to reach the VPS's TCP 7871,
  in addition to existing operator access. **Do not grant the peer access to AM's
  normal port**: AM's ordinary API is a trusted operator API, not a peer API.
  Existing broad tailnet grants must be narrowed too: an additional narrow grant
  does not override a broad allow. Review this with the tailnet administrator.
- The VPS federation listener binds only its configured `100.64.0.0/10` address.
  IPv6-only tailnets, proxies, Serve/Funnel, tsnet and userspace-networking without
  an assigned local tailnet address are unsupported in v1. The laptop opens no
  listener. Do not publish or reverse-proxy the federation port.

Inspect `tailscale ip -4` and `tailscale whois --json <IP>` locally to obtain the
exact IP and stable device ID for each end. Pin the **device** StableID, not its
user, display name or DNS name. Device re-enrolment requires new pairing review.
No Tailscale authentication keys belong in this configuration.

## Pairing

Generate two files on a trusted host (placeholder values below):

```sh
node scripts/federation-pair.mjs init /absolute/private-pair-dir 100.64.0.10 nHUBNODE 100.64.0.20 nLAPTOPNODE
```

The directory must not already exist. It is created with mode 0700; files are
0600 and contain a fresh 256-bit secret and epoch. No secret is printed. Configure
permissions before use. Transfer `spoke.json` to the laptop using an existing
trusted administrative channel; do not paste either file into a chat, URL,
issue, PR or AM workspace. Keep only the required end's file on each host; treat
any retained pairing copies and backups as secrets. On each host place the file
in its own mode-0700 directory outside AM DATA_DIR/workspaces, with mode 0600 and
owned by the AM service user. No symlink directories/files. Private durable
state and audit are created alongside it. Do not use a bucket/FUSE mount.

Set the appropriate absolute `tailscale` executable path in each file. Both ends
must use the same `port`, secret and epoch. File edits are administrative actions,
not model-controlled pairing requests. Each permission list starts empty:

```json
{
  "export": [{"id":"local-research","summary":"Research agent for approved collaboration"}],
  "send": [{"from":"local-research","to":"other-research"}],
  "receive": [{"from":"other-research","to":"local-research"}]
}
```

These are exact AM session IDs, **not thread IDs or display names**. Set these
under `permissions` on this end and mirror the intended grants on the other end.
`export` shares name, CLI, status, conversation activity and the summary you write;
no automatic last-message excerpt or filesystem path. Export is independent of
send/receive permission. Sender existence is checked locally, and receiver IDs
are checked on their owning instance. Messages are labelled **peer-attested**;
a paired machine can assert any source allowed in your incoming grants. Choose
receiving agents and their tool/approval policies accordingly.

Validate and enable in the service environment, then restart that AM instance
at an operator-approved time (no Codex server restart is needed):

```sh
node scripts/federation-pair.mjs check /absolute/private-dir/config.json
# Add to the AM service environment, not a shell command containing credentials:
# AM_FEDERATION_CONFIG=/absolute/private-dir/config.json
```

On Linux use the existing systemd service environment/drop-in; on macOS use the
existing launchd agent's EnvironmentVariables. Do not create another AM process
against the same DATA_DIR or federation state directory. An unset variable means
no federation listener or background poll. An invalid configuration or failed
Tailscale verification disables federation without changing other AM features.
Review service startup logs for the generic disabled diagnostic.

## Manager workflow (on either machine)

```sh
curl --fail -sS -H 'X-AM-Request: 1' http://127.0.0.1:7860/api/federation
curl --fail -sS -H 'X-AM-Request: 1' -H 'content-type: application/json' \
  -X POST http://127.0.0.1:7860/api/federation/messages --data-binary @message.json
```

`message.json` contains `{"id":"<new UUID>","from":"<local AM ID>","to":"<peer AM ID>","text":"task"}`.
Generate one UUID per intended message and **reuse that UUID and text on retry**.
Resolve your own exact AM identity as usual; do not borrow another agent's ID.
The normal local AM trust boundary is unchanged, not upgraded into per-process
agent authentication. The response is a queue receipt. Poll the read-only status
when needed; it includes peer owner, online/stale status, incoming/outgoing status
and the last 100 metadata-only audit entries. It contains no key or message text.
Replies are new explicitly authorized messages in the opposite direction, not an
automatic ping-pong. Nothing creates sessions on the other machine.

Roster observation is cached for up to ten seconds; unavailable observations
are omitted rather than blocking transport, and cached rows expire after 30 seconds.
The spoke exchanges every five seconds, one exchange at a time, with a 10-second
network timeout. After 30 seconds without a verified exchange the roster is stale
and the peer is offline. Queued tasks expire after 24 hours. Loaded busy tasks wait;
unloaded tasks are never booted. Unsupported, archived or missing targets reject.
Native dispatch happens at most once per stored message. After an ambiguous
network/native failure or process crash, `uncertain` requires manual transcript
inspection; do not send a new UUID just to clear it. Queue fairness is round-robin.

## Rotation, revocation, retention

For immediate local revocation:

```sh
node scripts/federation-pair.mjs revoke /absolute/private-dir/config.json
```

Every exchange and pre-dispatch check re-reads the protected file. Any configuration
change, deletion or permission failure disables the existing runtime immediately;
a dispatch already accepted by Codex cannot be recalled by revocation. No old
queue is replayed after restart with a new epoch. For rotation, on a trusted
administrative host holding both configuration copies, use `rotate HUB_FILE
SPOKE_FILE`, install both new files, then restart each opted-in AM process. Keep
old-epoch files for investigating uncertain/outstanding tasks; they are not loaded
by the new epoch. Never reset receipts while keeping the same key/epoch.

Limits: 50 exported sessions, 100 routes per direction, 8 KiB per message,
256 KiB exchanges, four messages per exchange, 1,000 retained incoming and 1,000
outgoing message IDs per epoch, 2,000 metadata audit events, 60 exchanges/minute,
two active requests and eight connections. There is no automatic receipt eviction.
At capacity, requests fail closed; review outstanding work before rotating epoch.
There is no unbounded spool. An exclusive PID lock rejects a second AM process
using the same state directory. After an unclean exit, `node
scripts/federation-pair.mjs unlock CONFIG_FILE` removes that lock only if its PID
is verifiably dead; a live or ambiguous owner is refused. Do not run unlock
concurrently with starting AM. State writes are atomic/fsynced; failed writes disable
further dispatch. Do not share a state directory across AM processes.

## Acceptance checklist before real rollout

Run the tests referenced by the PR, then pair disposable receiving sessions on
actual VPS/macOS installations. Confirm both directions, visible attribution,
idle-only delivery, laptop sleep/wake, lost ACK/reconnect, revocation and denial
from a different tailnet device. Confirm the normal AM port is inaccessible to
that peer and existing local creation/terminal work is unchanged. Unit/socket
fixtures cannot validate your tailnet ACLs or macOS installation. No production
pairing or deployment is implied by this PR.
