# File links

File references in the reader and terminal open a read-only preview **inside the
originating session pane**. Back/Escape returns through followed links; Close
returns directly to the session. The session stays mounted, at the same size,
with its scroll position and composer intact. Other panes remain usable.
Previewing does not create a session or start/attach to another agent.
Markdown, source code, images, HTML and PDFs use the existing Files viewer.
Unknown binary files offer a download. Transcript JSONL files open as source.

**Open in file viewer** keeps the resolved file in a separate Files pane in the
app, in the originating group when present. It creates a passive Files session
(not a terminal), or reuses a pane already showing that file. It never replaces
another pane's unsaved edits. The file selection is remembered in this browser
across pane switches and reloads, like the existing Files browser; when browser
storage is unavailable it lasts only until reload. Additional configured roots
remain read-only in the retained viewer too.

External web links still open new browser tabs with `noopener noreferrer`.
Modifier-clicks on file links and copied preview URLs can explicitly open a
standalone preview tab. Ordinary file clicks do not change the browser URL or
replace the session.

## Supported references

- Markdown links: `[readme](./README.md)`, absolute filesystem paths, and
  `[source](src/app.ts:42:3)` or `[source](src/app.ts#L42)`.
- Inline code containing a path, such as `` `docs/notes.md` ``. Fenced code
  blocks are left alone.
- Plain paths in terminal output, including soft-wrapped paths and optional
  line/column suffixes. Explicit OSC 8 `file:///…` hyperlinks also work, including
  paths with spaces. HTTP(S) OSC 8 links and detected web URLs open new tabs.
- Relative links and images inside a Markdown preview resolve beside that file.

Relative references from a local session resolve against its configured working
folder, not the folder of whichever agent is currently selected. `workspace/`
explicitly means the workspace root. `./workspace/` names an actual subdirectory
of the session folder. A trace of a local session uses that source session;
imported traces and remote conversations report that their files are unavailable
here. Shell `cd` commands and historical per-tool working directories are not
inferred. Use an absolute path when an agent works outside its configured folder.

After resolving a reference, “Copy link” provides a standalone preview URL, for
example (an embedded preview does not change the app's URL):

```text
/#file=my-project%2FREADME.md&root=workspace&line=42
```

“Copy link” copies this URL. It identifies a named file location, independent of
the originating session. Session rename or deletion does not invalidate it, but
moving/deleting the file does. It opens the current file contents, not a snapshot.
The link uses the same private Agent Manager access as the rest of the app.

## Additional file locations

The workspace directory is available as `workspace`. Operators can make other
directories available for **read-only previews** by setting a JSON map before
starting the server:

```sh
AM_FILE_LINK_ROOTS='{"checkouts":"/home/node/local/git"}'
```

An absolute path under that directory resolves to a stable `root=checkouts` link.
Only explicitly configured roots are available; names must start with a lowercase
letter and contain only lowercase letters, numbers, hyphens or underscores.
`workspace` is reserved, and filesystem roots such as `/` are rejected. Invalid
configuration fails at startup. This does not add editing access to those roots.

The server checks both the lexical and real path on every resolution, preview,
raw and download request. Symlinks cannot leave their selected root. Previews
cap text reads at 512 KiB and disclose truncation. HTML retains the existing
opaque-origin sandbox and starts with scripts disabled. Missing files, folders,
unknown locations and unavailable remote files have explicit error states.

Plain terminal detection is intentionally conservative: whitespace and surrounding
punctuation delimit paths, and wrapped scans are bounded. Use an explicit OSC 8
link or a Markdown link for filenames with spaces or delimiter characters.

## Verification

```sh
cd server && node test/file-links.test.mjs
cd ../web && node test/fileLinks.test.mjs
node test/sessionFilePreview.test.mjs
npm run build
```

The server suite checks scope, additional roots, symlinks, missing files, special
characters, truncation and raw/download headers. The browser suite clicks actual
reader and xterm links and verifies in-pane previews, unchanged source state,
back/close/focus, retained Files panes and reloads, external new tabs, file URI
links, nested Markdown assets, source-line navigation, mobile layout and errors.
