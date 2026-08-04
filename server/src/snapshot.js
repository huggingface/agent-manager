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

// Snapshot history is plain terminal text. Count its display columns closely
// enough to know how many visual rows it occupies when restored at a different
// width; using string.length loses wrapped rows (and then the screen repaint
// overwrites them). Combining marks are zero-width, common CJK/emoji ranges are
// two columns, and everything else is one.
export function textColumns(text) {
  let width = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp === 0x200d || cp === 0xfe0e || cp === 0xfe0f || /\p{Mark}/u.test(char)) continue;
    const wide = cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a
      || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
      || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe10 && cp <= 0xfe19)
      || (cp >= 0xfe30 && cp <= 0xfe6f)
      || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6)
      || (cp >= 0x1f300 && cp <= 0x1faff)
      || (cp >= 0x20000 && cp <= 0x3fffd)
    );
    width += wide ? 2 : 1;
  }
  return width;
}

function htmlEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function cssColor(style, property, layer) {
  const escaped = property.replace('-', '\\-');
  const palette = style.match(new RegExp(`(?:^|;)${escaped}: var\\(--vt-palette-(\\d+)\\)`));
  if (palette) return `${layer};5;${palette[1]}`;
  const rgb = style.match(new RegExp(`(?:^|;)${escaped}: rgb\\((\\d+), (\\d+), (\\d+)\\)`));
  return rgb ? `${layer};2;${rgb[1]};${rgb[2]};${rgb[3]}` : '';
}

function htmlStyleSgr(style) {
  const codes = [];
  const foreground = cssColor(style, 'color', 38);
  const background = cssColor(style, 'background-color', 48);
  if (foreground) codes.push(foreground);
  if (background) codes.push(background);
  if (style.includes('font-weight: bold')) codes.push('1');
  if (style.includes('opacity: 0.5')) codes.push('2');
  if (style.includes('font-style: italic')) codes.push('3');
  if (/text-decoration-line:[^;]*underline/.test(style)) codes.push('4');
  if (/text-decoration-line:[^;]*blink/.test(style)) codes.push('5');
  if (style.includes('filter: invert(100%)')) codes.push('7');
  if (/text-decoration-line:[^;]*line-through/.test(style)) codes.push('9');
  if (/text-decoration-line:[^;]*overline/.test(style)) codes.push('53');
  return codes.length ? `\x1b[${codes.join(';')}m` : '';
}

const hasAnsiStyle = (text) => text.replace(/\x1b\[0m/g, '').includes('\x1b[');

/** Convert Ghostty's deterministic debug HTML into one ANSI string per visual row. */
function htmlAnsiRows(html) {
  if (typeof html !== 'string') return [];
  const first = html.indexOf('>');
  const last = html.lastIndexOf('</div>');
  if (first < 0 || last <= first) return [];
  const inner = html.slice(first + 1, last);
  const ansi = inner
    .replace(/<div style="([^"]*)">/g, (_, style) => htmlStyleSgr(style))
    .replace(/<\/div>/g, '\x1b[0m');
  return htmlEntities(ansi).split('\n');
}

/** Styled visual rows for the complete primary grid, including scrollback. */
export function styledTerminalRows(snap, html) {
  const plain = [...(snap.scrollbackLines || []), ...(snap.visibleLines || [])];
  const ansi = htmlAnsiRows(html);
  while (ansi.length < plain.length && !(plain[ansi.length]?.text || '')) ansi.push('');
  if (ansi.length !== plain.length) return plain.map((line) => ({ text: line.text || '' }));
  return plain.map((line, index) => {
    const text = line.text || '';
    const rendered = ansi[index] || '';
    return hasAnsiStyle(rendered) ? { text, ansi: `${rendered}\x1b[0m` } : { text };
  });
}

function joinStyledRows(rows, cols) {
  const lines = [];
  let text = '';
  let ansi = '';
  for (const row of rows) {
    text += row.text || '';
    ansi += row.ansi || row.text || '';
    if (textColumns(row.text || '') < cols) {
      lines.push(hasAnsiStyle(ansi) ? { text, ansi: `${ansi}\x1b[0m` } : { text });
      text = '';
      ansi = '';
    }
  }
  if (text || ansi) lines.push(hasAnsiStyle(ansi) ? { text, ansi: `${ansi}\x1b[0m` } : { text });
  return lines;
}

/** Styled logical lines, joining visual rows that were soft-wrapped. */
export function styledLogicalLines(snap, html) {
  return joinStyledRows(styledTerminalRows(snap, html), snap.cols);
}

/** Parse Ghostty's formatted state once when both visual and logical keys are needed. */
export function styledSnapshotLines(snap, html) {
  const rows = styledTerminalRows(snap, html);
  return { rows, logical: joinStyledRows(rows, snap.cols) };
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
  const history = (snap.scrollbackLines || []).map((line) => ({
    text: line.text || '', ansi: typeof line.ansi === 'string' ? line.ansi : '',
  }));
  let out = '\x1b[?1049l\x1b[?25l\x1b[0m\x1b[H\x1b[2J';
  if (history.length) {
    out += history.map((line) => line.ansi || line.text).join('\r\n');
    const visualRows = history.reduce((total, line) =>
      total + Math.max(1, Math.ceil(textColumns(line.text) / Math.max(1, snap.cols))), 0);
    out += `\x1b[${snap.rows};1H` + '\r\n'.repeat(Math.min(visualRows, snap.rows));
  }
  out += snapshotToAnsi(snap);
  return out;
}
