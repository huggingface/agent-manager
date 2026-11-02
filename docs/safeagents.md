# Tool-call guard (safeagents)

**Settings → Safety** puts [safeagents](https://github.com/huggingface/safeagents)
between Claude Code and its model server. The proxy checks every tool call the
model makes before Claude Code sees it, and can replace a call it blocks with
a text notice. It is off by default.

| Mode | What it does |
|---|---|
| Off | No proxy. Sessions talk to the model server directly. |
| Log only | Records the calls safeagents would block, and lets them run. |
| Block | Replaces those calls with a notice, so Claude Code never runs them. |

## How it is wired

- `server/src/safeagents.js` runs one `safeagents` child process on
  `127.0.0.1:8787` (`AM_SAFEAGENTS_PORT`). It forwards to whatever Claude Code
  would otherwise use: `ANTHROPIC_BASE_URL` if the Space sets it, otherwise
  `https://api.anthropic.com`. If the proxy dies, it is restarted with backoff.
- When a **Claude Code** session launches while the proxy is up, it gets
  `ANTHROPIC_BASE_URL` pointing at the proxy (`runner.setLaunchEnv`). Sessions
  that are already running keep the environment they launched with. To guard
  one of them, restart it.
- When the proxy is not up, a launch is not routed through it. A URL that
  nothing answers would leave the session unable to reach the model.
- Turning the guard **off** while guarded sessions are still running leaves
  the proxy in log-only mode until the last of them exits. Otherwise those
  sessions would lose their model server.
- Boot revival waits for the proxy's first start, so revived sessions are
  guarded too.
- The setting lives in `$DATA_DIR/safeagents.json`. It is written with the
  same revision check as the other settings files.

## Logs

The Safety page shows three views:

- **Flagged**: safeagents' journal, `$DATA_DIR/safeagents/calls.jsonl`. It
  holds every call that did not simply pass, with its full arguments, the task
  it was made for, the findings and any judge verdict. It survives restarts.
  The arguments can contain secrets.
- **Live**: every call reviewed since the proxy started, including passes.
  This comes from the proxy's stdout and is kept in memory only.
- **Proxy log**: the proxy's own messages (start-up, upstream errors, exits).

`GET /api/safeagents` returns all of it.
`PUT /api/safeagents/config?base=<rev>` with `{ mode, allowHosts }` changes the
setting.

## Not covered yet

- **Codex** speaks the OpenAI Responses API, which safeagents does not check.
- **opencode and Hermes** are supported by safeagents, but only through their
  config files (a provider `baseURL`, auxiliary models). Routing them here
  would mean rewriting the operator's own config.
- **Calls are not tied to a session.** The journal does not record which
  session a call came from. Claude Code can send a per-session header
  (`ANTHROPIC_CUSTOM_HEADERS`), but safeagents would need to record it.
- With a custom base URL, Claude Code turns off Remote Control and tool search.
