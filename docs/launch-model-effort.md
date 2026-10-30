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
| gemini | `-m` | — (settings file only) | `VALID_GEMINI_MODELS` in the installed gemini-cli bundle |
| opencode | `-m provider/model` | — (TUI ignores a config variant) | `opencode models` |
| antigravity | `--model` (ids carry a tier, e.g. `gemini-4-argon-high`) | `--effort` low…max | `agy models` (network; the `modelProvider: gemini` setting when only `GEMINI_API_KEY` is set) |
| hermes | `--provider` + `-m` | `--reasoning` | `~/.hermes/provider_models_cache.json` |
| openclaw | — (`chat` has no `--model`) | `--thinking` | — |
| fx | — | — | — |

Lists are built in the background after boot, one CLI at a time, cached in
memory and in `STATE_DIR/cli-models.json`; `POST /api/launch-options/refresh`
(the ↻ in the form) asks again. A CLI whose list could not be built offers no
model at all — the server only accepts an id that is on the current list.

In the form (`web/src/components/LaunchPicker.tsx`), every open panel shares
one catalog. It is asked again each time a panel opens, and every 3 s while
the server says it is still building the lists (`refreshing`, true until the
first scan after boot ends). A CLI that takes a model but has no list yet shows
a disabled "Model: listing…" select next to the ↻. When the catalog changes,
a model or effort it no longer offers is cleared, so the form never submits a
choice it does not show. In the quick panel, changing the choice starts a new
target, like changing the name or folder: a session already created for
attachments is not reused with the old choice.

## Claude's picker probe

Claude Code has no list command, so `server/src/claude-models.js` starts
`claude` in a PTY (in `STATE_DIR/claude-model-probe`), opens `/model`, scrolls
the picker with Down and leaves with Esc. It never presses Enter or `s` in the
picker (that would change the default model for every session). No prompt is
sent.

- It starts Claude with `--safe-mode` (no hooks, plugins, MCP servers,
  CLAUDE.md or skills; the sign-in still works), plus
  `--settings '{"disableAllHooks":true}' --strict-mcp-config --no-chrome`.
  `--bare` is not used: it never reads the OAuth sign-in.
- It runs in its own process group, killed as a whole when the probe ends.
  The list commands of the other CLIs run the same way.
- It runs only when Claude Code has a credential, and once per Claude Code
  version, whether it worked or not; the ↻ refresh tries again.
- **It is off unless the server runs with `AM_CLAUDE_MODEL_PROBE=1`.** The
  Docker entrypoint sets that for the server (a Space variable
  `AM_CLAUDE_MODEL_PROBE=0` turns it off). A server you start by hand, a local
  install or a test server does not probe, and offers the aliases. Sessions
  never inherit the variable, and the test runner forces it to `0`.
