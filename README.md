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
CLI's config/credentials/history (`HOME=/data/home`, plus `CLAUDE_CONFIG_DIR`
and `CODEX_HOME` under `/data/state`).

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
snapshot repaint plus replayed scrollback rather than a redraw, several browsers
can watch and drive one session at once (they share one grid, sized to the
smallest), and agent state is read from the grid instead of shelling out per
session. A resize is a request too: the browser measures itself and asks, the
backend applies the size once the asking stops and then repaints every viewer
from the grid — so a window drag costs one PTY resize instead of one per frame,
each of which would push another copy of a TUI's screen into the scrollback. Sessions survive browser disconnects but NOT a backend restart, and not
a Space sleep/rebuild; with storage the working dir and CLI state persist, so a
re-opened session resumes its own conversation. Claude
sessions are pinned to a per-session conversation id at creation; Codex sessions
are pinned right after first launch (the id is captured from the rollout file
Codex creates) — so agents sharing a folder never resume each other's
conversations.

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `7860` | HTTP + WS port (HF `app_port`) |
| `DATA_DIR` | `/data` | Durable root (mounted private Storage Bucket) |
| `AM_SCROLLBACK` | `20000` | Scrollback lines kept per session grid |
| `AM_REPLAY_BYTES` | `262144` | PTY bytes replayed to a reattaching browser |
| `AM_RESIZE_SETTLE_MS` | `120` | Quiet period before a resize is applied to the PTY |
| `AM_RESIZE_CARRY` | `1` | `0` reflows on resize like a plain terminal (duplicates scrollback) |
| `AM_RESIZE_ARCHIVE_MS` | `700` | Grace period for an app to repaint before rows a shrink pushed off are archived |
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
