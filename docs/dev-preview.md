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

The Space also needs a **GitHub token** as a secret (`GH_TOKEN` or
`GITHUB_TOKEN`), any token that can read the repository. Without one GitHub
does not answer the permission check below, so every switch is refused and a
saved selection is not re-applied. Listing open PRs works either way.

## What a switch does

1. Resolves each PR number through the GitHub API and refuses it unless:
   - it is **open** (GitHub keeps `refs/pull/N/head` after a PR closes, so the
     ref proves nothing on its own);
   - its **head branch is on `huggingface/agent-manager` itself, or on a fork
     owned by the PR's author** (a fork owned by anyone else is refused); and
   - its **author currently has `write`, `maintain` or `admin` permission** on
     `huggingface/agent-manager`, read from
     `GET /repos/huggingface/agent-manager/collaborators/{author}/permission`
     at that moment. `author_association` is not used: `MEMBER` covers the
     whole huggingface organisation.

   If the permission cannot be read (no token, rate limit, GitHub down, an
   author that is not a plain user such as a bot), the PR is refused:
   permission is never assumed. This is all in code (`headRefusal()`,
   `permissionAllows()` and `eligibility()` in `server/src/dev-preview.js`)
   and does not rely on the repository's PR-creation setting. The same rule
   marks PRs in the list (refused ones greyed out with the reason; the
   author's permission and branch repository shown; forks flagged, with an
   allowed fork marked as the author's own) and is checked again, fresh, on
   every boot re-apply.
   The switch is bound to the head SHA the API reports, and to main's SHA from
   the API. A SHA sent from the list that is no longer the head is refused
   ("moved; refresh").
   Fetches main and the PR heads from
   `https://github.com/huggingface/agent-manager.git` into a **freshly
   created** git database on local disk (`$AM_LOCAL/dev-preview/repo`,
   recreated every switch, global and system config ignored), so no `insteadOf`
   anywhere can redirect it. Each PR's fetched head must be exactly the bound
   SHA, and the base must be on the fetched main. Nothing is ever fetched by SHA:
   GitHub serves any commit of the fork network through the parent repository,
   so a SHA alone proves nothing. The repository is a constant; no request can
   name another.
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
the **image's** server reads `/data/state/dev-preview.json` and re-checks it
with GitHub before running anything: every PR must still be open, still pass
the rule in step 1 (so an author whose write access was revoked after the pick
is refused), and still have the saved SHA as its head, and the saved base must
be on main. Then it re-applies exactly those SHAs and restarts into them.
If any of that fails, including GitHub being unreachable, it stays on the
image and says why in the sidebar row and panel; pick again to switch. The
sidebar row says `main` until a re-apply has restarted into its build.

The supervisor in `entrypoint.sh` is the image's code, not the previewed
build's, so it does not depend on a PR's own copy of the switcher. While
`/app/current` points at a previewed build, it rolls back to the image (repoints
`/app/current`, leaves a marker, starts the image) when that build:

- exits for any reason other than "restart me" (75), at any time;
- does not answer `/api/health` within `AM_DEV_PREVIEW_START_DEADLINE` seconds
  (default 180); or
- stops answering it for `AM_DEV_PREVIEW_HEALTH_FAILS` checks in a row (default
  12, one every `AM_DEV_PREVIEW_HEALTH_EVERY` = 10 s).

The image then reports it in the sidebar row and panel, clears the saved
selection (so the next boot does not rebuild the same thing) and logs it.

### Out-of-band recovery

If a previewed build misbehaves while staying healthy (it runs, answers
`/api/health`, but its switcher does not roll back), turn the feature off from
the Hub: **delete the `AM_DEV_PREVIEW` variable** of the Space (Settings →
Variables) and restart it. Without the variable, `entrypoint.sh` starts the
image's server exactly as on any other Space: `/app` is the fresh image, no
route exists, and the saved selection is never read. Setting the variable again
later re-checks that selection with GitHub before applying it, as above. To
forget it, delete `/data/state/dev-preview.json` first.

## Security

This is code execution by design. Whatever the picked PRs contain runs with
everything the app can reach: the Space's secrets, the `/data` bucket, every
agent and its credentials. Their `npm ci` scripts and `vite build` do so as
soon as a switch starts, before the operator sees the result. **The boundary is
which PRs can be picked and who picks**, and it is enforced in code, not left to
repository settings:

- only open PRs whose author currently has write, maintain or admin
  permission on `huggingface/agent-manager`, from a branch upstream or on the
  author's own fork (step 1), checked with GitHub at every switch and again on
  every boot; a permission GitHub does not confirm is a refusal;
- the operator picks, behind the Space's HF auth, after one confirmation that
  names each PR's author, their permission and the branch repository, and says
  plainly that the code will run with this Space's secrets, bucket and agents;
- the gate covers routes, `/api/info`, the UI and the boot path;
- a switch body is `{prs: [{number, sha?}]}` only: JSON integers, 40-hex SHAs,
  no duplicates, at most 6, no other keys; every subprocess is `execFile` with
  an argument array;
- every switch request is in the API log (`POST /api/dev-preview/switch`), and
  its outcome, boot re-applies and rollbacks are appended as `PREVIEW` records
  from origin `dev-preview`.

**Not a control, just hygiene:** subprocesses get a fresh environment without
the Space's secrets, and their output is passed through the API audit log's
credential filter (the Space's secret values plus token patterns) before it is
shown or saved, with fixed text for errors. That keeps a secret from being
shown by accident. It does not keep anything from a hostile build, which can
read the manager's `/proc/<pid>/environ` and `/data` (both readable by the same
user) and encode or send what it finds. This container has no user namespaces
(seccomp), no root, and `/data` is a FUSE mount readable by every uid, so the
build cannot be sandboxed here; it would not matter much anyway, since a
switched-in server is the manager.

## API

| Route | |
| --- | --- |
| `GET /api/dev-preview/status` | running build, saved selection, last job with steps and timings, log |
| `GET /api/dev-preview/prs` | open PRs (number, title, author and their permission, head repo, head SHA, allowed or why not) and main's SHA |
| `POST /api/dev-preview/switch` | `{prs: [{number, sha?}]}` → 202; progress via status |
| `POST /api/dev-preview/rollback` | back to the image build |
