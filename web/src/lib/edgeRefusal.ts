// "This Space was just made private", as an open locked tab sees it.
//
// A tab loaded while its Space was public carries no Hugging Face sign-in
// cookie. Switching the Space to private does not restart it: the server
// unlocks itself on its next check, but from then on HF's edge answers every
// unsigned request from that tab with its own page (404 text/html), not AM's
// JSON, and the locked page's poll never hears the unlock. Only a reload
// through huggingface.co/spaces/<id> signs the tab in again.
//
// So an answer to the status poll that is clearly not AM's and looks like the
// edge refusing an unsigned request (a non-JSON 401/403/404, or an HTML page)
// is read as "now private". A 5xx (the Space restarting, a 503 from AM itself)
// and a dropped connection are outages, never this; AM's own JSON answers,
// including its locked 403, keep their meaning. App only acts on two in a row.

export const EDGE_REFUSED = 'edge-refused';
/** Consecutive edge refusals before the locked page says "now private". */
export const EDGE_STREAK = 2;

type ResponseLike = { status: number; headers: { get(name: string): string | null } };

export function isEdgeRefusal(r: ResponseLike): boolean {
  if (r.status >= 500) return false;
  const type = (r.headers.get('content-type') || '').toLowerCase();
  if (type.includes('json')) return false;
  if (r.status === 401 || r.status === 403 || r.status === 404) return true;
  return type.includes('text/html');
}

/** Which way the Reload button went; also left on <html data-am-reload> for tests. */
export type ReloadPath = 'top' | 'hub' | 'self';
type WindowLike = {
  top: { location: { reload(): void; replace(url: string): void } } | null;
  location: { reload(): void };
  document?: { documentElement?: { dataset: Record<string, string | undefined> } };
};
const SPACE_ID = /^[\w.-]+\/[\w.-]+$/;

// Called from the button's click, so the navigation carries a user gesture.
// The top window's reload is the one that re-signs (a top-level hf.space tab,
// or the Hub page when it is same-origin); embedded in the Hub's Space page it
// throws cross-origin, and the Hub page is opened again instead (replace() is
// one of the two Location members a cross-origin frame may use). Reloading
// only this frame is the last resort, hence the ⌘R / Ctrl+R hint beside it.
export function reloadThroughHub(win: WindowLike, spaceId?: string | null): ReloadPath {
  const mark = (path: ReloadPath) => { const el = win.document?.documentElement; if (el) el.dataset.amReload = path; };
  try { mark('top'); win.top!.location.reload(); return 'top'; } catch { /* cross-origin top */ }
  if (spaceId && SPACE_ID.test(spaceId)) {
    try { mark('hub'); win.top!.location.replace(`https://huggingface.co/spaces/${spaceId}`); return 'hub'; } catch { /* top navigation blocked */ }
  }
  mark('self');
  win.location.reload();
  return 'self';
}
