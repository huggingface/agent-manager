// The name the create panel shows before you have typed anything.
//
// The panel prefills its name field from this endpoint so the operator sees the
// name the agent will actually get. That makes it a display value, not a
// reservation: the field stays empty until it is edited, and an untouched field
// sends no name at all, so the server keeps naming the session the way it always
// did. This suite pins both halves — the endpoint agrees with the creation path,
// and two creations racing on the same prefill still land on distinct names.
//
// Run with:  node test/next-name.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 7893;
const API = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'next-name-'));

let pass = 0; let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...BASE_ENV } = process.env;
const srv = spawn('node', ['src/index.js'], {
  env: { ...BASE_ENV, PORT: String(PORT), DATA_DIR, AM_BASHRC: '/nonexistent', AM_ALLOW_MISSING_ORIGIN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, init = {}) => {
  const sep = route.includes('?') ? '&' : '?';
  const r = await fetch(`${API}${route}${sep}from=operator`, {
    headers: { 'content-type': 'application/json' }, ...init,
  });
  let body = null;
  try { body = await r.json(); } catch { /* empty */ }
  return { status: r.status, body };
};
// `name` omitted entirely — this is what an untouched prefill sends.
const mkNameless = (cli = 'shell') =>
  api('/api/sessions', { method: 'POST', body: JSON.stringify({ cli, path: 'w' }) });
const hint = (cli) => api(`/api/next-name?cli=${encodeURIComponent(cli)}`);

try {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false)) break;
    await sleep(250);
  }

  // ---- the hint is the name the creation path would pick ----
  const first = await hint('shell');
  check('a hint comes back for a known cli', first.status === 200, JSON.stringify(first.body));
  check('and it is the first free name', first.body?.name === 'shell-1', JSON.stringify(first.body));
  check('the cli is echoed so a late reply cannot fill the wrong field',
    first.body?.cli === 'shell', JSON.stringify(first.body));

  const made = await mkNameless();
  check('a nameless create takes exactly that name', made.body?.name === 'shell-1', JSON.stringify(made.body?.name));
  const second = await hint('shell');
  check('and the hint moves on', second.body?.name === 'shell-2', JSON.stringify(second.body));

  // ---- the hint reserves nothing: the server still names, so no collision ----
  const [a, b] = await Promise.all([mkNameless(), mkNameless()]);
  check('two nameless creates racing on one hint get distinct names',
    a.body?.name !== b.body?.name, `${a.body?.name} vs ${b.body?.name}`);
  check('and both are real names, not blanks', !!a.body?.name && !!b.body?.name);

  // ---- an edited field wins ----
  const named = await api('/api/sessions', {
    method: 'POST', body: JSON.stringify({ cli: 'shell', path: 'w', name: 'chosen-by-hand' }),
  });
  check('a name the operator typed is honoured', named.body?.name === 'chosen-by-hand', JSON.stringify(named.body?.name));

  // ---- bad input ----
  const unknown = await hint('not-a-cli');
  check('an unknown cli is a 400, not a guessed name', unknown.status === 400, `status ${unknown.status}`);
  const blank = await api('/api/next-name');
  check('a missing cli is a 400 too', blank.status === 400, `status ${blank.status}`);
} catch (e) {
  check(`suite threw: ${e && e.message}`, false, log.slice(-600));
} finally {
  srv.kill();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* tmp */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
