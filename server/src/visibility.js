// Self-visibility check. This app has no authentication, so it must only run a
// usable terminal backend when the Space is PRIVATE. We detect visibility from
// the public HF API: an unauthenticated GET of a *public* space returns 200 with
// `private:false`; a *private* space returns 401/404 (we can't see it without a
// token). No token required.
//
// When public, the server locks down (see index.js) and the UI shows a setup
// widget instead. Re-checked periodically so flipping the Space to Private
// unlocks it within a minute — no rebuild needed.

const SPACE_ID = process.env.SPACE_ID || null;
let state = { spaceId: SPACE_ID, public: false, known: false, checkedAt: 0 };

async function check() {
  // No SPACE_ID → local dev or non-Space host: never lock.
  if (!SPACE_ID) {
    state = { spaceId: null, public: false, known: true, checkedAt: Date.now() };
    return state;
  }
  try {
    const r = await fetch(`https://huggingface.co/api/spaces/${SPACE_ID}`, {
      headers: { 'user-agent': 'agent-manager' },
    });
    if (r.ok) {
      const j = await r.json();
      state = { spaceId: SPACE_ID, public: j.private === false, known: true, checkedAt: Date.now() };
    } else {
      // Not publicly visible (401/404) → it's private → safe to run.
      state = { spaceId: SPACE_ID, public: false, known: true, checkedAt: Date.now() };
    }
  } catch {
    // Network blip: keep the last known verdict rather than flapping. Initial
    // state is not-public, so a private Space is never wrongly locked.
    state = { ...state, checkedAt: Date.now() };
  }
  return state;
}

export function isPublic() { return state.public; }
export function visibility() { return state; }

export function startVisibilityWatch() {
  check();
  const t = setInterval(check, 60_000);
  if (t.unref) t.unref();
}
