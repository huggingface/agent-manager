// A stand-in for an agent TUI, for the resize tests. Repaints the way Claude
// Code does (measured from a live pane): hide the cursor, home, erase every
// visible row with `\x1b[2K\x1b[1B`, home again, then print the tail of its
// transcript wrapped to the CURRENT width — no screen clear, no scrollback
// clear, no alternate screen. That is what makes a resize duplicate content:
// rows the emulator pushed into scrollback while shrinking are printed again.
//
// Every token is unique (`LLL.CC`), so a token appearing twice in the grid is a
// real duplicate and not two identical filler lines.
const COLS = () => process.stdout.columns || 80;
const ROWS = () => process.stdout.rows || 24;

const TRANSCRIPT = Array.from({ length: 60 }, (_, i) =>
  Array.from({ length: 22 }, (_, j) => `${String(i + 1).padStart(3, '0')}.${String(j).padStart(2, '0')}`).join(' '));

function paint() {
  let out = '\x1b[?25l\x1b[H';
  for (let r = 0; r < ROWS(); r++) out += '\x1b[2K\x1b[1B';
  out += '\x1b[H';
  // Print enough of the transcript to fill the screen at this width — the tail,
  // like a TUI showing the most recent output above its input box.
  const perLine = Math.max(1, Math.ceil(TRANSCRIPT[0].length / COLS()));
  const fit = Math.max(1, Math.floor((ROWS() - 2) / perLine));
  out += TRANSCRIPT.slice(-fit).join('\r\n');
  out += `\r\n[fixture ${COLS()}x${ROWS()}]\x1b[?25h`;
  process.stdout.write(out);
}

process.stdout.on('resize', paint);
process.stdin.resume();
paint();
setInterval(() => {}, 1 << 30);
