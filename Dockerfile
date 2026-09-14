# ---------- build the frontend ----------
FROM node:24-bookworm AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# ---------- runtime ----------
# Node 24 (LTS "Krypton"): OpenClaw requires `>=24.16.0 <25 || >=26.1.0`, so 22
# cannot run it at all — that is why `openclaw` has never been in this image.
# 24 over 26 because it is the LTS line; 25 is excluded by that range anyway.
# bookworm stays: Debian 12's python3.11 is what Hermes's venv and /opt/py are
# built against, and nothing here needs a newer base.
# Everything else merely allows 24 — the highest floor among the other CLIs is
# claude-code's >=22.0.0. Both native addons (node-pty, libghostty-vt-node) are
# N-API, so they are not tied to a Node major.
FROM node:24-bookworm AS runtime

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
# Gemini merges hook arrays across settings layers. The lowest-priority system
# defaults layer adds an observation-only ToolPermission hook without replacing
# any user or project hooks.
COPY gemini-system-defaults.json /etc/gemini-cli/system-defaults.json
RUN npm install -g opencode-ai@latest || echo "opencode install failed"
RUN npm install -g openclaw@latest || echo "openclaw install failed"
# fx (Vercel Labs) ships as one static binary, not an npm package. Fetch the
# PINNED tarball rather than piping the vendor's setup.sh into a shell: that
# script resolves whatever `latest.txt` says on the day of the build, so the
# image would stop being reproducible. Apache-2.0 asks that the notices travel
# with a redistributed binary, hence the two doc files.
#
# Best-effort like the npm installs above, and for the same reason: one vendor
# CDN being unreachable must not fail the whole image and take the Space down
# with it. A missing binary is already a first-class state — cliCatalog() reports
# fx unavailable and the launcher greys it out.
RUN (curl -fsSL https://releases.fx.sh/v0.0.5/fx-linux-x86_64.tar.gz -o /tmp/fx.tar.gz \
      && tar -xzf /tmp/fx.tar.gz -C /tmp fx LICENSE THIRD_PARTY_NOTICES.md \
      && install -D -m 0755 /tmp/fx /usr/local/bin/fx \
      && install -D -m 0644 -t /usr/local/share/doc/fx /tmp/LICENSE /tmp/THIRD_PARTY_NOTICES.md \
      && fx --version) || echo "fx install failed"
RUN rm -f /tmp/fx.tar.gz /tmp/fx /tmp/LICENSE /tmp/THIRD_PARTY_NOTICES.md
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
#
# The browser revision must match the playwright the app pins. A bare
# `npx -y playwright install` fetches whatever is newest on the day the image
# is built, and playwright refuses a revision it wasn't built against — so the
# image shipped a chromium nothing could launch, and every browser test failed
# with "Executable doesn't exist" until someone downloaded 114MB by hand. Take
# the version from web/package.json so the two cannot drift apart again.
#
# PLAYWRIGHT_SKIP_BROWSER_GC is what makes the sharing above actually work. A
# `playwright install` does not only add its own revision: unless this is set,
# it also garbage-collects every revision its version doesn't know about
# (registry `_validateInstallationCache`, logged as "Removing unused browser").
# The Hermes installer further down runs its own pinned playwright against this
# same directory, so without this it deletes the revision installed here and
# leaves the image with a chromium the app cannot launch — which is exactly
# what a test build showed, 47 seconds after this step succeeded.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
ENV PLAYWRIGHT_SKIP_BROWSER_GC=1
COPY web/package.json /tmp/web-package.json
RUN PW="$(node -p 'require("/tmp/web-package.json").devDependencies.playwright.replace(/^\D*/, "")')" \
      && echo "installing chromium for playwright@$PW" \
      && npx -y "playwright@$PW" install --with-deps chromium \
      && chmod -R a+rwX /opt/pw-browsers \
      && rm -f /tmp/web-package.json \
      && ls /opt/pw-browsers \
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

# ---------- what actually installed ----------
# Every install above is best-effort (`|| echo "… failed"`), so the build stays
# green whether a CLI landed or not. That is how a missing OpenClaw shipped for
# months without anyone noticing. This step makes the log SAY what the image
# ended up with, per CLI and with versions, so a build can be read rather than
# trusted.
#
# Deliberately non-fatal: `set +e`, and it always exits 0. Making a missing CLI
# fail the build is a policy change nobody has asked for — see the PR.
RUN set +e; \
    echo "=================== IMAGE CLI INVENTORY ==================="; \
    printf '  %-10s %s\n' node "$(node --version 2>/dev/null)"; \
    printf '  %-10s %s\n' npm "$(npm --version 2>/dev/null)"; \
    printf '  %-10s %s\n' python3 "$(python3 --version 2>&1)"; \
    echo "  ----------------------------------------------------------"; \
    missing=""; \
    for c in claude codex gemini opencode openclaw hermes fx ccusage uv hf; do \
      path="$(command -v "$c" 2>/dev/null)"; \
      if [ -n "$path" ]; then \
        ver="$(timeout 30 "$c" --version 2>&1 | head -1 | tr -d '\r')"; \
        printf '  %-10s PRESENT  %-26s %s\n' "$c" "${ver:-(no --version output)}" "$path"; \
      else \
        printf '  %-10s MISSING  (not on PATH)\n' "$c"; \
        missing="$missing $c"; \
      fi; \
    done; \
    echo "  ----------------------------------------------------------"; \
    if [ -f /app/server/node_modules/node-pty/build/Release/pty.node ]; then \
      printf '  %-10s built    %s\n' node-pty "$(ls -la /app/server/node_modules/node-pty/build/Release/pty.node | awk '{print $5" bytes"}')"; \
    else \
      printf '  %-10s MISSING  native build did not produce pty.node\n' node-pty; \
    fi; \
    lg=/app/server/node_modules/@coder/libghostty-vt-node/prebuilds/linux-x64; \
    [ -d "$lg" ] && printf '  %-10s ok       %s\n' libghostty "$lg" \
                 || printf '  %-10s MISSING  no linux-x64 prebuild\n' libghostty; \
    echo "  ----------------------------------------------------------"; \
    if [ -n "$missing" ]; then \
      echo "  !!  NOT INSTALLED:$missing"; \
      echo "  !!  The build is still green on purpose; these will show as"; \
      echo "  !!  unavailable in Settings. Read this block, not the exit code."; \
    else \
      echo "  all expected CLIs resolved"; \
    fi; \
    echo "=========================================================="; \
    true

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
    DISABLE_AUTOUPDATER=1 \
    UV_THREADPOOL_SIZE=16

# Why 16 and not libuv's default 4: /data is a FUSE bucket, and moving the
# re-pin walks off the event loop moved them onto that pool instead — one
# outstanding op per watching pane, and panes launched together stay in phase,
# so their beats land together. Measured on the bucket, one stat on an unrelated
# file while N panes walk (p95 / worst):
#
#   pool  4:  N=4  0.2ms / 8ms      N=8  99.6ms / 177ms
#   pool 16:  N=4  0.2ms / 5ms      N=8   0.3ms /  89ms
#
# At 4 the pool is oversubscribed by the walks and everything else fs-shaped in
# the process queues behind them. The isolated worst-case outliers are the mount
# hiccuping and survive any pool size — it's the p95 that this fixes.

# Snapshot the env var NAMES present at build time. HF injects Space secrets and
# variables only at runtime, so anything in the runtime env that's absent here
# was injected by the platform — that's how the app detects which secrets exist
# (names only; values are never recorded).
RUN env | sed 's/=.*//' | sort -u > /app/build-env-keys.txt

EXPOSE 7860
CMD ["sh", "/app/entrypoint.sh"]
