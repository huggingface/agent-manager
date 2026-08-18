# File and screenshot input

Status: implemented in draft PR

Date: 2026-08-06

## 1. Summary

Let the operator attach local files to an agent prompt by:

- pasting files or screenshots from the browser clipboard;
- dragging files onto a prompt or terminal pane; or
- choosing files with a small attachment button in live views.

The browser uploads the bytes to Agent Manager. Agent Manager stores them
outside the user's repository, then gives the target CLI a server-local path.
Raster images additionally use native image interfaces where the harness has a
reliable one. The prompt remains text at the PTY boundary; no binary data is
sent through xterm or terminal escape sequences.

The first version covers local agent sessions. Remote agents need an additional
download protocol because they do not share the Space's filesystem and are a
separate phase.

## 2. Why this shape

Three constraints decide the architecture.

### 2.1 The browser and the CLI have different clipboards

The browser receives a pasted screenshot as a `ClipboardEvent`/`File`. The agent
CLI runs in a headless container and can only inspect that container's OS
clipboard. Asking Claude, Codex, Hermes, or another TUI to read its clipboard
therefore cannot see what the operator copied on their laptop or phone.

Agent Manager's existing mobile paste code already documents the same boundary:
direct browser clipboard access may also be unavailable inside the Hugging Face
cross-origin iframe, while a user-driven DOM `paste` event remains readable.

Hermes Agent's own browser dashboard independently uses the intended bridge:
extract image files from the browser transfer, upload them to the gateway, then
drive the server-side TUI with the resulting local path. This is useful prior
art, not an integration dependency.

### 2.2 Agent Manager's terminal transport is text

Overview replies call `POST /api/sessions/:id/input`, `deliver()` starts the
session when needed, and `runner.sendInput()` writes a bracketed text paste plus
a separate Return key to the PTY. A live browser pane similarly sends xterm input
as WebSocket `{t:'i', d}` frames.

That transport should stay text. Sending an image through a PTY would require a
terminal graphics/clipboard protocol and corresponding support in every TUI.
Those protocols do not solve the browser/container clipboard boundary and would
couple Agent Manager to terminal-specific behavior.

### 2.3 Coding CLIs already understand local file paths

The exact native image affordance differs by harness, but a server-local path is
the common denominator for images, PDFs, Office documents, archives, source
files, and other regular files:

| Harness | Observed path as of this design | First implementation |
|---|---|---|
| Claude Code | accepts an image path in a prompt; native terminals also support image paste/drop | explicit absolute path in the prompt |
| Codex | `-i/--image` supports initial images; in-session image paste reads the server clipboard | native `-i` on the first turn plus an explicit path fallback |
| Gemini CLI | `@<path>` injects supported images as multimodal context | `@<absolute-path>` |
| opencode | TUI image drop and `opencode run -f/--file` are supported | explicit/drop-style absolute path |
| Hermes | the current TUI supports `/image <path>` and detects a pasted standalone image path | `/image <absolute-path>` adapter, with explicit-path fallback |
| OpenClaw | no stable image-attachment CLI contract was verified | explicit path, best effort |

Every adapter must retain the explicit-path fallback. Native image flags and
TUI commands change faster than Agent Manager, while a file that exists and a
prompt that names it remain inspectable by an agent with filesystem and vision
tools.

## 3. Goals

1. Paste a file or screenshot into any local agent input without first saving it
   by hand.
2. Drag one or more regular files onto the input or terminal pane.
3. Work in the Hugging Face iframe and on phone-sized layouts.
4. Make upload progress, success, and failure visible.
5. Never submit a partially uploaded or missing attachment.
6. Avoid modifying or dirtying the user's repository.
7. Keep the attachment available for the lifetime of the session so resumed
   agents can still inspect it.
8. Preserve ordinary text paste and Agent Manager's existing pane drag/drop.
9. Use bounded streaming uploads so files do not block the process that pumps
   every PTY.
10. Preserve native image behavior while making non-image files available by
    explicit local path.

## 4. Non-goals

- Images in agent-to-agent prompts. Agents inside the Space can already write a
  file and reference its path.
- Synchronizing the operator's filesystem with a remote agent's filesystem.
- Making xterm render an attachment editor inside a third-party TUI.
- Automatically publishing screenshots with shared session traces.
- OCR, resizing, transcoding, or other server-side image processing.
- Replacing the PTY integration with each harness's structured SDK/server API.

## 5. User experience

### 5.1 Composers

The Sidebar quickstart, Overview reply, and rendered reader composer share the
same paste/drop behavior:

- Pasting a file adds a chip and does not insert binary or fake text
  into the textarea.
- Dropping files over the composer shows a restrained dashed highlight and
  adds the same chips.
- Overview exposes a file button in its reply row. Reader and live-terminal
  views share the pane header's attachment button; it targets the reader draft
  or terminal insertion flow according to the visible mode. Each uses an
  unrestricted `<input type="file" multiple>`. Quick creation intentionally
  stays prompt-first and accepts paste/drop without another picker.
- Image chips show thumbnails; other files show a compact extension badge.
- The prompt may contain text plus files or files alone.
- A files-only submission uses `Please inspect the attached file.` (or `files`
  for several) as its text. Image-only server delivery retains the more specific
  `screenshot` wording.
- At most five files may be attached to one prompt.
- Choosing, pasting, or dropping a file starts its upload immediately. Each
  chip shows transferred bytes, percentage, and server-confirmed success.
- The send button is disabled until every upload has succeeded.
- A failed upload leaves the draft and pending files intact, names the exact
  server/connection failure next to the affected chip, and offers retry when
  retrying the same bytes can help.
- The chip's × remains available during transfer. It aborts an in-flight upload;
  removing a server-confirmed but unsent chip also deletes that stored file and
  immediately lets the remaining text/files send.

Pending files remain browser `File` objects for retry even after the server has
stored them. `URL.createObjectURL()` supplies local previews and is revoked when
a chip is removed or the component unmounts. Successful files are session-owned
and follow that session's existing deletion/pruning lifecycle.

### 5.2 Rendered terminal reader

Reader mode covers a still-mounted terminal with a structured conversation and
its own reply composer. The pane header keeps one attachment button in both
views; while the reader is visible it opens the reader's hidden picker instead
of the terminal's. The resulting chips, byte progress, failure reason, Cancel,
and Retry stay above the fixed composer because they belong to—and gate—that
draft. Paste, drop, upload, and structured `/input` delivery use the same queue.
Terminal upload status, the mobile key bar, and fallback paste sheet stay hidden.
Otherwise a file chosen while reading would be inserted into the invisible
xterm prompt instead of being part of the visible reply.

The rendered reader and Overview both permit text-plus-file and file-only turns,
preserve the text draft behavior introduced by the reader, and keep failed
uploads available for retry.

### 5.3 Live terminal panes

xterm owns the visible composer, so Agent Manager cannot reliably place its own
persistent attachment chips inside it. File paste/drop therefore behaves as a
short transaction:

1. Show `uploading file · 0%` over the bottom of the pane and update it as bytes
   transfer.
2. Upload the file without sending a prompt.
3. On success, attach it through the harness adapter or paste a formatted path
   reference into the CLI composer.
4. Return focus to xterm. The operator can keep typing and presses Enter when
   ready.

The upload status includes a Cancel action while bytes are transferring. A
saved-but-not-inserted file offers both Retry and Remove, so an insertion failure
does not trap the terminal attachment affordance.

The pane header's attachment button starts that transaction. Progress and
recovery remain in the terminal overlay rather than competing with the header's
compact attach/search/info/close cluster; unlike the reader, xterm has no visible
Agent Manager draft queue to hold chips.

An upload must never auto-submit the agent's prompt. Inserting the attachment and
submitting are separate actions, matching native TUI image paste behavior.

Only file-bearing drag events are claimed. Session/pane drag data continues to
reach the existing group layout handlers. The terminal drop target sets
`dropEffect='copy'`; pane reordering keeps `move`.

### 5.4 Mobile paste

The existing key-bar Paste action becomes file-aware:

1. Try `navigator.clipboard.read()` inside the button's user gesture and extract
   one preferred representation per file item (native raster first). Rich text
   with a `text/plain` representation remains text rather than becoming a file.
2. If no file exists, try `navigator.clipboard.readText()` and retain current
   text behavior.
3. If either API is missing or denied, open the visible fallback textarea.
4. Its `onPaste` handler checks `clipboardData.items` for files before reading
   `text/plain`.

This keeps the cross-origin iframe fallback as the load-bearing path rather than
assuming async Clipboard API permission.

### 5.5 Remote panes

The attachment affordance is disabled for remote sessions in phase one, with:

> Files are not available for remote agents yet — that agent cannot read
> files stored on this Space.

Silently inserting a Space path would be worse: it looks attached in the UI but
cannot exist on the remote machine.

## 6. Data model and storage

### 6.1 Location

Managed files live at:

```text
${STATE_DIR}/attachments/<session-id>/<attachment-id>-<safe-original-name>
```

This is deliberately outside `WORKSPACES_DIR`:

- attachments do not appear as untracked repository files;
- Agent Manager owns their lifecycle;
- several sessions sharing one working directory do not share an attachment
  namespace;
- a later remote download endpoint can reuse the same store; and
- the mounted `/data` bucket keeps them across browser disconnects, Space sleep,
  and process restarts.

Attachment ids are generated by the server. The client filename is decoded,
reduced to a basename, stripped of control/path characters, and bounded before
it is appended to that id. Keeping the safe name preserves extensions required
by tools that inspect PDF, DOCX, archive, source, and data files.

### 6.2 Attachment shape

```ts
interface Attachment {
  id: string;        // att_<random>, scoped to the session
  kind: 'image' | 'file';
  name: string;      // sanitized original name; image extension is corrected
  mime: string;
  bytes: number;
  path: string;      // absolute server path; used by the CLI adapter
  previewUrl: string;
  insertText: string; // safe fallback for direct terminal insertion
}
```

The attachment id is untrusted input everywhere it returns from the browser.
Accept only `^att_[a-f0-9]{24}$`, resolve the extension by listing/looking up the
session's own directory, and never join an arbitrary browser-supplied filename.

### 6.3 Lifecycle

- Composer and terminal files are uploaded immediately on attachment. Prompt
  delivery only reuses server-confirmed attachment ids; it never starts an
  upload.
- Quick creation first allocates a stopped session because attachment ids are
  session-scoped, then immediately uploads into it without launching the CLI.
- Closing quick creation aborts its transfers and conditionally deletes that
  placeholder session. The server refuses the conditional delete once the
  session has ever started, so a target the operator deliberately opened is
  retained. An invalid/restored selection falls back to Overview rather than to
  the new placeholder, preventing its terminal pane from mounting implicitly.
- Removing a successful unsent chip, or unmounting its composer, deletes the
  stored file. A successful send deliberately keeps it for the session.
- Successful attachments remain while the session exists, including while it
  is stopped.
- Deleting a session removes its managed attachment directory. It does not
  affect files in the session workspace, preserving the existing session-delete
  contract.
- Startup may prune attachment directories whose session no longer exists and
  whose newest file is older than seven days. The grace period covers a crash
  between session persistence and upload completion.
- Failed and aborted uploads delete their temporary file immediately.
- Each file is capped at 100 MiB; each session is capped at 200 stored files and
  500 MiB. Uploads for one session are serialized so concurrent requests cannot
  race the quota check.
- Pruning and session deletion use asynchronous filesystem operations so a
  large attachment store cannot block terminal I/O.

No separate database is required. The session-scoped directory, validated id,
extension, and `stat` provide the metadata needed in v1.

## 7. HTTP API

### 7.1 Upload

```http
POST /api/sessions/:id/attachments
Content-Type: application/pdf
X-File-Name: brief.pdf

<raw bytes>
```

Successful response:

```json
{
  "id": "att_74e0f69dc9ed772cb685999e",
  "kind": "file",
  "name": "brief.pdf",
  "mime": "application/pdf",
  "bytes": 184332,
  "path": "/data/state/attachments/session-id/att_74e0f69dc9ed772cb685999e-brief.pdf",
  "previewUrl": "/api/sessions/session-id/attachments/att_74e0f69dc9ed772cb685999e/raw",
  "insertText": "File: /data/state/attachments/session-id/att_74e0f69dc9ed772cb685999e-brief.pdf "
}
```

The request body is streamed to a temporary file. While streaming, count bytes
and abort with `413` above 100 MiB. Once complete:

1. Read the first small header from the temporary file.
2. Detect PNG, JPEG, GIF, or WebP by magic bytes. Correct misleading image
   metadata from those bytes and validate the complete image envelope.
3. If a supported raster image is claimed but its bytes are invalid, reject it
   with `415`. Otherwise preserve the regular file as an opaque attachment.
4. Sanitize the basename and rename atomically under the generated id.
5. Return `201`.

Do not base64-wrap attachment data in JSON. Base64 adds roughly one third to
transfer size and forces both browser and server to hold large strings in
memory. The existing Files upload route is a good streaming pattern, but it is
not reused directly because it writes into the user workspace and has different
overwrite semantics.

Errors:

| Status | Meaning |
|---|---|
| `400` | session cannot accept files or malformed request |
| `404` | unknown session/attachment |
| `413` | empty, larger than 100 MiB, or over the session quota |
| `415` | a claimed PNG/JPEG/GIF/WebP is malformed |
| `429` | per-session upload backstop exceeded |
| `500` | durable write failed |

Use a small backstop such as 20 uploads/minute/session. This is not the security
boundary—the private Space is—but protects the terminal process from accidental
paste/drop loops.

### 7.2 Preview

```http
GET /api/sessions/:id/attachments/:attachmentId/raw
```

Return the detected MIME with:

```text
X-Content-Type-Options: nosniff
Content-Security-Policy: sandbox
Cache-Control: no-store
```

Validated raster images use `Content-Disposition: inline` for chip previews.
Every other file uses `Content-Disposition: attachment`; combined with `sandbox`
and `nosniff`, HTML, SVG, Office, PDF, and other browser-capable formats cannot
become active content in the Agent Manager origin.

Attachments may contain sensitive material, so use `Cache-Control: no-store` in
the first version. If bucket reads become measurable, a short private cache can
be evaluated later without making year-long browser retention the default.

### 7.3 Remove unsent state

```http
DELETE /api/sessions/:id/attachments/:attachmentId
DELETE /api/sessions/:id?ifNeverStarted=1
```

The first route removes one canceled/unsent stored file. The second is the quick
creation cleanup guard: it returns `409` rather than deleting a session whose
`everStarted` flag is true. Ordinary session deletion remains unchanged.

### 7.3 Send a structured prompt

Extend the existing route without breaking text-only callers:

```http
POST /api/sessions/:id/input
Content-Type: application/json

{
  "text": "Match this layout",
  "attachmentIds": ["att_74e0f69dc9ed772cb685999e"]
}
```

The server resolves every id inside that session's attachment directory before
starting or typing into the CLI. Unknown ids reject the whole request; never send
a prompt with only a subset of its files.

`attachmentIds` defaults to `[]`, preserving every existing UI and API caller.
The agent-to-agent `text/plain` route remains unchanged.

## 8. Prompt delivery

### 8.1 One normalized input

Refactor delivery conceptually to:

```js
deliver(session, { text, attachments }, from)
```

The HTTP route validates and resolves attachment ids, then the harness adapter
turns `{text, absolutePaths}` into one of:

- a textual prompt containing explicit file paths;
- a path-injection syntax such as Gemini's `@path`; or
- a short TUI attachment command followed by the textual prompt.

The normalized prompt recorded in traces should remain legible even when the
harness receives a native attachment:

```text
Match this layout

Attached files:
- /data/state/attachments/<session>/<attachment>-brief.pdf
```

This is also the universal fallback. Do not include base64 data in the prompt or
trace.

### 8.2 Adapter interface

Keep version-sensitive behavior in one module rather than scattered across React
components and `runner.js`. The implementation exposes the universal formatted
prompt and any native prelude commands separately:

```ts
formatAttachmentDelivery(cli, text, attachments): string
formatAttachmentPrelude(cli, attachments): string[]
```

Initial adapters:

- `gemini`: append `@<escaped-absolute-path>` tokens to the prompt.
- `hermes`: send `/image <quoted-path>` + Return for each image, then send the
  prompt. If the command is unavailable, use the universal prompt.
- all others and all non-image files: use the universal explicit-path prompt.

opencode `--file` and other native launch flags are optional follow-ups. Codex
uses its installed `--image` support on a first turn; every adapter retains the
explicit path so a missing or changed native flag is not the only route to the
file.

### 8.3 First prompt without a boot race

The quickstart path currently places an initial prompt on the CLI launch command
because typing into a booting TUI could lose it. On the first attachment it uses
a two-step browser flow—create a stopped session, then upload to its attachment
scope—so `deliver()` must preserve that property:

1. `POST /api/sessions` without a prompt creates a stopped session.
2. Upload each file immediately to the returned session id, with byte progress.
3. When the operator launches, `POST /api/sessions/:id/input` with text and the
   already-uploaded attachment ids.
4. If the session has never started and its CLI has `withPrompt`, store the
   fully formatted prompt as `pendingPrompt`; for Codex, also retain the
   validated image paths as `pendingImagePaths`; then call `ensureRunning()`.
5. `commandFor()` consumes those fields on the first launch, adding one Codex
   `-i` flag per image, and clears them once the PTY starts.

Only resumed or already-started sessions use the existing boot-then-type path.
If attachment upload fails after session creation, keep the stopped session and
the browser draft while the dialog remains open so Retry can reuse it. Closing
the dialog abandons that work and conditionally deletes the never-started target.

### 8.4 Terminal insertion

Live terminal paste/drop does not call `/input`, because `/input` submits a turn.
After upload, it asks the server to insert the resolved attachments without a
Return key:

```http
POST /api/sessions/:id/attachments/insert
Content-Type: application/json

{"attachmentIds":["att_74e0f69dc9ed772cb685999e"]}
```

The server writes `insertText` to the running PTY and acknowledges only after
the write is accepted. It never sends Return. If the process stops after upload,
the browser says the file was saved but not inserted and retains its attachment
id behind a Retry action. This avoids treating a browser-local xterm paste as
proof that a disconnected or non-controlling pane reached the CLI. Completed
terminal insertions are idempotent by attachment id, so retrying after a lost
HTTP response cannot paste the same path twice.

Hermes is the one useful native exception: the server may send `/image <path>`
and Return, briefly wait for the command to settle, and then restore focus without
submitting the actual prompt. This logic should still live behind the same
adapter and fall back to `insertText`.

## 9. Frontend structure

Add a small module, `web/src/lib/attachments.ts`, containing:

- image-preview MIME hints and a client-side 100 MiB check;
- `filesFromTransfer(DataTransfer)`;
- `transferMayContainFile(DataTransfer)`;
- duplicate suppression across `items` and `files`;
- local preview creation/revocation; and
- sequential upload helpers that report progress and preserve per-file errors.

Use sequential uploads initially. Five files is the maximum, bucket writes are
the bottleneck, and simpler ordering makes chip status deterministic.

Add a reusable `Attachments` chip row used by Sidebar and Overview. The
terminal imports only the transfer/upload helpers.

Expected file changes:

| File | Change |
|---|---|
| `web/src/api.ts` | attachment types, progress-aware XHR upload, preview URL, `sendInput(..., attachmentIds)` |
| `web/src/lib/attachments.ts` | clipboard/drop extraction and pending-file lifecycle |
| `web/src/components/Attachments.tsx` | image previews, file badges, picker, progress/error states |
| `web/src/components/Sidebar.tsx` | quickstart paste/drop, stopped-target creation, and immediate upload |
| `web/src/components/Overview.tsx` | reply attachments and file-only send |
| `web/src/components/TerminalPane.tsx` | capture-phase file paste/drop and mobile file paste |
| `web/src/components/conversation/ConversationView.tsx` | rendered-reader attachments and structured send |
| `web/src/styles.css` | chips, drop highlight, terminal upload overlay |
| `server/src/attachments.js` | storage, validation, lookup, preview, cleanup |
| `server/src/index.js` | routes and structured delivery |
| `server/src/runner.js` | adapter prelude sequencing/first-prompt support if needed |
| `server/src/config.js` | optional per-harness attachment-directory access flags |

## 10. Security and privacy

### 10.1 Treat browser metadata as untrusted

- Detect native/inline raster images from bytes, not `Content-Type`, extension,
  or `File.name`.
- Treat every non-raster format—including SVG and HTML—as an inert file and
  force download; never render it as active content in the app origin.
- Generate the attachment id server-side and reduce the client name to a
  bounded, control-free basename.
- Resolve only under a fixed session attachment root.
- Refuse symlinks and non-regular files during lookup/preview.
- Cap bytes while streaming and remove partial files on abort/error.
- Use `wx`/exclusive temporary creation and atomic rename; never overwrite.

### 10.2 Keep attachments private by default

Attachments routinely contain tokens, customer data, internal documents, and
source code. They remain on the private Agent Manager storage and are not
uploaded to the Hub by this feature.

Session sharing should keep its current safe behavior: a trace may contain the
local attachment path, but the attachment bytes are not bundled. A future
"include attachments" option requires its own explicit consent, redaction story,
and dataset visibility review.

### 10.3 Avoid prompt ambiguity

Paths are data, not instructions. Format the fallback in a clearly delimited
block generated by Agent Manager, while keeping the operator's text unchanged.
The server does not derive prompt text from an original filename.

## 11. Remote-agent phase

Remote agents currently exchange text messages and explicitly have no shared
filesystem or file upload. Supporting attachments requires protocol work, not
just enabling the button.

Extend a remote user message with attachments:

```json
{
  "seq": 42,
  "role": "user",
  "from": "operator",
  "text": "fix this alignment",
  "attachments": [
    {
      "id": "att_74e0f69dc9ed772cb685999e",
      "name": "screenshot.png",
      "mime": "image/png",
      "bytes": 184332,
      "url": "/api/remote/my-agent/attachments/att_74e0f69dc9ed772cb685999e"
    }
  ]
}
```

The copied remote prompt must then:

1. Download each attachment with the same authenticated HTTP client/HF token
   used for polling.
2. Store it in a fresh local temporary directory.
3. Include the resulting local path when handing the message to the remote CLI.
4. Remove or retain it according to the remote session's lifecycle.

The endpoint must be scoped to the remote name and attachment id. Base64 in the
message log is rejected: it exceeds the current 32 KiB message contract, bloats
Markdown logs, and needlessly injects binary material into traces.

## 12. Failure behavior

| Failure | User-visible result | Prompt sent? |
|---|---|---|
| clipboard contains no file | ordinary text paste continues, or no-op | no |
| file larger than limit | chip says `too large (100 MB max)` | no |
| interrupted/offline connection | chip or terminal overlay names the connection failure and offers retry | no |
| operator cancels an upload | abort transfer, remove its chip, and unblock the remaining draft | no |
| non-JSON proxy rejection | chip classifies the HTTP status (including proxy `413`) | no |
| one of several uploads fails | successful files remain, all chips stay for retry | no |
| attachment id missing at send | `attachment no longer exists`; retain draft | no |
| terminal socket closes after upload | say file was saved but not inserted; offer retry | no |
| remote target | explain unsupported phase | no |
| CLI cannot inspect path | agent sees explicit path and can report the limitation | yes |

For multi-file composer sends, atomicity applies to delivery, not storage: files
start uploading when attached, but `/input` runs only after all have succeeded.
A retry reuses already uploaded ids and transfers only failed files.

## 13. Testing

### 13.1 Server

- PNG, JPEG, GIF, and WebP magic bytes produce the right extension/MIME.
- MIME/extension lies do not affect detection.
- PDF, DOCX, text, archives, and unknown extensions are stored as inert files.
- Empty input and malformed claimed raster images are rejected.
- The byte limit trips during streaming and leaves no partial file.
- Aborted requests leave no partial file.
- Concurrent uploads produce unique files.
- Concurrent uploads cannot race the per-session byte/count quota.
- Attachment ids cannot cross sessions or traverse paths.
- Preview headers include CSP and `nosniff`.
- A structured prompt rejects if any referenced attachment is absent.
- File-only and screenshot-only prompts receive appropriate default text.
- Deleting a session removes only its managed attachment directory.
- First-turn attachment delivery uses `pendingPrompt` rather than the boot delay.

### 13.2 Browser/Playwright

- A synthetic clipboard PNG on the quickstart textarea creates one chip and no
  text.
- A pasted DOCX creates a generic extension chip and uploads beside an image.
- A drop containing the same file through both `items` and `files` creates one
  chip.
- Plain-text paste is unchanged.
- Removing a chip revokes its preview and excludes it from upload.
- Canceling a held upload removes its chip and immediately re-enables sending;
  removing an uploaded unsent chip deletes the server file.
- Upload starts when a file is attached, before `/input` or launch.
- Progress exposes transferred bytes/percentage and waits for server confirmation
  at 100%.
- Interrupted connections and non-JSON proxy errors remain actionable at the
  affected chip, with retry where appropriate.
- A multi-file submission remains disabled until every upload succeeds.
- Terminal paste receives a server acknowledgement and inserts without Return.
- A terminal stopped after upload reports saved-but-not-inserted, disables new
  attachments, and can retry the stored attachment after restart.
- Remote live composers explain that Space-local files are unavailable.
- Reader mode owns the pane header's one attachment button, opens its hidden
  picker, and keeps progress/error/retry chips in the visible composer rather
  than inserting into the covered terminal.
- Reader and Overview image-only replies send attachment ids through the same
  structured `/input` route.
- Terminal file drop does not trigger pane movement.
- Pane movement data does not trigger the file drop UI.
- The mobile fallback textarea handles both file and text paste.
- Clipboard API denial reaches the fallback sheet.
- Upload failure preserves the draft and shows the server's reason.
- On a fresh visit, quick attachment creation stays stopped on Overview; Escape
  removes the placeholder across reload, while conditional cleanup retains a
  target that has actually started.

`server/terminal-ui.test.mjs` already supplies a Chromium/xterm harness and
clipboard permissions; extend it for the live-terminal cases. Add a focused
server attachment test for storage and validation.

### 13.3 Manual harness matrix

For each installed CLI, verify a first turn and a later turn with one PNG, then
repeat with a PDF or DOCX to exercise explicit-path delivery:

- the prompt arrives once;
- the CLI/model actually inspects the file (and its visual content for images);
- the terminal remains editable before submission;
- resuming the session can still inspect the same path; and
- a path containing a configurable `DATA_DIR` with spaces is quoted correctly.

Test Chrome and Safari desktop, Chrome Android or Safari iOS, direct Space URL,
and the Hugging Face iframe. Clipboard permission behavior differs enough that
the DOM paste fallback must be exercised explicitly.

## 14. Rollout

1. Land storage/API plus Overview attachments. This proves durable upload and
   structured delivery without touching xterm.
2. Add Sidebar quickstart and the first-prompt `pendingPrompt` path.
3. Add terminal paste/drop and the mobile fallback.
4. Add/verify native harness adapters one at a time; retain fallback paths.
5. Observe attachment sizes/counts in logs, then tune limits if real screenshots
   routinely exceed them.
6. Design and land remote download transport separately.

No migration is required. The attachment directory is created lazily on the
first successful upload. Old web clients continue sending `{text}` and old
sessions have no attachment state.

## 15. Alternatives considered

### Reuse `/api/files/:id/upload`

Rejected as the public contract. It is intentionally a general workspace file
operation, accepts arbitrary names and bytes, overwrites an existing target, and
has no size cap. Its streaming/error cleanup pattern should be reused in the new
managed route.

### Save screenshots inside the working repository

Rejected as the default. It makes `git status` noisy, can accidentally enter a
commit, and forces cleanup policy into user source trees. A user who wants the
image as a project asset can separately save/copy it there.

### Put base64 images in the prompt or remote Markdown log

Rejected. It expands bytes, consumes memory and tokens, pollutes traces, exceeds
remote message limits, and makes accidental sharing more dangerous.

### Emulate native clipboard/image terminal protocols

Rejected. The browser still cannot place bytes on the container's clipboard,
and support differs across terminal emulators and CLIs. Uploading produces the
local path those native mechanisms eventually need anyway.

### Integrate every CLI's structured API

Deferred. Codex app-server, Gemini ACP, opencode serve, Hermes gateway, and other
interfaces could carry native image blocks, but adopting all of them would
replace Agent Manager's core PTY/session architecture. A path bridge is small,
observable, and works with the terminal sessions already being managed.

## 16. References

- Agent Manager input delivery: `server/src/index.js`, `server/src/runner.js`
- Existing browser paste behavior: `web/src/components/TerminalPane.tsx`
- Existing streaming file uploads: `server/src/index.js`,
  `web/src/components/FilesPane.tsx`
- Remote filesystem scope: `docs/remote-agents.md`
- Claude Code image workflow:
  <https://code.claude.com/docs/en/common-workflows#work-with-images>
- Gemini CLI `@` commands:
  <https://geminicli.com/docs/cli/commands/>
- opencode image drag/drop:
  <https://opencode.ai/docs>
- OpenAI Codex CLI overview (multimodal inputs):
  <https://help.openai.com/en/articles/11096431-openai-codex-cli-getting-started>
