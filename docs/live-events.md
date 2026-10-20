# Live state and reader updates

The sidebar and Overview state marks, the working spinner, unread marks and
an open reader all follow what an agent is doing within about half a second.
Polls are still there as a backstop, but these updates no longer depend on
them.

## Where the delay was

Measured on a local instance with a fake agent TUI in a real PTY (see the
test below). Times run from the event in the PTY or transcript to the browser
showing it.

| Stage | Before | After |
| --- | --- | --- |
| Turn starts → sidebar shows working | 0.9 s median, up to 1.6 s (tree poll, 2.5 s) | ~5 ms |
| Turn ends → server says waiting/idle | 4.5 s (4 s quiet window, rounded) | ~370 ms |
| Turn ends → sidebar shows it | 4.9–6.8 s | ~350 ms |
| New transcript record → reader shows it | 1.2–2.7 s (reader poll, 3 s) | ~8 ms |

## How it works

**Detection** (`server/src/runner.js`). A pane counts as working on the first
changed frame. The release is asymmetric. Once the screen goes quiet, it
returns to waiting/idle after `AM_RELEASE_QUIET_MS` (350 ms), unless the
screen still shows a busy marker (`esc to interrupt`, `esc to cancel`). With
a marker it waits the old 4 s. A shell whose command is still running is held
the same way. CLIs with no known marker use `AM_RELEASE_UNMARKED_MS` (1.5 s).
Three kinds of frames don't count as work: the echo of typed input (within
`AM_ECHO_MS`, 150 ms, of a non-submitting write), and the repaints the server
makes itself (resize, history restore). The 250 ms sampling throttle now
samples a trailing frame too, so the last change of a burst is never missed.

**Push** (`server/src/live-events.js`, `web/src/lib/liveEvents.ts`). The app
opens one socket on the existing endpoint, `/ws?events=1`, with the same
admission and privacy lock as a terminal socket. The server sends:

- `{t:'states', states}`, once when the socket connects;
- `{t:'state', id, state, running, inputRequired}` on each transition;
- `{t:'trace', id, watched}` when a live transcript grows. Transcripts are
  watched with `fs.watch` on the live CLI files, which are on local disk. The
  watch runs only while a browser is connected, and nothing polls the bucket.
  Pulses for one file are at least 150 ms apart.

The app patches the tree and metadata in place. A pushed state is only
overwritten by a poll that was *sent* after it arrived, so a response that
was already in flight can't bring back the old state. When a turn ends, the
app makes one `/api/meta?fresh=1` read, which waits for the digest rebuild
that is already under way, so the unread mark belongs to the turn that just
ended. A `trace` pulse makes the open reader read forward from its cursor at
once, at most once per 250 ms, and the same goes for an expanded Overview
card.

**Load.** With the socket up, the tree poll slows from 2.5 s to 5 s. A reader
whose transcript is watched polls every 10 s as a backstop, instead of every
3 s. The forward reads that pulses trigger are small appended windows of a
local file.

Not covered (these stay on their polls): remote agents, Codex shared
sessions (their state comes from the app server), and opencode/Hermes
transcripts (SQLite).

Validation: `server/test/live-latency.test.mjs` runs a fake TUI
(`server/test/fixtures/fake-tui.mjs`) as `claude` in a real PTY. It checks
that working, each new transcript record, and the end of a turn each reach a
WebSocket client within 500 ms. It also checks that a turn which goes quiet
with its marker on screen, or a shell command that is silent for a second,
does not flap.
