// Archiving, and the rule that delete hangs off it.
//
// The point of the feature is that one destructive action is reachable from
// exactly one place: you retire a session, and only then can you remove it.
// That rule is enforced here rather than only in the sidebar, so this drives
// the API directly — a caller that is not the UI has to meet it too.
//
// Run with:  node test/archive.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 7894;
const API = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-'));

let pass = 0; let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

// Test servers must not publish skills over a live Space (same strip the other
// boot suites use).
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
const mkSession = async (name, cli = 'shell') =>
  (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name, cli, path: name }) })).body;
const sessionOf = async (id) =>
  (await api('/api/tree')).body.sessions.find((s) => s.id === id);

try {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false)) break;
    await sleep(250);
  }

  // ---- delete is gated on archiving ----
  const a = await mkSession('to-delete');
  const refused = await api(`/api/sessions/${a.id}`, { method: 'DELETE' });
  check('a live session cannot be deleted', refused.status === 409, `status ${refused.status}`);
  check('and the refusal says why, in words the UI can show',
    /archive/i.test(refused.body?.error || ''), JSON.stringify(refused.body));
  check('the refusal carries a code', refused.body?.code === 'not-archived');
  check('and the session is still there', !!(await sessionOf(a.id)));

  const archived = await api(`/api/sessions/${a.id}/archive`, { method: 'POST' });
  check('archiving succeeds', archived.status === 200, `status ${archived.status}`);
  check('and stamps when it happened', !!archived.body?.archivedAt);

  const deleted = await api(`/api/sessions/${a.id}`, { method: 'DELETE' });
  check('an archived session deletes', deleted.status === 200, `status ${deleted.status}`);
  check('and is gone from the tree', !(await sessionOf(a.id)));

  // ---- the flag survives a restart, which is the whole reason it is stored ----
  const b = await mkSession('survivor');
  await api(`/api/sessions/${b.id}/archive`, { method: 'POST' });
  const persisted = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8'));
  const onDisk = (Array.isArray(persisted) ? persisted : persisted.sessions || []).find((s) => s.id === b.id);
  check('the archive is written to disk, not held in a browser', !!onDisk?.archivedAt);

  // ---- restore ----
  const restored = await api(`/api/sessions/${b.id}/unarchive`, { method: 'POST' });
  check('unarchiving succeeds', restored.status === 200, `status ${restored.status}`);
  check('and clears the stamp', !(await sessionOf(b.id))?.archivedAt);
  const refusedAgain = await api(`/api/sessions/${b.id}`, { method: 'DELETE' });
  check('so it is undeletable again', refusedAgain.status === 409, `status ${refusedAgain.status}`);

  // ---- archiving stops the agent ----
  const c = await mkSession('running-one');
  // Opening a terminal socket is what starts the process; the resize suite does
  // the same. A shell is enough — the point is that something is running.
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?session=${c.id}&cols=80&rows=24`);
  await new Promise((r) => { ws.onopen = r; ws.onerror = r; });
  await sleep(1200);
  const before = await sessionOf(c.id);
  check('the agent is running before archiving', before?.running === true, `state ${before?.state}`);
  await api(`/api/sessions/${c.id}/archive`, { method: 'POST' });
  await sleep(600);
  const after = await sessionOf(c.id);
  check('archiving stopped it', after?.running === false, `state ${after?.state}`);
  check('and `stopped` is still the state it lands in', after?.state === 'stopped', `state ${after?.state}`);
  try { ws.close(); } catch { /* already gone */ }

  // ---- unknown ids ----
  const missing = await api('/api/sessions/nope-nope/archive', { method: 'POST' });
  check('archiving something that does not exist is a 404', missing.status === 404, `status ${missing.status}`);
} catch (e) {
  check(`suite threw: ${e && e.message}`, false, log.slice(-600));
} finally {
  srv.kill();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* tmp */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
