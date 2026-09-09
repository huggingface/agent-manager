// What the on-demand module cache promises, without a browser: one request per
// loader however many panels mount, a bounded automatic retry that asks for the
// chunk under a new URL (a plain re-import never reaches the network — Chromium
// remembers the failure), a manual retry only where one can work, and a stale
// deployment recognised from the page's own HTML rather than guessed.
//
// No test runner: esbuild transpiles the module and it is imported directly.
// Run with:  node test/lazyModule.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-module-')), 'lazyModule.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/lazyModule.ts')],
  outfile: out, format: 'esm', bundle: false, logLevel: 'error',
});
const m = await import(pathToFileURL(out).href);
const {
  readModule, subscribeModule, retryModule, resetLazyModules, lazyModuleInternals,
  failedModuleUrl, bustUrl, entryScriptOf, deploymentChanged,
} = m;

const PAGE = 'http://app.test/some/path?x=1';
const ENTRY = '/assets/index-AAA.js';
const CHUNK = 'http://app.test/assets/FilesPane-BBB.js';
const chromeError = () => new TypeError(`Failed to fetch dynamically imported module: ${CHUNK}`);
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

// The seams: no timers, no network, no DOM.
let html = `<!doctype html><html><body><script type="module" crossorigin src="${ENTRY}"></script></body></html>`;
const imports = [];
let importResult = () => Promise.resolve({ default: 'retried' });
Object.assign(lazyModuleInternals, {
  delay: () => Promise.resolve(),
  importUrl: (url) => { imports.push(url); return importResult(url); },
  fetchPageHtml: () => Promise.resolve(html),
  currentEntryScript: () => ENTRY,
  baseHref: () => PAGE,
});

let failed = 0;
const check = (what, fn) => fn().then(
  () => console.log(`  ok  ${what}`),
  (e) => { failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`); },
);
const fresh = () => { resetLazyModules(); imports.length = 0; };

await check('pure helpers: the URL a browser names, a busted URL, the entry script of a page', async () => {
  assert.equal(failedModuleUrl(chromeError(), PAGE), CHUNK);
  assert.equal(failedModuleUrl(new Error(`error loading dynamically imported module: ${CHUNK}`), PAGE), CHUNK, 'Firefox wording');
  assert.equal(failedModuleUrl(new Error('Importing a module script failed.'), PAGE), null, 'WebKit names nothing');
  assert.equal(failedModuleUrl(new Error('Failed to fetch dynamically imported module: https://evil.test/x.js'), PAGE), null, 'never another origin');
  assert.equal(failedModuleUrl(undefined, PAGE), null);
  assert.equal(bustUrl(CHUNK, 2), `${CHUNK}?am-retry=2`);
  assert.equal(bustUrl(`${CHUNK}?v=1`, 3), `${CHUNK}?v=1&am-retry=3`);
  assert.equal(entryScriptOf(html), ENTRY);
  assert.equal(entryScriptOf('<script src="/assets/a.js" type="module"></script>'), '/assets/a.js', 'attribute order');
  assert.equal(entryScriptOf('<script src="/sw.js"></script>'), null, 'a classic script is not the entry');
  assert.equal(await deploymentChanged(), false);
  html = html.replace(ENTRY, '/assets/index-ZZZ.js');
  assert.equal(await deploymentChanged(), true);
  html = html.replace('/assets/index-ZZZ.js', ENTRY);
});

await check('one loader call serves every reader; the module is kept', async () => {
  fresh();
  let calls = 0;
  let resolve;
  const loader = () => { calls++; return new Promise((r) => { resolve = r; }); };
  const seen = [];
  const un = subscribeModule(loader, () => seen.push(readModule(loader).kind));
  assert.equal(readModule(loader).kind, 'loading');
  assert.equal(readModule(loader).kind, 'loading', 'a second reader does not start a second load');
  subscribeModule(loader, () => {});
  assert.equal(calls, 1);
  resolve({ default: 'Panel' });
  await settle();
  assert.deepEqual(seen, ['ready']);
  assert.deepEqual(readModule(loader), { kind: 'ready', module: { default: 'Panel' } });
  un();
  assert.equal(calls, 1, 'nothing re-fetches on later reads');
});

await check('a named chunk gets exactly one automatic retry, under a new URL', async () => {
  fresh();
  let calls = 0;
  const loader = () => { calls++; return Promise.reject(chromeError()); };
  importResult = () => Promise.resolve({ default: 'second try' });
  readModule(loader);
  await settle();
  assert.equal(calls, 1, 'the plain import is not repeated — the module map would answer from memory');
  assert.deepEqual(imports, [`${CHUNK}?am-retry=2`]);
  assert.deepEqual(readModule(loader), { kind: 'ready', module: { default: 'second try' } });
});

await check('when the retry fails too it settles as failed, retryable, and not stale', async () => {
  fresh();
  const loader = () => Promise.reject(chromeError());
  importResult = () => Promise.reject(chromeError());
  readModule(loader);
  await settle();
  const st = readModule(loader);
  assert.equal(st.kind, 'failed');
  assert.equal(st.retryable, true);
  assert.equal(st.stale, false, 'the page HTML still names this build');
  assert.equal(imports.length, 1, 'automatic retries are bounded');
});

await check('a manual retry is one more attempt, and success is kept', async () => {
  fresh();
  const loader = () => Promise.reject(chromeError());
  let n = 0;
  importResult = () => (++n < 2 ? Promise.reject(chromeError()) : Promise.resolve({ default: 'third' }));
  readModule(loader);
  await settle();
  assert.equal(readModule(loader).kind, 'failed');
  retryModule(loader);
  assert.equal(readModule(loader).kind, 'loading');
  await settle();
  assert.deepEqual(readModule(loader), { kind: 'ready', module: { default: 'third' } });
  assert.deepEqual(imports, [`${CHUNK}?am-retry=2`, `${CHUNK}?am-retry=3`], 'every attempt uses a URL the module map has not seen');
  retryModule(loader);
  assert.equal(readModule(loader).kind, 'ready', 'retry is a no-op unless the load failed');
});

await check('a stale deployment is reported as such and is not offered a retry', async () => {
  fresh();
  const loader = () => Promise.reject(chromeError());
  importResult = () => Promise.reject(chromeError());
  html = html.replace(ENTRY, '/assets/index-NEW.js');
  readModule(loader);
  await settle();
  const st = readModule(loader);
  assert.equal(st.kind, 'failed');
  assert.equal(st.stale, true);
  assert.equal(st.retryable, false);
  retryModule(loader);
  assert.equal(readModule(loader).kind, 'failed', 'nothing this tab can fetch would succeed');
  html = html.replace('/assets/index-NEW.js', ENTRY);
});

await check('a failure the browser does not name is not retryable and asks nothing of the network', async () => {
  fresh();
  const loader = () => Promise.reject(new Error('Importing a module script failed.'));
  readModule(loader);
  await settle();
  const st = readModule(loader);
  assert.equal(st.kind, 'failed');
  assert.equal(st.retryable, false);
  assert.equal(imports.length, 0);
  retryModule(loader);
  assert.equal(readModule(loader).kind, 'failed');
});

await check('when the page HTML cannot be read, staleness is unknown rather than asserted', async () => {
  fresh();
  const loader = () => Promise.reject(chromeError());
  importResult = () => Promise.reject(chromeError());
  const saved = lazyModuleInternals.fetchPageHtml;
  lazyModuleInternals.fetchPageHtml = () => Promise.resolve(null);
  readModule(loader);
  await settle();
  const st = readModule(loader);
  assert.equal(st.stale, null);
  assert.equal(st.retryable, true, 'offline is exactly when a retry is worth offering');
  lazyModuleInternals.fetchPageHtml = saved;
});

await check('a listener that unsubscribed hears nothing more', async () => {
  fresh();
  let resolve;
  const loader = () => new Promise((r) => { resolve = r; });
  let heard = 0;
  const un = subscribeModule(loader, () => heard++);
  un();
  resolve({ default: 'x' });
  await settle();
  assert.equal(heard, 0);
  assert.equal(readModule(loader).kind, 'ready');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
