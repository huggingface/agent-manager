# Dev preview: switch a dev Space between PRs in place

One dev Space can run any open PR of `huggingface/agent-manager`, or a stack of
them, without a Docker rebuild. The image's slow layers (CLIs, apt packages,
Python tools, Chromium) stay; only the app itself is replaced.

## Turning it on

Set the Space **variable** (not a secret) `AM_DEV_PREVIEW=1`. Any other value,
or no value, is off:

| | off | on |
| --- | --- | --- |
| `/api/dev-preview/*` | not registered (404) | registered |
| `/api/info.devPreview` | absent | what runs, the last switch |
| UI | nothing | "Preview:" row under the sidebar logo, Settings → Preview |
| boot | `node` started as before | supervisor loop, re-apply of the saved selection |

Production and the template never set it.

## What a switch does

1. Resolves each PR number through the GitHub API: it must be **open** on
   `huggingface/agent-manager` (GitHub keeps `refs/pull/N/head` after a PR
   closes, so the ref proves nothing), and the switch is bound to the head SHA
   the API reports, and to main's SHA from the API. A SHA sent from the list
   that is no longer the head is refused ("moved; refresh").
   Fetches those commits from `https://github.com/huggingface/agent-manager.git`
   into a **freshly created** git database on local disk
   (`$AM_LOCAL/dev-preview/repo`, recreated every switch, global and system
   config ignored), so no `insteadOf` anywhere can redirect it, and a commit
   that is not there is refused. The repository is a constant in
   `server/src/dev-preview.js`; no request can name another.
2. Merges the PRs onto main **in the order picked** (one PR is merged onto main
   too, the way GitHub's merge ref is). A conflict stops the switch and names the
   PR and files.
3. Refuses if the result would need a **full rebuild**: it changes, or differs
   from the running image in, `Dockerfile`, `.dockerignore`, `entrypoint.sh`,
   `codex-requirements.toml`, `gemini-system-defaults.json`,
   `scripts/am-codex-repin-hook.sh` or the playwright pin in `web/package.json`.
   The image keeps its copies in `/app/.image-inputs/` for this comparison. A
   test fails if the Dockerfile gains a `COPY` this list does not cover.
4. Refuses a tree without `server/src/dev-preview.js`: it would boot an app with
   no way back. Until this feature is on main, put its PR first in the stack.
5. Installs dependencies **only when the lockfile changed**: `server/` reuses the
   image's `node_modules` when `package.json` + `package-lock.json` match;
   otherwise `npm ci --omit=dev` into a cache keyed by their hash. The web's
   `node_modules` (the image has none) are cached the same way and pre-installed
   at boot for main's lockfile.
6. Builds the web app with `vite build` (no type check; that is CI's job).
7. Swaps the build in **one rename**. At boot, before any server runs,
   `entrypoint.sh` moves the image's `server`, `scripts`, `public` and
   `session.bashrc` to `/app/.image/` once and routes each path through one
   link, `/app/current` (`/app/server` → `current/server`, …). This has to
   happen there: on the container's overlay filesystem an image directory
   cannot be renamed (`EXDEV`), only copied, and that must not happen under a
   live server. A switch then saves the selection (base SHA and PR SHAs) to
   `/data/state/dev-preview.json` and repoints `/app/current` at the release.
   If that rename fails, the saved selection is put back, so the links and the
   selection never disagree. The current and previous releases are kept under
   `$AM_LOCAL/dev-preview/releases/`.
8. Exits the server with code 75. The supervisor in `entrypoint.sh` starts it
   again; the container keeps running. All agent sessions restart with the
   server. Until that happens the sidebar row says what is still answering and
   "restarting into …", and no other switch or rollback is accepted.

**Roll back to main** repoints `/app/current` at `/app/.image/` and restarts:
no fetch, no build.

## Restarts and crashes

A container restart puts `/app` back to the image and wipes local disk. On boot
the server reads `/data/state/dev-preview.json` and re-applies the **same SHAs**
(fetching them by SHA if a PR has moved on), then restarts into them. This is
the one path that does not ask GitHub: it re-applies exactly what the operator
accepted, even if that PR has since moved or closed. The sidebar row
says `main` until then.

If a previewed build exits non-zero within two minutes of starting, the
supervisor repoints `/app/current` at the image, leaves a marker, and starts the
image. The image then reports the crash in the sidebar row and panel, clears the saved
selection (so the next boot does not rebuild the same crash) and logs it.

## Security

This is code execution by design: whatever the picked PRs contain runs as the
app, with everything the app can reach. The boundary is that only
collaborators can open PRs on the hard-coded repository, only open PRs can be
picked, and the operator picks. It sits behind the Space's HF auth like the
rest of Agent Manager, and:

- the gate covers routes, `/api/info`, the UI and the boot path;
- a switch body is `{prs: [{number, sha?}]}` only: JSON integers, 40-hex SHAs,
  no duplicates, at most 6, no other keys;
- every subprocess is `execFile` with an argument array, with a fresh
  environment that does not include the Space's secrets;
- **nothing a subprocess prints is shown, saved or audited unfiltered**: every
  log line passes the API audit log's credential filter, with the Space's
  injected secret values as known values plus its token patterns; a failing
  command's error (`job.error`, the audit record) is fixed text, its output only
  in the filtered log;
- every switch request is in the API log (`POST /api/dev-preview/switch`), and
  its outcome, boot re-applies and crash rollbacks are appended as `PREVIEW`
  records from origin `dev-preview`, through the same filter.

**What is not isolated.** The install and build run as the manager's user.
They can read what the manager can: its `/proc/<pid>/environ`, and `/data`. This
container has no user namespaces (seccomp), no root, and `/data` is a FUSE
mount readable by every uid, so neither a sandbox nor a second user would keep
a build away from the Space's secrets. Filtering stops a secret from being
*shown* by accident; it cannot stop a hostile build that encodes a secret, or
sends it over the network. That is the same exposure the previewed server has
once it runs, which is why the trust decision is which PRs can be picked, not
how the build runs.

## API

| Route | |
| --- | --- |
| `GET /api/dev-preview/status` | running build, saved selection, last job with steps and timings, log |
| `GET /api/dev-preview/prs` | open PRs (number, title, author, head SHA) and main's SHA |
| `POST /api/dev-preview/switch` | `{prs: [{number, sha?}]}` → 202; progress via status |
| `POST /api/dev-preview/rollback` | back to the image build |
