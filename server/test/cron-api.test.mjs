// Cron API, durable boot behavior, scheduled identity, and same-name creation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 7902;
const API = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-cron-api-'));
const bin = path.join(DATA_DIR, 'bin');
fs.mkdirSync(bin, { recursive: true });
const fakeClaude = path.join(bin, 'claude');
fs.writeFileSync(fakeClaude, `#!/bin/sh
printf '%s\\n' "$*" >> "$DATA_DIR/fake-claude.log"
sleep 120
`, { mode: 0o755 });

const seed = (id, name) => ({
  id, name,
  agent: { name: 'shared-cron-agent', cli: 'claude' },
  prompt: `Run ${name}.`,
  schedule: { cron: '0 * * * *', tz: 'UTC' },
  runOnRestart: true,
  state: 'running',
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
});
fs.writeFileSync(path.join(DATA_DIR, 'crons.json'), JSON.stringify([
  seed('cron_boot_one', 'boot one'), seed('cron_boot_two', 'boot two'),
]));

let pass = 0; let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...BASE_ENV } = process.env;
const server = spawn('node', ['src/index.js'], {
  env: {
    ...BASE_ENV,
    PATH: `${bin}:${BASE_ENV.PATH || ''}`,
    PORT: String(PORT), DATA_DIR, HOME: path.join(DATA_DIR, 'home'),
    CLAUDE_CONFIG_DIR: path.join(DATA_DIR, 'home', '.claude'),
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
  if (init.method && init.method !== 'GET') headers.set('x-am-origin', 'operator');
  const response = await fetch(`${API}${route}`, { ...init, headers });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

try {
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false)) break;
    await sleep(250);
  }

  // Both boot jobs fire, but name lookup + synchronous creation gives them one
  // shared agent. This is the race the feature must be idempotent across.
  let sessions = [];
  let operations = [];
  for (let i = 0; i < 60; i++) {
    sessions = (await api('/api/sessions')).body || [];
    operations = (await api('/api/operations?limit=50')).body?.operations || [];
    const cronOps = operations.filter((row) => row.origin?.type === 'cron');
    if (sessions.length === 1 && cronOps.length >= 2) break;
    await sleep(250);
  }
  check('two restart jobs naming one agent create exactly one session', sessions.length === 1, `sessions ${sessions.length}`);
  check('the cron-created workspace follows workspaces/<agent-name>', sessions[0]?.path === 'shared-cron-agent', `path ${sessions[0]?.path}`);
  const cronOps = operations.filter((row) => row.origin?.type === 'cron');
  check('scheduled runs are attributed to cron identities in operations',
    cronOps.length >= 2 && cronOps.every((row) => row.origin.id.startsWith('cron:') && row.origin.name.startsWith('boot')),
    JSON.stringify(cronOps.map((row) => row.origin)));

  let listed = await api('/api/crons');
  for (let i = 0; i < 80 && !listed.body?.crons?.every((job) => job.last); i++) {
    await sleep(250);
    listed = await api('/api/crons');
  }
  check('GET lists both durable jobs', listed.status === 200 && listed.body?.crons?.length === 2);
  check('run-on-restart records delivery outcomes', listed.body.crons.every((job) => job.last?.status === 'ok'),
    JSON.stringify(listed.body.crons.map((job) => job.last)));

  const manual = await api('/api/crons/cron_boot_one/run', { method: 'POST' });
  check('Run now is accepted and reuses the agent', manual.status === 202 && manual.body?.agentCreated === false,
    JSON.stringify(manual.body));

  const stopped = await api('/api/crons/cron_boot_one', {
    method: 'PUT', body: JSON.stringify({ state: 'stopped' }),
  });
  check('stop keeps the job and clears its next fire', stopped.status === 200 && stopped.body.state === 'stopped' && stopped.body.next === null);

  const created = await api('/api/crons', {
    method: 'POST', body: JSON.stringify({
      name: 'Zurich morning', agent: { name: 'morning', cli: 'claude' }, prompt: 'Good morning.',
      schedule: { cron: '0 9 * * 1-5', tz: 'Europe/Zurich' }, runOnRestart: false,
    }),
  });
  check('POST stores the timezone and returns the next UTC instant',
    created.status === 201 && created.body.schedule.tz === 'Europe/Zurich' && /Z$/.test(created.body.next),
    JSON.stringify(created.body));

  const invalid = await api('/api/crons', {
    method: 'POST', body: JSON.stringify({
      name: 'bad zone', agent: { name: 'bad', cli: 'claude' }, prompt: 'No.',
      schedule: { cron: '0 9 * * *', tz: 'Moon/Sea' },
    }),
  });
  check('invalid timezone is a readable 400', invalid.status === 400 && /invalid schedule/.test(invalid.body?.error || ''), JSON.stringify(invalid.body));

  const deleted = await api('/api/crons/cron_boot_two', { method: 'DELETE' });
  check('delete is distinct from stop and removes the job', deleted.status === 200
    && !(await api('/api/crons')).body.crons.some((job) => job.id === 'cron_boot_two'));

  const disk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'crons.json'), 'utf8'));
  check('the final state is on DATA_DIR, not local process memory',
    disk.some((job) => job.id === 'cron_boot_one' && job.state === 'stopped')
      && !disk.some((job) => job.id === 'cron_boot_two'));
} catch (error) {
  check(`suite threw: ${error && error.message}`, false, log.slice(-1200));
} finally {
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), sleep(3000)]);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
