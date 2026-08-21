# First-run dialogs on a new session

A new Claude Code or Codex session could stop at a dialog before running the
task it was launched with. Nobody is watching a pane the manager or another
agent just opened, and a freshly booted CLI reports `idle`, so a coordinator
polling the session saw "finished" while the work had not started.

Everything below was measured by launching the installed CLIs — Claude Code
2.1.232, Codex 0.149.0 — against copied credentials in brand-new folders.

## What a new session hits

| CLI | dialog | when | keyed on | recorded in |
|---|---|---|---|---|
| both | do you trust this folder? | any new folder | absolute path | Claude: `projects[<path>].hasTrustDialogAccepted` in `.claude.json`. Codex: `[projects."<path>"] trust_level` in `config.toml` |
| Codex | **Update available! → Update now / Skip / Skip until next version** | a launch **with no prompt**, when the cache holds a newer version | the version cache | `dismissed_version` in `version.json` |
| Claude | managed settings / telemetry approval | when the managed settings change | a hash of those settings | `remote-settings-consent.json` |
| Claude | "running in Bypass Permissions mode" | until answered | global | `skipDangerousModePermissionPrompt` in `settings.json` |

### Trust inheritance differs per CLI — do not generalise

- **Claude Code 2.1.232 inherits.** With only `<root>` marked
  `hasTrustDialogAccepted: true`, a brand-new `<root>/child` ran its launch task
  with no dialog. That is why its answer can be one boot-time entry on the
  workspaces root instead of a write per session.
- **Codex 0.149.0 does not.** The same shape — parent trusted, child new —
  showed the trust dialog. Codex needs the exact path.

An earlier version of this document said neither inherits. That was wrong, and
it was wrong in the expensive direction: it justified writing CLI state on every
session start when Claude needed no runtime write at all.

### The Codex update screen is real, and an earlier version of this document ruled it out

It does not appear when a task is passed on the command line, which is how every
run in the first investigation was done — so the first pass concluded, wrongly,
that the operator's "do you want to update now" must have been one of the trust
dialogs. It is its own dialog. Launch `codex` with **no prompt** against a cache
holding a newer version and it blocks before the session:

```
✨ Update available! 0.149.0 -> 999.0.0
› 1. Update now (runs `npm install -g @openai/codex`)
  2. Skip
  3. Skip until next version
  Press enter to continue
```

That is exactly a session created without a task — the operator clicks "new
agent", types the first prompt, and it goes into the dialog. `DISABLE_AUTOUPDATER`
does not suppress it and there is no CLI flag or env switch for it.

## What happens to a prompt while a dialog is up

- **A launch argument survives.** It is queued and runs once the dialog is
  answered, on both CLIs.
- **A prompt sent while the dialog is showing is partly eaten.** The dialog's
  key handler consumes the leading characters and the trailing Enter dismisses
  it, releasing the queued launch prompt. `reply with exactly SECOND` arrived as
  `with exactly SECOND`.
- **`waitForInputReady` cannot help.** It waits for the screen to go quiet, and
  a dialog is a quiet screen.

So the answer has to be that the question was already answered.

## The fix, and why each part is where it is

Two rules, both learned from a review that reproduced a silent data loss in the
first attempt: **never rewrite CLI-owned state on the session path**, and when
boot has to write, write once and only when the answer is missing.

| what | where | why there |
|---|---|---|
| Claude folder trust | **boot**, one entry on the workspaces root | it inherits, so this covers every session; boot runs before the app spawns anything |
| Claude bypass warning | **boot**, `settings.json` | that file is already written by the app's hooks installer, so it is not CLI-owned state |
| Codex folder trust | **per launch**, appended to `config.toml` | Codex neither inherits nor honours a `-c` override for trust, so the answer must be in the file — but it is **appended**, never rewritten |
| Codex update prompt | **per launch**, `dismissed_version` | the cache is refreshed in the background hours after boot, so once at boot is not enough |

### Why append instead of rewrite

The first attempt read all of `.claude.json`, changed one entry, and renamed the
result over the live file on every new session. A rename prevents a *torn* file;
it is not a lock. A review reproduced the loss deterministically — a concurrent
CLI write vanished, and because nothing ends up malformed, nothing downstream
ever notices.

An append cannot do that: it never writes another process's bytes. The worst
case is that our own few bytes are lost if Codex rewrites the file at the same
instant, and the only consequence is the dialog appearing once more.

`codexTrustedPaths()` decodes every `[projects.KEY]` header — basic strings,
literal strings (`[projects.'/path']`), and bare keys — because appending a
second table for a path that already has one under a different legal spelling
produces a file Codex refuses to load ("declared twice").

### Suppressing a prompt is not the same as never updating

`dismissCodexUpdatePrompt()` writes **only** `dismissed_version`.
`latest_version` and `last_checked_at` are left exactly as Codex wrote them, so
the background check keeps working, the cache keeps recording what is available,
and `codex update` still does its job. The version found is logged at boot and
before the launch that dismissed it:

```
[first-run] codex 999.0.0 is available (running 0.149.0); its update prompt is
dismissed so it cannot block a session — run `codex update` or rebuild the image
```

Nothing here disables update *checking*, and nothing changes what an agent is
allowed to do: `permissions.defaultMode` and Codex's `approval_policy` /
`sandbox_mode` are left as found.

## Durability

Both config trees are already carried by `scripts/agent-state.sh`:
`CLAUDE_CONFIG_DIR` ⇄ `$DATA_DIR/state/claude` (restored whole) and `CODEX_HOME`
⇄ `$DATA_DIR/state/codex` (restored whole except databases and caches). The live
copies are on local disk and are wiped every deploy; they are there because the
bridge restores them at boot. Nothing new had to be made durable.
