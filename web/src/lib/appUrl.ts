// The only query parameters the app itself reads. Anything else in the address
// was put there by something in front of the app (a hosting edge, a referrer)
// and may be a credential, so it is never copied into a link the app produces.
// Keep public/sw.js's copy of this list in sync.
export const APP_PARAMS = ['vvdebug', 'touchdebug'] as const;

/** `?…` with only the app's own parameters from `search`, or ''. */
export function appSearch(search: string = location.search): string {
  const from = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const key of APP_PARAMS) for (const value of from.getAll(key)) kept.append(key, value);
  const text = kept.toString();
  return text ? `?${text}` : '';
}

// Built with URL setters on this origin, never by joining strings: a pathname
// such as `//other.example/x` would otherwise read as a protocol-relative link
// to another host. The origin check is the invariant every caller relies on.
function onThisOrigin(pathname: string, search: string, hash: string): string {
  const url = new URL(location.origin);
  url.pathname = pathname;
  url.search = search;
  url.hash = hash;
  if (url.origin !== location.origin) throw new Error('refusing to build a link to another origin');
  return url.href;
}

/** Absolute link to this page: origin, path, allowlisted parameters, then `hash`. */
export function appUrl(hash = ''): string {
  return onThisOrigin(location.pathname, appSearch(), hash);
}

/** The app's root on this origin, with nothing from the current address. */
export function appRootUrl(): string {
  return onThisOrigin('/', '', '');
}

/** Drop every non-app parameter from the address bar, keeping path and hash.
 *  Returns whether the address is clean afterwards. */
export function stripForeignParams(): boolean {
  if (location.search !== appSearch()) history.replaceState(history.state, '', appUrl(location.hash));
  return location.search === appSearch();
}
