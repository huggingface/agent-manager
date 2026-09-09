# The privacy lock

Agent Manager has no login of its own. Its only access control is that the
Hugging Face Space it runs on, and the storage bucket mounted on it, are
**private**. The privacy lock is a safety net against accidental exposure: the
server keeps checking both, and while it cannot confirm they are private it
refuses to serve anything privileged — to new requests **and** to connections
that were already open.

It is not a substitute for keeping the Space and bucket private, it cannot make
a public bucket private, and it cannot take back anything that was already
delivered before it locked. Locking is what happens *after* something went
wrong; the fix is always on the Hub.

The model lives in `server/src/visibility.js`. Everything below describes that
file; keep the two in step.

## What is verified, and what counts as evidence

Three kinds of resource are checked, each against the Hub's public API. Only
the responses listed here produce a verdict. Everything else — redirects, HTTP
403/429/5xx, timeouts, network errors, non-JSON bodies, missing or wrong-typed
fields, a body about a different repo — is **no verdict**: the attempt is
recorded, the previous evidence is left exactly as it was, and the check is
retried next cycle.

| Resource | Request | Verdict rules (verified against the Hub on 2026-09-09) |
| --- | --- | --- |
| The Space | unauthenticated `GET /api/spaces/{id}` | `200` + JSON object with boolean `private` and the expected `id` → **public** if `private:false`, **private** if `private:true`. `401`/`404` + JSON object → **private** (the Hub answers `{"error":"Invalid username or password."}` for a repo the caller may not see). |
| Bucket discovery | authenticated `GET /api/spaces/{id}` (the `HF_TOKEN` secret) | `200` + JSON object with the expected `id` and a `runtime` object → **ok**; the mount list is every `runtime.volumes[]` entry with `type:"bucket"` and a string `source`. A Space with no storage has **no `volumes` key** — that is the legitimately-empty list. A `volumes` that is not an array, or a bucket entry without a string `source`, is invalid metadata: no verdict. If that body says `private:false`, that is also a public-Space verdict. `401`/`403`/`404` + JSON object → **unauthorized** (the credential cannot read this Space). |
| Each mounted bucket | unauthenticated `GET /api/buckets/{id}` | same rules as the Space. |

A valid response about one resource refreshes only that resource's
verification age. Every resource keeps two timestamps: `attemptedAt` (the last
completed attempt, success or not) and `verifiedAt` (the last response that
produced a verdict). Status responses expose both, so "we tried a minute ago"
and "we last knew a minute ago" are never confused.

## The effective state

One function derives the lock from the evidence; HTTP admission, live
connections and the status endpoints all read it. Public verdicts win, then
freshness, then the bucket policy:

| Situation | `locked` | `reason` | Notes |
| --- | --- | --- | --- |
| No `SPACE_ID` (local install, non-Space host) | no | – | Supported local mode. Nothing is checked. |
| Space verdict is **public** | yes | `public-space` | Locks the moment the verdict is accepted, inside any grace. Sticky: only a later valid *private* response for the Space clears it. |
| Any known bucket verdict is **public** | yes | `public-bucket` (+ `bucket`) | Same as above, per bucket. Known-public buckets are kept through later discovery failures; only a successful discovery that no longer lists the bucket drops it (logged). |
| Space never verified private in this process | yes | `checking` | Boot state. Also after a credential change until discovery is re-done. |
| Space verified private, but longer ago than the grace | yes | `verification-unavailable` | An outage of the check, not a claim of exposure. |
| Space fresh; discovery **unauthorized** | **no** | – | The documented warning-only mode: `bucketUnverified:true` is surfaced and the UI warns. The bucket is *not* called verified. |
| Space fresh; discovery has no verdict yet | yes | `checking` / `verification-unavailable` | A discovery outage is never treated as an empty mount list or as the unauthorized exemption. |
| Space fresh; discovery ok; some bucket not fresh | yes | `checking` / `verification-unavailable` | Whichever bucket is oldest decides. |
| Space fresh; discovery ok; every bucket fresh | **no** | – | Verified private. |

"Fresh" means a **private** verdict whose `verifiedAt` is less than the grace
ago. The grace is measured from that timestamp — never from an attempt, a retry
or a page visit — and repeated status reads do not extend it.

### The warning-only exemption, precisely

Bucket discovery needs a token the container does not otherwise have. The
exemption applies in exactly two cases:

- **No token.** None of `HF_TOKEN`, `HUGGING_FACE_HUB_TOKEN`, `HF_API_TOKEN` is
  set: discovery is skipped and the state is *unauthorized* immediately.
- **A token the Hub rejects for this Space.** The authenticated Space read
  answers `401`, `403` or `404` with a JSON body, three cycles in a row
  (`UNAUTHORIZED_CONFIRMATIONS`). Until the third answer the app stays locked
  (`checking`).

In both cases the Space itself still has to verify private. A network failure,
a `5xx`, a rate limit or a malformed discovery body is **not** the exemption:
those keep the app locked and are retried every cycle. Restoring a usable
credential is picked up on the next cycle (the evidence is keyed to the
credential's identity and invalidated when it changes); removing the token
switches to warning-only mode on the next cycle.

Fixing this properly means giving the Space a token with read access to it —
then the bucket is verified for real, and the warning disappears.

## Timing

| Constant | Value | Why |
| --- | --- | --- |
| `CHECK_MS` | 60 s | One verification cycle per minute; also how quickly a fix on the Hub reopens the app. |
| `GRACE_MS` | **150 s** (2.5 cycles) | How long verified-private evidence stays good without a fresh success. Two consecutive failed checks are tolerated; the app locks before the third completes. Chosen as a short, fixed constant — long enough that one Hub hiccup does not close every terminal, short enough that a real outage is visible within minutes. Not configurable from the UI. |
| `HF_TIMEOUT_MS` | 8 s | Per Hub request. |
| `CYCLE_BUDGET_MS` | 25 s | Whole cycle, all resources. A cycle that overruns is aborted; its late results are discarded. |
| `MAX_BUCKETS` | 8 | Buckets verified per cycle. Any beyond that stay unverified (locked), which is a misconfiguration worth noticing. |

Expiry is a timer armed from the oldest required `verifiedAt`, so the lock
lands on time even while a check is hung. Nothing about the lock is persisted:
a fresh process starts locked (`checking`) and earns its own evidence — no
grace is ever carried across a restart.

Checks are single-flight and generation-tagged: a cycle that is still running
when a new one is due is joined, not duplicated; a result from an aborted or
superseded cycle is ignored even if it arrives later, so it can neither reopen
access nor overwrite a newer public verdict. Status reads (`/api/info`,
`/api/visibility`) read cached state and never cause a Hub request.

`AM_VISIBILITY_CHECK_MS` and `AM_VISIBILITY_GRACE_MS` shorten the cycle for
tests. Leave them unset in a deployment.

## What a lock does

On every transition into a locked state, the server:

1. **Refuses new privileged requests.** Every `/api/*` route answers
   `403 {"error":"locked","reason":"<reason>"}` (plus `"bucket"` for
   `public-bucket`). The exceptions are the deliberately safe trio
   `/api/health`, `/api/info` and `/api/visibility`, and static assets, so the
   lock page can render and explain itself. `/api/info` withholds secret names
   and backup details while locked.
2. **Refuses new terminal attachments.** A WebSocket is closed with code
   `4003` and reason `locked:<reason>` before anything is attached or replayed.
3. **Revokes connections admitted before the lock**, on the server, whether or
   not any browser is awake:
   - open terminal sockets are detached from their session and closed with
     `4003 locked:<reason>`; frames already in flight are dropped, later input,
     resize and claim frames are ignored, and a peer that never answers the
     close frame is terminated after 2 s;
   - `/api/agents/:id/wait` long polls end at once with the 403 above;
   - remote agents' `/api/remote/:name/stream` polls end with the protocol's
     own `{"stop":true,"reason":"the manager locked itself (…)"}` line — a
     queued prompt never rides out through an admitted poll. Their next call is
     refused with the 403; the agent's loop ends and has to be reconnected by
     hand once the lock clears;
   - any other `/api` response still open — a download mid-stream, an upload
     still arriving, a handler still working — has its connection destroyed.
     Nothing further is delivered or read on it.

**Commit boundary.** Revocation detaches clients; it does not kill, restart or
re-prompt agents, delete sessions or touch histories. Work a handler had
already committed stays committed (writes are atomic, so a cut connection
cannot half-write a file), an upload cut mid-body is not committed, and nothing
is replayed when the app reopens — a browser that lost a mutation to the lock
sees the error and decides for itself.

Reopening follows the normal rules: a terminal reattaches and replays the
retained screen of the still-running agent; no new process is started and no
input is repeated.

## What the browser does

The app learns the state through one shared channel (`web/src/lib/lockStatus.ts`):

- every `/api` response of `403 {"error":"locked"}` and every terminal socket
  closed with `4003` announce the lock; the app applies it immediately and
  fetches `/api/info` for the full explanation;
- `/api/info` is fetched on load, on return to the tab (and back online), and
  every 15 s while locked — so an open app reopens by itself within a check
  cycle of the lock clearing;
- observations are ordered twice over. By request: a lock seen through any
  channel opens a new epoch, and an "unlocked" status is applied only if it was
  requested after the last lock observation. By server state: every status
  carries the server's transition counter (`seq`) and a per-process `boot` id;
  after a lock observation an "unlocked" status must carry a `seq` newer than
  anything applied before the lock, so even a late answer to a post-lock request
  cannot reopen the app with pre-lock state. A new `boot` (the server restarted)
  starts the counting over.

While locked, protected polling stops, the protected view is unmounted (no
terminal, Reader or composer stays in the DOM beneath the lock page), and the
terminal pane does not reconnect on `4003`. Selection, Reader position and
unsent drafts live in the app's existing local state and storage, so they are
where they were when the app reopens. A tab that was hidden when the lock
landed shows its last screen until it returns; its live connections were
nevertheless cut by the server the moment the lock landed.

The lock page has one explanation per reason: the setup guide for a public
Space, a warning naming the public bucket, "checking" for a fresh start, and a
verification-outage page that says plainly that an outage is not proof of
exposure and does not ask anyone to duplicate the Space.

## Limits

- Detection is only as fast as the cycle: a Space flipped public on the Hub is
  noticed within about a minute, and whatever was served in between was served.
- Verification talks to `huggingface.co`. If the Space cannot reach it for
  longer than the grace, the app locks even though nothing is public; it
  reopens on its own when the Hub is reachable again.
- The warning-only mode is deliberate compatibility, not verification: without
  a usable token the bucket's visibility is unknown, and the operator has to
  check it.
- Everything here was tested against a local fake of the Hub's API, with the
  response shapes recorded above. Behaviour at the real hosting edge (for
  example a `hf.space` proxy page in front of an error) is covered only in so
  far as it produces one of those shapes; anything else is "no verdict", which
  fails closed.
