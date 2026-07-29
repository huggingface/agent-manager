// Both panels run on the SAME fixed grid. Sizing is the one variable that would
// otherwise contaminate the comparison (the classic path resizes tmux per
// client, the held path cannot), so it is pinned here and the browser scales its
// font to fit instead of resizing the PTY.
export const COLS = 100;
export const ROWS = 32;

// Control frames ride the terminal socket behind a leading NUL pair, which real
// PTY output never begins with.
export const CTRL = '\x00\x00LAB:';

export const SEED_PROMPT =
  'You are the-gatherer. Read your memory, then give me a short status: '
  + 'where the corpus stands, what you were mid-way through, and the three '
  + 'things you would pick up next. Keep it to about 15 lines.';

// Panel B runs WITHOUT tmux on purpose. With tmux in the middle the server's
// grid can never hold scrollback: tmux repaints 32 rows in place and keeps the
// history to itself, so nothing ever scrolls off into libghostty. Holding the
// PTY directly is both the only way to get scrollback and the actual end-state
// architecture. The cost is real and the lab shows it: panel A's session
// survives a server restart, panel B's does not.
export const PANELS = [
  {
    id: 'classic',
    mode: 'classic',
    tmux: true,
    label: 'current stack',
    sub: 'tmux redraw → ws bytes → xterm.js',
    dir: 'the-gatherer-a',
    notes: [
      'A new PTY attaches to tmux on every open',
      'Screen comes back as a tmux REDRAW',
      'Server has no idea what is on screen',
      'Survives a server restart (tmux outlives it)',
    ],
  },
  {
    id: 'ghostty',
    mode: 'ghostty',
    tmux: false,
    label: 'libghostty',
    sub: 'server grid → snapshot → ghostty-web',
    dir: 'the-gatherer-b',
    notes: [
      'One PTY held server-side, always warm',
      'Screen comes back as a snapshot() repaint',
      'Server can read the grid any time',
      'Dies with the server — no tmux to outlive it',
    ],
  },
];
