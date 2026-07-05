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

# System deps: tmux (session durability), git, build tools (node-pty native build),
# ripgrep (used by the coding CLIs), curl/ca-certs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux git ca-certificates curl python3 make g++ ripgrep bubblewrap rsync \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=C.UTF-8

# AI coding CLIs available to every session (installed globally, on PATH for all users).
# Pinned to @latest so a factory reboot (no-cache rebuild) reinstalls the newest
# published versions — that's what the "Relaunch & update" button triggers.
RUN npm install -g @anthropic-ai/claude-code@latest @openai/codex@latest
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

# Non-root user: the node base image already ships uid 1000 as "node" (HF runs as uid 1000).
ENV HOME=/home/node
ENV PATH=/home/node/.local/bin:$PATH
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

# App code + built frontend + runtime config (tmux + prompt rcfile).
COPY --chown=node:node server/ server/
COPY --chown=node:node --from=web /web/dist /app/public
COPY --chown=node:node entrypoint.sh /app/entrypoint.sh
COPY --chown=node:node tmux.conf session.bashrc /app/

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
