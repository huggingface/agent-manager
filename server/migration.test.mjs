// End-to-end check of the libghostty-backed session model.
// Uses a `shell` session so it costs no agent tokens.
//   node migration.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-migration-'));

const PORT = 7893;
const CTRL = '\x00\x00AM:';
const base = `http://localhost:${PORT}`;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn('node', ['src/index.js'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, AM_BASHRC: '/nonexistent' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
srv.stdout.on('data', (d) => { bootLog += d; });
srv.stderr.on('data', (d) => { bootLog += d; });

/** A viewer: collects raw bytes and control frames, can send input/resize/claim. */
function view(id, cols = 100, rows = 30) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?session=${id}&cols=${cols}&rows=${rows}`);
    const v = {
      bytes: '', frames: [], closes: [],
      type: (d) => ws.send(JSON.stringify({ t: 'i', d })),
      resize: (c, r) => ws.send(JSON.stringify({ t: 'r', cols: c, rows: r })),
      claim: () => ws.send(JSON.stringify({ t: 'claim' })),
      lastFrame: (t) => [...v.frames].reverse().find((f) => f.t === t) || null,
      open: () => ws.readyState === 1,
      close: () => { try { ws.close(); } catch {} },
    };
    ws.on('message', (data) => {
      const s = data.toString('utf8');
      if (s.startsWith(CTRL)) { try { v.frames.push(JSON.parse(s.slice(CTRL.length))); } catch {} }
      else v.bytes += s;
    });
    ws.on('close', (code) => v.closes.push(code));
    ws.on('open', () => resolve(v));
    ws.on('error', () => resolve(v));
  });
}

const stateOf = async (id) => {
  const tree = await (await fetch(`${base}/api/tree`)).json();
  return (tree.sessions || []).find((s) => s.id === id) || null;
};

try {
  let up = false;
  // Generous: importing the dependency tree off a cold FUSE-mounted workspace can
  // take half a minute (express alone measured 32s), and a boot timeout looks
  // exactly like a broken server.
  for (let i = 0; i < 400; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  check('server boots without tmux', up);
  if (!up) { console.log(bootLog.slice(-1500)); throw new Error('no boot'); }

  const health = await (await fetch(`${base}/api/health`)).json();
  check('health reports the libghostty engine', health.engine === 'libghostty' && health.ghostty === true,
    health.ghosttyError || `engine=${health.engine} ghostty=${health.ghostty}`);

  const created = await (await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cli: 'shell', name: 'mig test' }),
  })).json();
  check('session created', !!created.id, created.id || JSON.stringify(created).slice(0, 140));
  const id = created.id;
  if (!id) throw new Error('no session');

  // --- attach, run something, verify output ---------------------------------
  const a = await view(id);
  check('viewer attaches', a.open());
  await sleep(1500);
  check('the first viewer controls the session', a.lastFrame('restore')?.controller === true);
  a.type('echo hello-from-viewer-a\r');
  await sleep(1300);
  check('input reaches the PTY and output comes back', a.bytes.includes('hello-from-viewer-a'),
    `${a.bytes.length}B received`);

  // --- closing the browser must NOT kill the session ------------------------
  a.close();
  await sleep(700);
  const survived = await stateOf(id);
  check('session survives the viewer closing', !!survived && survived.state !== 'stopped',
    survived ? `state=${survived.state}` : 'missing from tree');

  // --- work continues with nobody attached ---------------------------------
  await fetch(`${base}/api/sessions/${id}/input`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'echo ran-while-detached' }),
  });
  await sleep(1600);

  // --- reattach: restore frame + canonical scrollback -----------------------
  const b = await view(id);
  await sleep(1000);
  const restore = b.lastFrame('restore');
  check('reattach sends a restore frame', !!restore, restore && `${restore.cols}x${restore.rows}`);
  check('restore serializes earlier scrollback', b.bytes.includes('hello-from-viewer-a'),
    `${b.bytes.length}B restored`);
  check('restore includes work done while detached', b.bytes.includes('ran-while-detached'));
  check('no tmux [exited] noise', !b.bytes.includes('[exited]'));

  // --- state comes from the grid, no subprocess ----------------------------
  b.type('for i in 1 2 3 4 5 6 7 8; do echo busy $i; sleep 0.4; done\r');
  await sleep(1700);
  const busy = await stateOf(id);
  check('a busy session reads as working', busy && busy.state === 'working', busy && busy.state);
  // Poll rather than guess: the loop above takes ~3.2s and the working
  // threshold is 4s of unchanged text, so a fixed sleep races the transition.
  let calm = null;
  for (let i = 0; i < 30; i++) {
    calm = await stateOf(id);
    if (calm && calm.state === 'idle') break;
    await sleep(500);
  }
  check('an idle shell settles back to idle', calm && calm.state === 'idle', calm && calm.state);

  // --- the agent-watch API still works, now off the grid --------------------
  // capturePane() reads the held grid directly. Same shape as the old endpoint:
  // plain text, with screen and scrollback above it.
  const tailRes = await fetch(`${base}/api/agents/${id}/tail?lines=200`);
  const tail = await tailRes.json();
  const tailText = typeof tail === 'string' ? tail : (tail.text || tail.tail || JSON.stringify(tail));
  check('agent tail endpoint answers from the grid', tailRes.ok && tailText.length > 0,
    `${tailText.length} chars`);
  check('agent tail includes screen AND scrollback',
    tailText.includes('hello-from-viewer-a') && tailText.includes('busy 8'),
    tailText.includes('hello-from-viewer-a') ? 'has scrollback' : 'MISSING scrollback');
  check('agent tail has no trailing blank padding', !/\n\s*\n\s*$/.test(tailText));

  // --- two viewers share one grid with one explicit controller --------------
  const c = await view(id, 150, 40);
  await sleep(400);
  c.resize(150, 40);
  await sleep(500);
  b.resize(40, 20);
  await sleep(900);
  check('both viewers stay connected (no handover)', b.open() && c.open());
  const bGrid = b.lastFrame('grid');
  const cGrid = c.lastFrame('grid');
  check('both viewers are told the same grid',
    !!bGrid && !!cGrid && bGrid.cols === cGrid.cols && bGrid.rows === cGrid.rows,
    bGrid && cGrid ? `${bGrid.cols}x${bGrid.rows} vs ${cGrid.cols}x${cGrid.rows}` : 'missing grid frame');
  check('grid follows the controller, not the smallest viewer', !!bGrid && bGrid.cols === 40 && bGrid.rows === 20,
    bGrid && `${bGrid.cols}x${bGrid.rows}`);
  check('viewer roles are explicit', !!bGrid && bGrid.controller === true && bGrid.viewers === 2
    && cGrid?.controller === false && cGrid.viewers === 2);
  c.type('echo ignored-watcher-input\r');
  await sleep(500);
  check('watcher input is ignored', !b.bytes.includes('ignored-watcher-input'));
  c.claim();
  await sleep(700);
  const claimed = c.lastFrame('grid');
  check('a watcher can explicitly claim control', !!claimed && claimed.controller === true
    && claimed.cols === 150 && claimed.rows === 40,
    claimed && `${claimed.cols}x${claimed.rows} controller=${claimed.controller}`);
  c.type('echo seen-by-both\r');
  await sleep(1100);
  check('both viewers see the same live output',
    b.bytes.includes('seen-by-both') && c.bytes.includes('seen-by-both'));

  b.resize(60, 20);
  await sleep(500);
  const stays = c.lastFrame('grid');
  check('a watcher resize cannot disturb the controller', !!stays && stays.cols === 150 && stays.rows === 40,
    stays && `${stays.cols}x${stays.rows}`);
  b.close();

  // --- stopping is explicit ------------------------------------------------
  await fetch(`${base}/api/sessions/${id}/stop`, { method: 'POST' });
  await sleep(1000);
  check('explicit stop closes viewers with the exit code', c.closes.includes(4000),
    `codes=${JSON.stringify(c.closes)}`);
  const after = await stateOf(id);
  check('stopped session reports stopped', after && after.state === 'stopped', after && after.state);

  await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
} catch (err) {
  check('no exceptions', false, String(err && err.message ? err.message : err));
  console.log('--- server log tail ---\n' + bootLog.slice(-1200));
} finally {
  srv.kill('SIGTERM');
  await sleep(600);
  srv.kill('SIGKILL');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
