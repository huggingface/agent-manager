// Privacy safety lock — the one place that decides whether this deployment may
// serve its privileged API. The app has no authentication of its own, so it is
// only safe to run while BOTH the Space and every bucket mounted on it are
// PRIVATE. A public bucket exposes everything the agents saved (login tokens
// included), which is exactly as bad as a public Space.
//
// This module owns a small explicit model — evidence per resource, an effective
// lock state derived from it, and a bounded check lifecycle — and publishes the
// result to three consumers that must never disagree: HTTP admission, live
// client connections (WebSockets, long polls) and the public-safe status
// responses. docs/privacy-lock.md is the operator-facing description; keep the
// two in step.
//
// EVIDENCE (verified against the Hub on 2026-09-09, see docs/privacy-lock.md):
//   Space, unauthenticated GET /api/spaces/{id}
//     200 + JSON object with boolean `private` and the expected `id`
//                                → verdict: `private` ? private : PUBLIC
//     401/404 + JSON object      → private (the Hub answers "Invalid username or
//                                  password." for a repo the caller may not see)
//     anything else              → no verdict (3xx, 403, 429, 5xx, non-JSON,
//                                  missing/wrong-type fields, timeout, network)
//   Bucket discovery, authenticated GET /api/spaces/{id}
//     200 + JSON object with the expected `id` and a `runtime` object
//                                → ok; buckets = runtime.volumes[] entries of
//                                  type 'bucket' with a string `source`. A Space
//                                  with no storage has NO `volumes` key at all,
//                                  which is the legitimately-empty case; a
//                                  present `volumes` that is not an array, or a
//                                  bucket entry without a string source, is
//                                  invalid metadata and no verdict.
//                                  `private === false` in that body is also a
//                                  PUBLIC-space verdict (public wins).
//     401/403/404 + JSON object  → unauthorized: the credential cannot read this
//                                  Space. After UNAUTHORIZED_CONFIRMATIONS in a
//                                  row this becomes the documented warning-only
//                                  mode (bucketUnverified); no token at all is
//                                  that mode immediately.
//     anything else              → no verdict; retried next cycle, never cached
//                                  as an empty mount list.
//   Each bucket, unauthenticated GET /api/buckets/{id}: same rules as the Space.
//
// A valid response about one resource refreshes only that resource's
// verification age. A public verdict is accepted the moment it arrives and is
// sticky: only a later valid private response for the SAME resource clears it.
//
// GRACE. Once every required resource has a fresh private verdict the app is
// unlocked. Each verdict ages from its own verifiedAt; when the oldest required
// one passes GRACE_MS the app locks with reason `verification-unavailable`
// (an outage, not a claim that anything is public). The expiry is a timer, so it
// fires even while a check is hung. Nothing is persisted across restarts: a
// fresh process starts locked (`checking`) until its own first verification.

export const CHECK_MS = 60_000;          // one verification cycle per minute
export const GRACE_MS = 150_000;         // 2.5 cycles: two consecutive failed checks are tolerated, the third is not
export const HF_TIMEOUT_MS = 8_000;      // per request
export const CYCLE_BUDGET_MS = 25_000;   // whole cycle, all resources
export const MAX_BUCKETS = 8;            // buckets verified per cycle; more than this is a misconfiguration
export const UNAUTHORIZED_CONFIRMATIONS = 3;

export const REASON = Object.freeze({
  PUBLIC_SPACE: 'public-space',
  PUBLIC_BUCKET: 'public-bucket',
  CHECKING: 'checking',
  UNAVAILABLE: 'verification-unavailable',
});

const HF_ENDPOINT = (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
const HEADERS = { 'user-agent': 'agent-manager' };

const sameId = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const parseJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

// ---------- response classification (pure; the evidence matrix above) ----------

/** Unauthenticated repo read → { verdict: 'public' | 'private' | null, error }. */
export function classifyRepoResponse({ status, text }, expectedId) {
  if (status === 200) {
    const body = parseJson(text);
    if (!isObject(body)) return { verdict: null, error: 'malformed-body' };
    if (typeof body.private !== 'boolean') return { verdict: null, error: 'missing-private-field' };
    if (body.id !== undefined && !sameId(body.id, expectedId)) return { verdict: null, error: 'id-mismatch' };
    return { verdict: body.private ? 'private' : 'public', error: null };
  }
  if (status === 401 || status === 404) {
    return isObject(parseJson(text)) ? { verdict: 'private', error: null } : { verdict: null, error: `http-${status}-malformed` };
  }
  return { verdict: null, error: `http-${status}` };
}

/** Authenticated Space read → { verdict: 'ok' | 'unauthorized' | null, buckets, spacePublic, error }. */
export function classifyDiscoveryResponse({ status, text }, expectedId) {
  if (status === 200) {
    const body = parseJson(text);
    if (!isObject(body)) return { verdict: null, error: 'malformed-body' };
    if (!sameId(body.id, expectedId)) return { verdict: null, error: 'id-mismatch' };
    if (!isObject(body.runtime)) return { verdict: null, error: 'missing-runtime' };
    const volumes = body.runtime.volumes;
    if (volumes !== undefined && !Array.isArray(volumes)) return { verdict: null, error: 'malformed-volumes' };
    const buckets = [];
    for (const v of volumes || []) {
      if (!isObject(v)) return { verdict: null, error: 'malformed-volume' };
      if (v.type !== 'bucket') continue;
      if (typeof v.source !== 'string' || !v.source) return { verdict: null, error: 'malformed-volume' };
      buckets.push(v.source);
    }
    return { verdict: 'ok', buckets: [...new Set(buckets)], spacePublic: body.private === false, error: null };
  }
  if (status === 401 || status === 403 || status === 404) {
    return isObject(parseJson(text)) ? { verdict: 'unauthorized', error: `http-${status}` } : { verdict: null, error: `http-${status}-malformed` };
  }
  return { verdict: null, error: `http-${status}` };
}

// ---------- the monitor ----------

const blankEvidence = () => ({ verdict: 'unknown', verifiedAt: 0, attemptedAt: 0, error: null });

/**
 * Everything is injectable so the lifecycle can be tested with a fake clock and
 * synthetic Hub responses. Production uses the module-level singleton below.
 */
export function createVisibilityMonitor({
  spaceId = null,
  token = () => null,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  endpoint = HF_ENDPOINT,
  checkMs = CHECK_MS,
  graceMs = GRACE_MS,
  timeoutMs = HF_TIMEOUT_MS,
  cycleBudgetMs = CYCLE_BUDGET_MS,
  maxBuckets = MAX_BUCKETS,
  log = console,
} = {}) {
  const space = blankEvidence();
  // verdict: unknown | ok | unauthorized. `buckets` is the accepted mount list
  // (null until a discovery succeeded). tokenKey remembers which credential the
  // evidence belongs to, so a changed token invalidates it.
  const discovery = { ...blankEvidence(), buckets: null, tokenKey: null, unauthorizedStreak: 0 };
  const buckets = new Map(); // id -> evidence

  let generation = 0;        // bumped per cycle and on stop(); results from older generations are dropped
  let inflight = null;       // the running cycle's promise (single flight)
  let inflightAbort = null;
  let interval = null;
  let expiryTimer = null;
  let stopped = false;
  let checks = 0;            // completed cycles (bounded-work evidence for tests)
  let requests = 0;          // upstream requests issued
  const listeners = new Set();
  let last = null;           // last published { locked, reason, bucket }

  const tokenKey = () => {
    const t = token();
    if (!t) return '';
    // Never keep or log the credential itself; a cheap fingerprint is enough to
    // notice that it changed.
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return `${t.length}:${h.toString(16)}`;
  };

  // ----- effective state -----

  const fresh = (ev, t) => ev.verdict === 'private' && ev.verifiedAt > 0 && t - ev.verifiedAt < graceMs;
  const staleReason = (ev) => (ev.verifiedAt > 0 ? REASON.UNAVAILABLE : REASON.CHECKING);

  function effective(t = now()) {
    if (!spaceId) return { locked: false, reason: null, bucket: null, bucketUnverified: false, local: true };
    if (space.verdict === 'public') return { locked: true, reason: REASON.PUBLIC_SPACE, bucket: null, bucketUnverified: false };
    for (const [id, ev] of buckets) {
      if (ev.verdict === 'public') return { locked: true, reason: REASON.PUBLIC_BUCKET, bucket: id, bucketUnverified: false };
    }
    if (!fresh(space, t)) return { locked: true, reason: staleReason(space), bucket: null, bucketUnverified: false };
    if (discovery.verdict === 'unauthorized') return { locked: false, reason: null, bucket: null, bucketUnverified: true };
    if (discovery.verdict !== 'ok') return { locked: true, reason: staleReason(discovery), bucket: null, bucketUnverified: false };
    for (const id of discovery.buckets) {
      const ev = buckets.get(id);
      if (!ev || !fresh(ev, t)) return { locked: true, reason: ev ? staleReason(ev) : REASON.CHECKING, bucket: null, bucketUnverified: false };
    }
    return { locked: false, reason: null, bucket: null, bucketUnverified: false };
  }

  // When the current unlocked state will expire on its own if nothing renews it.
  function expiresAt() {
    let t = space.verifiedAt;
    if (discovery.verdict === 'ok') for (const id of discovery.buckets) t = Math.min(t, buckets.get(id)?.verifiedAt || 0);
    return t + graceMs;
  }

  function publish() {
    const eff = effective();
    if (expiryTimer) { clearTimer(expiryTimer); expiryTimer = null; }
    if (!eff.locked && spaceId && !stopped) {
      const delay = Math.max(0, expiresAt() - now());
      expiryTimer = setTimer(() => { expiryTimer = null; publish(); }, delay);
      if (expiryTimer && expiryTimer.unref) expiryTimer.unref();
    }
    const changed = !last || last.locked !== eff.locked || last.reason !== eff.reason || last.bucket !== eff.bucket;
    last = { locked: eff.locked, reason: eff.reason, bucket: eff.bucket };
    if (!changed) return eff;
    if (spaceId) log.warn(`[visibility] ${eff.locked ? `LOCKED (${eff.reason}${eff.bucket ? `: ${eff.bucket}` : ''})` : `unlocked${eff.bucketUnverified ? ' (bucket unverified)' : ''}`}`);
    for (const fn of [...listeners]) { try { fn(eff); } catch (e) { log.error('[visibility] listener failed', e && e.message); } }
    return eff;
  }

  // ----- upstream -----

  async function probe(url, headers, signal) {
    requests++;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = setTimer(() => ac.abort(), timeoutMs);
    // Race the abort explicitly as well as passing the signal: the cycle must
    // end on its budget even if a fetch implementation ignores the signal.
    const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    const aborted = new Promise((_, reject) => {
      if (ac.signal.aborted) reject(abortError());
      else ac.signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    aborted.catch(() => {});
    try {
      const r = await Promise.race([fetchImpl(url, { headers: { ...HEADERS, ...headers }, redirect: 'manual', signal: ac.signal }), aborted]);
      const text = await Promise.race([r.text(), aborted]);
      return { status: r.status, text };
    } catch (e) {
      return { status: 0, text: '', error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimer(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  // Accept a repo verdict for one resource. Public is accepted at once and
  // sticks; private refreshes that resource's age; no verdict only stamps the
  // attempt.
  function acceptRepo(ev, res, expectedId) {
    const t = now();
    ev.attemptedAt = t;
    if (res.error) { ev.error = res.error; return ev; }
    const c = classifyRepoResponse(res, expectedId);
    ev.error = c.error;
    if (c.verdict) { ev.verdict = c.verdict; ev.verifiedAt = t; }
    return ev;
  }

  function acceptDiscovery(res) {
    const t = now();
    discovery.attemptedAt = t;
    if (res.error) { discovery.error = res.error; return; }
    const c = classifyDiscoveryResponse(res, spaceId);
    discovery.error = c.error;
    if (c.verdict === 'ok') {
      discovery.verdict = 'ok';
      discovery.verifiedAt = t;
      discovery.unauthorizedStreak = 0;
      // The mount list is deployment-scoped (mounting a bucket restarts the
      // Space). A resource that is no longer mounted drops out of the model —
      // loudly if it was known to be public.
      for (const id of [...buckets.keys()]) {
        if (!c.buckets.includes(id)) {
          if (buckets.get(id).verdict === 'public') log.warn(`[visibility] bucket ${id} was public and is no longer mounted; dropping it from the model`);
          buckets.delete(id);
        }
      }
      discovery.buckets = c.buckets;
      if (c.spacePublic) { space.verdict = 'public'; space.verifiedAt = t; space.attemptedAt = t; space.error = null; }
    } else if (c.verdict === 'unauthorized') {
      if (++discovery.unauthorizedStreak >= UNAUTHORIZED_CONFIRMATIONS) {
        if (discovery.verdict !== 'unauthorized') log.warn(`[visibility] the HF token cannot read this Space's metadata (${c.error}, ${discovery.unauthorizedStreak}x) — bucket visibility cannot be verified; unlocking with a warning once the Space itself verifies private`);
        discovery.verdict = 'unauthorized';
        discovery.verifiedAt = t;
      }
    }
    // No verdict: nothing cached. Known buckets (public ones included) are kept.
  }

  function syncCredential() {
    const key = tokenKey();
    if (discovery.tokenKey !== key) {
      // Configuration identity changed (or first look): discovery evidence and
      // any half-counted unauthorized streak belong to another credential.
      // Public bucket verdicts are kept — they are facts about the buckets, not
      // about the token.
      discovery.verdict = 'unknown'; discovery.verifiedAt = 0; discovery.buckets = null; discovery.unauthorizedStreak = 0; discovery.error = null;
      discovery.tokenKey = key;
    }
    if (!key && discovery.verdict !== 'unauthorized') {
      discovery.verdict = 'unauthorized'; discovery.verifiedAt = now(); discovery.attemptedAt = discovery.verifiedAt;
      discovery.error = 'no-token'; discovery.buckets = null;
    }
    return key;
  }

  // A public verdict is published the moment it is accepted; private verdicts
  // are published together at the end of the cycle, so a Space that went from
  // public back to private does not flash an intermediate "unavailable" lock
  // while its buckets are still being re-verified.
  const publishIfPublic = () => {
    const r = effective().reason;
    if (r === REASON.PUBLIC_SPACE || r === REASON.PUBLIC_BUCKET) publish();
  };

  async function cycle(gen, signal) {
    const live = () => gen === generation && !signal.aborted;
    // 1. The Space itself.
    const r = await probe(`${endpoint}/api/spaces/${spaceId}`, {}, signal);
    if (!live()) return;
    acceptRepo(space, r, spaceId);
    publishIfPublic();
    if (space.verdict === 'public') return; // public wins; no need to spend the budget on buckets

    // 2. Bucket discovery — once per credential, retried only while it has no verdict.
    const key = syncCredential();
    if (key && discovery.verdict === 'unknown') {
      const d = await probe(`${endpoint}/api/spaces/${spaceId}`, { authorization: `Bearer ${token()}` }, signal);
      if (!live()) return;
      acceptDiscovery(d);
      publishIfPublic();
      if (space.verdict === 'public') return;
    }
    if (discovery.verdict !== 'ok') return;

    // 3. Each mounted bucket, bounded.
    const ids = discovery.buckets.slice(0, maxBuckets);
    if (discovery.buckets.length > maxBuckets) log.warn(`[visibility] ${discovery.buckets.length} buckets mounted; only the first ${maxBuckets} are verified`);
    for (const id of ids) {
      if (!live()) return;
      const b = await probe(`${endpoint}/api/buckets/${id}`, {}, signal);
      if (!live()) return;
      if (!buckets.has(id)) buckets.set(id, blankEvidence());
      acceptRepo(buckets.get(id), b, id);
      publishIfPublic();
      if (buckets.get(id).verdict === 'public') return; // locked; the rest can wait for the next cycle
    }
  }

  /** Run one verification cycle (single-flight: a call during a cycle joins it). */
  function check() {
    if (!spaceId) { publish(); return Promise.resolve(effective()); }
    if (inflight) return inflight;
    if (stopped) return Promise.resolve(effective());
    const gen = ++generation;
    const ac = new AbortController();
    inflightAbort = ac;
    const budget = setTimer(() => ac.abort(), cycleBudgetMs);
    inflight = cycle(gen, ac.signal)
      .catch((e) => log.error('[visibility] check failed', e && e.message))
      .then(() => {
        clearTimer(budget);
        if (gen === generation) { inflight = null; inflightAbort = null; }
        checks++;
        return publish();
      });
    return inflight;
  }

  function start() {
    stopped = false;
    const first = check();
    if (spaceId && !interval) {
      interval = setInterval(() => { check(); }, checkMs);
      if (interval.unref) interval.unref();
    }
    return first;
  }

  function stop() {
    stopped = true;
    generation++; // anything still in flight is stale now
    if (inflightAbort) { try { inflightAbort.abort(); } catch {} }
    inflight = null; inflightAbort = null;
    if (interval) { clearInterval(interval); interval = null; }
    if (expiryTimer) { clearTimer(expiryTimer); expiryTimer = null; }
    listeners.clear();
  }

  const view = (ev) => ({ verdict: ev.verdict, verifiedAt: ev.verifiedAt || null, attemptedAt: ev.attemptedAt || null, error: ev.error });

  /** Public-safe status: enough to explain the state, nothing more. */
  function publicStatus() {
    const eff = effective();
    const attempted = Math.max(space.attemptedAt, discovery.attemptedAt, ...[...buckets.values()].map((b) => b.attemptedAt));
    return {
      spaceId,
      locked: eff.locked,
      reason: eff.reason,
      bucket: eff.bucket,
      bucketUnverified: !eff.locked && eff.bucketUnverified,
      attemptedAt: attempted || null,
      verifiedAt: !eff.locked && spaceId ? expiresAt() - graceMs : null,
      space: view(space),
      bucketDiscovery: { verdict: discovery.verdict, verifiedAt: discovery.verifiedAt || null, attemptedAt: discovery.attemptedAt || null, error: discovery.error },
      // Bucket ids are the operator's business: while locked only the one the
      // lock is about is named.
      buckets: [...buckets].filter(([id]) => !eff.locked || id === eff.bucket).map(([id, ev]) => ({ id, ...view(ev) })),
      checkMs,
      graceMs,
    };
  }

  return {
    start, stop, check, effective, publicStatus,
    isLocked: () => effective().locked,
    /** Ids of the buckets a successful discovery listed (empty until then). */
    mountedBuckets: () => (discovery.verdict === 'ok' ? [...discovery.buckets] : []),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    // Test/diagnostic counters: how much upstream work a scenario cost.
    stats: () => ({ checks, requests, listeners: listeners.size, generation, inflight: !!inflight, expiryArmed: !!expiryTimer }),
  };
}

// ---------- the production singleton ----------

const num = (v, fallback) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback; };
const monitor = createVisibilityMonitor({
  spaceId: process.env.SPACE_ID || null,
  token: () => process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || process.env.HF_API_TOKEN || null,
  // Test fixtures shorten the cycle; production leaves these unset (docs/privacy-lock.md).
  checkMs: num(process.env.AM_VISIBILITY_CHECK_MS, CHECK_MS),
  graceMs: num(process.env.AM_VISIBILITY_GRACE_MS, GRACE_MS),
});

export const visibilityMonitor = monitor;
/** True while the privileged API must not be served. Fails closed on a Space until verified. */
export const isLocked = () => monitor.isLocked();
/** { locked, reason, bucket, bucketUnverified } — the one effective state. */
export const lockState = () => monitor.effective();
export const visibility = () => monitor.publicStatus();
/** The mounted bucket ids, once discovery has succeeded (backup.js needs the source bucket). */
export const mountedBuckets = () => monitor.mountedBuckets();
export const onVisibilityChange = (fn) => monitor.onChange(fn);
/** Returns the first cycle's promise so startup can wait (bounded) for a verdict. */
export const startVisibilityWatch = () => monitor.start();
/** The machine-readable body every locked refusal carries. */
export const lockError = (eff = monitor.effective()) => ({ error: 'locked', reason: eff.reason, ...(eff.bucket ? { bucket: eff.bucket } : {}) });
