// Code for the panels an operator may never open — Files, Trace, Settings and
// its subpages — is fetched the first time such a panel is shown, not at
// startup. A loader is a stable, module-level `() => import('…')`; each loader
// gets one entry here holding the module once it landed (every later mount
// reuses it without a request) or the failure, so the panel can say what
// happened and what the operator can do about it.
//
// Why not React.lazy: React caches a rejected lazy promise for good, so the only
// "retry" it can offer is a reload. Chromium caches a FAILED module fetch too —
// verified: after one aborted fetch, a second import() of the same URL fails
// without touching the network. A retry that can succeed has to ask for the
// same file under a new URL, and the browser only tells us that URL in its error
// message (Chromium and Firefox do, WebKit does not) — so "Try again" is offered
// exactly when it can work. One automatic retry covers a dropped request; after
// that the operator decides.
//
// A chunk that is gone because a newer build replaced the hashed files is a
// different situation: nothing this tab can do will load it. Rather than a
// reload loop, the page's own HTML is re-read once and, when its entry script
// changed, the panel says so and offers a reload. It never reloads on its own.

export type Loader<T> = () => Promise<T>;

export type ModuleState<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; module: T }
  /** `stale`: a newer deployment replaced this build's files (null = could not tell). */
  | { kind: 'failed'; error: unknown; stale: boolean | null; retryable: boolean };

type Entry<T> = {
  state: ModuleState<T>;
  auto: number;                 // automatic retries spent
  tries: number;                // every attempt, for a unique cache-busting URL
  url: string | null;           // the chunk the browser named in its last failure
  listeners: Set<() => void>;
};

const MAX_AUTO_RETRIES = 1;
const RETRY_DELAY_MS = 400;

// Seams the unit test replaces; the browser build never touches them.
export const lazyModuleInternals = {
  delay: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  importUrl: (url: string): Promise<unknown> => import(/* @vite-ignore */ url),
  fetchPageHtml: async (): Promise<string | null> => {
    try {
      const r = await fetch(`${location.pathname}${location.search}`, { cache: 'no-store', headers: { accept: 'text/html' } });
      return r.ok ? await r.text() : null;
    } catch { return null; }
  },
  currentEntryScript: (): string | null =>
    document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null,
  baseHref: () => location.href,
};

const entries = new Map<Loader<unknown>, Entry<unknown>>();
const LOADING: ModuleState<never> = { kind: 'loading' };

const entryFor = <T>(loader: Loader<T>): Entry<T> => {
  let e = entries.get(loader as Loader<unknown>) as Entry<T> | undefined;
  if (!e) {
    e = { state: LOADING, auto: 0, tries: 0, url: null, listeners: new Set() };
    entries.set(loader as Loader<unknown>, e as Entry<unknown>);
    void attempt(loader, e);
  }
  return e;
};

const setState = <T>(e: Entry<T>, s: ModuleState<T>) => {
  e.state = s;
  for (const l of e.listeners) l();
};

/** The chunk URL a failed dynamic import names, when the browser says (same origin only). */
export function failedModuleUrl(err: unknown, base = lazyModuleInternals.baseHref()): string | null {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const m = /(?:module|script)[^:]*:\s*(\S+)/i.exec(msg) || /(https?:\/\/\S+)/.exec(msg);
  if (!m) return null;
  try {
    const u = new URL(m[1].replace(/[.,;)]+$/, ''), base);
    return u.origin === new URL(base).origin ? u.href : null;
  } catch { return null; }
}

/** Same file, a URL the module map has not seen: `?am-retry=<n>` (kept apart from any query it has). */
export const bustUrl = (url: string, n: number) => `${url}${url.includes('?') ? '&' : '?'}am-retry=${n}`;

/** The `<script type="module" src>` a page's HTML would load, or null. */
export function entryScriptOf(html: string): string | null {
  const m = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/i.exec(html)
    || /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*\btype=["']module["']/i.exec(html);
  return m ? m[1] : null;
}

/** true = the server now hands out a different build than this page runs; null = could not tell. */
export async function deploymentChanged(): Promise<boolean | null> {
  const mine = lazyModuleInternals.currentEntryScript();
  const html = await lazyModuleInternals.fetchPageHtml();
  if (!mine || html === null) return null;
  const theirs = entryScriptOf(html);
  if (!theirs) return null;
  const base = lazyModuleInternals.baseHref();
  try { return new URL(theirs, base).href !== new URL(mine, base).href; } catch { return null; }
}

async function attempt<T>(loader: Loader<T>, e: Entry<T>): Promise<void> {
  e.tries++;
  try {
    // A retry asks for the chunk the browser named, under a fresh URL; the first
    // attempt is the plain import the bundler wrote.
    const mod = e.url ? await lazyModuleInternals.importUrl(bustUrl(e.url, e.tries)) as T : await loader();
    setState(e, { kind: 'ready', module: mod });
  } catch (err) {
    // Remember the chunk the FIRST failure named: a retry's error names the
    // busted URL, and busting that again would only pile up query strings.
    if (!e.url) e.url = failedModuleUrl(err);
    if (e.url && e.auto < MAX_AUTO_RETRIES) {
      e.auto++;
      await lazyModuleInternals.delay(RETRY_DELAY_MS);
      return attempt(loader, e);
    }
    setState(e, { kind: 'failed', error: err, stale: null, retryable: !!e.url });
    const stale = await deploymentChanged();
    // Only annotate the failure it belongs to: a manual retry may have moved on.
    if (e.state.kind === 'failed' && e.state.error === err) {
      setState(e, { ...e.state, stale, retryable: !!e.url && !stale });
    }
  }
}

/** Start loading (once) and read the current state. Idempotent, so safe during render. */
export function readModule<T>(loader: Loader<T>): ModuleState<T> {
  return entryFor(loader).state;
}

export function subscribeModule<T>(loader: Loader<T>, listener: () => void): () => void {
  const e = entryFor(loader);
  e.listeners.add(listener);
  return () => { e.listeners.delete(listener); };
}

/** Operator-driven: one more attempt for a failure that can still succeed. */
export function retryModule<T>(loader: Loader<T>): void {
  const e = entryFor(loader);
  if (e.state.kind !== 'failed' || !e.state.retryable) return;
  setState(e, LOADING);
  void attempt(loader, e);
}

/** Tests only: forget every entry. */
export function resetLazyModules(): void { entries.clear(); }
