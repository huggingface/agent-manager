// Saving settings: what the answer means.
//
// Settings are written on every change now, so these two files are rewritten
// constantly and while agents are reading them. Two things follow. The write
// has to be atomic — a half-written am-config.json reads back as "no settings
// at all", which is every setting silently reverting. And the answer has to be
// true: a save that did not happen must not come back as ok, or the change
// vanishes at the next load with nothing on screen to say so.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 7906;
const API = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-settings-write-'));
const CONFIG = path.join(DATA_DIR, 'am-config.json');
const NOTES = path.join(DATA_DIR, 'secret-notes.json');
const ENV_SKILL = path.join(DATA_DIR, 'workspaces', 'skills', 'environment.md');

let pass = 0; let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// SPACE_ID and AM_DISTRIBUTE_SKILLS are dropped on purpose: with either set, a
// generated skill is fanned out into the real ~/.claude of whoever runs this.
const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...BASE_ENV } = process.env;
const server = spawn('node', ['src/index.js'], {
  env: {
    ...BASE_ENV,
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
const until = async (fn, ms = 4000) => {
  for (let i = 0; i * 50 < ms; i++) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};

try {
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false)) break;
    await sleep(250);
  }

  // ---- what the response says was saved ----
  const saved = await api('/api/config', {
    method: 'PUT',
    body: JSON.stringify({
      artifacts: { enabled: true, space: '  someone/pages  ', visibility: 'public' },
      jobs: { askAboveUsd: 12 },
      archive: { after: 'week' },
      revive: { enabled: false, days: 7 },
      backup: { every: 'never', dataset: '', exclude: [] },
    }),
  });
  check('a save answers with what was committed, normalization included',
    saved.status === 200 && saved.body?.artifacts?.space === 'someone/pages'
      && saved.body?.jobs?.askAboveUsd === 12,
    JSON.stringify(saved.body?.artifacts));
  const read = await api('/api/config');
  check('and reading it back agrees', read.body?.archive?.after === 'week'
    && read.body?.artifacts?.visibility === 'public' && read.body?.revive?.enabled === false,
    JSON.stringify(read.body?.revive));
  check('the file it was written to is whole JSON, not a fragment',
    JSON.parse(fs.readFileSync(CONFIG, 'utf8')).jobs.askAboveUsd === 12);
  check('and nothing is left behind beside it',
    !fs.readdirSync(DATA_DIR).some((f) => f.includes('am-tmp')), fs.readdirSync(DATA_DIR).join(','));

  // ---- a write that cannot happen is not a save ----
  const before = fs.readFileSync(CONFIG, 'utf8');
  // A read-only directory and a read-only file: no temp file can be made beside
  // the target and no in-place write can land on it either, which is what a full
  // disk or a wedged mount looks like from here. Root ignores both modes.
  if (process.getuid && process.getuid() === 0) {
    console.log('SKIP  write-failure checks (running as root: the modes would not stop a write)');
  } else {
    fs.chmodSync(CONFIG, 0o444);
    fs.chmodSync(DATA_DIR, 0o555);
    const refused = await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ artifacts: { enabled: false, space: 'x/y', visibility: 'private' }, jobs: { askAboveUsd: 99 } }),
    });
    fs.chmodSync(DATA_DIR, 0o755);
    fs.chmodSync(CONFIG, 0o644);
    check('a failed write is answered as a failure, not as ok',
      refused.status === 500 && !refused.body?.ok && typeof refused.body?.error === 'string',
      `status ${refused.status} ${JSON.stringify(refused.body).slice(0, 120)}`);
    check('with something the operator can read',
      /could not save settings/.test(refused.body?.error || ''), refused.body?.error);
    check('the settings that were there are whole and untouched',
      fs.readFileSync(CONFIG, 'utf8') === before);
    check('and no half-written file is left beside them',
      !fs.readdirSync(DATA_DIR).some((f) => f.includes('am-tmp')), fs.readdirSync(DATA_DIR).join(','));
    // The contract, stated as the thing that goes wrong when it is broken: a
    // save that answered ok must be there on the next load. Answering ok for a
    // write that did not happen is how a setting reverts with nothing on screen
    // to say so.
    const still = await api('/api/config');
    check('a save that said ok is still there when the settings are read again',
      refused.body?.ok !== true || still.body?.jobs?.askAboveUsd === 99,
      `answered ${JSON.stringify(refused.body?.ok)}, reads back ${still.body?.jobs?.askAboveUsd}`);
  }

  // ---- descriptions, and the skill derived from them ----
  const notesOne = await api('/api/secrets', { method: 'PUT', body: JSON.stringify({ notes: { HF_TOKEN: 'mark-a' } }) });
  check('descriptions save the same way', notesOne.status === 200 && notesOne.body?.notes?.HF_TOKEN === 'mark-a');
  check('and land as whole JSON', JSON.parse(fs.readFileSync(NOTES, 'utf8')).HF_TOKEN === 'mark-a');

  // The generated skill is derived state: it is rebuilt after the response, and
  // what it must never do is settle on a value that has been replaced.
  // Markers, not prose: the generated skill is full of English, and "first"
  // appearing in it would prove nothing either way.
  for (const value of ['mark-b', 'mark-c', 'mark-d', 'mark-e']) {
    await api('/api/secrets', { method: 'PUT', body: JSON.stringify({ notes: { HF_TOKEN: value } }) });
  }
  const settled = await until(() => {
    try { return /mark-e/.test(fs.readFileSync(ENV_SKILL, 'utf8')); } catch { return false; }
  });
  check('a burst of saves leaves the generated skill on the last one', settled);
  const skill = fs.readFileSync(ENV_SKILL, 'utf8');
  check('and not on one it overtook', !/mark-[bcd]/.test(skill));

} catch (error) {
  check(`suite threw: ${error && error.message}`, false, log.slice(-1200));
} finally {
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), sleep(3000)]);
  try { fs.chmodSync(DATA_DIR, 0o755); } catch {}
  // The server may still be flushing state under HOME as it goes down, which
  // makes the first sweep of a temp dir race it. Tidying up is not the test.
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); break; } catch { await sleep(100); }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
