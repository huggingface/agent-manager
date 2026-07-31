// Invariants for the server-held terminal model.
//
// These tests intentionally avoid classifying foreground applications or
// counting "acceptable" duplicate rows. The contract is smaller and firmer:
// Ghostty owns retained state, a resize is ordered ordinary reflow, and exactly
// one viewer controls input and PTY geometry. Full serialization is attach-only.
//   node resize.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-resize-'));
const PORT = 7895;
const CTRL = '\x00\x00AM:';
const base = `http://localhost:${PORT}`;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (fn, timeout = 8000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};

const srv = spawn('node', ['src/index.js'], {
  cwd: HERE,
  env: { ...process.env, PORT: String(PORT), DATA_DIR, AM_BASHRC: '/nonexistent' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (data) => { log += data; });
srv.stderr.on('data', (data) => { log += data; });

let Headless = null;
try { Headless = (await import('@xterm/headless')).default.Terminal; } catch {}

function view(id, cols, rows, mirror = false) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?session=${id}&cols=${cols}&rows=${rows}`);
    const term = mirror && Headless
      ? new Headless({ cols, rows, scrollback: 20000, allowProposedApi: true })
      : null;
    const v = {
      bytes: '', frames: [], term,
      type: (data) => ws.send(JSON.stringify({ t: 'i', d: data })),
      resize: (nextCols, nextRows) => ws.send(JSON.stringify({ t: 'r', cols: nextCols, rows: nextRows })),
      claim: () => ws.send(JSON.stringify({ t: 'claim' })),
      lastFrame: (type) => [...v.frames].reverse().find((frame) => frame.t === type) || null,
      countFrames: (type) => v.frames.filter((frame) => frame.t === type).length,
      open: () => ws.readyState === WebSocket.OPEN,
      close: () => { try { ws.close(); } catch {} },
      screenText: async () => {
        if (!term) return '';
        await new Promise((done) => term.write('', done));
        const buf = term.buffer.active;
        const lines = [];
        for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
        return lines.join('\n');
      },
    };
    ws.on('message', (data) => {
      const text = data.toString('utf8');
      if (text.startsWith(CTRL)) {
        let frame;
        try { frame = JSON.parse(text.slice(CTRL.length)); } catch { return; }
        v.frames.push(frame);
        if (term && (frame.t === 'grid' || frame.t === 'restore')) {
          const applyGrid = () => {
            if (frame.reset) { term.reset(); term.clear(); }
            if (frame.cols > 0 && frame.rows > 0
                && (term.cols !== frame.cols || term.rows !== frame.rows)) {
              term.resize(frame.cols, frame.rows);
            }
          };
          const geometryChanged = frame.cols > 0 && frame.rows > 0
            && (term.cols !== frame.cols || term.rows !== frame.rows);
          if (frame.reset || geometryChanged) term.write('', applyGrid);
          else applyGrid();
        }
      } else {
        v.bytes += text;
        if (term) term.write(text);
      }
    });
    ws.on('open', () => resolve(v));
    ws.on('error', () => resolve(v));
  });
}

async function session(name) {
  const created = await (await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cli: 'shell', name }),
  })).json();
  if (!created.id) throw new Error(`no session: ${JSON.stringify(created).slice(0, 200)}`);
  return created.id;
}

const gridText = async (id, lines = 2000) => {
  const response = await fetch(`${base}/api/agents/${id}/tail?lines=${lines}`);
  const body = await response.json();
  return typeof body === 'string' ? body : (body.text || body.tail || '');
};

const stop = async (id) => {
  await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST' }).catch(() => {});
  await sleep(250);
};

try {
  const up = await waitFor(async () => {
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, 100_000);
  if (!up) throw new Error(`server never came up:\n${log.slice(-1200)}`);

  // A long logical line must survive ordinary Ghostty reflow. The former
  // screen-carry path cropped the right side before rebuilding a narrower grid.
  {
    const id = await session('long line reflow');
    const v = await view(id, 110, 24, true);
    await sleep(700);
    v.type(`printf 'LONG-%s-END-SENTINEL\\n' "$(printf 'x%.0s' {1..90})"\r`);
    const printed = await waitFor(async () => (await gridText(id)).includes('END-SENTINEL'));
    check('long line is present before resize', printed);
    v.resize(60, 24);
    const resized = await waitFor(() => v.lastFrame('grid')?.cols === 60);
    check('resize settles at the requested geometry', resized, JSON.stringify(v.lastFrame('grid')));
    const after = await gridText(id);
    check('narrowing does not crop the right side of a logical line', after.includes('END-SENTINEL'));
    check('resize does not retransmit all history', v.lastFrame('grid')?.reset === false);
    if (Headless) check('the ordered viewer reflow also retains the line', (await v.screenText()).includes('END-SENTINEL'));
    v.close();
    await stop(id);
  }

  // A drag should issue one final resize, not one SIGWINCH per animation frame.
  {
    const id = await session('resize storm');
    const v = await view(id, 120, 40);
    await sleep(400);
    for (let i = 0; i < 16; i++) {
      v.resize(120 - i * 2, 40 - i);
      await sleep(25);
    }
    v.resize(88, 24);
    const settled = await waitFor(() => v.lastFrame('grid')?.cols === 88 && v.lastFrame('grid')?.rows === 24);
    check('resize storm settles at its final size', settled, JSON.stringify(v.lastFrame('grid')));
    check('resize storm is coalesced', v.countFrames('grid') <= 3, `${v.countFrames('grid')} grid frames`);
    v.close();
    await stop(id);
  }

  // Reattachment is serialized from Ghostty state, not from a 256 KiB suffix
  // of raw PTY traffic. Both the oldest and newest retained rows must return.
  {
    const id = await session('full canonical restore');
    const a = await view(id, 110, 30);
    await sleep(600);
    a.type(`for i in $(seq 1 4500); do printf 'RESTORE-%04d-%070d\\n' "$i" "$i"; done\r`);
    const complete = await waitFor(async () => (await gridText(id, 5000)).includes('RESTORE-4500-'), 20_000);
    check('large history finishes printing', complete);
    a.close();
    await sleep(300);
    const b = await view(id, 110, 30, true);
    const restored = await waitFor(() => b.bytes.includes('RESTORE-4500-'), 12_000);
    check('reattach receives the canonical restore', restored && !!b.lastFrame('restore'));
    check('restore is not capped at the old raw replay limit', b.bytes.length > 262_144, `${b.bytes.length} bytes`);
    check('restore includes the oldest retained output', b.bytes.includes('RESTORE-0001-'));
    check('restore includes the newest retained output', b.bytes.includes('RESTORE-4500-'));
    if (Headless) {
      const rendered = await b.screenText();
      check('a fresh emulator can scroll to the oldest restored output', rendered.includes('RESTORE-0001-'));
      check('a fresh emulator contains the newest restored output', rendered.includes('RESTORE-4500-'));
    }
    b.close();
    await stop(id);
  }

  // One viewer owns both input and size. A watcher has no effect until an
  // explicit claim, after which the old controller becomes inert.
  {
    const id = await session('controller lease');
    const a = await view(id, 120, 35);
    await sleep(400);
    const b = await view(id, 60, 20);
    await sleep(400);
    check('first viewer is the controller', a.lastFrame('grid')?.controller === true
      && b.lastFrame('restore')?.controller === false);
    b.resize(50, 15);
    await sleep(400);
    check('watcher size cannot shrink the session', b.lastFrame('restore')?.cols === 120
      && !b.frames.some((frame) => frame.t === 'grid' && frame.cols === 50));
    b.type('echo WATCHER-MUST-NOT-RUN\r');
    await sleep(400);
    check('watcher input is rejected by the server', !a.bytes.includes('WATCHER-MUST-NOT-RUN'));

    b.claim();
    const claimed = await waitFor(() => b.lastFrame('grid')?.controller === true
      && b.lastFrame('grid')?.cols === 50 && b.lastFrame('grid')?.rows === 15);
    check('watcher can claim input and geometry together', claimed, JSON.stringify(b.lastFrame('grid')));
    b.type('echo CONTROLLER-RAN\r');
    check('new controller input reaches every viewer', await waitFor(() => a.bytes.includes('CONTROLLER-RAN')
      && b.bytes.includes('CONTROLLER-RAN')));
    a.resize(140, 45);
    await sleep(400);
    check('old controller becomes an inert watcher', b.lastFrame('grid')?.cols === 50
      && b.lastFrame('grid')?.rows === 15);

    b.close();
    const handed = await waitFor(() => a.lastFrame('grid')?.controller === true
      && a.lastFrame('grid')?.cols === 140 && a.lastFrame('grid')?.rows === 45);
    check('controller lease passes to a remaining viewer on disconnect', handed, JSON.stringify(a.lastFrame('grid')));
    a.close();
    await stop(id);
  }

  // Focus and unrelated layout events may re-report the same preference.
  {
    const id = await session('no-op size');
    const v = await view(id, 80, 24);
    await sleep(300);
    const before = v.countFrames('grid');
    for (let i = 0; i < 5; i++) v.resize(80, 24);
    await sleep(500);
    check('re-reporting the current size performs no reset', v.countFrames('grid') === before,
      `${v.countFrames('grid') - before} extra frames`);
    v.close();
    await stop(id);
  }
} catch (err) {
  check('no exceptions', false, String(err && err.message ? err.message : err));
  console.log('--- server log tail ---\n' + log.slice(-1600));
} finally {
  srv.kill('SIGTERM');
  await sleep(500);
  srv.kill('SIGKILL');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
