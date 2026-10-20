// Is the server there? One shared answer for every pane and view.
//
// A Space restart drops every terminal socket and fails every read for as long
// as the container boots (~45s on the live Space, 2026-10-20). Each terminal
// used to decide alone, on a refusal budget that ran out in ~13s, and stayed
// paused after the server came back until the page was reloaded. Here an
// outage is noticed once, polled once — however many panes are open — and
// its end is announced to everyone who asked, spread out so a dozen retained
// panes do not reconnect in the same instant.
//
// The probe is /api/visibility: tiny, served while locked, and it carries the
// server's boot id, so the end of an outage also says whether the server
// restarted. If it did and the web build changed with it, `updateReady` turns
// true: the page now runs an old client against a new server, which only a
// reload fixes (App offers it; nothing reloads by itself and loses a draft).

export interface ServerBack { rebooted: boolean }
type Listener = (back: ServerBack) => void;

export interface ReachDeps {
  fetch: typeof fetch;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
  random: () => number;
  window: Pick<Window, 'addEventListener'> | null;
  document: (Pick<Document, 'addEventListener'> & { hidden: boolean }) | null;
  /** The hashed entry script this page runs, or null when there is none (dev). */
  loadedBuild: () => string | null;
}

/** Backoff for the shared poll while the server does not answer. */
export const pollDelay = (n: number) => Math.min(2000 * 1.5 ** Math.max(0, n - 1), 20_000);
/** How far the end of an outage is spread across listeners. */
export const SPREAD_MS = 1500;

const ENTRY = /\/assets\/index-[\w-]+\.js/;

export function createServerReach(deps: ReachDeps) {
  let knownBoot: string | null = null;
  let down = false;
  let polls = 0;
  let timer: unknown = null;
  let probing: Promise<boolean> | null = null;
  let updateReady = false;
  const listeners = new Set<Listener>();
  const updateListeners = new Set<() => void>();

  const probe = (): Promise<boolean> => {
    if (probing) return probing;
    probing = (async () => {
      try {
        const res = await deps.fetch('/api/visibility', { cache: 'no-store', credentials: 'same-origin' });
        if (res.status >= 500) return false;
        try {
          const boot = (await res.json())?.boot;
          if (typeof boot === 'string') noteBoot(boot);
        } catch { /* an edge page, not ours: still an answer */ }
        return true;
      } catch { return false; }
    })().finally(() => { probing = null; });
    return probing;
  };

  let bootChanged = false;
  function noteBoot(boot: string | null | undefined) {
    if (!boot) return;
    if (knownBoot && knownBoot !== boot) bootChanged = true;
    knownBoot = boot;
  }

  const checkBuild = async () => {
    const loaded = deps.loadedBuild();
    if (!loaded || updateReady) return;
    try {
      const res = await deps.fetch('/', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) return;
      const served = (await res.text()).match(ENTRY)?.[0];
      if (served && served !== loaded) { updateReady = true; for (const fn of updateListeners) fn(); }
    } catch { /* checked again on the next restart */ }
  };

  const recovered = () => {
    down = false; polls = 0;
    const back = { rebooted: bootChanged };
    bootChanged = false;
    if (back.rebooted) void checkBuild();
    for (const fn of [...listeners]) {
      deps.setTimeout(() => { if (listeners.has(fn)) fn(back); }, Math.floor(deps.random() * SPREAD_MS));
    }
  };

  const schedule = () => {
    if (timer !== null || !down) return;
    // A hidden tab does not poll: the return events below resume it.
    if (deps.document?.hidden) return;
    const base = pollDelay(++polls);
    timer = deps.setTimeout(tick, base * (0.8 + deps.random() * 0.4));
  };
  const tick = async () => {
    timer = null;
    if (!down) return;
    if (await probe()) recovered(); else schedule();
  };
  /** Ask now (a return event, or a caller that just failed). */
  const wake = () => {
    if (!down) return;
    if (timer !== null) { deps.clearTimeout(timer); timer = null; }
    polls = 0;
    void tick();
  };

  for (const ev of ['online', 'focus'] as const) deps.window?.addEventListener(ev, wake);
  deps.document?.addEventListener('visibilitychange', () => { if (!deps.document?.hidden) wake(); });

  return {
    /** Does the server answer? Shares one in-flight probe among all callers. */
    answers: probe,
    /** Something failed and the server did not answer: start the shared poll. */
    reportOutage() { if (down) return; down = true; polls = 0; schedule(); },
    /** Called (once per outage, spread out) when the server answers again. */
    onBack(fn: Listener): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
    onUpdateReady(fn: () => void): () => void { updateListeners.add(fn); return () => { updateListeners.delete(fn); }; },
    noteBoot,
    get down() { return down; },
    get updateReady() { return updateReady; },
  };
}

const browser = typeof window !== 'undefined';
export const serverReach = createServerReach({
  fetch: (...a) => fetch(...a),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  random: Math.random,
  window: browser ? window : null,
  document: browser ? document : null,
  loadedBuild: () => {
    if (!browser) return null;
    const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.getAttribute('src') || '';
    return src.match(ENTRY)?.[0] ?? null;
  },
});
