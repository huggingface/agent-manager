# Model and effort at creation

A new agent can be given a model and a reasoning effort when it is created
(the create panels, `POST /api/sessions` `{model, effort}`, the agent spawn API
`?model=&effort=`, and a cron's `agent.model` / `agent.effort`). Empty means
the CLI's own default, which is how every session launched before this.

The choice is stored on the session and rebuilt into flags on **every** launch
of it: fresh, seeded prompt, resume, continue, the fallbacks, and the shared
Codex helper. A restart keeps it, and an in-session `/model` that rewrites the
CLI's shared default cannot move it. See `launch` in `server/src/config.js`.

| CLI | Model | Effort | Model list from |
|---|---|---|---|
| claude | `--model` | `--effort` low…max | its own `/model` picker (below); aliases if that fails |
| codex | `-m` | `-c model_reasoning_effort=` per model | `codex debug models` |
| gemini | `-m` | — (settings file only) | names bundled in gemini-cli 0.66 |
| opencode | `-m provider/model` | — (TUI ignores a config variant) | `opencode models` |
| hermes | `--provider` + `-m` | `--reasoning` | `~/.hermes/provider_models_cache.json` |
| openclaw | — (`chat` has no `--model`) | `--thinking` | — |
| fx | — | — | — |

Lists are built in the background after boot, one CLI at a time, cached in
memory and in `STATE_DIR/cli-models.json`; `POST /api/launch-options/refresh`
(the ↻ in the form) asks again. A CLI whose list could not be built offers no
model at all — the server only accepts an id that is on the current list.

## Claude's picker probe

Claude Code has no list command, so `server/src/claude-models.js` starts
`claude` in a PTY (in `STATE_DIR/claude-model-probe`), opens `/model`, scrolls
the picker with Down and leaves with Esc. It never presses Enter or `s` in the
picker (that would change the default model for every session). It runs only
when Claude Code has a credential, and again only when its version changes or
on refresh. No prompt is sent.

The test runner sets `AM_CLAUDE_MODEL_PROBE=0`, because test servers run on the
real HOME. Set it yourself when you boot a server by hand on a signed-in HOME
and don't want the probe.
