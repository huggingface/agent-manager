// Resize behaviour of a server-held grid.
//
// The bug this pins down: resizing a pane duplicated content in the scrollback
// (the same lines re-wrapped at every width the pane passed through) and left
// the browser's buffer disagreeing with the grid. Two causes, both here:
//
//   * a resize STORM — ResizeObserver fires per animation frame while a window
//     is dragged, and every tick used to resize the PTY, so a full-screen TUI
//     repainted dozens of times and each repaint pushed another copy of its
//     screen into scrollback;
//   * the browser reflowing ITSELF (fit.fit()) before the server confirmed, so
//     its scrollback was a byte log wrapped at mixed widths while the grid held
//     a properly reflowed one.
//
// fixtures/repaint-tui.mjs stands in for an agent TUI and repaints exactly the
// way Claude Code does, so this costs no agent tokens.
//   node resize.test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, '.resize');
const FIXTURE = path.join(HERE, 'fixtures', 'repaint-tui.mjs');
const PORT = 7895;
const CTRL = '\x00\x00AM:';
const base = `http://localhost:${PORT}`;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn('node', ['src/index.js'], {
  cwd: HERE,
  env: { ...process.env, PORT: String(PORT), DATA_DIR, AM_BASHRC: '/nonexistent' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });

function view(id, cols, rows) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?session=${id}&cols=${cols}&rows=${rows}`);
    const v = {
      bytes: '', frames: [],
      type: (d) => ws.send(JSON.stringify({ t: 'i', d })),
      resize: (c, r) => ws.send(JSON.stringify({ t: 'r', cols: c, rows: r })),
      lastFrame: (t) => [...v.frames].reverse().find((f) => f.t === t) || null,
      countFrames: (t) => v.frames.filter((f) => f.t === t).length,
      close: () => { try { ws.close(); } catch {} },
    };
    ws.on('message', (data) => {
      const s = data.toString('utf8');
      if (s.startsWith(CTRL)) { try { v.frames.push(JSON.parse(s.slice(CTRL.length))); } catch {} }
      else v.bytes += s;
    });
    ws.on('open', () => resolve(v));
    ws.on('error', () => resolve(v));
  });
}

/** Tokens the fixture prints are unique, so a repeat is a duplicated line. */
function duplicateTokens(text) {
  const counts = new Map();
  for (const m of text.matchAll(/\b\d{3}\.\d{2}\b/g)) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
  return [...counts.values()].filter((n) => n > 1).length;
}

const gridText = async (id) => {
  const r = await (await fetch(`${base}/api/agents/${id}/tail?lines=500`)).json();
  return typeof r === 'string' ? r : (r.text || '');
};

async function session(name) {
  const created = await (await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cli: 'shell', name }),
  })).json();
  if (!created.id) throw new Error(`no session: ${JSON.stringify(created).slice(0, 200)}`);
  return created.id;
}

/** A pane showing the fixture, painted and settled. */
async function paintedFixture(name, cols = 120, rows = 40) {
  const id = await session(name);
  const v = await view(id, cols, rows);
  v.resize(cols, rows);
  await sleep(900);
  v.type(`node ${FIXTURE}\r`);
  await sleep(1500);
  return { id, v };
}

try {
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (!up) throw new Error(`server never came up:\n${log.slice(-800)}`);

  // --- one deliberate resize -----------------------------------------------
  {
    const { id, v } = await paintedFixture('resize once');
    const before = duplicateTokens(await gridText(id));
    check('a painted fixture starts with no duplicated lines', before === 0, `${before} duplicated tokens`);

    v.resize(80, 30);
    await sleep(1200);
    const after = duplicateTokens(await gridText(id));
    // One repaint at a new width cannot avoid leaving the rows the shrink pushed
    // into scrollback, so a handful is expected; a copy of the whole screen is
    // not.
    check('one resize duplicates at most a few lines', after <= 12, `${after} duplicated tokens`);
    check('the fixture followed the resize', (await gridText(id)).includes('[fixture 80x30]'));
    v.close();
    await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST' });
  }

  // --- a drag: ResizeObserver fires every frame ----------------------------
  {
    const { id, v } = await paintedFixture('resize storm');
    // 16 sizes in ~500ms is a slow drag; a real one is faster.
    for (let i = 0; i < 16; i++) {
      v.resize(120 - i * 2, 40 - i);
      await sleep(30);
    }
    v.resize(88, 24);
    await sleep(1500);

    const dupes = duplicateTokens(await gridText(id));
    check('a drag does not multiply scrollback', dupes <= 12, `${dupes} duplicated tokens`);
    check('the grid settles at the final size', (await gridText(id)).includes('[fixture 88x24]'));
    // Every viewer must be told the size that was actually applied, and the
    // coalescing must not swallow the last one.
    const last = v.lastFrame('grid');
    check('the last grid frame matches the final size', !!last && last.cols === 88 && last.rows === 24,
      last && `${last.cols}x${last.rows}`);
    check('the storm is coalesced into few PTY resizes', v.countFrames('grid') <= 4,
      `${v.countFrames('grid')} grid frames`);
    v.close();
    await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST' });
  }

  // --- the browser is repainted from the grid after a resize ---------------
  // An app that ignores SIGWINCH (a bash prompt, an agent sitting idle) would
  // otherwise leave the viewer showing its own reflow of a byte log, which is
  // exactly where the two disagree.
  {
    const { id, v } = await paintedFixture('resize repaint');
    const beforeBytes = v.bytes.length;
    v.resize(70, 26);
    await sleep(1200);
    const sent = v.bytes.slice(beforeBytes);
    check('a settled resize repaints the viewer from the grid', sent.includes('\x1b[2J'),
      `${sent.length}B after resize`);
    // The size must arrive BEFORE the bytes that assume it.
    check('the grid frame precedes the repaint',
      v.frames.some((f) => f.t === 'grid' && f.cols === 70 && f.rows === 26));
    v.close();
    await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST' });
  }

  // --- a viewer that only re-asks for the same size costs nothing ----------
  // Tab focus and unrelated layout changes call resync() constantly.
  {
    const { id, v } = await paintedFixture('resize noop');
    const framesBefore = v.countFrames('grid');
    for (let i = 0; i < 5; i++) { v.resize(120, 40); await sleep(120); }
    await sleep(600);
    check('re-requesting the current size changes nothing', v.countFrames('grid') === framesBefore,
      `${v.countFrames('grid') - framesBefore} extra grid frames`);
    check('no duplication from no-op resyncs', duplicateTokens(await gridText(id)) === 0);
    v.close();
    await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST' });
  }
} catch (err) {
  check('no exceptions', false, String(err && err.message ? err.message : err));
  console.log('--- server log tail ---\n' + log.slice(-1200));
} finally {
  srv.kill('SIGTERM');
  await sleep(600);
  srv.kill('SIGKILL');
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
