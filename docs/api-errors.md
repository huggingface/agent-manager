# HTTP validation and failures

This is the compatibility inventory for the Express **4** request boundary.
The routes and successful payloads are unchanged. HTTP failures retain the
top-level `error` string used by copied shell/agent clients, and add `code`:

```json
{"error":"name: must not be empty","code":"invalid-input","details":[{"field":"name","message":"must not be empty"}]}
```

`error` is display text, not HTML; clients branch on `code`, not English.
Expected exceptions use `ApiError`. Arbitrary exceptions (including library
errors carrying their own `status`) do not authorize exposing their messages.
Unexpected errors return a generic 500. Legacy local 5xx JSON replies are also
sanitized before the audit recorder sees them. An optional `requestId` is a
server-generated UUID, never a request-supplied identifier. No exception body,
stack, upstream response or new secret-bearing diagnostic is logged here.

## Status and code contract

| Status | Codes | Safe extra data / meaning |
| --- | --- | --- |
| 400 | `invalid-input`, `bad-request`, `invalid-json`, `invalid-path` | `details: [{field,message}]`; no rejected values echoed |
| 400 | `origin-required`, `unknown-origin` | Existing attribution requirement, unchanged ordering |
| 400 | `bad-repo`, `not-a-bundle` | Existing import refusals |
| 400 | `request-aborted` | Upload/body interrupted before a response was committed |
| 403 | `locked` | `reason: public-space`; health/info/visibility remain accessible |
| 403 | `forbidden`, `no-access`, `no-hf-token`, `backup-unavailable` | Expected access/capability refusal |
| 404 | `not-found`, `api-not-found` | Missing item versus nonexistent API route |
| 404 | `no-trace`, `unsupported-harness`, `trace-not-user-conversation` | Expected Reader availability, not a failed fetch substituted with empty content |
| 409 | `conflict`, `not-archived`, `input-not-ready`, `invalid-workspace`, `remote-agent`, `cron-unavailable`, `backup-running`, `no-transcript` | Action cannot run in the current state; not permission to replay it |
| 409 | `file-changed` | Existing `mtime` preserved; browser also retains `tag`/`currentTag` when supplied by file-save endpoints |
| 409 | `redaction-blocked` | Existing `hits` rule/count map preserved |
| 409 | `conflict` on paused remote messages | Existing `stop` and `reason` retained, plus additive `error`/`code` |
| 413 / 415 / 429 | `payload-too-large` / `unsupported-media-type` / `rate-limited` | Body limits, media/encoding policy, existing rate limits |
| 5xx | `internal-error` | Generic safe message; optional bounded `requestId` |

`reason`, `hint`, `hits`, `mtime`, `tag`, `currentTag`, `retryAfter`, and
`details` are optional, not universally present. The browser retains these
allowlisted fields in `ApiError.data`, with bounded strings/collections. It
retains `status` even for an unreadable proxy response. No automatic retry,
new timeout policy, mutation replay or delivery guarantee is added.

## Route / response / mutation inventory

Paths below are relative to `/api`. The handler inventory was checked against
main `ef08e843d1c67fcc4e1c463415819ea351734d6d`, rather than relying on planning
line numbers. `apiRoutes` covers every API registration in `index.js`, including
the generated `mkdir`/`touch` routes. Global JSON parsing, privacy lock and
operation attribution stay in their original order; validation runs after
route-specific parsers and before the final action. The separate browser-origin
and audit-filter work is not reimplemented here.

| Routes | Forms and responses | Mutation / compatibility notes |
| --- | --- | --- |
| GET `health`, `info`, `visibility`, `clis`, `tree`, `sessions`, `next-name` | JSON | Health/public lock exceptions unchanged; next-name validates CLI |
| GET `usage`, `operations`, `traces`, `meta`, `meta/:id` | JSON | Provider enum; operation limit 1–1000, existing timestamp cursor; optional provider/digest subsystem fallbacks remain local |
| POST `push/subscribe`, `push/unsubscribe`, `notify` | JSON command | Subscription structure, endpoint and notification fields validated before dispatch; notification zero-device/per-device partial outcomes remain **200 `ok:false`** |
| POST `sessions` | JSON creation, 201 | CLI required; optional name/prompt/path; blank name retains generated default, blank path retains workspace root; group must exist; optional prompt still starts asynchronous work |
| PUT `sessions/:id` | JSON selected-field update | Display name only, no folder rename |
| POST `sessions/:id/input`, `attachments/insert` | JSON command | Text / attachment ID types checked before resolution or agent input; existing attachment limits and insertion acknowledgement unchanged |
| POST `sessions/:id/attachments` | Raw bytes, 201 JSON metadata | Any file media type, including JSON, bypasses JSON parser; existing quotas, image validation and cancellation retained |
| DELETE `sessions/:id/attachments/:attachmentId`; GET `…/raw` | JSON command; binary stream | Stream errors before headers are JSON, after headers terminate; disconnect destroys file source |
| GET `agents`, `agents/:id`, `…/tail`, `…/subagents`, `…/subagents/:agentId` | JSON | Tail line integer validation with existing 2000-line clamp (including clients requesting more), trace query validation; roster/trace distinctions retained |
| GET `agents/:id/wait` | JSON long poll | State list, timeout 1–300 s, settle 0–60 s; existing wait/deadline behavior retained, disconnect stops polling |
| POST `agents`, `agents/:id/prompt`, `agents/:id/stop` | Text body **or** JSON `prompt` / `text`; `from` body/query, launch CLI/name/path/group query aliases | Preserve curl's non-JSON default content type as literal prompt text, not form decoding. Sender, target, installed CLI, self-target and group resolution checks remain before action |
| GET `remote/:name/ping`, `…/messages`, `sessions/:id/remote`; POST `remote/:name/hello`, `sessions/:id/remote/paused` | JSON | Remote peer strings/paused boolean; scalar sequence cursor; existing remote-origin fallback unchanged |
| POST `remote/:name/messages`; GET `…/prompt`, `…/stream` | Text/JSON message command; plain-text instructions; heartbeat/NDJSON long poll | Paused poll's **200 stop result** is deliberate; paused message is 409. Stream sends connected/heartbeat/one JSON line, never JSON error appended after bytes. Wait remains 5–1800 s, no global short timeout |
| POST `demo`, `welcome/seen`, `relaunch`, `update`; GET `update/check` | JSON commands/status | Demo boolean. `no-space`, `no-token`, `cooldown`, `busy`, `upstream-unreachable` and upstream refusal capability results remain **200 `ok:false`**; thrown request failures now return safe 500 |
| GET/PUT `config` | JSON **replacement** | Omitted sections/fields keep existing replacement defaults; booleans are not coerced; explicit zero, false and backup `exclude:[]` preserved. No durable-store/recovery rewrite |
| GET/PUT `secrets` | JSON notes-map replacement | Notes contain arbitrary user-defined keys with string values, including empty strings; no global field stripping |
| GET `backup/status`; POST `backup/run` | JSON status / starts asynchronous Job | Missing prerequisites, already-running and bad IDs explicitly classified; status subsystem's optional lookup fallbacks unchanged; no Job lifecycle redesign |
| GET `skills`, `skills/:name`; PUT/DELETE `skills/:name` | JSON listing/read; text replacement / delete | PUT must decode to a string, including valid empty text; JSON objects cannot silently overwrite a skill with empty text; distribution remains best effort |
| GET `files/:id`, `…/preview`, `folders` | JSON | Scalar paths; existing lexical/realpath, file-kind and size checks retained |
| GET `files/:id/raw`, `…/download`, `trace/:id/download` | Binary/download stream | Existing sandbox/content-disposition headers; explicit callback forwarding; no JSON appended after headers |
| PUT `files/:id/write` | Text replacement, JSON result | Valid empty text allowed; existing `base` revision precondition, text-size and path checks retained; JSON objects rejected before writing |
| POST `files/:id/mkdir`, `…/touch`, `…/rename`, `…/move`; DELETE `…/entry` | JSON commands | Single filename / destination types validated before filesystem changes; root/dependency/existing-entry checks retained |
| POST `files/:id/upload` | Raw bytes → JSON completion | Raw JSON files also bypass body parsing. One completion/error path; abort unpipes/closes destination and releases listeners. Existing overwrite policy unchanged (separate file-protection work) |
| POST `overview/hidden`, `move`; POST/PUT/DELETE `groups[/id]` | JSON | Hide boolean/ref; live move targets; group PUT is a selected-field patch, not replacement. `layout:null` means auto; explicit layout is 1–3 rows/columns; session ordering retains live membership checks |
| GET/POST `crons`; PUT/DELETE `crons/:id`; POST `…/run` | JSON; creation 201, manual fire 202 | Create requires name/agent/prompt/five-field schedule/time zone. PUT patches selected fields, nested agent/schedule objects still replace as before. Strict runOnRestart/state types. 202 means accepted, not finished; later failure stays in `last` with safe text. No target identity/scheduling behavior change |
| GET/POST `sessions/:id/share`; GET/POST `share/access` | JSON | Visibility/name/user lists validated; redaction 409 and successful share's `granted`/`grantErrors` retained. Partial grant errors get a safe message/code; best-effort access-list lookups remain unchanged |
| POST `trace/import`; GET `trace/bundles` | JSON | Bare repo or pasted dataset URL still supported; known domain codes kept. No safe re-import/transaction changes |
| GET `trace/:id`, `…/location`, `files/:id/trace`; PUT `trace/:id/source` | JSON trace pages/windows/summary; selected source update | Trace modes mutually exclusive; safe nonnegative integer cursors, v1/v2; existing page/window-size clamps retained (500 turns / 8 MiB). Source kind enum, ref/target checks before storing |
| POST `sessions/:id/archive`, `…/unarchive`, `…/stop`; DELETE `sessions/:id` | JSON commands | Existing archive/delete and `ifNeverStarted=1` rules unchanged; optional attachment cleanup remains isolated |
| `/ws` | WebSocket terminal protocol | Not JSON wrapped; framing, origin admission and terminal lifecycle unchanged |
| Other `/api` paths; static assets and SPA paths | API 404 JSON; ordinary static/SPA responses | API errors never fall through to an HTML application page; non-API failures remain Express/static concerns |

## Validator conventions

- Validate at the route boundary before any domain action, not only in TS.
  Schema helpers distinguish missing values from null/empty/false; no generic
  truthiness or numeric-string conversion for JSON. JSON-only routes require
  `application/json` when a content type is supplied. Malformed JSON, unsupported
  encodings and parser limits get deliberate JSON errors. Express's strict
  parser rejects scalar JSON documents (including bare `null`).
- Queries are scalar strings: duplicate/bracket-structured parameters are
  rejected. Numeric query fields use complete integer syntax, safe integer
  bounds and route limits. Existing documented clamping of trace size budgets
  stays in the domain reader. Paths reject null characters and retain existing
  containment checks; do not introduce a second path resolver.
- Unknown fields retain each endpoint's existing handling, usually ignored.
  No input object is stripped or rewritten by validation. Notes-map extension
  keys remain supported. Intentional empty group names on creation, empty text
  file replacement and null group layout keep their special meaning.
- Schedule validation is reused, with a public validation error instead of
  arbitrary parser exception text. Store schemas/durability, scheduler identity,
  import replacement, async work receipts and delivery retries are separate work.

## Adding a handler and client

```js
// server/src/index.js — register via api, not app, and add its input case to
// createValidator. Use ApiError only for a message known to be public.
api.post('/api/example', async (req, res) => {
  if (!available()) throw new ApiError(409, 'example-unavailable', 'Try after the current task finishes.');
  res.json(await performValidatedAction(req.body));
});
```

Promise rejections and synchronous throws enter one Express error path. For
event emitters, explicitly forward errors and remove timers/listeners on close;
the promise wrapper cannot catch unrelated future callbacks. Downloads pass
their callback error to `next`; `pipeResponse` and `remoteStream` demonstrate
the before/after-headers distinction. A late failure after a completed response
is consumed, not sent again. Do not change status or append JSON to committed
stream bytes.

```ts
// web/src/api.ts — the existing local fetch keeps attribution; json uses the
// single decoder. For a text success, use decodeResponse(r, 'text').
export const example = (body: ExampleInput) =>
  fetch('/api/example', { method: 'POST', headers: HEADERS, body: JSON.stringify(body) }).then(json);
// UI: catch ApiError; display .message, branch on .code, inspect .data.
// Keep the draft and existing explicit failure actions; never replay here.
```

`decodeResponse` reads a failure body once, capped at 64 KiB, cancels oversized
reads, and never shows a proxy's HTML/status text. Empty success is allowed;
malformed expected-JSON success is `unreadable-response`. Legacy `{error:string}`
still works. AbortError identity remains intact for Reader cancellation;
`timeout`, `offline`, and `network-error` are distinct transport failures with
no HTTP status unless headers were already received. XHR remains the upload
transport: same decoder, progress, explicit cancellation and upload deadline.
TraceUnavailable and RedactionBlocked remain subclasses with their existing
constructors/fields; generic HTTP failures are not Reader empty states.

Tests: `server/test/api-boundary.test.mjs` exercises the real Express stack with
failure injection and fake action counters; `api-http.test.mjs` exercises the
production routes with isolated roots and mocked external calls. The discovered
web decoder and control tests exercise real fetch/XHR, Reader/file/share/group
controls and draft retention. No test sends real agent work or notifications.
