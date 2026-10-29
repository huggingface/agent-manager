# Restarting sessions after a reboot

A Space sleep, restart or rebuild ends every PTY the server owns. Two settings in
**Settings → General** bring the working set back.

## Which sessions come back (`revive.enabled`, `revive.days`)

Every 30 s `server/src/runstate.js` writes `DATA_DIR/runstate.json`: which
sessions were running, and for a shell, whether a command was still running in
it. On the next boot a session is started again when it was running at the last
snapshot and either you prompted it within `days` (1, 3 or 7) or it is a shell
with a job in flight. Sessions start at most 12, 4 s apart, newest first. Files,
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
- It uses the Overview reply box's delivery path (`deliver()` in `index.js`),
  so the privacy lock and the submit confirmation apply.
- It is sent once per boot and only to a pane that boot started. It waits up to
  120 s for the CLI to be ready for input. A pane stopped in the meantime is not
  started again and gets nothing.
- It is never sent to shells (their command is simply gone), Files, Trace or
  remote panes.

Turn it off with the **Tell restarted agents to continue** switch, or
`"revive": {"continue": false}` in `am-config.json`. Revived agents then wait
for you, as before.

Tests: `server/test/revive.test.mjs` (selection rules, who is told),
`server/test/revive-continue.test.mjs` (two real boots with a fake TUI: each
revived agent receives the message exactly once, a shell and a session stopped
before the restart receive nothing, and nothing is sent with the setting off).
