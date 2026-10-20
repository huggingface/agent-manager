// Agent Manager service worker: display agent-initiated push notifications and
// deep-link into the app when one is tapped. No caching — the app stays live.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Agent Manager', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    data: { url: d.url || '/' },
  }));
});

// Same list as web/src/lib/appUrl.ts: the only query parameters the app reads.
const APP_PARAMS = ['vvdebug', 'touchdebug'];

// A notification may only open a page of this app, with the app's own query
// parameters. Anything else (another origin, edge parameters) opens the root.
// Built with URL setters on this origin and returned absolute, so no pathname
// (`//other.example/x`, backslashes) can be read as a link to another host.
function appTarget(raw) {
  const origin = self.location.origin;
  const root = new URL('/', origin).href;
  try {
    const from = new URL(raw || '/', origin);
    if (from.origin !== origin) return root;
    const kept = new URLSearchParams();
    for (const key of APP_PARAMS) for (const value of from.searchParams.getAll(key)) kept.append(key, value);
    const url = new URL(origin);
    url.pathname = from.pathname;
    url.search = kept.toString();
    url.hash = from.hash;
    return url.origin === origin ? url.href : root;
  } catch { return root; }
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = appTarget(e.notification.data && e.notification.data.url);
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) {
      if ('focus' in c) {
        if (c.navigate) c.navigate(url);
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
