# Managed skills

The manager owns a source file and explicitly recorded generated `SKILL.md`
files. A matching directory name does not establish ownership. Support files,
other installations and configured roots are never recursively deleted.
Deletion is permanent. There is no trash, backup, snapshot, undo or content
history in this service.

## Identity and destinations

`server/src/skills.js` is the shared lifecycle service for the HTTP routes,
startup redistribution and generated `environment.md`. Its queue serializes
these callers within one manager process, including their reads and revision
checks. Do not run two managers against the same source/state roots.

The installation ID retains the previous mapping: strip the last extension,
lowercase, normalize punctuation/whitespace to `-`, trim edge hyphens, truncate
to 40 characters. Invalid/path-like filenames and empty IDs are rejected.
Distinct sources that collide after case, extension, normalization or truncation
are rejected before either source or installation bytes change. The global
session/group `slugify` function is unchanged.

Distribution is still enabled only by `SPACE_ID` or `AM_DISTRIBUTE_SKILLS=1`.
The destinations remain ordinary `HOME/.agents/skills`, Claude's configured
skills directory, `HOME/.hermes/skills`, and the `.agents/skills` directories
under configured Gemini and OpenClaw homes. There are no new destinations.
The source, state and target roots are canonicalized; configured root aliases
are supported and duplicate destinations are coalesced. Overlapping ownership
roots are refused. Managed entries, including dangling symlinks and temporary
entries, must not redirect through symlinks. Replacing an already resolved root
with a redirect is also refused. These checks prevent accidental redirection;
they do not isolate files against arbitrary hostile same-user filesystem races.

## Ownership and existing installations

The version 1 manifest is stored at `DATA_DIR/state/skills/skills-v1.json`.
It binds the canonical source root and each source filename to its installation
ID, a unique creation identity, current source digest, exact target roots/files, and generated-file digests.
It records which skill directories the operation creates; adopted directories
are never owned. Recorded paths are checked against current configured roots
and reconstructed expected filenames before use. A changed source root, unknown
manifest version, corrupt/unreadable manifest or invalid path disables mutations.
An unwritable manifest cannot authorize a new operation.

On first startup without a manifest, a unique valid source may be adopted.
An existing destination is adopted **only** when its `SKILL.md` is byte-identical
to the rendering of that source. Only that file is adopted, never its directory
or support files. Missing destinations can be installed. A modified destination
or ambiguous source makes the whole skill conflict before writes. Other skills
continue independently, and the server reports degraded distribution without
stopping its other functions. Deleting a generated skill disables automatic
generation of that name. Explicit recreation publishes the user's content but
keeps automatic generation disabled. Saving changed generated content also
pauses regeneration, so Settings changes and startup cannot erase those edits.
These decisions store only a name flag, never a content copy. The editor explains
this behavior before editing a generated skill and shows when regeneration is
paused. Ordinary explicit saves and redistribution still publish the customized
skill; there is no automatic resumption that can overwrite it. Generation cannot
take over an existing user-created managed skill. Legacy environment content
follows the same adoption checks, using the existing source to verify its
installation before publishing new generated content.

Name matching alone cannot authorize deletion, even when the source is absent.
After losing a manifest, removal returns not-found until ownership has been
narrowly verified again. Never delete the manifest to force an overwrite. To
resolve a legacy conflict, choose a noncolliding source name or deliberately
resolve the independent installation outside the manager, then restart
redistribution. An externally modified installed copy still blocks saves and
deletion, even with a fresh revision; resolve that independent installation
deliberately outside this API. There is no force-adopt endpoint.
A removed/redirected configured destination must be restored before operations
on records that still reference it can proceed.

An external edit to a managed **source** (including edits through Files or by an
agent) invalidates old revisions and stops automatic republication. Open or
refresh it in Skills, review the current contents, then explicitly Save or
confirm permanent deletion. A matching current revision authorizes exactly those
source bytes. The service persists their accepted hash with the operation intent
before any mutation; installed-file ownership checks remain unchanged. A source
edit after that snapshot still conflicts. Retrying a pending operation can
likewise accept a freshly reviewed source, while retaining the original target
set and, for saves, the original intended content. No historical bytes need to
be restored to unblock an explicit operation.
This does not claim a new file that appears after an initial source creation
failed: without a previously owned source hash, only byte-identical intended
content can be recognized as an interrupted publication.

## HTTP mutation contract

All calls still require the usual operation origin (`?from=…`, or the existing
operator header used by the web client). Origin attribution is not authentication.

| Call | Contract |
| --- | --- |
| `GET /api/skills` | Lists source names and pending operations, including records whose source is missing. |
| `GET /api/skills/:name` | Returns content, an opaque `revision`, ownership/pending state, and exact managed installation paths with their current presence. |
| `POST /api/skills/:name` | Create only, with a plain-text body. Existing source or installation-ID collisions return 409. |
| `PUT /api/skills/:name` | Explicit save, with a plain-text body and `If-Match` set to the exact returned `revision`. Missing tags return 428; stale tags return 409. |
| `DELETE /api/skills/:name` | Permanent removal of the recorded files, with the same required `If-Match` revision. No record returns 404 and removes nothing. |

Revisions include current source content, ownership/operation metadata, observed
installation contents and the configured target set. A stale tab or changed
confirmation cannot overwrite/delete the new state. A newly created skill has
a new identity even when it reuses a deleted filename and identical content. Current revision tags do
not override detected external changes to an owned installation. Repeated
already-completed deletions return the same documented 404/no-mutation outcome.

The UI uploads/creates via POST. Conflicts offer another name or cancellation;
users open the managed skill to edit it. Failed saves retain the selected source
and entered text. Refreshing its revision preserves that text and displays the
current saved source for comparison before another explicit Save.

Deletion has its own modal showing the exact filename and installation paths,
with a permanent-deletion notice. Cancel receives initial focus. Opening it,
Cancel and Escape do not mutate. Its captured identity/revision cannot follow a
changed selection, and duplicate submissions are disabled immediately. A stale
confirmation must be refreshed. Partial deletion displays remaining/absent
installations before a scope-limited retry.

## Atomic publication, partial outcomes and retries

Before changing content, the service atomically publishes an operation record
containing the intended source/target hashes and the exact target set. No
historical content is stored. Source and generated replacements are written to
exclusive operation-owned temporary files, flushed, checked, and renamed into
place. A failed replacement preserves the preceding file. New files are checked for absence immediately before rename; the manager queue
prevents concurrent create calls from passing that check for the same name.
Publication does not require hard-link support on bucket-backed roots.
Cleanup never removes a pre-existing or substituted temporary path.

Multi-target distribution is not a filesystem transaction. HTTP 207 results
carry `ok: false`, separate `source` and `manifest` outcomes, per-target
`installed`/`removed`/`absent`/`failed`/`not-attempted` outcomes, and the current
skill snapshot where available. A failed manifest commit is distinguished from
successful content publication. A persisted intent lets the service recognize
either the previous or intended hashes after interruption, without claiming
ownership of differently modified files.

Retry an incomplete create/save by GET followed by PUT with the same intended
content and current revision. A create whose source write failed may have a
pending ownership record and no source yet. POST remains create-only; it cannot
silently turn that pending create into an overwrite. Startup can resume a pending
save only when its intended source content is available. It leaves a missing
source or different content alone. Incomplete operations never add destinations
on retry; newly configured destinations wait for a subsequent ordinary save or
startup redistribution after the operation finishes.

Deletion persists its intent **before** unlinking targets and removes the source
**last**, only after every recorded target file is absent. Empty directories may
be removed only if the manager created them; a failed optional directory cleanup
is returned as `directoryError`, and the directory is retained. Extra files
always remain. A target-file failure retains the source and pending record.
Startup never republishes a pending deletion and does not automatically finish
it. GET followed by DELETE retries only the originally recorded targets, checking
their contents again; an external replacement is a conflict. Even if source
removal succeeded but the final manifest commit failed, the pending record is
sufficient to finish that same deletion after restart.

## Verification

The discovered suites are `server/test/skills.test.mjs`,
`server/test/skills-api.test.mjs` and `web/test/skills.browser.test.mjs`.
The API/browser fixture clears inherited credentials, Space settings and harness
homes, injects five disposable destinations, verifies them before opting into
distribution, and starts no real harnesses. Its fault preload exists only in the
test fixture and is not used by the application.

Run focused discovery with `npm test --prefix server -- skills` and
`npm test --prefix web -- skills`, and the full suites with `npm test` in each
package. `npm run build --prefix web` includes the production typecheck.
`node scripts/mutation-check-skills.mjs` and
`node scripts/mutation-check-skills-ui.mjs` deliberately remove the important
guards in disposable code copies and require regression failures. Set
`AM_SKILLS_SCREENSHOTS` to a disposable output folder when running the browser
suite to capture its conflict, confirmation and partial-deletion states.
