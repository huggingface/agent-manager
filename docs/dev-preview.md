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
| UI | nothing | header banner, Settings → Preview |
| boot | `node` started as before | supervisor loop, re-apply of the saved selection |

Production and the template never set it.

## What a switch does

1. Fetches `main` and `pull/<N>/head` for each picked PR from
   `https://github.com/huggingface/agent-manager.git` into a checkout on local
   disk (`$AM_LOCAL/dev-preview/repo`). The repository is a constant in
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
7. Swaps `/app/server`, `/app/scripts`, `/app/public` and `/app/session.bashrc`.
   The first switch moves the image's copies to `/app/.image/` and leaves
   symlinks; each swap is one atomic `rename` of a symlink. The current and
   previous releases are kept under `$AM_LOCAL/dev-preview/releases/`.
8. Saves the selection (base SHA and PR SHAs) to `/data/state/dev-preview.json`
   and exits the server with code 75. The supervisor in `entrypoint.sh` starts it
   again; the container keeps running. All agent sessions restart with the server.

**Roll back to main** points the symlinks back at `/app/.image/` and restarts:
no fetch, no build.

## Restarts and crashes

A container restart puts `/app` back to the image and wipes local disk. On boot
the server reads `/data/state/dev-preview.json` and re-applies the **same SHAs**
(fetching them by SHA if a PR has moved on), then restarts into them. The banner
says `main` until then.

If a previewed build exits non-zero within two minutes of starting, the
supervisor points the symlinks back at the image, leaves a marker, and starts the
image. The image then reports the crash in the banner and panel, clears the saved
selection (so the next boot does not rebuild the same crash) and logs it.

## Security

This is code execution by design: whatever the picked PRs contain runs as the
app. It sits behind the Space's HF auth like the rest of Agent Manager, and:

- the gate covers routes, `/api/info`, the UI and the boot path;
- a switch body is `{prs: [{number, sha?}]}` only: JSON integers, 40-hex SHAs,
  no duplicates, at most 6, no other keys;
- every subprocess is `execFile` with an argument array; git runs with global
  and system config ignored and only `https` allowed, so an `insteadOf` cannot
  redirect it; children get a fresh environment without the Space's secrets;
- every switch request is in the API log (`POST /api/dev-preview/switch`), and
  its outcome, boot re-applies and crash rollbacks are appended as `PREVIEW`
  records from origin `dev-preview`.

## API

| Route | |
| --- | --- |
| `GET /api/dev-preview/status` | running build, saved selection, last job with steps and timings, log |
| `GET /api/dev-preview/prs` | open PRs (number, title, author, head SHA) and main's SHA |
| `POST /api/dev-preview/switch` | `{prs: [{number, sha?}]}` → 202; progress via status |
| `POST /api/dev-preview/rollback` | back to the image build |
