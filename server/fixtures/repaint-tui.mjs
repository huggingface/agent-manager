// A stand-in for an agent TUI, for the resize tests. Repaints the way Claude
// Code does (measured from a live pane): hide the cursor, home, erase every
// visible row with `\x1b[2K\x1b[1B`, home again, then print the tail of its
// transcript wrapped to the CURRENT width — no screen clear, no scrollback
// clear, no alternate screen. That is what makes a resize duplicate content:
// rows the emulator pushed into scrollback while shrinking are printed again.
//
// Every token is unique (`LLL.CC`), so a token appearing twice in the grid is a
// real duplicate and not two identical filler lines.
import fs from 'node:fs';
import path from 'node:path';

const COLS = () => process.stdout.columns || 80;
const ROWS = () => process.stdout.rows || 24;

const TRANSCRIPT = Array.from({ length: 60 }, (_, i) =>
  Array.from({ length: 22 }, (_, j) => `${String(i + 1).padStart(3, '0')}.${String(j).padStart(2, '0')}`).join(' '));

// With FIXED_LINES set, print that many transcript lines whatever the size —
// which is what an agent showing the tail of a conversation does. Narrowing the
// pane then WRAPS those lines, so the printed frame becomes taller than the screen
// and printing it scrolls the overflow into scrollback. That overflow is a copy of
// what the frame also shows, and it is the artifact a real agent pane leaves
// behind on zoom. Without the variable, the frame is trimmed to fit and nothing
// scrolls.
const FIXED = Number(process.env.FIXED_LINES || 0);
const HISTORY = Number(process.env.HISTORY_LINES || 0);

function paint(limit = null) {
  let out = '\x1b[?25l\x1b[H';
  for (let r = 0; r < ROWS(); r++) out += '\x1b[2K\x1b[1B';
  out += '\x1b[H';
  // Print enough of the transcript to fill the screen at this width — the tail,
  // like a TUI showing the most recent output above its input box.
  const perLine = Math.max(1, Math.ceil(TRANSCRIPT[0].length / COLS()));
  const fit = Math.max(1, Math.floor((ROWS() - 2) / perLine));
  out += TRANSCRIPT.slice(-(limit ?? (FIXED || fit)))
    .map((line, index) => `\x1b[38;5;${31 + (index % 6)}m${line}\x1b[0m`)
    .join('\r\n');
  out += `\r\n[fixture ${COLS()}x${ROWS()}]\x1b[?25h`;
  process.stdout.write(out);
}

process.stdout.on('resize', paint);
process.stdin.resume();
if (HISTORY > 0) {
  process.stdout.write(Array.from({ length: HISTORY }, (_, i) =>
    `history-${String(i + 1).padStart(4, '0')}`).join('\r\n') + '\r\n');
}
const resumeDelay = Number(process.env.DELAY_RESUME_MS || 0);
const launchMarker = path.join(process.cwd(), '.repaint-fixture-launched');
if (resumeDelay > 0 && fs.existsSync(launchMarker)) {
  // Claude can pause after the first part of its resumed screen. A startup
  // capture must span that gap; otherwise the remainder is mistaken for new
  // terminal history and duplicates the persisted transcript.
  paint(1);
  setTimeout(paint, resumeDelay);
} else {
  if (resumeDelay > 0) fs.writeFileSync(launchMarker, '1');
  paint();
}
setInterval(() => {}, 1 << 30);
