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
const { createLockTracker, reasonFromCloseReason, describeVerification, LOCKED_CLOSE_CODE } = await import(pathToFileURL(out).href);

// ---- ordering ----
{
  const t = createLockTracker();
  const a = t.begin();
  assert.equal(t.accept(a, false), true, 'an unlocked status with nothing newer is applied');
  const b = t.begin();
  const c = t.begin();
  assert.equal(t.accept(c, true), true, 'a locked status is always applied');
  assert.equal(t.accept(b, false), false, 'an older in-flight "unlocked" arriving after a lock is ignored');
  const d = t.begin();
  assert.equal(t.accept(d, false), true, 'an unlocked status requested after the lock reopens');
}
{
  const t = createLockTracker();
  const a = t.begin();
  t.observeLocked(); // a 403 body or a 4003 socket close, seen while `a` was in flight
  assert.equal(t.accept(a, false), false, 'a 403/4003 observation outranks an older status fetch');
  assert.equal(t.accept(t.begin(), false), true, 'the next fetch decides');
}
{
  const t = createLockTracker();
  const began = t.begin();
  for (let i = 0; i < 5; i++) t.observeLocked();
  assert.equal(t.accept(began, true), true, 'repeated lock observations never block applying a lock');
  assert.equal(t.accept(began, false), false, '...and still block the stale unlock');
}

// ---- close reasons ----
assert.equal(LOCKED_CLOSE_CODE, 4003);
assert.equal(reasonFromCloseReason('locked:public-space'), 'public-space');
assert.equal(reasonFromCloseReason('locked:verification-unavailable'), 'verification-unavailable');
assert.equal(reasonFromCloseReason('exited'), null);
assert.equal(reasonFromCloseReason(''), null);
assert.equal(reasonFromCloseReason(undefined), null);
assert.equal(reasonFromCloseReason('locked:<script>'), null, 'only reason slugs are accepted');

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
