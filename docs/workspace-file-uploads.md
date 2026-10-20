# Workspace file uploads

Workspace uploads are create-only unless the operator confirms one exact
replacement. This is intentionally different from reader attachments: reader
files always receive unique server ids, so equal display names remain separate.

## Collision and replacement API

`POST /api/files/:id/upload?path=<folder>&name=<name>` streams bytes. With no
replacement header it creates a new file. If that destination exists, the server
does not consume it as authorization and returns `409`:

```json
{
  "error": "\"report.txt\" already exists",
  "code": "file-exists",
  "name": "report.txt",
  "path": "reports/report.txt",
  "revision": "sha256:<bytes>:<digest>",
  "replaceToken": "<opaque token>"
}
```

The Files pane shows the exact name and workspace-relative destination. Replace
is a separate action in a dialog whose focused/default action is Cancel. Escape
and backdrop dismissal also cancel. There is no Replace All path.

After confirmation the browser repeats the upload with
`X-AM-Replace-Token`. The token authenticates the resolved destination and a
streamed SHA-256 identity of the existing content; it is not an mtime check and
does not buffer the existing file. Tokens are process-local, so a server restart
requires a fresh collision/decision. If the file or destination folder changed,
the server returns `409 replacement-stale` with a fresh identity/token and the
old choice cannot publish.

## Publication and failure scope

Every body first streams to a random, exclusive `.part` file beside the resolved
destination. The parent/root relationship and replacement identity are checked
again after streaming. Only then is the temporary published. Aborts, validation
errors and failed replacement renames remove that operation's temporary and
leave existing destination bytes alone. Final-entry symlinks are refused;
parent aliases must resolve inside the same workspace root and must not retarget
during the request.

Manager-originated writes to one resolved destination are serialized. Create-only
publication uses a hard link for atomic no-replace semantics. On storage adapters
without hard links it falls back to `COPYFILE_EXCL`: a competing creator is still
never overwritten, but the adapter cannot promise that a brand-new file is
invisible until the exclusive copy finishes. Replacement uses same-directory
rename after revalidation. An external agent can still write in the small gap
between the final content check and the filesystem rename; that cross-process,
storage-adapter race is not presented as a transaction or exactly-once guarantee.

The text editor keeps its existing content-tag API and UI state. It only shares
the unique temporary-file and per-destination publication primitive; autosave and
save-state redesign remain outside this work.
