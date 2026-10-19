// The latency budget for live state: an agent starting or finishing a turn, or
// writing to its transcript, reaches a connected client within BUDGET_MS.
//
// Before this, the sidebar and reader learned it from their next poll after a
// 4 s quiet window: 4.5-7 s for "finished", ~2.5 s for new reader text. Now the
// server pushes it on the event socket (server/src/live-events.js) and releases
// "working" after a short quiet window unless the screen still shows a busy
// marker (server/src/runner.js).
//
// A fake agent TUI (fixtures/fake-tui.mjs) runs in a real PTY as `claude`, so
// the whole path is the production one: PTY output -> Ghostty grid -> state
// detector -> WebSocket, and transcript append -> fs.watch -> WebSocket. It
// stamps each moment it acts on with the shared machine clock.
//
// Run with:  node --test --test-reporter=tap test/live-latency.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeFetch as fetch, NativeWebSocket } from './native-client.mjs';

const BUDGET_MS = 500;
const PORT = 7961;
const API = `http://localhost:${PORT}`;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-latency-'));
const DATA_DIR = path.join(root, 'data');
const HOME = path.join(root, 'home');
const BIN = path.join(root, 'bin');
for (const d of [DATA_DIR, HOME, BIN, path.join(HOME, '.claude')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), '{}');
// The pane runs `bash -lc`, so the fake goes on PATH through the login profile.
fs.writeFileSync(path.join(BIN, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, 'fixtures', 'fake-tui.mjs')}" "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(HOME, '.bash_profile'), `export PATH="${BIN}:$PATH"\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, init = {}) => {
  const r = await fetch(`${API}${route}${route.includes('?') ? '&' : '?'}from=operator`,
    { headers: { 'content-type': 'application/json' }, ...init });
  return r.json();
};

let srv; let log = '';
let socket; const received = [];
const sessions = {};

before(async () => {
  // Only what the server needs: no live CLI homes or durable paths leak in.
  const env = {
    PATH: process.env.PATH, LANG: 'C.UTF-8', TERM: 'xterm-256color', HOME, TMPDIR: os.tmpdir(),
    PORT: String(PORT), DATA_DIR, AM_BASHRC: '/nonexistent', AM_ALLOW_MISSING_ORIGIN: '1',
    CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'), CODEX_HOME: path.join(HOME, '.codex'),
  };
  srv = spawn(process.execPath, ['src/index.js'], { cwd: path.join(here, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false)) break;
    await sleep(250);
  }
  sessions.agent = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ cli: 'claude', name: 'fake-agent' }) });
  sessions.shell = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ cli: 'shell', name: 'fake-shell' }) });
  socket = new NativeWebSocket(`ws://localhost:${PORT}/ws?events=1`);
  // `at` is when this client got it; `kind` is the event's own `t`.
  socket.on('message', (d) => { const { t: kind, ...rest } = JSON.parse(String(d)); received.push({ at: Date.now(), kind, ...rest }); });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
});

after(async () => {
  try { socket?.close(); } catch {}
  srv?.kill();
  await sleep(300);
  fs.rmSync(root, { recursive: true, force: true });
});

const eventsFile = (s) => path.join(DATA_DIR, 'workspaces', s.path || '', '.fake-events.jsonl');
const fakeEvents = (s) => {
  try { return fs.readFileSync(eventsFile(s), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};
const input = (s, text) => api(`/api/sessions/${s.id}/input`, { method: 'POST', body: JSON.stringify({ text }) });
const firstPush = (pred, from) => received.find((e) => e.at >= from && pred(e));
const pushes = (id, kind, from) => received.filter((e) => e.id === id && e.kind === kind && e.at >= from);
async function waitFor(pred, ms, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = pred(); if (v) return v; await sleep(step); }
  return pred();
}
async function idle(s, want) {
  // The first prompt after a launch waits for the TUI to settle (input-ready).
  await waitFor(() => received.some((e) => e.kind === 'state' && e.id === s.id && e.state === want), 20_000);
}

test('connecting sends a snapshot of every session state', async () => {
  const snap = await waitFor(() => received.find((e) => e.kind === 'states'), 2000);
  assert.ok(snap, `no states snapshot in ${JSON.stringify(received.slice(0, 3))}`);
  assert.equal(snap.states[sessions.agent.id]?.state, 'stopped');
  assert.equal(snap.states[sessions.shell.id]?.state, 'stopped');
});

test(`an agent turn: working, new transcript text and the end each arrive within ${BUDGET_MS} ms`, async () => {
  const s = sessions.agent;
  await input(s, 'hello');               // launches the pane; the fake ignores this
  await idle(s, 'waiting');
  fs.rmSync(eventsFile(s), { force: true });
  const sent = Date.now();
  await input(s, 'work 2');
  const ev = await waitFor(() => { const e = fakeEvents(s); return e.some((x) => x.ev === 'work-end') && e; }, 15_000);
  assert.ok(ev, `the fake never finished: ${log.slice(-2000)}`);
  await sleep(BUDGET_MS + 200);
  const at = Object.fromEntries(ev.map((e) => [e.ev, e]));

  const working = pushes(s.id, 'state', sent).find((e) => e.state === 'working');
  assert.ok(working, 'no working push');
  // The typed prompt's echo is the turn's first PTY output, so working may
  // legitimately be pushed before the fake marks work-start.
  assert.ok(working.at - at['work-start'].t <= BUDGET_MS, `working pushed ${working.at - at['work-start'].t} ms after the turn began`);

  const midPulse = pushes(s.id, 'trace', at['mid-text'].t)[0];
  assert.ok(midPulse, 'no transcript push after the halfway record');
  assert.ok(midPulse.at - at['mid-text'].t <= BUDGET_MS, `halfway record pushed after ${midPulse.at - at['mid-text'].t} ms`);
  assert.equal(midPulse.watched, true, 'pushed by the file watch, not by the turn ending');

  const waiting = pushes(s.id, 'state', at['work-end'].t).find((e) => e.state === 'waiting');
  assert.ok(waiting, 'no waiting push after the turn');
  assert.ok(waiting.at - at['work-end'].t <= BUDGET_MS, `waiting pushed ${waiting.at - at['work-end'].t} ms after the turn ended`);
  const endPulse = pushes(s.id, 'trace', at['work-end'].t)[0];
  assert.ok(endPulse && endPulse.at - at['work-end'].t <= BUDGET_MS, 'final record not pushed within budget');

  // One working and one waiting for one turn: no flapping in between.
  const flips = pushes(s.id, 'state', sent).filter((e) => e.at <= waiting.at);
  assert.deepEqual(flips.map((e) => e.state), ['working', 'waiting'], JSON.stringify(flips.map((e) => [e.state, e.at - at['work-start'].t]).concat([['sent', sent - at['work-start'].t]])));
});

test('a turn that goes quiet with its busy marker on screen does not flap to waiting', async () => {
  const s = sessions.agent;
  fs.rmSync(eventsFile(s), { force: true });
  const sent = Date.now();
  await input(s, 'pause 1');
  const ev = await waitFor(() => { const e = fakeEvents(s); return e.some((x) => x.ev === 'work-end') && e; }, 15_000);
  assert.ok(ev, 'the fake never finished');
  await sleep(BUDGET_MS + 200);
  const at = Object.fromEntries(ev.map((e) => [e.ev, e]));
  assert.ok(at['pause-end'].t - at['pause-start'].t >= 1100, 'the fake did pause');
  const flips = pushes(s.id, 'state', sent);
  assert.deepEqual(flips.map((e) => e.state), ['working', 'waiting'], 'one working, one waiting');
  assert.ok(flips[1].at >= at['work-end'].t, 'waiting only after the turn ended');
  assert.ok(flips[1].at - at['work-end'].t <= BUDGET_MS, `waiting pushed ${flips[1].at - at['work-end'].t} ms after the end`);
});

test(`a shell: a command running is held, its prompt returns idle within ${BUDGET_MS} ms`, async () => {
  const s = sessions.shell;
  await input(s, 'true');
  await idle(s, 'idle');
  await sleep(500);
  const marker = path.join(root, 'shell-end');
  const sent = Date.now();
  // A silent second inside a running command must not read as idle.
  await input(s, `echo one; sleep 1; echo two; date +%s%3N > ${marker}`);
  const end = await waitFor(() => fs.existsSync(marker) && Number(fs.readFileSync(marker, 'utf8')), 10_000);
  assert.ok(end, 'the command never finished');
  await sleep(BUDGET_MS + 200);
  const flips = pushes(s.id, 'state', sent);
  assert.deepEqual(flips.map((e) => e.state), ['working', 'idle'], 'held working through the silent second');
  assert.ok(flips[1].at - end <= BUDGET_MS, `idle pushed ${flips[1].at - end} ms after the command ended`);
});
