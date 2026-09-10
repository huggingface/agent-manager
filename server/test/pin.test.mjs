// Pinning, at the API. Two things matter here and neither is the happy path.
//
// The first is that pinning does NOT get in the way of archiving. Archiving is
// the operator saying "I am finished with this one", and a feature that made a
// pinned session un-archivable would have quietly taken that away. It stays
// available, and taking it clears the pin — a record asserting both "keep this
// in front of me" and "I am done with this" is a record that has stopped
// meaning anything.
//
// The second is that pinning is stored, not derived: it survives a restart, the
// way `archivedAt` does and the idle window deliberately does not.
//
// Run with:  node test/pin.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 7892;
const API = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));

let pass = 0; let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...BASE_ENV } = process.env;
const boot = () => spawn('node', ['src/index.js'], {
  env: { ...BASE_ENV, PORT: String(PORT), DATA_DIR, AM_BASHRC: '/nonexistent', AM_ALLOW_MISSING_ORIGIN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srv = boot();
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
const waitUp = async () => {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false)) return;
    await sleep(250);
  }
};
const mkSession = async (name) =>
  (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name, cli: 'shell', path: name }) })).body;
const tree = async () => (await api('/api/tree')).body;
const sessionOf = async (id) => (await tree()).sessions.find((s) => s.id === id);
const groupOf = async (id) => (await tree()).groups.find((g) => g.id === id);

try {
  await waitUp();

  // ---- a session ----
  const a = await mkSession('pinme');
  check('a new session is not pinned', !(await sessionOf(a.id)).pinnedAt);

  const pinned = await api(`/api/sessions/${a.id}/pin`, { method: 'POST' });
  check('pinning answers 200', pinned.status === 200, `status ${pinned.status}`);
  check('and the record carries the moment it happened', !!(await sessionOf(a.id)).pinnedAt);

  await api(`/api/sessions/${a.id}/unpin`, { method: 'POST' });
  check('unpinning clears it', !(await sessionOf(a.id)).pinnedAt);

  // ---- a group ----
  const g = (await api('/api/groups', { method: 'POST', body: JSON.stringify({ name: 'fleet' }) })).body;
  await api(`/api/groups/${g.id}`, { method: 'PUT', body: JSON.stringify({ sessionIds: [a.id] }) });
  check('a new group is not pinned', !(await groupOf(g.id)).pinnedAt);
  const gp = await api(`/api/groups/${g.id}/pin`, { method: 'POST' });
  check('pinning a group answers 200', gp.status === 200, `status ${gp.status}`);
  check('and the group record carries it', !!(await groupOf(g.id)).pinnedAt);
  check('the member is NOT pinned in its own right — membership is what carries it',
    !(await sessionOf(a.id)).pinnedAt);

  // A rename goes through the same update() the tree editor uses; a pin it does
  // not know about must not be collateral damage.
  await api(`/api/groups/${g.id}`, { method: 'PUT', body: JSON.stringify({ name: 'fleet-2' }) });
  check('renaming the group leaves its pin alone', !!(await groupOf(g.id)).pinnedAt);
  await api(`/api/groups/${g.id}/unpin`, { method: 'POST' });
  check('unpinning the group clears it', !(await groupOf(g.id)).pinnedAt);

  // ---- pinning does not block archiving, and archiving clears the pin ----
  const b = await mkSession('busy');
  await api(`/api/sessions/${b.id}/pin`, { method: 'POST' });
  check('pinned to start with', !!(await sessionOf(b.id)).pinnedAt);
  const arch = await api(`/api/sessions/${b.id}/archive`, { method: 'POST' });
  check('archiving a PINNED session is still allowed', arch.status === 200, `status ${arch.status}`);
  const after = await sessionOf(b.id);
  check('it is archived', !!after.archivedAt);
  check('and the pin is gone — the two cannot both be true', !after.pinnedAt);
  const back = await api(`/api/sessions/${b.id}/unarchive`, { method: 'POST' });
  check('restoring it works', back.status === 200);
  const restored = await sessionOf(b.id);
  check('and it comes back unpinned, not silently re-pinned', !restored.pinnedAt && !restored.archivedAt);

  // ---- stored, not derived ----
  const c = await mkSession('survivor');
  await api(`/api/sessions/${c.id}/pin`, { method: 'POST' });
  const g2 = (await api('/api/groups', { method: 'POST', body: JSON.stringify({ name: 'keep' }) })).body;
  await api(`/api/groups/${g2.id}/pin`, { method: 'POST' });
  srv.kill();
  await sleep(600);
  srv = boot();
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  await waitUp();
  check('a pinned session is still pinned after a restart', !!(await sessionOf(c.id)).pinnedAt);
  check('and so is a pinned group', !!(await groupOf(g2.id)).pinnedAt);

  // ---- the invariant: a session in a group never HOLDS a pin ----
  //
  // Not "reads as unpinned" — holds none. A stray `pinnedAt` on a member is
  // suppressed by every read while the session is grouped, and every one of
  // those reads stops applying the moment it leaves. The pin then springs back
  // on a row the operator has had no way to see or change since it joined. So
  // the ways IN are covered here next to the ways OUT: guarding one exit is not
  // the same as the value never existing, and there is more than one exit.

  // The asymmetric pairing the review found. The sidebar's carry-pin looks at
  // the DRAGGED row; here the pinned one is the target, which becomes a member
  // without ever being examined.
  const pa = await mkSession('anchor');
  const pb = await mkSession('dragged');
  await api(`/api/sessions/${pa.id}/pin`, { method: 'POST' });
  const paired = await api('/api/move', {
    method: 'POST',
    body: JSON.stringify({ ref: `s:${pb.id}`, to: { kind: 'pair', sessionId: pa.id } }),
  });
  check('pairing an unpinned session onto a pinned one answers 200', paired.status === 200, `status ${paired.status}`);
  check('and the pinned TARGET loses its pin on the way in', !(await sessionOf(pa.id)).pinnedAt);

  // Exit one: the group is deleted and its members go loose.
  const pairGroup = (await tree()).groups.find((g) => g.sessionIds.includes(pa.id));
  check('the pair really did make a group', !!pairGroup);
  await api(`/api/groups/${pairGroup.id}`, { method: 'DELETE' });
  check('released by deleting its group, it does not come back pinned', !(await sessionOf(pa.id)).pinnedAt);

  // The other way a member can acquire one: the API, directly. The sidebar
  // never asks — it leaves the control off a grouped row — but an agent can.
  const held = (await api('/api/groups', { method: 'POST', body: JSON.stringify({ name: 'held' }) })).body;
  const pc = await mkSession('member');
  await api(`/api/groups/${held.id}`, { method: 'PUT', body: JSON.stringify({ sessionIds: [pc.id] }) });
  const refused = await api(`/api/sessions/${pc.id}/pin`, { method: 'POST' });
  check('pinning a session inside a group is refused', refused.status === 409, `status ${refused.status}`);
  check('and nothing was written to the record', !(await sessionOf(pc.id)).pinnedAt);

  // The tree editor sends whole membership lists rather than one attach.
  const pd = await mkSession('joiner');
  await api(`/api/sessions/${pd.id}/pin`, { method: 'POST' });
  await api(`/api/groups/${held.id}`, { method: 'PUT', body: JSON.stringify({ sessionIds: [pc.id, pd.id] }) });
  check('a tree edit that adds a pinned session clears its pin', !(await sessionOf(pd.id)).pinnedAt);

  // Exit two: pulled back out beside a top-level row.
  await api('/api/move', {
    method: 'POST',
    body: JSON.stringify({ ref: `s:${pd.id}`, to: { kind: 'before', ref: `g:${held.id}` } }),
  });
  check('pulled back out to the top level, it is still unpinned', !(await sessionOf(pd.id)).pinnedAt);

  // Straight in through a move, and straight back out.
  const pe = await mkSession('mover');
  await api(`/api/sessions/${pe.id}/pin`, { method: 'POST' });
  await api('/api/move', {
    method: 'POST',
    body: JSON.stringify({ ref: `s:${pe.id}`, to: { kind: 'into', groupId: held.id } }),
  });
  check('moving a pinned session INTO a group clears its pin', !(await sessionOf(pe.id)).pinnedAt);

  // And the anchor form, which attaches beside a row that is itself nested.
  const pf = await mkSession('nested');
  await api(`/api/sessions/${pf.id}/pin`, { method: 'POST' });
  await api('/api/move', {
    method: 'POST',
    body: JSON.stringify({ ref: `s:${pf.id}`, to: { kind: 'after', ref: `s:${pc.id}` } }),
  });
  check('placed beside a nested row, a pinned session loses its pin', !(await sessionOf(pf.id)).pinnedAt);

  // Exit three: records written BEFORE the invariant was enforced. Those exist
  // in the wild, so write the state the old code could produce and boot on it.
  srv.kill();
  await sleep(600);
  const sessionsFile = path.join(DATA_DIR, 'sessions.json');
  const onDisk = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  onDisk.find((x) => x.id === pc.id).pinnedAt = new Date().toISOString();
  fs.writeFileSync(sessionsFile, JSON.stringify(onDisk, null, 2));
  srv = boot();
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  await waitUp();
  check('a stray pin left by an older record is cleared on load', !(await sessionOf(pc.id)).pinnedAt);
  const stillGrouped = (await tree()).groups.find((g) => g.id === held.id);
  check('and clearing it did not disturb the membership', stillGrouped.sessionIds.includes(pc.id));

  // ---- unknown ids ----
  const missing = await api('/api/sessions/nope-nope/pin', { method: 'POST' });
  check('pinning something that does not exist is a 404', missing.status === 404, `status ${missing.status}`);
  const missingG = await api('/api/groups/nope-nope/pin', { method: 'POST' });
  check('and so is pinning a group that does not exist', missingG.status === 404, `status ${missingG.status}`);
} catch (e) {
  check(`suite threw: ${e && e.message}`, false, log.slice(-600));
} finally {
  srv.kill();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* tmp */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
