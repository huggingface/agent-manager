---
title: Agent Manager
emoji: 🖥️
colorFrom: gray
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
license: apache-2.0
short_description: Private cloud manager for AI coding CLI sessions
---

# Agent Manager

A private, single-user cloud terminal manager for AI coding CLIs — **Claude Code**,
**Codex**, **Gemini CLI**, **opencode**, and **Hermes** — plus a plain shell and a
file browser, all in your browser. Each agent runs in a workspace folder you
pick at creation (defaulting to where the last agent was created) — names are
just labels, independent of folders, and several agents can share a folder.
Groups are visual: they organize the sidebar and tile agents side by side.
Sessions live in the
backend, so they survive disconnects and can be watched from several devices at
once. A **Skills** page distributes reusable
`SKILL.md` files to every agent, and a **Usage** page shows tokens/cost and your
5-hour / weekly quota.

> ## ⚠️ This app has no authentication — keep your Space **private**
> Anyone who can open the Space gets a real shell and your logged-in agents.
> Access control is the Space's **private** visibility and nothing else. Never
> run a public instance with credentials. (This public page is a *template* to
> duplicate, not a usable instance.)

## Run your own (private) instance

**Option A — one click:** press **⋮ → Duplicate this Space** at the top of this
page. Keep visibility **Private**. Then create a private Storage Bucket and mount
it at `/data` before logging in:

```python
from huggingface_hub import HfApi, Volume, create_bucket

api = HfApi()
space_id = "your-username/agent-manager"
bucket_id = "your-username/agent-manager-data"

create_bucket(bucket_id, private=True, exist_ok=True)
api.set_space_volumes(
    space_id,
    volumes=[
        Volume(type="bucket", source=bucket_id, mount_path="/data"),
    ],
)
api.restart_space(space_id)
```

**Option B — one script** (needs `pip install -U huggingface_hub` and
`hf auth login`):

```python
from huggingface_hub import HfApi, Volume, create_bucket

api = HfApi()
space_id = "your-username/agent-manager"
bucket_id = "your-username/agent-manager-data"

create_bucket(bucket_id, private=True, exist_ok=True)
api.duplicate_repo(
    from_id="lvwerra/agent-manager-template",
    to_id=space_id,
    repo_type="space",
    private=True,
    space_volumes=[
        Volume(type="bucket", source=bucket_id, mount_path="/data"),
    ],
)
```

Then open your new private Space and **log in to each agent inside its terminal**
(run `claude`, `codex`, etc. and follow the prompt). You can also set provider
keys as Space **secrets** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) instead of
logging in interactively.

## Storage bucket (required for real use)

Agent Manager expects a private Storage Bucket mounted read-write at `/data`.
That bucket stores your sessions, workspaces, skills, CLI credentials, and
history. Without the bucket mount, the Space can still boot for preview, but it
falls back to ephemeral disk: sessions, logins, and history reset whenever the
Space sleeps or rebuilds.

If you duplicated first, you can add or replace the mount later:

```python
from huggingface_hub import HfApi, Volume, create_bucket

api = HfApi()
space_id = "your-username/agent-manager"
bucket_id = "your-username/agent-manager-data"

create_bucket(bucket_id, private=True, exist_ok=True)
api.set_space_volumes(
    space_id,
    volumes=[
        Volume(type="bucket", source=bucket_id, mount_path="/data"),
    ],
)
api.restart_space(space_id)
```

Everything durable lives under `/data`: `sessions.json`, `groups.json`,
`workspaces/<path>/` (agent working dirs + shared `skills/`), and each
CLI's closed state checkpoints under `/data/state`. Active harness state lives
on local POSIX storage and is restored/checkpointed by
[`scripts/agent-state.sh`](scripts/agent-state.sh); SQLite harnesses use online
database backups rather than copying live WAL files. See
[`docs/agent-state-checkpoints.md`](docs/agent-state-checkpoints.md).

## Architecture

```
browser (xterm.js panes)
  └── WebSocket /ws?session=<id>          one connection per visible pane
        └── Node backend (Express + ws)
              └── node-pty per agent + a libghostty-vt grid   ← the live screen
                    └── claude | codex | gemini | opencode | hermes | bash
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

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `7860` | HTTP + WS port (HF `app_port`) |
| `DATA_DIR` | `/data` | Durable root (mounted private Storage Bucket) |
| `AM_SCROLLBACK_BYTES` | `67108864` | Maximum Ghostty scrollback memory per session |
| `AM_RESIZE_SETTLE_MS` | `120` | Quiet period before a resize is applied to the PTY |
| `ANTHROPIC_API_KEY` | — | Claude Code / opencode / Hermes (Space **secret**) |
| `OPENAI_API_KEY` / `CODEX_API_KEY` | — | Codex (Space secret) |
| `GEMINI_API_KEY` | — | Gemini CLI (Space secret) |

Logging in interactively inside a terminal works too — credentials are written to
`HOME`/state dirs on `/data` and persist across restarts.

## Local development

```bash
# backend (needs node >= 20.19 for libghostty-vt; only the Shell CLI works offline)
cd server && npm install && npm run dev

# frontend (proxies /api and /ws to the backend on :7860)
cd web && npm install && npm run dev
```

This repo *is* the Space — the build runs the `Dockerfile`.

### Deploying a branch to a dev Space

Test a branch on real Space infrastructure — the FUSE bucket, HF's edge, tmux —
without touching production:

```bash
export HF_TOKEN=<write access to your namespace>
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
- **Private, always.** The app authenticates nobody past HF's edge, so a public
  instance is a shell for whoever finds it. It does lock itself when public, but
  the right answer is not to publish it at all.
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
