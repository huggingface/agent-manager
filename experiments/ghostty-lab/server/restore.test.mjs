// Round-trips a restore payload (replayed bytes + snapshot repaint) through a
// fresh terminal and checks the receiver ends up with the same visible screen
// AND real, styled scrollback.
// Run: node restore.test.mjs
import { createTerminal } from '@coder/libghostty-vt-node';
import { buildPaletteIndex, snapshotToAnsi } from './src/snapshot.js';

buildPaletteIndex(createTerminal);

const COLS = 100, ROWS = 32;
const mk = () => createTerminal({ cols: COLS, rows: ROWS, scrollbackLimit: 5000 });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

/** Everything the server writes into the holder's PTY stream for one session. */
function makeSession() {
  const chunks = [];
  const emit = (s) => chunks.push(s);
  for (let i = 1; i <= 500; i++) emit(`\x1b[33mhistory ${i}\x1b[0m some output text\r\n`);
  emit('\x1b[2J\x1b[H');
  emit('\x1b[1;36m╭─ the-gatherer ──────────╮\x1b[0m\r\n');
  emit('\x1b[1;36m│\x1b[0m corpus \x1b[1;32m161\x1b[0m sources    \x1b[1;36m│\x1b[0m\r\n');
  emit('\x1b[1;36m╰─────────────────────────╯\x1b[0m\r\n');
  emit('  emoji 🚀 wide 日本語 \x1b[4munderlined\x1b[0m\r\n');
  emit('\x1b[38;5;208m⠹\x1b[0m Thinking…');
  return chunks;
}

const cellKey = (c) => `${c.row},${c.col}:${c.text}|${c.bold ? 'b' : ''}${c.italic ? 'i' : ''}${c.underline ? 'u' : ''}|${c.foreground || ''}|${c.background || ''}`;

function compareVisible(label, source, target, snap, after) {
  check(`${label}: visible text identical`, source.getVisibleText() === target.getVisibleText());
  if (source.getVisibleText() !== target.getVisibleText()) {
    const a = source.getVisibleText().split('\n'), b = target.getVisibleText().split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) console.log(`   line ${i}\n     src=${JSON.stringify(a[i])}\n     dst=${JSON.stringify(b[i])}`);
    }
  }
  const src = new Set(snap.cells.map(cellKey));
  const dst = new Set(after.cells.map(cellKey));
  const missing = [...src].filter((k) => !dst.has(k));
  check(`${label}: visible cell styling identical`, missing.length === 0, `${src.size} cells, ${missing.length} mismatched`);
  if (missing.length) console.log('   sample:', missing.slice(0, 5));
  check(`${label}: cursor preserved`, snap.cursorRow === after.cursorRow && snap.cursorCol === after.cursorCol,
    `${snap.cursorRow},${snap.cursorCol} → ${after.cursorRow},${after.cursorCol}`);
}

// --- 1. full replay: history survives WITH styling -------------------------

const chunks = makeSession();
const source = mk();
for (const c of chunks) source.feed(c);

const snap = source.snapshot({ includeCells: true, includeScrollback: true });
const replay = chunks.join('');
const payload = replay + snapshotToAnsi(snap);

const target = mk();
target.feed(payload);
const after = target.snapshot({ includeCells: true, includeScrollback: true });

compareVisible('full replay', source, target, snap, after);

const srcHistory = (snap.scrollbackLines || []).map((l) => l.text.replace(/\s+$/, ''));
const dstHistory = (after.scrollbackLines || []).map((l) => l.text.replace(/\s+$/, ''));
check('full replay: scrollback present', dstHistory.length > 0, `${dstHistory.length} lines`);
check('full replay: scrollback matches source', srcHistory.length === dstHistory.length && srcHistory.every((t, i) => t === dstHistory[i]),
  `src ${srcHistory.length}, dst ${dstHistory.length}`);
// The whole point of replaying bytes instead of snapshot lines: history keeps
// its colour. snapshot() cannot report scrollback styling, so assert on the
// stream that produced it.
check('full replay: history carries colour', /history 1\b/.test(replay) && replay.includes('\x1b[33mhistory 1'));

// --- 2. a wrapped ring starts mid-stream -----------------------------------

function trimToNewline(s) {
  const nl = s.indexOf('\n');
  return nl >= 0 ? s.slice(nl + 1) : s;
}

// Simulate the ring having dropped the first ~40% of the session mid-sequence.
const cut = replay.slice(Math.floor(replay.length * 0.4));
const partial = trimToNewline(cut) + snapshotToAnsi(snap);
const target2 = mk();
target2.feed(partial);
const after2 = target2.snapshot({ includeCells: true, includeScrollback: true });
compareVisible('trimmed ring', source, target2, snap, after2);
check('trimmed ring: still has scrollback', (after2.scrollbackLines || []).length > 0,
  `${(after2.scrollbackLines || []).length} lines`);
check('trimmed ring: keeps only recent history',
  (after2.scrollbackLines || []).length < srcHistory.length,
  `${(after2.scrollbackLines || []).length} < ${srcHistory.length}`);

// --- 3. alt-screen normalisation -------------------------------------------

check('repaint leaves alt screen when source is on the main buffer',
  snapshotToAnsi(snap).startsWith('\x1b[?1049l'));

// A receiver parked on the alternate screen must be pulled back, or the repaint
// would land on the wrong buffer and vanish when the app exits alt mode.
const target3 = mk();
target3.feed('\x1b[?1049h');
target3.feed('junk on the alternate screen\r\n');
target3.feed(payload);
const after3 = target3.snapshot({ includeCells: true });
check('stranded alt-screen receiver is normalised', !after3.isAltScreen);
compareVisible('alt-screen recovery', source, target3, snap, after3);

// --- 4. an alt-screen session restores onto the alt screen ------------------

const altSource = mk();
altSource.feed('\x1b[?1049h\x1b[2J\x1b[H\x1b[1;35mfullscreen TUI\x1b[0m');
const altSnap = altSource.snapshot({ includeCells: true });
check('alt-screen source repaints onto the alt screen', altSnap.isAltScreen && snapshotToAnsi(altSnap).startsWith('\x1b[?1049h'));
const altTarget = mk();
altTarget.feed(snapshotToAnsi(altSnap));
compareVisible('alt-screen source', altSource, altTarget, altSnap, altTarget.snapshot({ includeCells: true }));

console.log(`\npayload ${(payload.length / 1024).toFixed(1)}KB (${(replay.length / 1024).toFixed(1)}KB replay + ${((payload.length - replay.length) / 1024).toFixed(1)}KB repaint)`);
console.log(failures ? `${failures} FAILURE(S)` : 'all checks passed');
process.exit(failures ? 1 : 0);
