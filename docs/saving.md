# Saving: settings, files, and what an answer means

Two things in Agent Manager are edited and saved from the browser, and they have
deliberately different policies.

- **Settings** — the configuration in Settings → General and the descriptions of
  the injected secrets — save **immediately**. There is no debounce, no
  save-on-blur, no save-on-close and no Apply button. A valid change is sent as
  soon as it is made.
- **Files** in the file viewer save **explicitly**, with the Save button or ⌘S.
  Typing writes nothing. These files have no undo and no history behind them, so
  a stray keystroke must never reach disk.

Both go through the same controller (`web/src/lib/saveQueue.ts`), because both
need the same guarantee about ordering.

## One writer, one pending value

Per resource there is **one request in flight** and **one pending slot** holding
the newest value asked for — never a queue of every intermediate keystroke. When
the active write settles, whatever is waiting goes out immediately; no timer
stands between an edit and its save, or between one write and the next.

A response may only speak for the editor if nothing newer was asked for while it
was away. Concretely, an older success may not:

- clear a draft that has been typed into since,
- report “Saved” over text that is still only in the buffer,
- or touch a different file, or a file whose viewer has been closed.

A file save carries the file it belongs to. When its answer arrives, the
remembered draft is only released if it still *is* the text that was committed;
otherwise it is kept and its base tag is advanced to the version that just
landed, so the next save is not refused for being based on the version its own
predecessor replaced.

## Revisions, and two people editing at once

`GET /api/config` and `GET /api/secrets` return a `rev`: the revision of the
committed bytes (a hash, not an mtime — `/data` is a FUSE mount that rewrites
mtimes on its own).

`PUT /api/config` and `PUT /api/secrets` are **whole-resource replacements**
guarded by that revision, passed as `?base=…`:

```sh
curl -sS "http://localhost:${AM_PORT:-7860}/api/config"        # → { …, "rev": "9c1f…" }
curl -sS -X PUT "http://localhost:${AM_PORT:-7860}/api/config?base=9c1f…&from=$AM_ID" \
  -H 'content-type: application/json' -d '{ … }'
```

- A resource that does not exist yet may be written without a `base`.
- Replacing one that does exist **requires** the `base` it is replacing:
  `409 { code: "base-required" }` otherwise.
- A `base` that is no longer current is `409 { code: "stale", rev, value }` —
  the response carries the revision and value actually stored, so the caller can
  show the difference. Nothing is merged for you and nothing is overwritten for
  you: in the browser this is “changed elsewhere”, with *Keep mine* (send again
  against the reported revision) and *Use theirs* (take the stored value).

To change one field, read the resource, edit it, and send it back. The
precondition is what keeps a second writer from posting its own stale copy of
every other field.

## Damaged settings are not empty settings

If a settings file exists but cannot be read — invalid JSON, wrong permissions —
the read reports `readError` and the write is refused with
`409 { code: "unreadable" }`. The original bytes are left alone. Treating an
unreadable file as “no settings” is what would let the next ordinary edit
replace a hand-written config with defaults. Repairing or removing the file is a
human decision; there is no automatic recovery, backup or version history here.

A file that is simply **missing** is different: it means “nothing configured
yet”, and documented defaults apply.

## Failures, timeouts, and lost answers

A write that failed is answered as a failure. `{ok:true}` for a write that did
not happen is how a setting reverts on the next load with nothing on screen to
say so.

Every settings save has a finite window for an answer (15s; file writes get
30s). When it passes, the slot is released — otherwise one request that never
settles traps every later edit behind it — and the state becomes *not
confirmed*, because a lost answer may mean the server committed. Before anything
is sent again, the client reads the resource back:

- if what is stored is what was sent, the write had landed: it is recorded as
  saved and not repeated;
- if it is not, the value is sent again through the ordinary path, precondition
  and all. A recovery is never a forced overwrite.

## How long a save lives

A settings save outlives the panel it was made in. The savers are owned by
`web/src/lib/settingsSaves.ts` for the life of the page, not by `SettingsView`,
so closing Settings cannot cancel work already asked for. If a failure arrives
after the panel is closed it is reported in the app, with a way back to the
setting and a Retry; reopening Settings shows the value still owed to the server
rather than fetching over it.

The limit is the browser itself. On reload or close with work outstanding the
page asks the browser to warn, which is all a page may do — an asynchronous
write cannot be guaranteed during shutdown, and nothing here pretends otherwise.
File buffers survive that case through the existing remembered-draft store; a
settings change that was never acknowledged does not.

## Derived work

The generated `environment` skill is derived from committed settings. It is
rebuilt after the response rather than on the save path, coalesced to one pass at
a time, and it reads the files rather than trusting what a request carried — so
a burst of saves converges on the last committed value.

Its outcome is reported separately, in `derived` on both settings reads:
“settings saved” and “the agents have been told” are different states, and the
panel says so when the second one fails. Skill distribution beyond this file is
issue #121's.
