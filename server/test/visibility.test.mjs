// The privacy lock's model, driven with an injected clock and synthetic Hub
// responses: which responses count as evidence, how grace expires, how public
// verdicts win, and that stale or reordered results can never reopen access.
// No network, no timers of its own. Run:  node test/visibility.test.mjs
import assert from 'node:assert/strict';
import {
  createVisibilityMonitor, classifyRepoResponse, classifyDiscoveryResponse, REASON,
  GRACE_MS, CHECK_MS, CYCLE_BUDGET_MS, HF_TIMEOUT_MS, UNAUTHORIZED_CONFIRMATIONS,
} from '../src/visibility.js';

let pass = 0; let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual) === JSON.stringify(expected) ? '' : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

// ---------- fixtures ----------

// A clock whose timers fire only when the test advances it. Promise callbacks
// still need the real microtask queue, so advance() is async and drains it.
const flush = () => new Promise((r) => setImmediate(r));
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  const timers = new Set();
  const clock = {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + Math.max(0, ms), unref() {} }; timers.add(h); return h; },
    clearTimeout: (h) => { if (h) timers.delete(h); },
    pending: () => timers.size,
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...timers].filter((h) => h.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        t = due.at;
        due.fn();
        await flush(); await flush();
      }
      t = target;
      await flush(); await flush();
    },
  };
  return clock;
}

const SPACE = 'owner/space';
const BUCKET_A = 'owner/bucket-a';
const BUCKET_B = 'owner/bucket-b';
const json = (status, body) => ({ status, text: JSON.stringify(body) });
const PRIVATE_401 = json(401, { error: 'Invalid username or password.' });
const spacePublic = () => json(200, { id: SPACE, private: false, runtime: {} });
const spacePrivateAuthed = (volumes) => json(200, { id: SPACE, private: true, runtime: volumes === undefined ? {} : { volumes } });
const bucketVol = (source) => ({ type: 'bucket', source, mountPath: '/data' });

// Routes: key `GET url` or `AUTH url`. A handler is a response object, a
// function (call) => response, or a promise. Missing route → network error.
function fakeHub() {
  const routes = new Map();
  const calls = [];
  const on = (url, handler, { auth = false } = {}) => routes.set(`${auth ? 'AUTH' : 'GET'} ${url}`, handler);
  const fetch = (url, init = {}) => {
    const auth = !!(init.headers && init.headers.authorization);
    calls.push({ url, auth });
    const h = routes.get(`${auth ? 'AUTH' : 'GET'} ${url}`);
    const resolve = (r) => ({ status: r.status, text: async () => r.text });
    if (h === undefined) return Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'TypeError' }));
    if (typeof h === 'function') { const r = h(calls.length); return r && typeof r.then === 'function' ? r.then(resolve) : Promise.resolve(resolve(r)); }
    if (typeof h.then === 'function') return h.then(resolve);
    return Promise.resolve(resolve(h));
  };
  return { on, fetch, calls };
}

const HUB = 'https://hub.test';
const SPACE_URL = `${HUB}/api/spaces/${SPACE}`;
const bucketUrl = (id) => `${HUB}/api/buckets/${id}`;
const quiet = { warn() {}, error() {}, log() {} };

function monitor(hub, clock, extra = {}) {
  const changes = [];
  const m = createVisibilityMonitor({
    spaceId: SPACE, endpoint: HUB, fetch: hub.fetch, now: clock.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, log: quiet, ...extra,
  });
  m.onChange((eff) => changes.push({ locked: eff.locked, reason: eff.reason, bucket: eff.bucket }));
  return { m, changes };
}
const eff = (m) => { const e = m.effective(); return { locked: e.locked, reason: e.reason, bucket: e.bucket, bucketUnverified: e.bucketUnverified }; };
const LOCKED_CHECKING = { locked: true, reason: REASON.CHECKING, bucket: null, bucketUnverified: false };
const LOCKED_UNAVAILABLE = { locked: true, reason: REASON.UNAVAILABLE, bucket: null, bucketUnverified: false };
const UNLOCKED = { locked: false, reason: null, bucket: null, bucketUnverified: false };
const UNLOCKED_WARN = { locked: false, reason: null, bucket: null, bucketUnverified: true };

// ---------- evidence matrix (pure) ----------

{
  const rows = [
    ['200 private:false', json(200, { id: SPACE, private: false }), 'public'],
    ['200 private:true', json(200, { id: SPACE, private: true }), 'private'],
    ['200 id differs in case only', json(200, { id: 'Owner/Space', private: false }), 'public'],
    ['401 JSON', PRIVATE_401, 'private'],
    ['404 JSON', json(404, { error: 'Repository not found' }), 'private'],
    ['200 private as string', json(200, { id: SPACE, private: 'false' }), null],
    ['200 missing private', json(200, { id: SPACE }), null],
    ['200 for another repo', json(200, { id: 'someone/else', private: false }), null],
    ['200 array body', json(200, []), null],
    ['200 invalid JSON', { status: 200, text: '<html>ok</html>' }, null],
    ['401 HTML (edge page)', { status: 401, text: '<html>denied</html>' }, null],
    ['404 HTML (edge page)', { status: 404, text: 'not found' }, null],
    ['302 redirect', { status: 302, text: '' }, null],
    ['403', json(403, { error: 'forbidden' }), null],
    ['429', json(429, { error: 'rate limited' }), null],
    ['500', json(500, { error: 'oops' }), null],
    ['503 HTML', { status: 503, text: 'maintenance' }, null],
  ];
  for (const [name, res, want] of rows) eq(`repo evidence: ${name} → ${want}`, classifyRepoResponse(res, SPACE).verdict, want);
}
{
  const rows = [
    ['200 no volumes key (no storage)', spacePrivateAuthed(undefined), 'ok', []],
    ['200 empty volumes', spacePrivateAuthed([]), 'ok', []],
    ['200 two buckets, one other volume', spacePrivateAuthed([bucketVol(BUCKET_A), { type: 'other', source: 'x' }, bucketVol(BUCKET_B)]), 'ok', [BUCKET_A, BUCKET_B]],
    ['200 duplicate bucket', spacePrivateAuthed([bucketVol(BUCKET_A), bucketVol(BUCKET_A)]), 'ok', [BUCKET_A]],
    ['200 volumes is a string', json(200, { id: SPACE, private: true, runtime: { volumes: 'bucket' } }), null, undefined],
    ['200 bucket without source', json(200, { id: SPACE, private: true, runtime: { volumes: [{ type: 'bucket' }] } }), null, undefined],
    ['200 volume entry is null', json(200, { id: SPACE, private: true, runtime: { volumes: [null] } }), null, undefined],
    ['200 missing runtime', json(200, { id: SPACE, private: true }), null, undefined],
    ['200 missing id', json(200, { private: true, runtime: {} }), null, undefined],
    ['200 another repo', json(200, { id: 'someone/else', private: true, runtime: {} }), null, undefined],
    ['200 invalid JSON', { status: 200, text: '{' }, null, undefined],
    ['401 JSON', PRIVATE_401, 'unauthorized', undefined],
    ['403 JSON', json(403, { error: 'forbidden' }), 'unauthorized', undefined],
    ['404 JSON', json(404, { error: 'Repository not found' }), 'unauthorized', undefined],
    ['401 HTML', { status: 401, text: '<html>' }, null, undefined],
    ['429', json(429, { error: 'slow down' }), null, undefined],
    ['500', json(500, {}), null, undefined],
    ['307', { status: 307, text: '' }, null, undefined],
  ];
  for (const [name, res, want, buckets] of rows) {
    const c = classifyDiscoveryResponse(res, SPACE);
    eq(`discovery evidence: ${name} → ${want}`, c.verdict, want);
    if (buckets) eq(`discovery evidence: ${name} buckets`, c.buckets, buckets);
  }
  check('discovery: authenticated body saying private:false is a public-space verdict', classifyDiscoveryResponse(json(200, { id: SPACE, private: false, runtime: {} }), SPACE).spacePublic === true);
}

// ---------- local mode ----------
{
  const hub = fakeHub(); const clock = fakeClock();
  const m = createVisibilityMonitor({ spaceId: null, fetch: hub.fetch, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, log: quiet });
  await m.start();
  check('local mode (no SPACE_ID): never locked, no upstream requests', !m.isLocked() && hub.calls.length === 0 && m.effective().local === true);
  m.stop();
}

// ---------- startup: fail closed until verified ----------
{
  const hub = fakeHub(); const clock = fakeClock();
  const { m, changes } = monitor(hub, clock);
  eq('before any check: locked, reason checking', eff(m), LOCKED_CHECKING);
  hub.on(SPACE_URL, json(500, { error: 'down' }));
  await m.check();
  eq('a failed first check leaves it checking (not unavailable, not public)', eff(m), LOCKED_CHECKING);
  const s1 = m.publicStatus();
  check('failed attempt is stamped as attempted, not verified', s1.space.attemptedAt === clock.now() && s1.space.verifiedAt === null && s1.attemptedAt === clock.now() && s1.verifiedAt === null);
  hub.on(SPACE_URL, () => new Promise(() => {})); // hangs
  const p = m.check();
  await clock.advance(HF_TIMEOUT_MS + 1);
  await p;
  eq('a hung first check times out and stays checking', eff(m), LOCKED_CHECKING);
  hub.on(SPACE_URL, PRIVATE_401);
  await m.check();
  eq('no token: private Space unlocks in warning-only mode', eff(m), UNLOCKED_WARN);
  eq('transitions published once each', changes, [{ locked: true, reason: REASON.CHECKING, bucket: null }, { locked: false, reason: null, bucket: null }]);
  check('one request per cycle without a token', hub.calls.length === 3 && hub.calls.every((c) => !c.auth));
  check('expiry timer armed while unlocked', m.stats().expiryArmed);
  m.stop();
  check('stop() clears timers and listeners', clock.pending() === 0 && m.stats().listeners === 0);
}

// ---------- token: discovery and per-bucket verification ----------
{
  const hub = fakeHub(); const clock = fakeClock();
  const { m } = monitor(hub, clock, { token: () => 'hf_test_token_value' });
  hub.on(SPACE_URL, PRIVATE_401);
  hub.on(SPACE_URL, spacePrivateAuthed([bucketVol(BUCKET_A), bucketVol(BUCKET_B)]), { auth: true });
  hub.on(bucketUrl(BUCKET_A), PRIVATE_401);
  hub.on(bucketUrl(BUCKET_B), json(200, { id: BUCKET_B, private: true }));
  await m.check();
  eq('private Space + two private buckets → unlocked, verified', eff(m), UNLOCKED);
  check('first cycle: space + discovery + 2 buckets', hub.calls.length === 4);
  await m.check();
  check('second cycle reuses the discovered mount list (deployment-scoped cache)', hub.calls.length === 7 && hub.calls.filter((c) => c.auth).length === 1);
  const st = m.publicStatus();
  check('status lists both buckets while unlocked', st.buckets.map((b) => b.id).sort().join() === [BUCKET_A, BUCKET_B].sort().join());
  check('status never carries upstream body text', !JSON.stringify(st).includes('Invalid username'));
  m.stop();
}

// ---------- discovery: retry transient failures, accept genuinely empty ----------
{
  const hub = fakeHub(); const clock = fakeClock();
  const { m } = monitor(hub, clock, { token: () => 'hf_test_token_value' });
  hub.on(SPACE_URL, PRIVATE_401);
  hub.on(SPACE_URL, json(503, { error: 'busy' }), { auth: true });
  await m.check();
  eq('discovery 503: locked, still checking (not cached as empty)', eff(m), LOCKED_CHECKING);
  hub.on(SPACE_URL, json(200, { id: SPACE, private: true, runtime: { volumes: 'nope' } }), { auth: true });
  await m.check();
  eq('discovery with malformed volumes: no verdict', eff(m), LOCKED_CHECKING);
  hub.on(SPACE_URL, json(200, { id: SPACE, private: true }), { auth: true });
  await m.check();
  eq('discovery without runtime: incomplete metadata, no verdict', eff(m), LOCKED_CHECKING);
  check('discovery was retried every cycle', hub.calls.filter((c) => c.auth).length === 3);
  hub.on(SPACE_URL, spacePrivateAuthed(undefined), { auth: true });
  await m.check();
  eq('a Space with no volumes key is a genuinely empty mount list → verified', eff(m), UNLOCKED);
  await m.check();
  check('an accepted discovery is not re-fetched', hub.calls.filter((c) => c.auth).length === 4);
  m.stop();
}

// ---------- credentials: the documented warning-only exemption ----------
{
  const hub = fakeHub(); const clock = fakeClock();
  let token = 'hf_stale_token';
  const { m } = monitor(hub, clock, { token: () => token });
  hub.on(SPACE_URL, PRIVATE_401);
  hub.on(SPACE_URL, json(401, { error: 'Invalid username or password.' }), { auth: true });
  for (let i = 1; i < UNAUTHORIZED_CONFIRMATIONS; i++) {
    await m.check();
    eq(`unauthorized discovery ${i}x: still locked/checking`, eff(m), LOCKED_CHECKING);
  }
  await m.check();
  eq(`unauthorized discovery ${UNAUTHORIZED_CONFIRMATIONS}x: warning-only mode, unlocked`, eff(m), UNLOCKED_WARN);
  check('warning mode does not call the bucket verified', m.publicStatus().bucketDiscovery.verdict === 'unauthorized' && m.publicStatus().buckets.length === 0);
  await m.check();
  check('unauthorized verdict is cached per credential', hub.calls.filter((c) => c.auth).length === UNAUTHORIZED_CONFIRMATIONS);
  // Restoring a usable credential re-discovers and verifies for real.
  token = 'hf_fresh_token';
  hub.on(SPACE_URL, spacePrivateAuthed([bucketVol(BUCKET_A)]), { auth: true });
  hub.on(bucketUrl(BUCKET_A), PRIVATE_401);
  await m.check();
  eq('a changed credential invalidates discovery and verifies the bucket', eff(m), UNLOCKED);
  // A general outage of discovery is NOT the exemption.
  token = 'hf_third_token';
  hub.on(SPACE_URL, () => Promise.reject(new TypeError('fetch failed')), { auth: true });
  const p = m.check();
  await clock.advance(1);
  await p;
  eq('after a credential change, a network failure locks rather than warning', eff(m), LOCKED_CHECKING);
  // Removing the token entirely is the exemption, immediately.
  token = null;
  await m.check();
  eq('no token at all → warning-only mode', eff(m), UNLOCKED_WARN);
  m.stop();
}

// ---------- grace boundaries ----------
{
  const hub = fakeHub(); const clock = fakeClock();
  const { m, changes } = monitor(hub, clock);
  hub.on(SPACE_URL, PRIVATE_401);
  await m.check();
  const t0 = clock.now();
  eq('verified private → unlocked', eff(m), UNLOCKED_WARN);
  hub.on(SPACE_URL, json(500, { error: 'down' }));
  await clock.advance(CHECK_MS); await m.check();
  eq('one failed check inside grace: still open', eff(m), UNLOCKED_WARN);
  await clock.advance(CHECK_MS); await m.check();
  eq('two failed checks inside grace: still open', eff(m), UNLOCKED_WARN);
  check('failed checks do not renew the evidence', m.publicStatus().verifiedAt === t0 && m.publicStatus().attemptedAt === clock.now());
  for (let i = 0; i < 5; i++) m.publicStatus();
  await clock.advance(GRACE_MS - 2 * CHECK_MS - 1);
  eq('just before expiry (repeated status reads did not extend it): open', eff(m), UNLOCKED_WARN);
  await clock.advance(1);
  eq('at expiry: locked, verification-unavailable — without any check running', eff(m), LOCKED_UNAVAILABLE);
  eq('the expiry was published as a transition', changes.at(-1), { locked: true, reason: REASON.UNAVAILABLE, bucket: null });
  check('unavailable is not a public claim', m.publicStatus().space.verdict === 'private');
  await clock.advance(CHECK_MS); await m.check();
  eq('another failure after expiry: still unavailable', eff(m), LOCKED_UNAVAILABLE);
  hub.on(SPACE_URL, PRIVATE_401);
  await m.check();
  eq('a successful check reopens', eff(m), UNLOCKED_WARN);
  // A hung check does not delay expiry.
  hub.on(SPACE_URL, () => new Promise(() => {}));
  const hung = m.check();
  await clock.advance(GRACE_MS);
  eq('expiry fires while a check is still pending', eff(m), LOCKED_UNAVAILABLE);
  await clock.advance(CYCLE_BUDGET_MS);
  await hung;
  check('the hung cycle ended on its budget', !m.stats().inflight);
  m.stop();
}

// ---------- per-resource ages ----------
{
  const hub = fakeHub(); const clock = fakeClock();
  const { m } = monitor(hub, clock, { token: () => 'hf_test_token_value' });
  hub.on(SPACE_URL, PRIVATE_401);
  hub.on(SPACE_URL, spacePrivateAuthed([bucketVol(BUCKET_A)]), { auth: true });
  hub.on(bucketUrl(BUCKET_A), PRIVATE_401);
  await m.check();
  const tb = clock.now();
  hub.on(bucketUrl(BUCKET_A), json(502, {}));
  await clock.advance(CHECK_MS); await m.check();
  await clock.advance(CHECK_MS); await m.check();
  const st = m.publicStatus();
  check('the Space renews on its own successes; the failing bucket keeps its old age',
    st.space.verifiedAt === clock.now() && st.buckets[0].verifiedAt === tb && st.verifiedAt === tb);
  await clock.advance(GRACE_MS - 2 * CHECK_MS);
  eq('the stale bucket expires the whole lock even though the Space is fresh', eff(m), LOCKED_UNAVAILABLE);
  m.stop();
}

// ---------- public verdicts win, immediately and stickily ----------
{
  const hub = fakeHub(); const clock = fakeClock();
  const { m, changes } = monitor(hub, clock, { token: () => 'hf_test_token_value' });
  hub.on(SPACE_URL, PRIVATE_401);
  hub.on(SPACE_URL, spacePrivateAuthed([bucketVol(BUCKET_A), bucketVol(BUCKET_B)]), { auth: true });
  hub.on(bucketUrl(BUCKET_A), PRIVATE_401);
  hub.on(bucketUrl(BUCKET_B), PRIVATE_401);
  await m.check();
  eq('baseline verified', eff(m), UNLOCKED);
  // Public Space: locks inside grace, no waiting.
  hub.on(SPACE_URL, spacePublic());
  await clock.advance(1000);
  const before = hub.calls.length;
  await m.check();
  eq('public Space locks at once', eff(m), { locked: true, reason: REASON.PUBLIC_SPACE, bucket: null, bucketUnverified: false });
  check('a public Space verdict ends the cycle (no bucket requests)', hub.calls.length === before + 1);
  hub.on(SPACE_URL, json(500, { error: 'down' }));
  await m.check();
  eq('an error after a public verdict cannot reopen', eff(m), { locked: true, reason: REASON.PUBLIC_SPACE, bucket: null, bucketUnverified: false });
  hub.on(SPACE_URL, () => Promise.reject(new TypeError('fetch failed')));
  await m.check();
  eq('a network failure after a public verdict cannot reopen either', eff(m), { locked: true, reason: REASON.PUBLIC_SPACE, bucket: null, bucketUnverified: false });
  hub.on(SPACE_URL, { status: 200, text: '<html>edge</html>' });
  await m.check();
  eq('a malformed answer after a public verdict cannot reopen either', eff(m), { locked: true, reason: REASON.PUBLIC_SPACE, bucket: null, bucketUnverified: false });
  await clock.advance(GRACE_MS * 2);
  eq('...nor does time', eff(m), { locked: true, reason: REASON.PUBLIC_SPACE, bucket: null, bucketUnverified: false });
  hub.on(SPACE_URL, PRIVATE_401);
  await m.check();
  eq('new valid private evidence for Space AND buckets reopens', eff(m), UNLOCKED);
  check('no intermediate unavailable flash between public and reopened', !changes.some((c) => c.reason === REASON.UNAVAILABLE));
  // Public bucket: private Space, one bucket public.
  hub.on(bucketUrl(BUCKET_B), json(200, { id: BUCKET_B, private: false }));
  await m.check();
  eq('a public mounted bucket locks with its id', eff(m), { locked: true, reason: REASON.PUBLIC_BUCKET, bucket: BUCKET_B, bucketUnverified: false });
  const st = m.publicStatus();
  check('locked status names only the public bucket', st.buckets.length === 1 && st.buckets[0].id === BUCKET_B && st.bucket === BUCKET_B);
  // Bucket B errors afterwards: still known public.
  hub.on(bucketUrl(BUCKET_B), json(500, {}));
  await m.check();
  eq('an error about a known-public bucket does not forget it', eff(m), { locked: true, reason: REASON.PUBLIC_BUCKET, bucket: BUCKET_B, bucketUnverified: false });
  hub.on(bucketUrl(BUCKET_B), PRIVATE_401);
  await m.check();
  eq('the bucket verified private again reopens', eff(m), UNLOCKED);
  m.stop();
}

// ---------- multi-resource: an error plus a public verdict ----------
{
  const hub = fakeHub(); const clock = fakeClock();
  const { m } = monitor(hub, clock, { token: () => 'hf_test_token_value' });
  hub.on(SPACE_URL, PRIVATE_401);
  hub.on(SPACE_URL, spacePrivateAuthed([bucketVol(BUCKET_A), bucketVol(BUCKET_B)]), { auth: true });
  hub.on(bucketUrl(BUCKET_A), json(500, {}));
  hub.on(bucketUrl(BUCKET_B), json(200, { id: BUCKET_B, private: false }));
  await m.check();
  eq('bucket A errors, bucket B public → locked on B', eff(m), { locked: true, reason: REASON.PUBLIC_BUCKET, bucket: BUCKET_B, bucketUnverified: false });
  // Public Space with a private bucket, and vice versa, both lock.
  const hub2 = fakeHub(); const { m: m2 } = monitor(hub2, clock, { token: () => 'hf_test_token_value' });
  hub2.on(SPACE_URL, spacePublic());
  hub2.on(SPACE_URL, spacePrivateAuthed([bucketVol(BUCKET_A)]), { auth: true });
  hub2.on(bucketUrl(BUCKET_A), PRIVATE_401);
  await m2.check();
  eq('public Space / private bucket → locked', eff(m2).reason, REASON.PUBLIC_SPACE);
  // Known-public bucket survives a later discovery failure after a credential change.
  let token = 'hf_a';
  const hub3 = fakeHub(); const { m: m3 } = monitor(hub3, clock, { token: () => token });
  hub3.on(SPACE_URL, PRIVATE_401);
  hub3.on(SPACE_URL, spacePrivateAuthed([bucketVol(BUCKET_A)]), { auth: true });
  hub3.on(bucketUrl(BUCKET_A), json(200, { id: BUCKET_A, private: false }));
  await m3.check();
  token = 'hf_b';
  hub3.on(SPACE_URL, json(500, {}), { auth: true });
  await m3.check();
  eq('a known-public bucket is kept through a failed re-discovery', eff(m3), { locked: true, reason: REASON.PUBLIC_BUCKET, bucket: BUCKET_A, bucketUnverified: false });
  // Authenticated body that says private:false is itself a public verdict.
  const hub4 = fakeHub(); const { m: m4 } = monitor(hub4, clock, { token: () => 'hf_x' });
  hub4.on(SPACE_URL, PRIVATE_401);
  hub4.on(SPACE_URL, json(200, { id: SPACE, private: false, runtime: {} }), { auth: true });
  await m4.check();
  eq('discovery body reporting private:false locks as public-space', eff(m4).reason, REASON.PUBLIC_SPACE);
  m.stop(); m2.stop(); m3.stop(); m4.stop();
}

// ---------- too many buckets: bounded work ----------
{
  const hub = fakeHub(); const clock = fakeClock();
  const ids = Array.from({ length: 12 }, (_, i) => `owner/bucket-${i}`);
  const { m } = monitor(hub, clock, { token: () => 'hf_x', maxBuckets: 8 });
  hub.on(SPACE_URL, PRIVATE_401);
  hub.on(SPACE_URL, spacePrivateAuthed(ids.map(bucketVol)), { auth: true });
  for (const id of ids) hub.on(bucketUrl(id), PRIVATE_401);
  await m.check();
  check('a cycle verifies at most maxBuckets buckets', hub.calls.filter((c) => c.url.includes('/api/buckets/')).length === 8);
  check('unverified extra buckets keep it locked (never assumed private)', m.isLocked() && m.effective().reason === REASON.CHECKING);
  m.stop();
}

// ---------- ordering: single flight, stale results, budget ----------
{
  const hub = fakeHub(); const clock = fakeClock();
  const { m } = monitor(hub, clock);
  let release;
  hub.on(SPACE_URL, () => new Promise((r) => { release = r; }));
  const p1 = m.check();
  const p2 = m.check();
  check('a check during a cycle joins it (single flight)', p1 === p2 && hub.calls.length === 1);
  // The cycle overruns its budget and ends without a verdict.
  await clock.advance(CYCLE_BUDGET_MS + 1);
  await p1;
  eq('budget exhausted: no verdict, still checking', eff(m), LOCKED_CHECKING);
  // A newer cycle verifies private; then the OLD response finally arrives, and says public.
  hub.on(SPACE_URL, PRIVATE_401);
  await m.check();
  eq('newer cycle verified', eff(m), UNLOCKED_WARN);
  release(spacePublic());
  await flush(); await flush();
  eq('a late result from an aborted cycle is discarded (would have been a lock, still ignored)', eff(m), UNLOCKED_WARN);
  // And the reverse: a late PRIVATE from an aborted cycle cannot reopen a newer lock.
  hub.on(SPACE_URL, () => new Promise((r) => { release = r; }));
  const p3 = m.check();
  await clock.advance(CYCLE_BUDGET_MS + 1);
  await p3;
  hub.on(SPACE_URL, spacePublic());
  await m.check();
  eq('newer cycle locked public', eff(m).reason, REASON.PUBLIC_SPACE);
  release(PRIVATE_401);
  await flush(); await flush();
  eq('a late private result cannot reopen a newer public lock', eff(m).reason, REASON.PUBLIC_SPACE);
  // stop() during a cycle: the result is dropped and nothing fires later.
  hub.on(SPACE_URL, () => new Promise((r) => { release = r; }));
  const p4 = m.check();
  m.stop();
  release(PRIVATE_401);
  await p4;
  check('stop() during a cycle discards its result and leaves no timers', m.effective().reason === REASON.PUBLIC_SPACE && clock.pending() === 0);
}

// ---------- listeners and repeated cycles do not accumulate ----------
{
  const hub = fakeHub(); const clock = fakeClock();
  const { m } = monitor(hub, clock);
  const seen = [];
  const off = m.onChange((e) => seen.push(e.locked));
  hub.on(SPACE_URL, PRIVATE_401);
  for (let i = 0; i < 20; i++) {
    hub.on(SPACE_URL, i % 2 ? PRIVATE_401 : spacePublic());
    await m.check();
  }
  check('20 lock/unlock cycles: exactly 20 transitions, 20 requests, one expiry timer at most', seen.length === 20 && hub.calls.length === 20 && clock.pending() <= 1);
  off();
  check('unsubscribe removes the listener', m.stats().listeners === 1);
  m.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
