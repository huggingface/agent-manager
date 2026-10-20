# Development and deployment

The [README](../README.md) covers installing a private instance and using the
app. This guide covers the source checkout, runtime configuration, and test
Spaces.

## Run the source locally

Use Git with Git LFS, **Node.js 24.16 or later** (the same major as the Docker
image), Python, and a C/C++ toolchain for the native terminal dependencies.
Claude Code needs Node 22+ and OpenClaw refuses to install below 24.16, so an
older Node fails partway through installing the CLIs rather than up front.

```bash
git clone https://github.com/huggingface/agent-manager.git
cd agent-manager
```

The Dockerfile installs the coding CLIs for a Space; `npm ci` does not. A shell
session works without any of them, but for a real local deployment install them
explicitly:

```bash
./scripts/install-local-clis.sh

# Or only the ones you want:
./scripts/install-local-clis.sh opencode codex
```

That installs into `${NPM_CONFIG_PREFIX:-$HOME/.local}`. Claude and Codex are
required and a failure stops the run; Gemini, opencode and OpenClaw are
best-effort, exactly as in the container image, and anything that does not
install is listed at the end and shown as unavailable in the app. Put that
prefix's `bin` on the server's `PATH` and restart — availability is read once at
startup. With no CLIs installed the app's first-run window shows this same
command to copy, and points back here.

Start the backend from the repository root:

```bash
cd server
npm ci
npm run dev
```

In a second terminal, also starting from the repository root:

```bash
cd web
npm ci
npm run dev
```

Open **http://localhost:5173**. Vite proxies `/api` and `/ws` to the backend on
port `7860`. For different ports, set `PORT` on the backend and `AM_API_PORT`
on Vite; `AM_DEV_PORT` changes the frontend port.

The backend defaults to `server/data` when launched from `server/`. A local
source checkout uses your installed CLIs and their local credentials. Keep it on
a trusted machine/network: it has no application login, and the Hugging Face
privacy checks apply only when running as a Space.

## Build and check

From `web/`, `npm run build` typechecks and builds the frontend. From the
repository root, `npm test` runs every server and web suite plus the typecheck
in parallel: about 2 minutes on a quiet 8-core machine, 5–6 minutes on a
loaded one. `npm test` in `server/` or `web/` runs one package. Browser tests
also need Playwright's matching Chromium (`npx playwright install chromium`
from `web/`). [Testing](testing.md) covers running one suite, the manual and
live suites, and writing a suite that is safe to run in parallel.

The repository is also a Docker Space: the `Dockerfile` builds the frontend and
runs the backend. It installs coding CLIs, with optional installations marked
unavailable in the app if they fail. The build's **IMAGE CLI INVENTORY** lists
which binaries and versions actually installed.

## Architecture

```
browser
  ├── React reader ── HTTP /api/trace/:id ── saved conversation records
  └── xterm.js ── WebSocket /ws?session=<id>
        └── Node backend (Express + ws)
              └── node-pty + libghostty-vt ── coding CLI or shell
```

Each agent is a PTY held by the backend, with a **libghostty-vt** terminal fed
from its output. That grid is the authoritative screen, so reopening a pane is a
canonical serialization of its retained history and styled screen rather than a
truncated PTY byte replay, and agent state is read from the grid instead of
shelling out per session. Several browsers can watch the same session, but one
explicit controller owns input and PTY dimensions; interacting with a watcher
claims control. This prevents background tabs and small phones from resizing a
desktop session, and prevents several browser emulators from all answering the
same terminal query.

A resize is a controller request. The backend coalesces window-drag bursts,
allows Ghostty to perform normal reflow, then tells every viewer the confirmed
geometry before more PTY output arrives. Full history serialization is reserved
for attach/reconnect. Browser zoom is presentation-only: it changes cell size
and pans locally without resizing the PTY. Sessions survive browser disconnects
but not a backend restart or Space sleep/rebuild; with storage the working
directory and CLI state persist, so a reopened session resumes its own
conversation. Claude
sessions are pinned to a per-session conversation id at creation; Codex sessions
are pinned right after first launch (the id is captured from the rollout file
Codex creates) — so agents sharing a folder never resume each other's
conversations.

A restart ends running processes; it does not checkpoint arbitrary commands.
The server snapshots which sessions are alive — and which have a command or background job actually running
in them — and on the next boot starts the ones that were still yours: those you
prompted inside the configured window, plus any that had work in flight. Their
scrollback comes back from the terminal history checkpoint, so a reopened pane
reads as you left it. Settings → General → *Restart sessions after a reboot*
sets the window (1 / 3 / 7 days, or off).

## Configuration

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `7860` | HTTP + WS port (HF `app_port`) |
| `DATA_DIR` | see purpose | Data root; `/data` in Docker, `./data` from the backend working directory otherwise |
| `AM_SCROLLBACK_BYTES` | `67108864` | Maximum Ghostty scrollback memory per session |
| `AM_RESIZE_SETTLE_MS` | `120` | Quiet period before a resize is applied to the PTY |
| `BIND_HOST` | `127.0.0.1` | HTTP + WS bind address (`0.0.0.0` in the container image) |
| `AM_FRAME_ANCESTORS` | — | Extra origins allowed to embed the app in a frame (comma-separated exact origins) |
| `ANTHROPIC_API_KEY` | — | Claude Code / opencode / Hermes (Space **secret**) |
| `OPENAI_API_KEY` / `CODEX_API_KEY` | — | Codex (Space secret) |
| `GEMINI_API_KEY` | — | Gemini CLI (Space secret) |
| `AI_GATEWAY_API_KEY` | — | fx (Space secret) |
| `HF_TOKEN` | — | Hub operations and mounted-bucket discovery; access requirements depend on the operation |

The backend binds `127.0.0.1` by default because Agent Manager has no login of
its own. If you set `BIND_HOST` to another interface, put an authenticated
reverse proxy in front of it — never expose the backend to an untrusted network.
For a non-Space deployment also set `AM_ALLOWED_ORIGINS` to the exact
browser-facing origin (for example `https://agents.example.com`); that
request-admission allowlist is not a substitute for proxy authentication.
Only the app itself (and, in a Space, huggingface.co) may frame it; to embed it
in another site on purpose, list that site in `AM_FRAME_ANCESTORS` (see
[browser request protection](browser-request-protection.md#framing)).
Internal clients use `AM_HOST` and send `X-AM-Request: 1`, as the generated
environment skill does.

Logging in interactively inside a terminal works too — the Docker entrypoint stores active
CLI state on local disk and checkpoints it under `/data/state`. With the bucket
mounted, completed checkpoints survive restarts. A plain source checkout does
not run that entrypoint or configure that storage automatically.

## Deploy a branch to a development Space

Test a branch on real Space infrastructure — the bucket mount and HF's edge —
without touching production:

```bash
# Set HF_TOKEN to a token with write access to your namespace.
bash scripts/deploy-dev-space.sh am-dev-2 feat/my-branch
```

Idempotent, so re-run it to redeploy. It creates the Space **private** and gives
it **its own bucket** (`<name>-data`) mounted at `/data`, force-pushes the branch
as the Space's `main` (Spaces only build `main`), names the dashboard card, then
waits for the build and checks `/api/health` answers JSON.

Four things it handles that catch people out by hand:

- **Its own bucket, never prod's.** Mounting production's bucket into a dev Space
  gives it prod's sessions, workspaces *and* logged-in CLI credentials, and lets
  a test run write to them. A dev instance gets a fresh bucket, so it starts
  empty and its own logins stay its own.
- **Private, always.** The app has no separate authentication behind HF's edge, so a public
  instance is a shell for whoever finds it. It does lock itself when public
  (see [the privacy lock](privacy-lock.md)), but the right answer is not to publish it at all.
- **LFS objects go up first.** Git hooks cannot run from a workspace on the
  bucket (object storage holds no exec bit), so the `git lfs` pre-push hook never
  fires and a plain `git push` sends an LFS *pointer* with no object behind it —
  which the Hub rejects, confusingly, as "an LFS pointer pointed to a file that
  does not exist". The script pushes objects explicitly first.
- **The dashboard card is renamed on the Space only.** Every instance builds from
  this same README, so they all show up as "Agent Manager" — useless when you
  have three. After pushing, the script rewrites the front-matter *in the Space
  repo* to `<name> (dev)` 🚧 with the branch and sha in the description. The
  repo's own README is untouched, so production is never renamed. `README.md` is
  not `COPY`'d by the `Dockerfile`, so that commit rebuilds no layers.

To throw one away: delete the Space **and** its bucket (the bucket is a separate
repo and outlives the Space otherwise).

```python
from huggingface_hub import HfApi, delete_bucket
HfApi().delete_repo("you/am-dev-2", repo_type="space")
delete_bucket("you/am-dev-2-data")   # buckets are not a repo_type — own function
```
