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

let state = { spaceId: SPACE_ID, public: false, known: false, checkedAt: 0, reason: null, bucket: null, buckets: [] };
let volumes = null; // bucket ids mounted on this Space; discovered once (fixed until restart)

const HEADERS = { 'user-agent': 'agent-manager' };

async function discoverBuckets() {
  if (volumes !== null) return volumes;
  const token = hfToken();
  if (!token) { volumes = []; return volumes; } // can't inspect a private Space without a token
  try {
    const r = await fetch(`https://huggingface.co/api/spaces/${SPACE_ID}`, {
      headers: { ...HEADERS, authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null; // transient — retry next cycle
    const j = await r.json();
    volumes = ((j.runtime && j.runtime.volumes) || [])
      .filter((v) => v && v.type === 'bucket' && v.source)
      .map((v) => v.source);
  } catch { return null; }
  return volumes;
}

async function check() {
  // No SPACE_ID → local dev or non-Space host: never lock.
  if (!SPACE_ID) {
    state = { spaceId: null, public: false, known: true, checkedAt: Date.now(), reason: null, bucket: null, buckets: [] };
    return state;
  }
  try {
    const r = await fetch(`https://huggingface.co/api/spaces/${SPACE_ID}`, { headers: HEADERS });
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
    for (const id of buckets) {
      try {
        const b = await fetch(`https://huggingface.co/api/buckets/${id}`, { headers: HEADERS });
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
    state = { spaceId: SPACE_ID, public: false, known: true, checkedAt: Date.now(), reason: null, bucket: null, buckets };
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
