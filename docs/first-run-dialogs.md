# First-run dialogs on a new session

A new Claude Code or Codex session used to stop at a dialog before it ran the
task it was launched with. Nobody is watching a pane the manager or another
agent just opened, so the work waited indefinitely — and a freshly booted CLI
reports `idle`, so a coordinator polling the session saw "finished".

This is what a clean launch actually asks, measured by launching both CLIs
against copied credentials in brand-new folders rather than read off their docs.

## What a new session hits

| CLI | dialog | keyed on | recorded in |
|---|---|---|---|
| both | **do you trust this folder?** | the **absolute path** | Claude: `projects[<path>].hasTrustDialogAccepted` in `.claude.json`. Codex: `[projects."<path>"] trust_level` in `config.toml` |
| Claude | managed settings / telemetry destination approval | a hash of the managed settings | `remote-settings-consent.json` (`dangerousSettingsHash`) |
| Claude | "running in Bypass Permissions mode" warning | global | `skipDangerousModePermissionPrompt` in `settings.json` |

**Trust does not inherit.** `/data/workspaces` being trusted does nothing for
`/data/workspaces/<new-session>`; the key is the exact path. That is why this is
a *per new session* problem rather than a once-per-Space one.

The other two are global and were already answered on this Space — but only
because a human once answered them, and only the trust file is written by
anything we control. `skipDangerousModePermissionPrompt` is now written by the
app (see `first-run.js`) so a rebuilt config cannot re-ask. Its default button
is **No, exit**, so a blind Enter on that dialog kills the session.

No update-available dialog appeared for either CLI, so nothing here touches
update *checking*. Suppressing a question we always answer the same way is not
the same as freezing the version, and the second is not something this should
buy quietly.

## What happens to the launch prompt while a dialog is up

Measured, because it decides whether pre-answering is enough:

- **The launch argument survives.** It is queued and runs as soon as the dialog
  is answered — for both CLIs. It is not lost.
- **A prompt sent while the dialog is showing is partly eaten.** The dialog's
  key handler consumes the leading characters and the trailing Enter dismisses
  the dialog, which then releases the queued launch prompt. Sending
  `reply with exactly SECOND` into a trust dialog arrived as
  `with exactly SECOND`, and the *first* prompt ran.

That is exactly the reported symptom — "the task never ran, and only started
after I sent the prompt a second time". The second send was answering the
dialog.

**`waitForInputReady` cannot detect this.** It waits for the screen to go quiet,
and a dialog is a quiet screen. So the fix has to be that the question was
already answered, not that we wait longer before typing.

## Where the answers have to live

Both files sit in the harness config dirs that `scripts/agent-state.sh` already
carries between local disk and the bucket:

- `CLAUDE_CONFIG_DIR` (`$AM_LOCAL/agent-state/claude`) ⇄ `$DATA_DIR/state/claude`
  — restored whole, so `.claude.json`, `settings.json` and
  `remote-settings-consent.json` all survive a deploy.
- `CODEX_HOME` (`$AM_LOCAL/codex-home`) ⇄ `$DATA_DIR/state/codex` — restored
  whole except databases and caches, so `config.toml` survives.

So nothing new has to be made durable; the existing bridge covers it. Note that
the live copies are on **local disk** and are wiped on every deploy — they are
only there because the bridge restores them at boot.

## The fix

Entirely in the spawn path; no image change was needed.

- `server/src/first-run.js` — `trustWorkspace(cli, dir)` writes the one trust
  key for that CLI, idempotently and additively, and
  `ensureClaudeDialogDefaults()` owns the bypass-warning answer.
- `runner.js:ensureRunning` calls `trustWorkspace` right after it creates the
  workspace and before it spawns the PTY. Done there rather than at session
  creation because the folder can be chosen, changed, or deleted and recreated
  in between.

Nothing about what an agent is *allowed* to do changes: `permissions.defaultMode`
and Codex's `approval_policy` / `sandbox_mode` are left exactly as found.
