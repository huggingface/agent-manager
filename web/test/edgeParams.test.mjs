// A hosting edge may put a sign-in parameter in the address the app is loaded
// at. The app must drop it from the address on boot and never carry it (or any
// other non-app parameter) into a link it builds, a clipboard write, a new tab,
// a request, or a notification click target. Every sink is also exercised with
// the foreign parameters put BACK into the address, so each one is proven clean
// on its own rather than only because boot cleaned up first.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'SECRET';
const DIRTY = `?__sign=${SECRET}&other=${SECRET}2&vvdebug=1`;
const leaks = (value) => typeof value === 'string' && (value.includes(SECRET) || value.includes('__sign') || value.includes('other='));

// 1. Boot order: boot.ts must be main.tsx's first import, so it runs before any
//    other module reads `location` at load time.
const main = fs.readFileSync(path.join(web, 'src/main.tsx'), 'utf8');
assert.match(main.split('\n').find((line) => line.startsWith('import ')), /^import '\.\/boot';/, 'boot.ts is the first import of main.tsx');

// 2. No source builds a URL by joining pieces of the address. No exemptions.
const offenders = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/location\.href|document\.URL|document\.baseURI|location\.(search|pathname)\s*\+|\+\s*location\.(search|pathname)|\$\{location\.(search|pathname)\}/.test(line)) {
          offenders.push(`${path.relative(web, file)}:${i + 1}`);
        }
      });
    }
  }
};
walk(path.join(web, 'src'));
assert.deepEqual(offenders, [], 'links are built with URL setters on this origin, never from the raw address');
console.log('edge-params: source checks passed');

// 3. Service worker: notification clicks open only this app, with app
//    parameters, absolute on this origin — in both the open-a-window branch
//    and the navigate-an-existing-client branch.
{
  const ORIGIN = 'https://space.example';
  const handlers = {};
  const targets = [];
  let clients = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    clients: {
      matchAll: async () => clients,
      openWindow: async (url) => { targets.push(['open', url]); },
      claim: async () => {},
    },
    registration: { showNotification: async () => {} },
    skipWaiting: () => {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(web, 'public/sw.js'), 'utf8'), { self, URL, URLSearchParams });
  const click = async (url) => {
    let done;
    handlers.notificationclick({ notification: { data: { url }, close: () => {} }, waitUntil: (p) => { done = p; } });
    await done;
    return targets.at(-1);
  };
  const cases = [
    [`/${DIRTY}#x`, `${ORIGIN}/?vvdebug=1#x`],
    [`${ORIGIN}/a${DIRTY}`, `${ORIGIN}/a?vvdebug=1`],
    [`${ORIGIN}//evil.example/x${DIRTY}`, `${ORIGIN}//evil.example/x?vvdebug=1`],
    ['//evil.example/x?__sign=SECRET', `${ORIGIN}/`],
    ['/\\evil.example/x?__sign=SECRET', `${ORIGIN}/`],
    ['https://elsewhere.example/?__sign=SECRET', `${ORIGIN}/`],
    [undefined, `${ORIGIN}/`],
  ];
  for (const [raw, want] of cases) assert.deepEqual(await click(raw), ['open', want], `openWindow target for ${raw}`);
  // An app window is already open: it is navigated and focused instead.
  clients = [{ focus: async () => {}, navigate: async (url) => { targets.push(['navigate', url]); } }];
  for (const [raw, want] of cases) assert.deepEqual(await click(raw), ['navigate', want], `navigate target for ${raw}`);
  for (const [, url] of targets) {
    assert.ok(!leaks(url), 'no notification target carries edge parameters');
    assert.equal(new URL(url).origin, ORIGIN, 'notification target stays on this origin');
  }
  console.log('edge-params: service worker passed');
}

// 4. Browser: the real modules, loaded at a dirty address, top-level and framed.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-params-'));
const bundle = path.join(tmp, 'fixture.js');
await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import './src/boot';
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import FileLinkContent, { FileLinkScope, FilePreviewContext, linkFileContent } from './src/components/FileLinkContent';
    import FileLinkPage from './src/components/FileLinkPage';
    import { PushRow } from './src/components/SettingsView';
    import * as links from './src/lib/fileLinks';
    import * as appUrl from './src/lib/appUrl';
    import { lazyModuleInternals, pageUrl } from './src/lib/lazyModule';
    window.t = { ...links, ...appUrl, linkFileContent, pageUrl, fetchPageHtml: lazyModuleInternals.fetchPageHtml, baseHref: lazyModuleInternals.baseHref };
    const request = links.requestFromHash(location.hash);
    const root = createRoot(document.getElementById('root'));
    // Re-render in place (same keys): hrefs are recomputed from the address as it is now.
    window.rerender = () => root.render(request ? <FileLinkPage request={request}/> : <main>
      <FilePreviewContext.Provider value={() => {}}>
        <FileLinkScope session="team"><FileLinkContent html={'<p><a href="./readme.md">Readme</a></p>'}/></FileLinkScope>
      </FilePreviewContext.Provider>
      <PushRow/>
    </main>);
    window.rerender();
  ` }, bundle: true, outfile: bundle, format: 'iife', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
});
const server = http.createServer((req, res) => {
  // Keep `//host/x` paths as paths: parse against a fixed base by hand.
  const [pathname] = req.url.split('?');
  if (pathname === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); return res.end(fs.readFileSync(bundle)); }
  if (pathname === '/host') {
    const src = new URL(req.url, 'http://fixture').searchParams.get('src') || '/';
    res.setHeader('content-type', 'text/html');
    return res.end(`<!doctype html><iframe id="app" src="${src}${DIRTY}" style="width:900px;height:600px"></iframe>`);
  }
  if (pathname.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json');
    if (pathname.endsWith('/resolve')) return res.end(JSON.stringify({ root: 'workspace', path: 'team/readme.md', absolute: '/data/workspaces/team/readme.md' }));
    if (pathname.endsWith('/preview')) return res.end(JSON.stringify({ kind: 'markdown', text: '# Readme preview', path: 'team/readme.md', name: 'readme.md', size: 16, mtime: 1 }));
    res.statusCode = 404; return res.end('{}');
  }
  if (pathname === '/favicon.ico') { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><div id="root"></div><script src="/fixture.js"></script>');
});
server.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(chromiumLaunchOptions());
const context = await browser.newContext({ viewport: { width: 1000, height: 760 } });
context.setDefaultTimeout(10_000);
// Record every clipboard write and window.open target in every frame.
await context.addInitScript(() => {
  window.__writes = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (v) => { window.__writes.push(String(v)); } } });
  const open = window.open.bind(window);
  window.open = (url, ...rest) => { window.__writes.push(String(url)); return open(url, ...rest); };
});
const errors = [];
const warnings = [];
const navigations = [];
const watch = (page) => {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => { if (msg.type() === 'warning' || msg.type() === 'error') warnings.push(msg.text()); });
  page.on('framenavigated', (frame) => navigations.push(frame.url()));
};
context.on('page', watch);
const requests = [];
context.on('request', (request) => requests.push(request));
const popup = async (action) => {
  const pending = context.waitForEvent('page');
  await action();
  const tab = await pending; await tab.waitForLoadState('domcontentloaded');
  return tab;
};
// Put the foreign parameters back into the address, keeping path and hash.
const redirty = async (frame) => {
  await frame.evaluate((dirty) => {
    const url = new URL(location.origin);
    url.pathname = location.pathname; url.search = dirty; url.hash = location.hash;
    history.replaceState(history.state, '', url.href);
  }, DIRTY);
  assert.ok(leaks(await frame.evaluate(() => location.search)), 'address is dirty again before the sink runs');
};
const clean = (value, label) => {
  assert.ok(!leaks(value), `${label} is clean: ${value}`);
  assert.equal(new URL(value, origin).origin, origin, `${label} stays on this origin`);
};
// Every attribute in the frame's DOM that could be a link.
const attrs = (frame) => frame.evaluate(() => [...document.querySelectorAll('*')].flatMap((el) =>
  [...el.attributes].filter((a) => /^(href|src|action|data-.*)$/.test(a.name)).map((a) => a.value)));
const frameOf = (host) => host.frames().find((f) => f !== host.mainFrame());
const booted = async (frame) => { await frame.waitForFunction(() => !!window.t); return frame; };
const outbound = [];
try {
  // 4a. Framed, as the Hub page embeds the Space, at a non-root path.
  const host = await context.newPage();
  await host.goto(`${origin}/host?src=/sub/page`);
  let frame = await booted(frameOf(host));
  assert.equal(new URL(frame.url()).pathname, '/sub/page');
  assert.equal(new URL(frame.url()).search, '?vvdebug=1', 'boot keeps only app parameters');
  assert.equal(frame.url().endsWith('/sub/page?vvdebug=1'), true);

  // Each sink, with the foreign parameters present in the address.
  await redirty(frame);
  const values = await frame.evaluate(() => ({
    fileLinkUrl: t.fileLinkUrl({ file: 'team/readme.md', session: 'team', line: 3 }),
    appUrl: t.appUrl('#x'), appRootUrl: t.appRootUrl(), pageUrl: t.pageUrl(), baseHref: t.baseHref(),
    rendered: new DOMParser().parseFromString(t.linkFileContent('<a href="./readme.md">r</a>', { session: 'team' }), 'text/html').querySelector('a').href,
  }));
  assert.equal(values.fileLinkUrl, `${origin}/sub/page?vvdebug=1#file=team%2Freadme.md&session=team&line=3`);
  assert.equal(values.appRootUrl, `${origin}/`);
  assert.equal(values.pageUrl, `${origin}/sub/page`);
  for (const [label, value] of Object.entries(values)) clean(value, label);
  await frame.evaluate(() => rerender());
  // "Open directly" opens the bare origin, whatever path the frame is at.
  const direct = frame.getByRole('link', { name: /Open directly/ });
  await direct.waitFor();
  assert.equal(await direct.getAttribute('href'), `${origin}/`);
  let tab = await popup(() => direct.click());
  assert.equal(tab.url(), `${origin}/`, 'Open directly lands on the bare origin'); await tab.close();
  // Ctrl/Cmd-click on a rendered file link and activateFileLink both open a tab.
  await redirty(frame);
  await frame.evaluate(() => rerender());
  const readme = frame.getByRole('link', { name: 'Readme' });
  clean(await readme.getAttribute('href'), 'rendered file link');
  tab = await popup(() => readme.click({ modifiers: ['ControlOrMeta'] }));
  clean(tab.url(), 'modified click target'); await tab.close();
  await redirty(frame);
  tab = await popup(() => frame.evaluate(() => t.activateFileLink(new MouseEvent('click', { ctrlKey: true }), { file: 'team/readme.md' })));
  clean(tab.url(), 'activateFileLink target'); await tab.close();
  // The page-HTML refetch: the request it sends, not just the string it builds.
  await redirty(frame);
  const before = requests.length;
  assert.ok(await frame.evaluate(() => t.fetchPageHtml()), 'page HTML refetch still works');
  const refetch = requests.slice(before).filter((r) => r.resourceType() === 'fetch');
  assert.equal(refetch.length, 1);
  assert.equal(refetch[0].url(), `${origin}/sub/page`, 'refetch asks for this page, without the query');
  for (const value of await attrs(frame)) clean(value, 'DOM attribute');
  outbound.push(...await frame.evaluate(() => window.__writes));

  // Reload only the frame (cleaned address, cookie only), then the host page.
  await frame.evaluate(() => location.reload());
  await host.waitForTimeout(300);
  frame = await booted(frameOf(host));
  assert.equal(frame.url(), `${origin}/sub/page?vvdebug=1`, 'frame reload keeps the clean address');
  await frame.getByRole('link', { name: 'Readme' }).waitFor();
  await host.reload();
  frame = await booted(frameOf(host));
  assert.equal(frame.url(), `${origin}/sub/page?vvdebug=1`, 'host reload is cleaned again on boot');
  await frame.getByRole('link', { name: /Open directly/ }).waitFor();
  console.log('edge-params: framed app passed');

  // 4b. A path that reads as protocol-relative stays on this origin everywhere.
  const odd = await context.newPage();
  await odd.goto(`${origin}//evil.example/x${DIRTY}`);
  await booted(odd.mainFrame());
  assert.equal(odd.url(), `${origin}//evil.example/x?vvdebug=1`, 'boot keeps the odd path on this origin');
  await redirty(odd.mainFrame());
  const oddValues = await odd.evaluate(() => ({
    fileLinkUrl: t.fileLinkUrl({ file: 'a.md' }), appUrl: t.appUrl(), appRootUrl: t.appRootUrl(), pageUrl: t.pageUrl(),
    rendered: new DOMParser().parseFromString(t.linkFileContent('<a href="./a.md">a</a>', {}), 'text/html').querySelector('a').href,
  }));
  assert.equal(oddValues.fileLinkUrl, `${origin}//evil.example/x?vvdebug=1#file=a.md`);
  assert.equal(oddValues.appRootUrl, `${origin}/`);
  for (const [label, value] of Object.entries(oddValues)) clean(value, `odd-path ${label}`);
  // The real page-HTML refetch at this path, with the foreign parameters still
  // in the address: assert the request that actually goes out, not a string.
  // Anything sent to another host is refused here so it never leaves the box.
  const offOrigin = (url) => url.origin !== origin;
  await context.route(offOrigin, (route) => route.abort());
  const oddBefore = requests.length;
  const oddHtml = await odd.evaluate(() => t.fetchPageHtml());
  const oddFetches = requests.slice(oddBefore).filter((r) => r.resourceType() === 'fetch');
  assert.equal(oddFetches.length, 1, 'odd-path refetch sends exactly one request');
  const sent = new URL(oddFetches[0].url());
  assert.equal(sent.origin, origin, `odd-path refetch stays on this origin: ${sent.origin}`);
  assert.equal(sent.pathname, '//evil.example/x', 'odd-path refetch asks for this page');
  assert.equal(sent.search, '', 'odd-path refetch carries no query');
  assert.ok(oddHtml, 'odd-path refetch still gets the page HTML');
  await context.unroute(offOrigin);
  // The boot cleanup itself, run on the dirty odd path, stays on this origin too.
  assert.equal(await odd.evaluate(() => t.stripForeignParams()), true);
  assert.equal(odd.url(), `${origin}//evil.example/x?vvdebug=1`);
  await odd.close();
  console.log('edge-params: protocol-relative path passed');

  // 4c. Top-level copied-link page: replaceState, "Agent Manager ↗" and "Copy link".
  const page = await context.newPage();
  await page.goto(`${origin}/${DIRTY}#file=readme.md&session=team`);
  await page.getByRole('heading', { name: 'Readme preview' }).waitFor();
  await page.waitForFunction(() => location.hash.includes('root=workspace'));
  assert.equal(page.url(), `${origin}/?vvdebug=1#file=team%2Freadme.md&root=workspace`);
  // Dirty again: the canonical replaceState (on Reload file) must clean it by itself.
  await redirty(page.mainFrame());
  await page.getByRole('button', { name: 'Reload file' }).click();
  await page.waitForFunction(() => !location.search.includes('__sign'));
  clean(page.url(), 'address after canonical replaceState');
  // Dirty again: the backlink and Copy link must not read it.
  await redirty(page.mainFrame());
  await page.evaluate(() => rerender());
  assert.equal(await page.getByRole('link', { name: /Agent Manager/ }).getAttribute('href'), `${origin}/?vvdebug=1`);
  await page.getByRole('button', { name: 'Copy link' }).click();
  await page.getByRole('status').filter({ hasText: 'Link copied' }).waitFor();
  const copied = await page.evaluate(() => window.__writes);
  assert.deepEqual(copied, [`${origin}/?vvdebug=1#file=team%2Freadme.md&root=workspace`]);
  outbound.push(...copied);
  for (const value of await attrs(page)) clean(value, 'DOM attribute');
  // A top-level reload of the cleaned address still works.
  await page.evaluate(() => history.replaceState(null, '', t.appUrl(location.hash)));
  await page.reload();
  await page.getByRole('heading', { name: 'Readme preview' }).waitFor();
  clean(page.url(), 'address after top-level reload');
  console.log('edge-params: file link page passed');

  // 4d. Nothing else left the page carrying the parameters.
  for (const value of outbound) clean(value, 'clipboard/window.open value');
  const loaded = (url) => url.includes(`/${DIRTY}`) || url.includes(`page${DIRTY}`) || url.includes(`x${DIRTY}`);
  for (const request of requests) {
    if (request.isNavigationRequest() && loaded(request.url())) continue; // the dirty addresses we loaded on purpose
    clean(request.url(), 'request');
  }
  for (const url of navigations) if (!loaded(url) && url !== 'about:blank') clean(url, 'navigation');
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.filter((w) => w.includes('[boot]')), [], 'boot cleanup succeeded everywhere');
  console.log('edge-params: all checks passed');
} finally {
  await browser.close(); await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
