// The browser-side lock tracker: a stale "unlocked" status response must never
// undo a lock that a newer observation already reported, and the copy for the
// two non-public lock states must describe an outage, not exposure.
// Run:  node test/lockStatus.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lockstatus-')), 'lockStatus.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/lockStatus.ts')],
  outfile: out, format: 'esm', bundle: false, logLevel: 'error',
});
const { createLockTracker, reasonFromCloseReason, parseCloseReason, describeVerification, LOCKED_CLOSE_CODE } = await import(pathToFileURL(out).href);

// ---- ordering by request (no server counters) ----
const U = (seq, boot = 'b1') => ({ locked: false, seq, boot });
const L = (seq, boot = 'b1') => ({ locked: true, seq, boot });
{
  const t = createLockTracker();
  const a = t.begin();
  assert.equal(t.accept(a, { locked: false }), true, 'an unlocked status with nothing newer is applied');
  const b = t.begin();
  const c = t.begin();
  assert.equal(t.accept(c, { locked: true }), true, 'a locked status is always applied');
  assert.equal(t.accept(b, { locked: false }), false, 'an older in-flight "unlocked" arriving after a lock is ignored');
  const d = t.begin();
  assert.equal(t.accept(d, { locked: false }), true, 'an unlocked status requested after the lock reopens');
}
{
  const t = createLockTracker();
  const a = t.begin();
  t.observeLocked(); // a 403 body or a 4003 socket close, seen while `a` was in flight
  assert.equal(t.accept(a, { locked: false }), false, 'a 403/4003 observation outranks an older status fetch');
  assert.equal(t.accept(t.begin(), { locked: false }), true, 'the next fetch decides');
}
{
  const t = createLockTracker();
  const began = t.begin();
  for (let i = 0; i < 5; i++) t.observeLocked();
  assert.equal(t.accept(began, { locked: true }), true, 'repeated lock observations never block applying a lock');
  assert.equal(t.accept(began, { locked: false }), false, '...and still block the stale unlock');
}

// ---- ordering by server state (seq/boot) ----
{
  const t = createLockTracker();
  assert.equal(t.accept(t.begin(), U(4)), true, 'initial unlocked status seq 4 applied');
  t.observeLocked(); // the socket closed with 4003: the server is past seq 4
  const late = t.begin();
  assert.equal(t.accept(late, U(4)), false, 'a post-lock request answered with the pre-lock status (seq 4) is refused');
  assert.equal(t.accept(t.begin(), U(6)), true, 'a genuinely newer unlocked status reopens');
}
{
  const t = createLockTracker();
  assert.equal(t.accept(t.begin(), U(2)), true);
  assert.equal(t.accept(t.begin(), L(3)), true, 'locked seq 3 applied');
  assert.equal(t.accept(t.begin(), U(2)), false, 'an unlocked status older than the applied lock is refused even with a fresh request');
  assert.equal(t.accept(t.begin(), U(4)), true, 'newer reopens');
}
{
  const t = createLockTracker();
  assert.equal(t.accept(t.begin(), L(40, 'old-boot')), true);
  assert.equal(t.accept(t.begin(), U(1, 'new-boot')), true, 'a restarted server (new boot id) starts the counting over');
  t.observeLocked();
  assert.equal(t.accept(t.begin(), U(1, 'new-boot')), false, '...and its own stale statuses are then refused');
  assert.equal(t.accept(t.begin(), U(3, 'new-boot')), true);
}
{
  const t = createLockTracker();
  assert.equal(t.accept(t.begin(), { locked: false }), true, 'an older server without counters still works');
  t.observeLocked();
  assert.equal(t.accept(t.begin(), { locked: false }), true, '...falling back to request order alone');
}

// ---- the other direction: a stale LOCKED answer must not undo a newer reopening ----
{
  const t = createLockTracker();
  assert.equal(t.accept(t.begin(), L(3)), true, 'locked seq 3');
  assert.equal(t.accept(t.begin(), U(4)), true, 'reopened at seq 4');
  const delayed = t.begin();
  assert.equal(t.accept(delayed, L(3)), false, 'a delayed locked status from seq 3 is ignored after the reopen');
  assert.equal(t.accept(t.begin(), U(4)), true, 'healthy polls keep the app open — nothing raised the bar');
  assert.equal(t.accept(t.begin(), L(5)), true, 'a genuinely new lock (seq 5) still applies');
  assert.equal(t.accept(t.begin(), U(4)), false, 'and the stale reopen from before it is refused');
  assert.equal(t.accept(t.begin(), U(6)), true);
}
{
  const t = createLockTracker();
  assert.equal(t.accept(t.begin(), L(3)), true);
  assert.equal(t.accept(t.begin(), U(4)), true);
  assert.equal(t.observeLocked(3), false, 'a delayed 403/4003 stamped with the old lock seq is not news');
  assert.equal(t.accept(t.begin(), U(4)), true, 'the app stays open');
  assert.equal(t.observeLocked(5), true, 'a refusal stamped with a newer seq is a new lock');
  assert.equal(t.accept(t.begin(), U(4)), false);
  assert.equal(t.accept(t.begin(), U(6)), true);
  assert.equal(t.observeLocked(null), true, 'a refusal without a seq (older server) is always taken as news');
}

// ---- close reasons ----
assert.equal(LOCKED_CLOSE_CODE, 4003);
assert.equal(reasonFromCloseReason('locked:public-space'), 'public-space');
assert.equal(reasonFromCloseReason('locked:verification-unavailable'), 'verification-unavailable');
assert.equal(reasonFromCloseReason('exited'), null);
assert.equal(reasonFromCloseReason(''), null);
assert.equal(reasonFromCloseReason(undefined), null);
assert.equal(reasonFromCloseReason('locked:<script>'), null, 'only reason slugs are accepted');
assert.deepEqual(parseCloseReason('locked:public-space:7'), { reason: 'public-space', seq: 7 });
assert.deepEqual(parseCloseReason('locked:checking:'), { reason: null, seq: null }, 'a dangling separator is not a valid reason string');
assert.deepEqual(parseCloseReason('locked:verification-unavailable'), { reason: 'verification-unavailable', seq: null });
assert.equal(reasonFromCloseReason('locked:public-bucket:12'), 'public-bucket');

// ---- copy ----
{
  const now = 1_000_000_000;
  const d = describeVerification({ locked: true, reason: 'verification-unavailable', bucket: null, verifiedAt: now - 200_000, attemptedAt: now - 30_000, checkMs: 60_000, graceMs: 150_000 }, now);
  assert.equal(d.lastVerified, 'Last verified private 3 min ago.');
  assert.equal(d.lastAttempt, 'Last check 30 s ago.');
  assert.equal(d.cadence, 'every 1 min');
  assert.equal(d.grace, '2.5 min');
  const fresh = describeVerification({ locked: true, reason: 'checking', bucket: null, verifiedAt: null, attemptedAt: null }, now);
  assert.match(fresh.lastVerified, /not been verified private yet/);
  assert.match(fresh.lastAttempt, /No check has completed yet/);
  const nothing = describeVerification(null, now);
  assert.equal(nothing.cadence, 'every 1 min', 'defaults match the server constants when no status is known');
  for (const text of Object.values(d)) assert.doesNotMatch(text, /public/i, 'the outage copy never says "public"');
}

console.log('lockStatus checks passed');
