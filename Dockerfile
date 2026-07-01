# ---------- build the frontend ----------
FROM node:20-bookworm AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# ---------- runtime ----------
FROM node:20-bookworm AS runtime

# System deps: tmux (session durability), git, build tools (node-pty native build),
# ripgrep (used by the coding CLIs), curl/ca-certs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux git ca-certificates curl python3 make g++ ripgrep bubblewrap \
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
# ccusage powers the Usage page (token/cost aggregation across agents). Its
# platform binary ships without an execute bit and the package tries to chmod
# itself on first run — which fails with EPERM at runtime as the non-root user.
# Make it executable here (as root) so it just works for the node user.
RUN npm install -g ccusage \
      && find "$(npm root -g)/ccusage" -type f -name ccusage -exec chmod a+rx {} + \
      || echo "ccusage install failed"

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

EXPOSE 7860
CMD ["sh", "/app/entrypoint.sh"]
