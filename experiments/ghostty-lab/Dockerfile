# ---------- build the frontend ----------
FROM node:22-bookworm AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# ---------- runtime ----------
FROM node:22-bookworm AS runtime

# tmux for the classic path's durability, build tools for node-pty, git/ripgrep
# because Claude Code expects them.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux git ca-certificates curl python3 make g++ ripgrep less procps \
    && rm -rf /var/lib/apt/lists/*

RUN git config --system safe.directory '*' \
    && git config --system user.name 'ghostty lab' \
    && git config --system user.email 'lab@ghostty-lab.local'

ENV LANG=C.UTF-8
RUN npm install -g @anthropic-ai/claude-code@latest

# HF runs as uid 1000, which the node image already ships as "node".
ENV HOME=/home/node
WORKDIR /app
RUN chown node:node /app

COPY --chown=node:node server/package.json server/
USER node
# node-pty compiles here; @coder/libghostty-vt-node pulls its linux prebuilt.
RUN cd server && npm install --omit=dev

COPY --chown=node:node server/ server/
COPY --chown=node:node --from=web /web/dist /app/public
COPY --chown=node:node entrypoint.sh tmux.conf /app/
COPY --chown=node:node seed/ /app/seed/

ENV PORT=7860 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/public \
    TMUX_CONF=/app/tmux.conf \
    DISABLE_AUTOUPDATER=1

EXPOSE 7860
CMD ["sh", "/app/entrypoint.sh"]
