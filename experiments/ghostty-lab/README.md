---
title: Ghostty Lab
emoji: 👻
colorFrom: gray
colorTo: green
sdk: docker
app_port: 7860
pinned: false
short_description: Side-by-side terminal stack comparison for agent-manager
---

# ghostty lab

A throwaway experiment for [agent-manager](https://github.com/huggingface/agent-manager):
does holding the terminal state server-side with **libghostty-vt** beat the
current tmux-redraw path?

Two Claude sessions, both preloaded as `the-gatherer`, on the same fixed
100×32 grid. The only variable is how a returning browser gets its screen back.

| | panel A — current stack | panel B — libghostty |
|---|---|---|
| PTY | new one per browser attach, via tmux | one held server-side, no tmux |
| restore | tmux REDRAW over the socket | `snapshot()` → ANSI repaint |
| renderer | xterm.js | ghostty-web (wasm) |
| scrollback | lives in tmux, reached by forwarding the wheel | replayed into the browser, scrolls locally |
| server knows the screen | no | yes |
| survives a server restart | yes | no |

### Why panel B drops tmux

Not a shortcut. With tmux in the middle the server-held grid can never have
scrollback: tmux repaints its 32 rows in place and keeps the history to itself,
so nothing ever scrolls off into libghostty. Holding the PTY directly is the
only way to get scrollback, and it is the end-state architecture anyway.

The cost is the last row of that table, and it is the real open question for
prod: tmux's one genuinely load-bearing job is outliving the Node process.
Replacing it means writing a small PTY daemon, or accepting that a server
restart ends sessions and leaning on each CLI's own resume.

## The measurements

Every attach records five marks, relative to panel mount:

- **engine ready** — renderer usable (for B this includes the ~400KB wasm init)
- **socket open**
- **first frame**
- **server preview** — B only: a server-rendered HTML paint of the last known
  screen, which can land before the renderer even exists
- **screen back** — the session is readable again. This is the number that matters.

### Resize

The lab header toggles how the grid is sized:

- **reflow** (default) — the font is pinned and the grid follows the container,
  so dragging the window edge resizes both PTYs. This is what production does,
  and the only mode that exercises reflow. Each panel reports its last resize as
  `old → new · settled in Xms · YKB repaint`, so "smooth" is measurable: panel A's
  repaint comes from tmux redrawing its grid, panel B's comes straight from the
  app reacting to SIGWINCH with libghostty reflowing the held scrollback.
- **fixed grid** — the grid is pinned and the font scales to it, so the PTY is
  never resized. This is the design's claim that a viewer can zoom without
  touching the session.

Panel B enforces ONE grid for all viewers, sized to the smallest of them, and
broadcasts it. A client may request a size; it never imposes one. Open the lab on
a laptop and a phone at once and the header shows `40×20 · 2 viewers · grid
shared`; close the phone and it grows back. Without this the phone resizes the
PTY while the laptop keeps rendering into its old geometry, which looks like
garbled output rather than a small terminal.

Panel A cannot do this: each browser spawns its own tmux client, and
`new-session -A -D` means the second device takes the session away from the first.

Leave the lab (`‹ back`) and return to take a fresh measurement. Both sessions
keep running while you are away, so returning is the realistic case. The landing
page keeps medians in `localStorage`.

The landing page also asks each panel *what is on your screen right now* with
nothing attached. Panel B answers from its grid in well under a millisecond.
Panel A cannot answer at all, which is the same limitation that pushes
agent-manager into parsing per-CLI transcript JSONL for its Overview feed.

## Running it

Needs a private Storage Bucket mounted at `/data` (Claude's login and both
workspaces live there), or set `ANTHROPIC_API_KEY` as a Space secret. Without
either, both panels show Claude's login prompt; logging in once in either panel
is enough.

Local dev:

```bash
cd server && npm install && DATA_DIR=./.data npm run dev
cd web && npm install && npm run dev
```

`@coder/libghostty-vt-node` ships prebuilts for linux x64/arm64 and macOS arm64
only, and needs Node ≥ 20.19. Without it the server still boots and panel A
still works; panel B reports the failure instead of pretending.

## Caveats

- The API of libghostty-vt is explicitly unstable, and both bindings
  (`@coder/libghostty-vt-node`, `ghostty-web`) are third party. Versions are pinned.
- The restore repaint emits truecolor SGR because `snapshot()` hands back
  already-resolved hex, so a restored screen does not follow a later theme change.
- Panel B pins the grid size server-side. That is the real tradeoff of the
  design, not an oversight: one grid, many viewers.
- Scrollback is restored by replaying raw PTY bytes from a bounded ring
  (`LAB_REPLAY_BYTES`, default 256KB), not from `snapshot()`. snapshot returns
  history as plain LINES rather than cells, so replaying it produced colourless
  scrollback under a fully styled screen. Replaying bytes reconstructs history
  exactly as a browser that never detached would have drawn it, and the snapshot
  repaint still lands on top as the authority for the visible screen.
