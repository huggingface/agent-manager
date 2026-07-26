// Self-visibility check. This app has no authentication, so it must only run a
// usable terminal backend when BOTH the Space and its mounted bucket(s) are
// PRIVATE — a public bucket exposes everything agents saved (including login
// tokens), which is exactly as bad as a public Space.
//
// Space check: unauthenticated GET of a *public* space returns 200 with
// `private:false`; a *private* space returns 401/404. No token required.
// Bucket check: same pattern via /api/buckets/{id}. The bucket ids are
// discovered once from the Space's own metadata (runtime.volumes), which for a
// private Space requires the HF_TOKEN the relaunch feature already uses —
// without a token we can't discover volumes and skip the bucket gate.
//
// When locked, the server blocks every working API (see index.js) and the UI
// shows the setup/warning page. Re-checked periodically so fixing visibility
// unlocks within a minute — no rebuild needed.

const SPACE_ID = process.env.SPACE_ID || null;
const hfToken = () => process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || process.env.HF_API_TOKEN || null;

// `bucketUnverified` is true when the Space is private but we couldn't check
// its mounted bucket's visibility (no HF_TOKEN → the bucket id can't be
// discovered; HF doesn't expose it to the container). We DON'T lock in that
// case — a public Space is already caught tokenless, and the bucket defaults
// private — but we surface a warning so the operator can verify or add a token.
let state = { spaceId: SPACE_ID, public: false, known: false, checkedAt: 0, reason: null, bucket: null, buckets: [], bucketUnverified: false };
let volumes = null; // bucket ids mounted on this Space; discovered once (fixed until restart)
// Failure counter for the authed volumes call. A transient network blip
// should retry; a permanently bad token (e.g. a stale HF_TOKEN carried over
// when a Space was duplicated) must NOT wedge the Space forever. After this
// many consecutive failures we give up, treat the bucket as undiscoverable,
// and unlock with a `bucketUnverified` warning instead of staying closed.
let bucketDiscoverFails = 0;
const BUCKET_DISCOVER_MAX_FAILS = 3;

const HEADERS = { 'user-agent': 'agent-manager' };
// Every HF API call is bounded: a hung request must never wedge the boot
// (server.listen used to wait on the first check) or a poll cycle.
const HF_TIMEOUT_MS = 8000;
const hfFetch = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(HF_TIMEOUT_MS) });

// Returns:
//   - an array of bucket ids (may be empty) once discovery has succeeded OR
//     has been given up on (so the Space can unlock with a warning).
//   - null only for a TRULY transient failure (first/short retry window) so
//     the caller keeps the last verdict and tries again next cycle.
async function discoverBuckets() {
  if (volumes !== null) return volumes;
  const token = hfToken();
  if (!token) { volumes = []; return volumes; } // can't inspect a private Space without a token
  try {
    const r = await hfFetch(`https://huggingface.co/api/spaces/${SPACE_ID}`, {
      headers: { ...HEADERS, authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      // 401/403 → the token is bad/expired. A network blip would have thrown.
      // Retry a couple of times in case HF is having a moment, then give up
      // so we don't wedge a confirmed-private Space forever.
      if (++bucketDiscoverFails >= BUCKET_DISCOVER_MAX_FAILS) {
        console.warn(`[visibility] authed /api/spaces returned ${r.status} ${bucketDiscoverFails}x — giving up on bucket discovery; unlocking with bucketUnverified (check the Space's HF_TOKEN secret)`);
        volumes = []; return volumes;
      }
      return null; // transient — retry next cycle
    }
    const j = await r.json();
    volumes = ((j.runtime && j.runtime.volumes) || [])
      .filter((v) => v && v.type === 'bucket' && v.source)
      .map((v) => v.source);
  } catch {
    // Thrown (DNS/timeout/network) → genuinely transient, don't burn the counter.
    return null;
  }
  return volumes;
}

async function check() {
  // No SPACE_ID → local dev or non-Space host: never lock.
  if (!SPACE_ID) {
    state = { spaceId: null, public: false, known: true, checkedAt: Date.now(), reason: null, bucket: null, buckets: [] };
    return state;
  }
  try {
    const r = await hfFetch(`https://huggingface.co/api/spaces/${SPACE_ID}`, { headers: HEADERS });
    if (r.ok) {
      const j = await r.json();
      if (j.private === false) {
        state = { spaceId: SPACE_ID, public: true, known: true, checkedAt: Date.now(), reason: 'public-space', bucket: null, buckets: state.buckets };
        return state;
      }
    }
    // Not publicly visible (401/404) → the Space is private. Now the bucket(s).
    const buckets = await discoverBuckets();
    if (buckets === null) { state = { ...state, checkedAt: Date.now() }; return state; } // keep last verdict
    // Treat the give-up path the same as having no token: the bucket is
    // unverifiable, NOT public. Unlock the Space with a warning rather than
    // wedging it closed forever (a bad/stale HF_TOKEN must never brick a
    // confirmed-private Space).
    const bucketUnverified = !hfToken() || bucketDiscoverFails >= BUCKET_DISCOVER_MAX_FAILS;
    if (bucketUnverified) {
      state = { spaceId: SPACE_ID, public: false, known: true, checkedAt: Date.now(), reason: null, bucket: null, buckets: [], bucketUnverified: true };
      return state;
    }
    for (const id of buckets) {
      try {
        const b = await hfFetch(`https://huggingface.co/api/buckets/${id}`, { headers: HEADERS });
        if (b.ok) {
          const bj = await b.json();
          if (bj.private === false) {
            state = { spaceId: SPACE_ID, public: true, known: true, checkedAt: Date.now(), reason: 'public-bucket', bucket: id, buckets };
            return state;
          }
        }
        // 401/404 → bucket is private → safe.
      } catch { state = { ...state, checkedAt: Date.now() }; return state; } // blip: keep last verdict
    }
    state = { spaceId: SPACE_ID, public: false, known: true, checkedAt: Date.now(), reason: null, bucket: null, buckets, bucketUnverified: false };
  } catch {
    // Network blip: keep the last known verdict rather than flapping.
    state = { ...state, checkedAt: Date.now() };
  }
  return state;
}

// Fail CLOSED while unknown: on a Space, stay locked until the first check
// succeeds, so a boot-time network blip can never leave a public Space serving
// shells. (Locally — no SPACE_ID — `known` is set immediately and never locks.)
export function isPublic() { return state.public || (!!SPACE_ID && !state.known); }
export function visibility() { return state; }

// Returns the first check's promise so startup can await a verdict before
// accepting connections.
export function startVisibilityWatch() {
  const first = check();
  const t = setInterval(check, 60_000);
  if (t.unref) t.unref();
  return first;
}
