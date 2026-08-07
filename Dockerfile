# ---------- build the frontend ----------
FROM node:22-bookworm AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# ---------- runtime ----------
# Node 22+: required by OpenClaw (22.19+); everything else is version-agnostic.
FROM node:22-bookworm AS runtime

# System deps: git, build tools (node-pty native build),
# tmux is still installed for AGENTS to use if they want it — the app itself no
# longer runs sessions through it (see server/src/runner.js),
# ripgrep (used by the coding CLIs), curl/ca-certs — plus everyday QoL tools
# agents and humans reach for (jq/htop/sqlite3/editors/media, fonts so headless
# Chromium screenshots don't render tofu).
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux git git-lfs ca-certificates curl python3 make g++ ripgrep bubblewrap rsync util-linux \
      jq htop lsof tree ncdu sqlite3 vim nano zip unzip file procps less \
      ffmpeg imagemagick fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && git lfs install --system

# Git defaults every agent benefits from: the FUSE bucket trips "dubious
# ownership" without safe.directory, and commits die without an identity —
# these are SYSTEM level, so anything the operator sets globally still wins.
RUN git config --system safe.directory '*' \
    && git config --system init.defaultBranch main \
    && git config --system user.name 'Agent Manager' \
    && git config --system user.email 'agents@agent-manager.local'

# GitHub CLI (auths from a GH_TOKEN Space secret automatically).
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    || echo "gh install failed"

ENV LANG=C.UTF-8

# AI coding CLIs available to every session (installed globally, on PATH for all users).
# Pinned to @latest so a factory reboot (no-cache rebuild) reinstalls the newest
# published versions — that's what the "Relaunch & update" button triggers.
RUN npm install -g @anthropic-ai/claude-code@latest @openai/codex@latest
# This image is the administrator of its own Codex runtime. Install Agent
# Manager's lifecycle adapter as a managed hook so it runs deterministically
# without weakening trust for any user/project hooks.
COPY codex-requirements.toml /etc/codex/requirements.toml
COPY scripts/am-codex-repin-hook.sh /etc/codex/hooks/am-codex-repin-hook.sh
RUN chmod 755 /etc/codex/hooks/am-codex-repin-hook.sh
# Newer agents, best-effort so a publish hiccup can't break the image build;
# the app marks any missing binary "unavailable" gracefully.
RUN npm install -g @google/gemini-cli@latest || echo "gemini-cli install failed"
RUN npm install -g opencode-ai@latest || echo "opencode install failed"
RUN npm install -g openclaw@latest || echo "openclaw install failed"
# ccusage powers the Usage page (token/cost aggregation across agents). Its
# platform binary ships without an execute bit and the package tries to chmod
# itself on first run — which fails with EPERM at runtime as the non-root user.
# Make it executable here (as root) so it just works for the node user.
RUN npm install -g ccusage \
      && find "$(npm root -g)/ccusage" -type f -name ccusage -exec chmod a+rx {} + \
      || echo "ccusage install failed"
# uv: fast Python package/env manager agents use to (re)build project envs from
# their lockfiles on local disk. Installed to /usr/local/bin (on PATH for all).
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
      || echo "uv install failed"
# hf: the Hugging Face CLI (auth, hub up/downloads). Installed as a uv tool into
# a world-readable dir with its shim on the global PATH; picks up an HF_TOKEN
# Space secret automatically.
RUN env UV_TOOL_BIN_DIR=/usr/local/bin UV_TOOL_DIR=/opt/uv-tools \
      uv tool install --python /usr/bin/python3 "huggingface_hub[cli]" \
      || echo "hf cli install failed"

# Headless Chromium for Playwright, shared by every agent and both language
# bindings via PLAYWRIGHT_BROWSERS_PATH (world-writable so a binding pinned to
# a different build can add its revision without root).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx -y playwright install --with-deps chromium \
      && chmod -R a+rwX /opt/pw-browsers \
      || echo "playwright chromium install failed"

# Batteries-included default python: a dedicated venv first on PATH (system
# python stays apt-owned/PEP-668 clean). One-off scripts get the data stack
# without setup; real projects still build their own uv env on $AM_LOCAL.
RUN uv venv /opt/py \
      && uv pip install --python /opt/py/bin/python \
           numpy pandas matplotlib seaborn requests pillow huggingface_hub ipython \
      && chmod -R a+rX /opt/py \
      || echo "python stack install failed"
ENV MPLBACKEND=Agg

# Login shells source /etc/profile, which RESETS PATH — dropping the build-time
# ~/.local/bin and the user-install dirs under $AM_LOCAL (pip --user, npm
# prefix). profile.d runs after that reset, so restore them here.
RUN printf '%s\n' \
      'PATH="/home/node/.local/bin:/opt/py/bin:$PATH"' \
      '[ -n "$AM_LOCAL" ] && PATH="$AM_LOCAL/py/bin:$AM_LOCAL/npm/bin:$AM_LOCAL/bin:$PATH"' \
      'export PATH' \
      > /etc/profile.d/agent-manager.sh

# Non-root user: the node base image already ships uid 1000 as "node" (HF runs as uid 1000).
ENV HOME=/home/node
ENV PATH=/home/node/.local/bin:/opt/py/bin:$PATH
WORKDIR /app
RUN chown node:node /app

# Server deps first (better layer caching); node-pty compiles here.
COPY --chown=node:node server/package.json server/
USER node
RUN cd server && npm install --omit=dev

# Best-effort Hermes (Nous Research). Hardened so it can never hang or fail the
# build; the app marks it "unavailable" gracefully if the binary isn't on PATH.
RUN (curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/h.sh \
      && timeout 180 bash /tmp/h.sh </dev/null) \
      || echo "hermes not installed — will show as unavailable"
# Its installer only drops a shim in ~/.local/bin — expose it globally in
# /usr/local/bin like every other CLI.
USER root
RUN [ -x /home/node/.local/bin/hermes ] \
      && ln -sf /home/node/.local/bin/hermes /usr/local/bin/hermes \
      || true
USER node

# App code + built frontend + runtime config (prompt rcfile).
COPY --chown=node:node server/ server/
# scripts/ is not developer-only: share.js runs scripts/share-session.mjs as a
# child process to build a share bundle off the event loop, so it must ship.
COPY --chown=node:node scripts/ scripts/
COPY --chown=node:node --from=web /web/dist /app/public
COPY --chown=node:node entrypoint.sh /app/entrypoint.sh
COPY --chown=node:node session.bashrc /app/

ENV PORT=7860 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/public \
    DISABLE_AUTOUPDATER=1

# Snapshot the env var NAMES present at build time. HF injects Space secrets and
# variables only at runtime, so anything in the runtime env that's absent here
# was injected by the platform — that's how the app detects which secrets exist
# (names only; values are never recorded).
RUN env | sed 's/=.*//' | sort -u > /app/build-env-keys.txt

EXPOSE 7860
CMD ["sh", "/app/entrypoint.sh"]
