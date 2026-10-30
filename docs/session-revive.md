# Restarting sessions after a reboot

A Space sleep, restart or rebuild ends every PTY the server owns. Two settings in
**Settings → General** bring the working set back.

## Which sessions come back (`revive.enabled`, `revive.days`)

Every 30 s `server/src/runstate.js` writes `DATA_DIR/runstate.json`: which
sessions were running, and for a shell, whether a command was still running in
it. On the next boot a session is started again when it was running at the last
snapshot and either you prompted it within `days` (1, 3 or 7) or it is a shell
with a job in flight. Sessions start at most 32, 4 s apart, newest first (beyond that the
most recently used are started and the rest are named in the log). Files,
Trace and remote panes, sessions stopped before the restart, and Codex sessions
that belong to the shared Codex server are never started. Each agent resumes its
own pinned conversation (`runner.commandFor`).

## Telling the agent it was interrupted (`revive.continue`, default on)

Resuming a conversation brings back the transcript, not the turn. Whatever the
agent was doing — a tool call, a sub-agent, the background `curl` listener it
keeps for peer messages — died with the old process, and the resumed CLI just
sits at its prompt. So once each revived **agent** can take input, Agent Manager
sends it one message:

> [Agent Manager:] Agent Manager was restarted, which interrupted this session:
> running tool calls and background listeners were stopped. If your turn was not
> finished, continue where you left off and restart any listeners you need. If it
> was, there is nothing to do.

- It goes to every revived agent, not only those caught mid-turn. An idle agent
  has lost its listeners too, and the text tells one that had finished that there
  is nothing to pick up. That avoids depending on a screen heuristic, which would
  be wrong for the turns that start or end within the 30 s between snapshots.
- **Only into an empty prompt** (`runner.promptReady`). Output must have settled,
  the CLI must not be reporting an open dialog (input-required), and a composer
  must be positively identified and empty: a ruled box with the cursor in it, the
  bottom-most prompt marker with no menu or dialog hint below it, or OpenCode's
  `┃ … ╹` box. A quiet screen alone is not enough, because a trust, login or update
  dialog is quiet too.
- **Only for CLIs with a prompt detector** (`promptDetector: true` in `config.js`),
  meaning ones whose empty composer has been checked on a pane captured from the real CLI
  (`server/test/fixtures/input-lines.json`). For any other CLI the message is
  skipped immediately with `[revive] <name>: no prompt detector for <cli>, not
  sent`, and the session is still revived.

  | CLI | Gets the message | Why |
  | --- | --- | --- |
  | Claude Code | yes | ruled `❯` composer box, captured |
  | Codex | yes | bottom-most `›` composer, captured |
  | OpenCode | yes | its `┃ … ╹` box, captured (own rule) |
  | Hermes | yes | `>` composer, captured |
  | Gemini CLI | no | the only capture is the OAuth code prompt; no empty composer captured |
  | OpenClaw | no | the only capture is a `[Y/n]` doctor dialog |
  | fx | no | the only capture is the sign-in menu |
  | Antigravity (`agy`, PR #227) | no | not merged; no captured screens |

  To add one, capture its empty and typed composer into `input-lines.json`, set
  the flag, and extend `revive-safety.test.mjs` (it pins the list).

- **Bound to the revived process.** The pane's launch id (`AM_RUN_ID`) is taken when
  revive starts it and is checked while waiting, again in `deliver()`, and once more
  in `sendInput` just before the keystrokes. A stop, restart or archive ends the
  wait, and a replacement process never inherits the message. Delivery never
  starts a pane.
- **The stagger leaves alone what the operator touched.** A slot skips a session
  that was archived, or launched by anyone since boot, including one opened and
  stopped again before its turn.
- **Privacy lock.** Each message holds a lock scope from when it is scheduled (at
  boot, before its slot) until it is delivered or dropped. A lock landing at any
  point drops it for good, even if the Space unlocks before the pane is ready.
- **OpenCode** can paint a stable first screen before its input handler works.
  The first send to each OpenCode launch now always waits for the text to be
  echoed back before pressing Enter, whoever started the pane.
- The message uses the Overview reply box's delivery path (`deliver()` in
  `index.js`), so submit confirmation applies. It is sent once per boot, only to
  panes that boot started, and never to shells (their command is simply gone),
  Files, Trace or remote panes. A failed delivery is logged and not retried.
- "Stopped before the restart" means stopped as of the last snapshot. A session
  stopped less than 30 s before the shutdown can still be revived and told.

Turn it off with the **Tell restarted agents to continue** switch, or
`"revive": {"continue": false}` in `am-config.json`. Revived agents then wait
for you, as before.

Tests: `server/test/revive.test.mjs` (selection rules, who is told),
`server/test/revive-continue.test.mjs` (two real boots with a fake TUI: each
revived agent receives the message exactly once, by `AM_ID`; a shell and a
session stopped before the restart receive nothing; nothing is sent with the
setting off), `server/test/revive-safety.test.mjs` (real runner PTYs with fake
CLIs: dialogs with and without an input-required signal, captured real screens,
OpenCode's late input handler, restart/stop/archive while waiting, the stagger
skipping touched sessions, lock cancellation), and `server/test/revive-lock.test.mjs`
(a real server and a fake Hub: a lock and unlock while the pane loads drops
the message).
