// Second line of defence against clickjacking, behind the server's CSP
// `frame-ancestors` (server/src/framing.js). If something strips that header,
// or a browser ignores it, the app still refuses to render its interface inside
// a page it doesn't trust, and offers to open itself in its own tab instead.
//
// Who is trusted: the app's own origin, the Hub page that embeds a Space, and
// whatever extra origins the server allows (`frameAncestors` in /api/info).
// Every ancestor must be trusted, not just the parent: a trusted page framing
// an untrusted one framing the app is still an untrusted embed.

export const HUB_ORIGIN = 'https://huggingface.co';

type FrameWindow = Pick<Window, 'self' | 'top' | 'parent' | 'location' | 'origin'>;

export type FrameEnv = { win: FrameWindow };

export const isFramed = (win: FrameWindow): boolean => {
  try { return win.top !== win.self; } catch { return true; }
};

// The ancestors' origins, nearest first. null = at least one can't be verified.
export function ancestorOrigins({ win }: FrameEnv): string[] | null {
  if (!isFramed(win)) return [];
  // Chromium, WebKit and current Firefox list every ancestor's origin ("null"
  // for opaque ones), as the browser itself knows them.
  const listed = (win.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (listed && typeof listed.length === 'number') return Array.from({ length: listed.length }, (_, i) => listed.item(i) || 'null');
  // Elsewhere only same-origin ancestors can be read. A cross-origin one can't
  // be identified by anything the page sees (document.referrer names whoever
  // navigated the frame, not its parent), so the ancestry is unverified and the
  // caller fails closed. That includes the Hub's embed in such browsers: it
  // shows the "Open Agent Manager" button, which still works.
  try { return readableAncestors(win); } catch { return null; }
}

function readableAncestors(win: FrameWindow): string[] | null {
  const out: string[] = [];
  let w: FrameWindow = win;
  for (let depth = 0; depth < 32 && w !== w.top; depth++) {
    const parent = w.parent as FrameWindow;
    const origin = parent.location.origin; // throws for a cross-origin ancestor
    if (typeof origin !== 'string') return null;
    out.push(origin);
    w = parent;
  }
  return w === w.top ? out : null;
}

// Origins trusted to frame the app before /api/info answers: itself, plus the
// Hub when it is served as a Space.
export function defaultTrusted(win: FrameWindow): string[] {
  const trusted = [win.location.origin];
  if (/\.hf\.space$/i.test(win.location.hostname)) trusted.push(HUB_ORIGIN);
  return trusted;
}

export type FrameVerdict = 'top' | 'trusted' | 'untrusted';

export function frameVerdict(env: FrameEnv, trusted: readonly string[]): FrameVerdict {
  if (!isFramed(env.win)) return 'top';
  // A sandboxed frame without allow-same-origin runs at an opaque origin. That
  // is never how the app is embedded on purpose (the Hub's Space page allows
  // same-origin), but it is how Hub-hosted user content frames other Spaces.
  if (env.win.origin === 'null') return 'untrusted';
  const ancestors = ancestorOrigins(env);
  if (!ancestors) return 'untrusted';
  const allowed = new Set(trusted);
  return ancestors.every((origin) => allowed.has(origin)) ? 'trusted' : 'untrusted';
}
