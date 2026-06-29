---
title: Agent Manager
emoji: 🖥️
colorFrom: gray
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
short_description: Private cloud manager for AI coding CLI sessions
---

# Agent Manager

A private, single-user cloud terminal manager for AI coding CLIs — **Claude Code**,
**Codex**, **Gemini CLI**, **opencode**, and **Hermes** — plus a plain shell and a
file browser, all in your browser. Each agent runs in its own workspace folder;
group agents to share a folder and tile them side by side. Sessions are
tmux-backed, so they survive disconnects. A **Skills** page distributes reusable
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
`workspaces/<folder>/` (per-agent working dirs + shared `skills/`), and each
CLI's config/credentials/history (`HOME=/data/home`, plus `CLAUDE_CONFIG_DIR`
and `CODEX_HOME` under `/data/state`).

## Architecture

```
browser (xterm.js panes)
  └── WebSocket /ws?session=<id>          one connection per visible pane
        └── Node backend (Express + ws)
              └── node-pty → tmux session per agent   ← survives disconnect/restart
                    └── claude | codex | gemini | opencode | hermes | bash
```

Each agent is a long-lived `tmux` session (`am-<id>`) that survives browser
disconnects and in-Space server restarts. It does not survive a Space
sleep/rebuild (the container is torn down), but with storage the working dir and
CLI state persist, so a re-opened session resumes its own conversation (Claude
sessions are pinned to a stable per-session id so grouped agents don't collide).

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `7860` | HTTP + WS port (HF `app_port`) |
| `DATA_DIR` | `/data` | Durable root (mounted private Storage Bucket) |
| `USE_TMUX` | auto | `1`/`0` to force tmux on/off (off = direct PTY, no persistence) |
| `ANTHROPIC_API_KEY` | — | Claude Code / opencode / Hermes (Space **secret**) |
| `OPENAI_API_KEY` / `CODEX_API_KEY` | — | Codex (Space secret) |
| `GEMINI_API_KEY` | — | Gemini CLI (Space secret) |

Logging in interactively inside a terminal works too — credentials are written to
`HOME`/state dirs on `/data` and persist across restarts.

## Local development

```bash
# backend (no tmux locally → direct-PTY mode; only the Shell CLI works offline)
cd server && npm install && npm run dev

# frontend (proxies /api and /ws to the backend on :7860)
cd web && npm install && npm run dev
```

This repo *is* the Space — the build runs the `Dockerfile`.
