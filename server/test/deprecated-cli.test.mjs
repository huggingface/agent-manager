// A deprecated CLI (Gemini CLI): nothing new, everything existing.
//
// Google replaced Gemini CLI with Antigravity CLI. Step 1 of its removal keeps
// every existing Gemini session working — it launches with the same command,
// is revived after a restart and takes prompts — while every way of creating a
// NEW one (the UI's POST /api/sessions, an agent's spawn, a cron) is refused
// with `cli-deprecated`. GET /api/clis says so as data for the UI.
// Run with: node test/deprecated-cli.test.mjs
import { nativeFetch as fetch } from './native-client.mjs';
import { freePort } from './free-port.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

let pass = 0; let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- in-process: the launch command and the revive rule are unchanged ----
const UNIT = fs.mkdtempSync(path.join(os.tmpdir(), 'am-deprecated-unit-'));
process.env.DATA_DIR = UNIT;
const sessions = await import('../src/sessions.js');
const runner = await import('../src/runner.js');
const { selectRevivable } = await import('../src/runstate.js');
sessions.init();

console.log('\nan existing Gemini session launches exactly as before');
const fresh = sessions.create({ name: 'gemini-cli-1', cli: 'gemini', path: 'g' });
sessions.update(fresh.id, { pendingPrompt: 'hi there' });
check('first launch rides the queued prompt', runner.commandFor(sessions.get(fresh.id)) === "exec gemini -i 'hi there'",
  runner.commandFor(sessions.get(fresh.id)));
sessions.update(fresh.id, { everStarted: true });
check('a relaunch starts gemini', runner.commandFor(sessions.get(fresh.id)) === 'exec gemini', runner.commandFor(sessions.get(fresh.id)));

console.log('\nand is revived after a restart like any agent');
const now = Date.now();
const plan = selectRevivable({
  snapshot: { at: new Date(now - 60_000).toISOString(), sessions: { [fresh.id]: { running: true } } },
  sessions: [{ ...sessions.get(fresh.id), lastInputAt: now - 3600_000 }],
  digests: new Map(), alive: new Set(), days: 3, now,
});
check('revived', plan.some((p) => p.id === fresh.id), JSON.stringify(plan));

// ---- over HTTP, with fake gemini and claude binaries ----
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-deprecated-'));
const bin = path.join(DATA_DIR, 'bin');
fs.mkdirSync(bin, { recursive: true });
// A minimal TUI: logs its arguments, draws a prompt line, and logs what is on
// it when Enter arrives outside a bracketed paste.
const fakeTui = (name) => `#!${process.execPath}
const fs = require('fs');
const log = process.env.DATA_DIR + '/fake-${name}.log';
fs.appendFileSync(log, 'argv: ' + process.argv.slice(2).join(' ') + '\\n');
let line = '', paste = false, buf = '';
const draw = () => process.stdout.write('\\x1b[H\\x1b[J> ' + line);
process.stdin.setRawMode && process.stdin.setRawMode(true);
draw();
process.stdin.on('data', (c) => {
  buf += c.toString();
  for (;;) {
    if (buf.startsWith('\\x1b[200~')) { paste = true; buf = buf.slice(6); continue; }
    if (buf.startsWith('\\x1b[201~')) { paste = false; buf = buf.slice(6); continue; }
    if (!buf) break;
    const ch = buf[0]; buf = buf.slice(1);
    if (ch === '\\r' && !paste) { fs.appendFileSync(log, 'submitted: ' + line + '\\n'); line = ''; }
    else if (ch >= ' ') line += ch;
    else if (ch === '\\n') line += ' ';
  }
  draw();
});
setTimeout(() => process.exit(0), 120000);
`;
for (const name of ['gemini', 'claude']) fs.writeFileSync(path.join(bin, name), fakeTui(name), { mode: 0o755 });
fs.mkdirSync(path.join(DATA_DIR, 'home'), { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'home', '.profile'), `export PATH="${bin}:$PATH"\n`);
for (const folder of ['gem', 'peer']) fs.mkdirSync(path.join(DATA_DIR, 'workspaces', folder), { recursive: true });

const seedSession = (id, name, cli, folder) => ({
  id, name, cli, path: folder, sessionUuid: `00000000-0000-4000-8000-${id.length.toString().padStart(12, '0')}`,
  createdAt: '2026-10-01T00:00:00.000Z', everStarted: true,
});
fs.writeFileSync(path.join(DATA_DIR, 'sessions.json'), JSON.stringify([
  seedSession('old-gemini', 'old-gemini', 'gemini', 'gem'),
  seedSession('peer', 'peer', 'claude', 'peer'),
]));
const seedCron = (id, agent) => ({
  id, name: id, agent, prompt: `Run ${id}.`, schedule: { cron: '0 0 1 1 *', tz: 'UTC' },
  runOnRestart: false, state: 'running', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
});
fs.writeFileSync(path.join(DATA_DIR, 'crons.json'), JSON.stringify([
  seedCron('cron_existing', { name: 'old-gemini', cli: 'gemini' }), // targets the existing session
  seedCron('cron_new', { name: 'brand-new-gemini', cli: 'gemini' }), // would have to create one
]));

const PORT = await freePort();
const API = `http://127.0.0.1:${PORT}`;
const { SPACE_ID, AM_DISTRIBUTE_SKILLS, GEMINI_API_KEY, GOOGLE_API_KEY, ...BASE_ENV } = process.env;
const server = spawn('node', ['src/index.js'], {
  env: {
    ...BASE_ENV,
    PATH: `${bin}:${BASE_ENV.PATH || ''}`,
    PORT: String(PORT), DATA_DIR, HOME: path.join(DATA_DIR, 'home'),
    GEMINI_CLI_HOME: path.join(DATA_DIR, 'home'),
    GEMINI_API_KEY: 'test-placeholder',
    AM_BASHRC: '/nonexistent',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (chunk) => { log += chunk; });
server.stderr.on('data', (chunk) => { log += chunk; });

const api = async (route, init = {}) => {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET' && !route.includes('from=')) headers.set('x-am-origin', 'operator');
  const response = await fetch(`${API}${route}`, { ...init, headers });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const json = (method, body) => ({ method, body: JSON.stringify(body) });
const fakeLog = (name) => { try { return fs.readFileSync(path.join(DATA_DIR, `fake-${name}.log`), 'utf8'); } catch { return ''; } };
const waitFor = async (fn, ms = 30_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await sleep(200); }
  return false;
};
const sessionCount = async () => (await api('/api/sessions')).body.length;
const refused = (r) => r.status === 400 && r.body?.code === 'cli-deprecated' && /Antigravity/.test(r.body?.error || '');

try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`${API}/api/clis`)).ok; } catch { await sleep(100); }
  }
  if (!up) throw new Error(`server did not start:\n${log}`);

  console.log('\nGET /api/clis marks gemini deprecated, as data');
  const clis = (await api('/api/clis')).body;
  const gemini = clis.find((c) => c.id === 'gemini');
  check('deprecated: true', gemini?.deprecated === true);
  check("replacement: 'antigravity'", gemini?.replacement === 'antigravity');
  check('carries the notice', /deprecated: Google replaced it with Antigravity CLI/.test(gemini?.deprecationNote || ''));
  check('available and ready are unchanged', gemini?.available === true && gemini?.ready === true, JSON.stringify(gemini));
  const claude = clis.find((c) => c.id === 'claude');
  check('the others are not deprecated', claude?.deprecated === false && !('replacement' in claude));

  console.log('\nevery way of creating a new Gemini session is refused');
  const before = await sessionCount();
  const ui = await api('/api/sessions', json('POST', { cli: 'gemini', name: 'nope' }));
  check('POST /api/sessions', refused(ui), JSON.stringify(ui));
  const quick = await api('/api/sessions', json('POST', { cli: 'gemini', prompt: 'do things' }));
  check('POST /api/sessions with a quickstart prompt', refused(quick), JSON.stringify(quick));
  const spawned = await api('/api/agents?cli=gemini&from=peer', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'work' });
  check('spawn (POST /api/agents)', refused(spawned), JSON.stringify(spawned));
  const roster = (await api('/api/agents?from=peer')).body;
  check('the spawn roster does not offer it', !roster.clis.some((c) => c.id === 'gemini') && roster.clis.some((c) => c.id === 'claude'));
  const cron = await api('/api/crons', json('POST', {
    name: 'new gemini job', agent: { name: 'g2', cli: 'gemini' }, prompt: 'x', schedule: { cron: '0 9 * * *', tz: 'UTC' },
  }));
  check('POST /api/crons', refused(cron), JSON.stringify(cron));
  const fired = await api('/api/crons/cron_new/run', { method: 'POST' });
  check('a cron fire that would create one', refused(fired), JSON.stringify(fired));
  const jobs = (await api('/api/crons')).body.crons;
  check('…and records why', jobs.find((j) => j.id === 'cron_new')?.last?.code === 'cli-deprecated');
  const kept = await api('/api/crons/cron_existing', json('PUT', { prompt: 'Run cron_existing.', agent: { name: 'old-gemini', cli: 'gemini' } }));
  check('a job already on gemini can still be edited', kept.status === 200, JSON.stringify(kept));
  const paused = await api('/api/crons/cron_existing', json('PUT', { state: 'stopped' }));
  const resumed = await api('/api/crons/cron_existing', json('PUT', { state: 'running' }));
  check('…and stopped and started', paused.status === 200 && resumed.status === 200);
  const switched = await api('/api/crons/cron_existing', json('PUT', { agent: { name: 'old-gemini', cli: 'claude' } }));
  const back = await api('/api/crons/cron_existing', json('PUT', { agent: { name: 'old-gemini', cli: 'gemini' } }));
  check('…but a job cannot be switched back to gemini', switched.status === 200 && refused(back), JSON.stringify(back));
  check('no session was created by any of it', await sessionCount() === before);
  check('other CLIs still create', (await api('/api/sessions', json('POST', { cli: 'claude', name: 'still-fine' }))).status === 201);

  console.log('\nthe existing Gemini session keeps working');
  const listed = (await api('/api/sessions')).body.find((s) => s.id === 'old-gemini');
  check('still listed', listed?.cli === 'gemini');
  const prompted = await api('/api/agents/old-gemini/prompt?from=peer', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello gemini' });
  check('accepts a prompt (and starts)', prompted.status === 200, JSON.stringify(prompted));
  check('launched as gemini', await waitFor(() => /argv: \n|argv: $/m.test(fakeLog('gemini'))), fakeLog('gemini'));
  check('the prompt was submitted', await waitFor(() => /submitted: \[message from peer:\] hello gemini/.test(fakeLog('gemini'))), fakeLog('gemini'));
  const ran = await api('/api/crons/cron_existing/run', { method: 'POST' });
  check('a cron naming it still delivers', ran.status === 202 && ran.body?.agentCreated === false, JSON.stringify(ran));
  check('…the scheduled prompt arrives', await waitFor(() => /submitted: .*Run cron_existing\./.test(fakeLog('gemini'))), fakeLog('gemini'));
  const stopped = await api('/api/sessions/old-gemini/stop', { method: 'POST' });
  const isDown = async () => (await api('/api/sessions')).body.find((x) => x.id === 'old-gemini')?.running === false;
  let down = false;
  for (let i = 0; i < 100 && !down; i++) { down = await isDown(); if (!down) await sleep(200); }
  check('stops', stopped.status === 200 && down, JSON.stringify(stopped));
  const restarted = await api('/api/agents/old-gemini/prompt?from=peer', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'again' });
  const relaunched = await waitFor(() => (fakeLog('gemini').match(/^argv: $/gm) || []).length >= 2);
  check('restarts on the next prompt', restarted.status === 200
    && relaunched && await waitFor(() => /submitted: .*again/.test(fakeLog('gemini'))), `${JSON.stringify(restarted)} relaunched=${relaunched}\n${fakeLog('gemini')}`);
} catch (error) {
  fail++;
  console.log(`  FAIL  ${error.stack || error}\n${log.slice(-2000)}`);
} finally {
  server.kill('SIGTERM');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
