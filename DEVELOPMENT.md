# Development

GitHub (`huggingface/agent-manager`) is the source of truth. The Spaces are
deployment targets, and their git history is disposable: everything that matters
at runtime lives on the mounted `/data` bucket, never in the repo.

## Remotes

| remote | repo | who pushes |
|---|---|---|
| `origin` | `github.com/huggingface/agent-manager` | you, always |
| `template` | `spaces/lvwerra/agent-manager-template` | on release, by hand or from Actions |
| `dev` | `spaces/lvwerra/agent-manager-dev` | you, to try a branch live |
| `space` | `spaces/lvwerra/agent-manager` | you, by hand, when you feel like it |

Set them up in a fresh clone:

```sh
git remote add template https://huggingface.co/spaces/lvwerra/agent-manager-template
git remote add dev      https://huggingface.co/spaces/lvwerra/agent-manager-dev
git remote add space    https://huggingface.co/spaces/lvwerra/agent-manager
```

Keep `origin` pointed only at GitHub. It used to carry the two Space URLs as
extra `pushurl`s, which meant a single `git push` deployed everywhere at once.

## The flow

1. **Branch, and open a PR against `main`.**
2. **Try it live** on the dev Space when it needs a real container (tmux, the
   bucket, real CLIs, agents talking to each other):
   ```sh
   git push dev HEAD:main --force
   ```
   or run the *Deploy dev Space* workflow from the Actions tab and pick your
   branch. Only one branch can be live there at a time.
3. **Merge to `main`.** Nothing deploys on merge.
4. **Publish a release** when you decide to: run the *Deploy template Space*
   workflow, which builds the frontend, checks the server parses, and mirrors
   `main` onto the template Space. Duplicated Spaces then see the new version
   behind their in-app update button. Publishing is manual precisely because it
   pushes an update to everyone who duplicated the Space. By hand:
   ```sh
   git push template main --force
   ```
5. **Your personal Space** (`space`) is yours to update whenever you want:
   ```sh
   git push space main --force
   ```

CI needs an `HF_TOKEN` repository secret with write access to the Space repos.
Prefer a fine-grained token scoped to just those Spaces over a personal
all-scopes one.

## Running locally

`tmux` is the only hard dependency (without it the server falls back to direct
PTYs and sessions don't survive a disconnect).

```sh
cd web    && npm install && npm run build   # or `npm run dev` for HMR
cd server && npm install && npm start
```

Useful env vars:

| var | why |
|---|---|
| `DATA_DIR` | point it somewhere disposable so you don't touch real sessions |
| `PORT` | defaults to 7860 |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME` | isolate CLI state from your own |
| `AM_NO_WATCHDOG=1` | silence the event-loop stall detector |
| `AM_DISTRIBUTE_SKILLS=1` | opt in to writing skills into `~/.claude` etc. Off unless `SPACE_ID` is set, so a local run never touches your own agent config |

A test run that shouldn't touch anything of yours:

```sh
cd server && DATA_DIR=/tmp/am-test PORT=7871 AM_NO_WATCHDOG=1 \
  CLAUDE_CONFIG_DIR=/tmp/am-test/claude npm start
```

To exercise a code path that would otherwise launch a real (paid) CLI, put a
stub earlier on `PATH`:

```sh
mkdir -p /tmp/stub && cat > /tmp/stub/claude <<'EOF'
#!/bin/sh
case "$1" in --version) echo "9.9.9 (stub)"; exit 0;; esac
echo "STUB claude launched with: $*"
exec cat
EOF
chmod +x /tmp/stub/claude
PATH=/tmp/stub:$PATH npm start   # in server/
```
