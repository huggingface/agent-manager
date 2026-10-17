# Tailscale federation v1: design and threat model

Status: first implementation slice, opt-in, no production rollout. Based on main
including #160; separate from that PR. One hub and one outbound-only spoke per
pair. Local session creation and ownership never change.

## Boundaries and protocol

AM's request-intent middleware is not authentication. Existing remote-agent
names and streams are not peer identities. Do not expose the normal AM port to
peers. Opt-in also requires the normal AM listener to bind loopback; any operator
reverse proxy remains an independently secured boundary, not a federation route. Federation has a separate HTTP listener on one exact Tailscale IPv4
address, only on the hub, with one POST exchange endpoint. The spoke initiates
polls; neither side follows URLs or redirects supplied by a peer. No reverse
proxy, Serve/Funnel, tsnet or forwarded identity headers in this version.

Before an exchange, use the installed Tailscale CLI's `whois --json` (which uses
the platform's authenticated LocalAPI) to verify the remote IP's Node.StableID
against the locally pinned node ID. Incoming identity comes from the TCP socket,
not a header. Both local/remote addresses must be Tailscale IPv4 addresses;
outbound connections bind the configured local address. Require tailnet ACLs
restricting the spoke to the hub's federation port, NOT the normal AM port.
Tailscale provides transport encryption; per-pair 256-bit random HMAC keys add
application authentication. Request and response MACs are domain separated,
cover exact body bytes, and responses bind the request nonce. Messages contain
no bearer key. Pairing is an out-of-band administrator action, never open enrolment.

Versioned, bounded JSON carries an allowlisted roster, up to four queued text
messages, and terminal receipts. Timestamps and durable single-use nonces
reject replay across restarts. UUID message IDs bind immutable content; duplicate
transport delivery returns the saved receipt without another model request.
Queue expiry is 24 hours. An offline peer is explicit after 30 seconds; cached
rosters are marked stale and never suggest remote execution moved here.

Durable delivery states: queued -> dispatching -> accepted / uncertain / rejected
/ expired. Persist dispatching BEFORE native mutation. Restart or ambiguous
failure becomes uncertain and is never automatically retried. This is at-most-once
attempt, not an exactly-once execution claim. Acceptance means native queue
acceptance, not completion. Busy/not-loaded tasks stay queued until expiry.
The initial delivery adapter supports ONLY already-loaded shared Codex sessions,
using native queue/add and existing receipt protection. Other CLIs are discoverable
but cannot receive federation tasks yet. No implicit TUI launch, thread creation,
interrupt, approvals, files or shell endpoint.

## Permissions and attribution

Each side independently lists exported session IDs with an operator-written
short summary (no automatic disclosure of prompts, paths or file names), and
exact allowed sender/destination pairs in each direction. Empty lists deny all.
The receiving peer verifies its local target; the source instance verifies its
local source. Attribution records both instance IDs, source session ID, target,
message UUID and payload hash. A peer vouches for its own agents, not for an
operator: the transcript explicitly calls this a peer-attested agent message.
There is no forwarding across a third peer and no local sender identity borrowing.

The normal AM surface remains a trusted operator/local-agent boundary, as before.
Its federation enqueue API must not be network reachable by the peer. Sending a
prompt to an approved agent can cause that agent to use its existing tools and
spend money: receiving allowlists are delegation of that agent's capabilities,
NOT a sandbox against malicious prompt content. Configure a restricted receiving
agent and retain its approval policy. This protocol never grants additional tools
or approval rights.

## Threats and controls

| Threat | Control / residual boundary |
| --- | --- |
| Public source / guessed URLs | Disabled by default; dedicated exact-address listener; HMAC + pinned Tailscale identity; generic refusal |
| Internet attacker | No public bind/discovery, tailnet ACL, Tailscale routing + identity verification |
| Other compromised tailnet node | Exact IP and StableID pin AND independent pair key; no trust in identity headers |
| Stolen paired device | Can use its explicitly delegated routes; revoke pair immediately. Cannot distinguish attacker from owner on a compromised paired host |
| Revoked / rotated credential | Re-read protected configuration before exchanges and dispatch; any change fails closed until restart; rotate to new key and epoch; old queue is not replayed |
| Replay / duplicated request | MAC over exact body, time window, persisted nonces, UUID/content binding and durable dispatch receipts |
| Agent impersonation | Local source existence validation; explicit incoming route grants; source labelled peer-attested, never operator/local AM identity |
| SSRF | Fixed configured literal tailnet IP/port, no DNS/redirects/caller URLs, no generic API proxy |
| Escalation | Dedicated transport has no admin/files/terminal/spawn routes; no changes to existing AM grants |
| Resource exhaustion | Body/roster/text/queue caps, connection/request concurrency and rate limits, timeouts; bounded retained receipts fail closed when full |
| Crash / lost acknowledgement | Durable at-most-once dispatch, stable receipt repeated on reconnect, ambiguous status visible; no silent resubmission |
| Host filesystem compromise | Out of scope; private config/state must be on local POSIX disk, owned by service user, protected directories/files; do not put in workspace, exports or backups without secret protection |

No key, message body or full roster in the federation audit: IDs, event, time and
content hash only. The normal local AM operations log follows its existing policy
and may contain the operator's outgoing text; pair keys never enter that API.
Configuration and journals are private files, not AM settings or API responses.
Retention is bounded by a hard per-epoch message budget; exhausting it requires
operator rotation (new epoch) after inspecting outstanding messages. No silent
receipt eviction that would reopen duplicate delivery.

## References and assumptions

- [Tailscale LocalAPI client](https://github.com/tailscale/tailscale/blob/main/client/local/local.go)
  documents platform-specific authenticated access, including macOS GUI variants.
- [WhoIs response](https://github.com/tailscale/tailscale/blob/main/client/tailscale/apitype/apitype.go)
  and [node schema](https://github.com/tailscale/tailscale/blob/main/tailcfg/tailcfg.go).
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve): header
  identity is a different trust boundary, deliberately not accepted here.

The CLI adapter requires `tailscale whois --json` with Node.StableID; schema
changes, unavailable daemon or CLI failure refuse the operation. Tested fixtures
are not proof of a real macOS/Tailscale pairing. That deployment check is required
before production use. A future tsnet transport must preserve the same identity
and capability checks rather than bypass them.
