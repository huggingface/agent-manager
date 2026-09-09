# Browser request protection

This is request-admission hardening within Agent Manager's existing **single-owner,
private deployment** model, not application authentication. Everyone admitted by
the private edge or local access boundary remains trusted with the application.
Keep the Space private; custom deployments must enforce their own access boundary.
See [SECURITY.md](../SECURITY.md) for private security reporting.

## Policy

| Client/context | Rule for actions and protected reads | Terminal connection |
| --- | --- | --- |
| Standalone app | Exact configured Origin, when present, plus `X-AM-Request: 1` | Exact configured page Origin; browser sockets cannot set custom HTTP headers |
| App embedded in a Hugging Face-style frame | Same rule, for the **app** origin, not the ancestor site; valid app Origin is not vetoed by cross-site ancestor metadata | Same exact app Origin; cross-site ancestor metadata is allowed |
| Same-origin browser fetch without Origin (typically GET) | Marker required; present Fetch Metadata must describe a same-origin API fetch | Missing Origin is not a normal browser socket handshake |
| In-container agent, scheduler or deliberate CLI script | Marker required inside the existing trusted deployment boundary; no browser Origin/metadata normally | Marker required when Origin is absent |
| Remote native client | Existing edge authentication **and** marker; the app does not validate arbitrary Authorization strings | Same native rule after edge authentication |
| Preview, unrelated page, opaque or disallowed Origin | No actions; a failed Origin check never falls through to native handling | Refused before upgrade/attach/replay |
| Ordinary Reader read, preview, download, health/setup/static page | Remains a read within the existing deployment boundary; no new token/login flow | Not applicable |
| Malformed/duplicate headers, unknown Fetch Metadata, unexpected target Host | Refused for protected requests; fixed reason codes only | Refused before upgrade |

`X-AM-Request: 1` is a **non-secret, non-safelisted protocol marker**, not a caller
identity. The browser cannot add it to a cross-origin request without a successful
preflight. The app grants **no API CORS permissions**, including to the parent
hosting page. OPTIONS returns 204 before handlers, without allow-origin, allow-header
or credential grants. UI, API and sockets are served at one browser origin, also
when a development/custom proxy is used.

Present Origin must be an exact HTTP(S) scheme/host/effective-port match. Standard
ports and host case normalize; paths, userinfo, opaque `null`, lists, malformed and
duplicate representations do not. No suffix/wildcard/provider-wide trust exists.
Origin is checked before the native exception. `from`, `x-am-origin`, names,
session IDs and Authorization-looking strings cannot satisfy admission.

Fetch Metadata is defense in depth. Absent metadata is supported for native clients
and browsers that omit it. Known API modes are `cors`/`same-origin`, or `websocket`
for upgrades; destination, if present, must be `empty`. Navigation/no-cors modes,
user-navigation metadata and unfamiliar values are refused. Same-site is not
same-origin. With no Origin, a present site value must be `same-origin`; with an
exact app Origin, cross-site metadata is allowed for embedding. There is no Referer,
ancestor URL, query parameter, loopback-connection or test-flag bypass.

## Deployment configuration

| Deployment | Trusted browser origins / target Host |
| --- | --- |
| Space | `https://${SPACE_HOST}` from trusted environment configuration. No implicit development origins. `SPACE_ID` without `SPACE_HOST` fails startup. |
| Custom/reverse proxy | `AM_ALLOWED_ORIGINS=https://app.example` (comma-separated exact origins, no trailing slash). Each origin's authority is an accepted target Host. Set `NODE_ENV=production` for standalone production. |
| Local development | With no Space identity, production mode or custom origin setting: HTTP localhost, 127.0.0.1 and `[::1]` at backend `PORT` (default 7860) and `AM_DEV_PORT` (default 5173), **not every local port**. |
| Alternate Vite ports | Set backend `PORT=8123 AM_DEV_PORT=5199`; run Vite with `AM_API_PORT=8123 AM_DEV_PORT=5199`. Vite uses `strictPort` and never silently chooses another UI port. |

Explicit custom origins replace implicit local browser defaults, and add to the
configured Space origin if present. Empty/invalid configuration fails startup.
Production without a Space origin needs `AM_ALLOWED_ORIGINS`. IPv6 loopback is
supported explicitly, not arbitrary IPv6 addresses.

The proxy must preserve a configured public Host, or use an exact loopback backend
authority at `PORT` (localhost, 127.0.0.1 or `[::1]`). Those backend target authorities
also let the internal scheduler connect in a Space. This does **not** allow browser
pages from those local origins in production or waive the marker. Other upstream
authorities must be deliberately configured, never learned from requests.
HTTPS termination is supported without enabling Express `trust proxy`; forwarded
headers neither populate the allowlist nor override the received Host. Do not expose
an unauthenticated backend around the edge, and do not globally trust all proxies.

## Ordering and route inventory

HTTP admission runs before JSON/text parsing, raw upload consumers, operation capture
and handlers. It never consumes an upload body. Every method except GET/HEAD/OPTIONS
inherits the action gate automatically, including aliases and new routes.

The protected GET/HEAD inventory is centralized in `protectedRead()`:

- `/api/remote/:name/stream` establishes contact, registers a poll and marks delivery.
- `/api/remote/:name/messages` includes agent-mode contact/delivery. The whole endpoint
  is gated so query-parser changes cannot weaken it; browser display reads normally
  use `/api/sessions/:id/remote` instead.
- `/api/update/check`, `/api/backup/status`, `/api/share/access` and
  `/api/sessions/:id/share` can initiate external authenticated/status operations.

HEAD is covered because Express can invoke a GET handler for HEAD. Case and trailing
slash behavior match Express. Ordinary traces, tails, waits, local cached metadata,
remote ping/display reads, file previews/downloads and static loads remain read-only
paths. Wait's existing audit event is unchanged. Preview sandbox restrictions remain
unchanged. When adding a GET handler, classify effects and extend this inventory if
it controls work, acknowledges messages or initiates privileged external operations.

The HTTP server checks terminal admission before `handleUpgrade`. Only an admitted
connection reaches visibility checks, session lookup, attachment/startup, replay,
ownership, input or resize. Visibility-verdict/revocation policy is unchanged (#131).

Frontend API fetch and attachment XMLHttpRequest share `requestHeaders()`; new helpers
inherit the marker and preserve attribution. Raw uploads, progress, abort signals and
multipart/text bodies retain their existing transport. Direct PDF/file reads need no
marker. No automatic mutation replay or token provisioning is introduced.

## Client migration and failures

Bundled generated environment/remote examples and internal cron requests send the
marker. Native terminal clients must include it in their handshake options if they
do not send an Origin. Current CLI lifecycle adapters write scoped disk breadcrumbs,
not HTTP requests, and require no protocol change.

For an already-copied native helper, add `-H 'X-AM-Request: 1'` to its manager curl
calls (including remote stream/messages reads), retaining existing edge authentication
and attribution. Regenerate/copy remote instructions for new connections. Do not add
the marker to unrelated external-service calls.

Older tabs/scripts receive HTTP 403 with `code: request-not-allowed`, a bounded
`reason`, and instructions to reload the client or update headers/configuration.
Stop a rejected remote loop, update it, then resume its cursor. Check the outcome of
an uncertain write before retrying; do not replay writes automatically. A fresh tab
needs no per-tab credentials. An existing Reader draft is not reset by the guard.
Browser upgrade failures have limited details, so the terminal stops after five
consecutive failed connections (immediately for 1008) and offers **retry connection**
without clearing retained output. A successful terminal restore resets that count.

There is no production legacy bypass. `AM_ALLOW_MISSING_ORIGIN` relaxes **audit
attribution only**, not request admission. Implementation/testing does not update
installed live scripts, restart agents or deploy; rollout coordination is separate.
The guard itself logs no request contents or caller-supplied values. Rejections are
not passed to the operations body capture. The broader audit policy is unchanged.

## Verification

Normally discovered suites cover pure origin/config/header matrices, actual HTTP and
upgrade adapters with harmless state counters, real isolated backend state/upload/
remote/audit behavior, actual shared browser fetch/XHR paths, sandboxed previews,
multiple tabs, cross-site ancestors, HTTPS termination and a mocked private edge.
The Vite test starts the real proxy configuration at explicit alternate ports.

Browser fixtures use Chromium and synthetic local origins, not a deployed Hugging
Face edge. They verify both a preserved public Host and a loopback rewritten Host;
they do not claim production edge authentication/cookie behavior was live-tested.
They require the packages' dependencies, Chromium and OpenSSL for ephemeral fixture
TLS. Rejections are asserted via unchanged state, not just unreadable responses.

Policy references: [Origin](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin),
[Fetch Metadata specification](https://w3c.github.io/webappsec-fetch-metadata/),
[OWASP custom-header guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#employing-custom-request-headers-for-ajaxapi)
and [WebSocket origin validation](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html#origin-header-validation).
