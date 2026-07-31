/**
 * Turn a libghostty-vt snapshot into an ANSI repaint.
 *
 * Deliberately renderer-agnostic: the output is just bytes, so the same restore
 * works for xterm.js today and anything else that speaks VT later. That
 * portability is the argument for holding the grid server-side: the browser
 * stays a dumb renderer, and a reattaching client is repainted from our own
 * grid instead of asking the agent's TUI to redraw itself.
 *
 * snapshot() omits blank cells entirely, so gaps are painted as spaces.
 */

/**
 * snapshot() resolves palette colours to hex against libghostty's OWN default
 * palette, so blindly emitting truecolor would repaint a restored screen in
 * ghostty's greens and yellows instead of the theme the browser renders live
 * with. Probe the library for its palette once, then emit indexed SGR whenever a
 * colour came from it — the client re-maps those through its own theme, and only
 * genuinely truecolor cells stay pinned.
 */
let paletteIndex = null;

export function buildPaletteIndex(createTerminal) {
  if (paletteIndex) return paletteIndex;
  const map = new Map();
  try {
    const probe = createTerminal({ cols: 16, rows: 16, scrollbackLimit: 0 });
    let out = '';
    for (let i = 0; i < 256; i++) {
      if (i % 16 === 0 && i > 0) out += '\r\n';
      out += `\x1b[38;5;${i}mX`;
    }
    probe.feed(`${out}\x1b[0m`);
    for (const cell of probe.snapshot({ includeCells: true }).cells || []) {
      const idx = cell.row * 16 + cell.col;
      // A cell with no explicit foreground rendered as the default, which has no
      // stable index to map back to — leave those to truecolor.
      if (idx < 256 && cell.foreground && !map.has(cell.foreground)) map.set(cell.foreground, idx);
    }
    probe.dispose();
  } catch {
    /* fall through to truecolor-only */
  }
  paletteIndex = map;
  return map;
}

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  if (h.length !== 6) return null;
  const n = Number.parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};

function colorSgr(hex, layer) {
  const idx = paletteIndex && paletteIndex.get(hex);
  if (idx !== undefined) return `\x1b[${layer};5;${idx}m`;
  const rgb = hexToRgb(hex);
  return rgb ? `\x1b[${layer};2;${rgb}m` : '';
}

function sgrFor(cell) {
  let out = '';
  if (cell.bold) out += '\x1b[1m';
  if (cell.italic) out += '\x1b[3m';
  if (cell.underline) out += '\x1b[4m';
  if (cell.foreground) out += colorSgr(cell.foreground, 38);
  if (cell.background) out += colorSgr(cell.background, 48);
  return out;
}

/** Cells indexed by row, since snapshot() returns them as a flat sparse list. */
function cellGrid(snap) {
  const grid = Array.from({ length: snap.rows }, () => new Array(snap.cols).fill(null));
  for (const cell of snap.cells || []) {
    if (cell.row >= 0 && cell.row < snap.rows && cell.col >= 0 && cell.col < snap.cols) {
      grid[cell.row][cell.col] = cell;
    }
  }
  return grid;
}

/**
 * One row as styled text, with no cursor positioning. Everything after the last
 * drawn cell is dropped: trailing spaces are the bulk of a mostly-empty agent
 * screen, and the caller has either just erased the line or is about to end it.
 */
function renderRow(cells, cols) {
  let last = -1;
  for (let col = cols - 1; col >= 0; col--) {
    if (cells[col] && (cells[col].text !== ' ' || cells[col].background)) { last = col; break; }
  }
  if (last < 0) return '';

  let out = '';
  let style = '';
  let col = 0;
  while (col <= last) {
    const cell = cells[col];
    if (!cell) {
      if (style) { out += '\x1b[0m'; style = ''; }
      out += ' ';
      col += 1;
      continue;
    }
    const next = sgrFor(cell);
    if (next !== style) {
      out += '\x1b[0m' + next;
      style = next;
    }
    out += cell.text;
    col += Math.max(1, cell.width || 1);
  }
  if (style) out += '\x1b[0m';
  return out;
}

export function snapshotToAnsi(snap) {
  const grid = cellGrid(snap);

  // Normalise the receiver's active buffer first. Reset attributes so nothing
  // leaks in from what was showing, and hide the cursor so the repaint doesn't
  // strobe across the screen.
  let out = snap.isAltScreen ? '\x1b[?1049h' : '\x1b[?1049l';
  out += '\x1b[?25l\x1b[0m\x1b[H\x1b[2J';

  for (let row = 0; row < snap.rows; row++) {
    const line = renderRow(grid[row], snap.cols);
    if (line) out += `\x1b[${row + 1};1H` + line;
  }

  out += `\x1b[0m\x1b[${snap.cursorRow + 1};${snap.cursorCol + 1}H`;
  out += '\x1b[?25h';
  return out;
}

/**
 * Rebuild a fresh viewer from Ghostty's canonical state.
 *
 * The binding currently exposes styled cells only for the visible screen, while
 * scrollback is plain text. That is still a much stronger restore boundary than
 * replaying a truncated raw PTY byte stream: it includes every retained history
 * row, is already reflowed to the current geometry, and cannot begin halfway
 * through an escape sequence.
 *
 * A line becomes scrollback only after it leaves the visible grid. Print the
 * history on the primary screen, then scroll the remaining visible history rows
 * off before painting the authoritative current screen.
 */
export function snapshotToRestoreAnsi(snap) {
  const history = (snap.scrollbackLines || []).map((line) => line.text || '');
  let out = '\x1b[?1049l\x1b[?25l\x1b[0m\x1b[H\x1b[2J';
  if (history.length) {
    out += history.join('\r\n');
    out += `\x1b[${snap.rows};1H` + '\r\n'.repeat(Math.min(history.length, snap.rows));
  }
  out += snapshotToAnsi(snap);
  return out;
}
