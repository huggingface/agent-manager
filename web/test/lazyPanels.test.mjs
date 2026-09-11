// The on-demand panels, in the production build, against a real backend.
//
// What the build promises (issue #133): a cold visit does not fetch or run the
// Files, Trace or Settings code; the first time a panel is shown its chunk is
// fetched and later shows reuse it; a chunk that does not load fails where the
// panel would be — with a way out, a retry that really retries, and an honest
// "reload" when a newer deployment replaced this build — while the rest of the
// app keeps working; and a panel closed while its code was still on the way
// stays closed. Assertions are on actual network entries and rendered DOM, not
// on mocked imports.
//
// Builds the web app into a temp dir (or uses $AM_TEST_DIST), boots the server
// on 7904 with the fixture fleet from helpers/fixture-server.mjs.
// Run with:  node test/lazyPanels.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
import { startFixtureServer, buildWeb } from './helpers/fixture-server.mjs';
import { MARK, FRAME } from './helpers/markers.mjs';

const PORT = 7904;
const PANEL_CHUNK = /\/assets\/(FilesPane|TracePane|SettingsView|ApiLog|CronSettings|UsagePanel|SkillsEditor)-[^/]+\.js/;
const chunkOf = (name) => new RegExp(`/assets/${name}-[^/]+\\.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = async (what, fn) => {
  try { await fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${String(e && e.message || e).split('\n').slice(0, 3).join('\n       ')}`);
  }
};

const dist = buildWeb(spawnSync, 'am-lazy-dist-');
const server = await startFixtureServer({ port: PORT, publicDir: dist, tag: 'am-lazy-' });
const browser = await chromium.launch(chromiumLaunchOptions());

// A fresh browser profile with the remembered selection already in place, and
// every script request on the wire recorded — the assertions read that log.
async function open({ restore = 'overview', focused = null, mobile = false, stage = false, storage = true, offline = false } = {}) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }, offline });
  const page = await ctx.newPage();
  const scripts = [];
  page.on('request', (r) => { if (r.resourceType() === 'script') scripts.push(r.url()); });
  await page.addInitScript(({ restore, focused, storage, stage }) => {
    if (!storage) {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } });
      return;
    }
    localStorage.setItem('am-active-ref', restore);
    if (focused) localStorage.setItem('am-focused-id', focused);
    localStorage.setItem('am-pane-mode', 'reader');
    if (stage) localStorage.setItem('am-mobile-stage', '1');
  }, { restore, focused, storage, stage });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.goto(server.origin + '/');
  return { ctx, page, scripts, requests: (re) => scripts.filter((u) => re.test(u)) };
}
// A top-level row by its exact name: `files` must not match the group's `g-files`.
const row = (page, name) => page.locator('.sidebar .row.session:not(.nested)').filter({ has: page.locator('.name', { hasText: new RegExp(`^${name}$`) }) });
const CARD = '.ov-tile, .ov-card';
const openSettings = (page) => page.locator('.icon-btn[title="Settings"]').first().click();
const tab = (page, label) => page.locator('.settings-navitem', { hasText: label }).click();
const failure = (page) => page.locator('.lazy-failed');

const entryHtml = await fetch(server.origin + '/').then((r) => r.text());
const entrySrc = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(entryHtml)[1];

try {
  console.log('the production dependency graph');
  await check('a cold Overview visit fetches no panel-specific chunk, and the entry carries no panel code', async () => {
    const { ctx, page, requests } = await open();
    await page.locator(CARD).first().waitFor({ timeout: 15_000 });
    await page.locator('.sidebar .row.session').first().waitFor();
    await sleep(1500); // the polls settle; nothing further may arrive
    assert.deepEqual(requests(PANEL_CHUNK), [], 'panel chunks requested at startup');
    const entry = await fetch(server.origin + entrySrc).then((r) => r.text());
    // The budget from the #133 measurements (697 kB measured, headroom to 720).
    // Reaching it again means a panel grew back into the entry or a new eager
    // import landed there; read the chunk stats before raising it.
    // Integration of the fourteen issue PRs (2026-09-09): 730 kB measured with
    // every panel still in its own chunk and no marker in the entry — the growth
    // is the unread, reader-history, refresh, admission and lock code that
    // belongs in the entry. Raised with the same headroom.
    assert.ok(entry.length <= 760 * 1024, `entry chunk is ${(entry.length / 1024).toFixed(0)} kB, over the 760 kB budget`);
    // One literal only that panel's module contains — a dynamic import that
    // merely wraps an unchanged graph would leave these in the entry.
    for (const [panel, marker] of [
      ['FilesPane', 'files-body'], ['TracePane', 'trace-body'], ['SettingsView', 'Defaults to your system setting.'],
      ['ApiLog', 'al-tbl'], ['CronSettings', 'cron-form'], ['UsagePanel', 'usage-card'], ['SkillsEditor', 'skills-list'],
    ]) assert.ok(!entry.includes(marker), `${panel} code is still in the entry chunk ("${marker}")`);
    // And the deferred panels do no background work while unopened.
    const api = [];
    page.on('request', (r) => { if (/\/api\/(usage|operations|crons|skills)\b/.test(r.url())) api.push(r.url()); });
    await sleep(2500);
    assert.deepEqual(api, [], 'unopened panels polled their APIs');
    await ctx.close();
  });

  await check('first Settings open fetches its chunk; each subpage fetches its own, once; a second visit reuses them', async () => {
    const { ctx, page, requests } = await open();
    await page.locator(CARD).first().waitFor({ timeout: 15_000 });
    await openSettings(page);
    await page.locator('.settings-page .setting-row').first().waitFor({ timeout: 10_000 });
    assert.equal(requests(chunkOf('SettingsView')).length, 1);
    assert.equal(requests(/UsagePanel|ApiLog|CronSettings|SkillsEditor/).length, 0, 'subpages came with the General page');
    for (const [label, marker, chunk] of [['Usage', FRAME.usage, 'UsagePanel'], ['API log', FRAME.apilog, 'ApiLog'], ['Skills', MARK.skills, 'SkillsEditor'], ['Cron', MARK.cron, 'CronSettings']]) {
      await tab(page, label);
      await page.locator(marker).first().waitFor({ timeout: 10_000 });
      assert.equal(requests(chunkOf(chunk)).length, 1, `${chunk} fetched once`);
    }
    await tab(page, 'General');
    await tab(page, 'Usage');
    await page.locator('.usage').waitFor();
    await page.locator('.brand .icon-btn[title="Back"]').click();
    await page.locator('.app:not(.settings)').waitFor();
    assert.equal(await page.locator('.app.settings').count(), 0);
    await openSettings(page);
    await tab(page, 'Cron');
    await page.locator('.cron-form').waitFor();
    assert.equal(requests(chunkOf('SettingsView')).length, 1, 'Settings reopened without a second fetch');
    assert.equal(requests(chunkOf('UsagePanel')).length, 1);
    assert.equal(requests(chunkOf('CronSettings')).length, 1);
    // Closing Settings ends its subpages' polling too.
    await page.locator('.brand .icon-btn[title="Back"]').click();
    await page.locator('.app:not(.settings)').waitFor();
    const api = [];
    page.on('request', (r) => { if (/\/api\/(usage|crons)\b/.test(r.url())) api.push(r.url()); });
    await sleep(2500);
    assert.deepEqual(api, [], 'closed subpages kept polling');
    await ctx.close();
  });

  await check('opening Files fetches the Files chunk and not the Trace one; the Trace pane fetches its own', async () => {
    const { ctx, page, requests } = await open();
    await row(page, 'files').waitFor({ timeout: 15_000 });
    await row(page, 'files').click();
    await page.locator('.files-body.tree .tree-row').first().waitFor({ timeout: 10_000 });
    assert.equal(requests(chunkOf('FilesPane')).length, 1);
    assert.equal(requests(chunkOf('TracePane')).length, 0, 'the trace renderer rode along with Files');
    await row(page, 'trace').click();
    await page.locator('.trace-body .cx-prompt, .trace-body .tv-md').first().waitFor({ timeout: 10_000 });
    assert.equal(requests(chunkOf('TracePane')).length, 1);
    await row(page, 'files').click();
    await page.locator('.files-body.tree .tree-row').first().waitFor();
    assert.equal(requests(chunkOf('FilesPane')).length, 1, 'Files reopened from the cached module');
    await ctx.close();
  });

  console.log('restored selections');
  await check('a restored Files selection starts its chunk as soon as the tree names it, without waiting on anything else', async () => {
    const { ctx, page, requests } = await open({ restore: `s:${server.ids.files}` });
    await page.locator('.files-body.tree .tree-row').first().waitFor({ timeout: 15_000 });
    assert.equal(requests(chunkOf('FilesPane')).length, 1);
    assert.equal(requests(/SettingsView|TracePane|ApiLog|CronSettings|UsagePanel|SkillsEditor/).length, 0);
    await ctx.close();
  });
  await check('a restored Reader session needs no panel chunk at all, and its composer is usable', async () => {
    const { ctx, page, requests } = await open({ restore: `s:${server.ids.cadence}` });
    await page.locator('.pane-reader .cx-prompt').first().waitFor({ timeout: 15_000 });
    await page.locator('.pane-reader .ov-composer textarea:not([disabled])').waitFor();
    await sleep(1000);
    assert.deepEqual(requests(PANEL_CHUNK), []);
    await ctx.close();
  });
  await check('a restored group shows its Files and Trace panes, each from its own chunk', async () => {
    const { ctx, page, requests } = await open({ restore: `g:${server.ids.group}`, focused: server.ids.groupFiles });
    await page.locator('.tile .files-body.tree .tree-row').first().waitFor({ timeout: 15_000 });
    await page.locator('.tile .trace-body .cx-prompt, .tile .trace-body .tv-md').first().waitFor({ timeout: 15_000 });
    assert.equal(requests(chunkOf('FilesPane')).length, 1);
    assert.equal(requests(chunkOf('TracePane')).length, 1);
    await ctx.close();
  });

  console.log('when a chunk does not load');
  await check('a failed Files chunk fails in its own tile: the Trace tile, the sidebar and Close still work; Try again then really loads it', async () => {
    const { ctx, page, requests } = await open({ restore: `g:${server.ids.group}`, focused: server.ids.groupFiles });
    let block = true;
    await page.route(chunkOf('FilesPane'), (r) => (block ? r.abort('failed') : r.continue()));
    await page.locator('.tile .trace-body .cx-prompt, .tile .trace-body .tv-md').first().waitFor({ timeout: 15_000 });
    await failure(page).waitFor({ timeout: 10_000 });
    assert.equal(await failure(page).count(), 1, 'one tile failed, not both');
    assert.match(await failure(page).innerText(), /Couldn’t load the file browser/);
    assert.equal(await failure(page).locator('button', { hasText: 'Try again' }).count(), 1);
    assert.equal(await failure(page).locator('button', { hasText: 'Close' }).count(), 1);
    assert.ok(await page.locator('.sidebar .row.session').first().isVisible(), 'the sidebar is gone');
    // The automatic retry asked for the chunk under a new URL and was blocked too.
    const urls = requests(chunkOf('FilesPane'));
    assert.equal(urls.length, 2, `attempts: ${urls.join(' ')}`);
    assert.match(urls[1], /\?am-retry=2$/);
    block = false;
    await failure(page).locator('button', { hasText: 'Try again' }).click();
    await page.locator('.tile .files-body.tree .tree-row').first().waitFor({ timeout: 10_000 });
    assert.equal(await failure(page).count(), 0);
    assert.match(requests(chunkOf('FilesPane')).at(-1), /\?am-retry=3$/, 'the manual retry used a fresh URL');
    await ctx.close();
  });

  await check('a chunk a newer deployment removed: says so, offers Reload, offers no retry, and never reloads by itself', async () => {
    const { ctx, page } = await open();
    await page.route(chunkOf('FilesPane'), (r) => r.fulfill({ status: 404, body: 'gone' }));
    // The page's own HTML, re-read by the panel: now naming another build.
    await page.route(`${server.origin}/`, (r) => (r.request().resourceType() === 'fetch'
      ? r.fulfill({ status: 200, contentType: 'text/html', body: entryHtml.replace(entrySrc, '/assets/index-NEWBUILD.js') })
      : r.continue()));
    let navigations = 0;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
    await row(page, 'files').waitFor({ timeout: 15_000 });
    await row(page, 'files').click();
    await failure(page).waitFor({ timeout: 10_000 });
    await failure(page).locator('button', { hasText: 'Reload' }).waitFor({ timeout: 5000 });
    assert.match(await failure(page).innerText(), /Agent Manager was updated/);
    assert.equal(await failure(page).locator('button', { hasText: 'Try again' }).count(), 0);
    await sleep(1500);
    assert.equal(navigations, 0, 'the page reloaded on its own');
    assert.equal(await page.locator('.sidebar').count(), 1);
    await ctx.close();
  });

  await check('offline first open settles as a failure with Try again; back online, Try again loads the panel', async () => {
    const { ctx, page } = await open();
    await row(page, 'files').waitFor({ timeout: 15_000 });
    await ctx.setOffline(true);
    await row(page, 'files').click();
    await failure(page).waitFor({ timeout: 10_000 });
    assert.match(await failure(page).innerText(), /offline/);
    await ctx.setOffline(false);
    await failure(page).locator('button', { hasText: 'Try again' }).click();
    await page.locator('.files-body.tree .tree-row').first().waitFor({ timeout: 10_000 });
    await ctx.close();
  });

  await check('Settings closed while its code was still loading stays closed when the code lands; the shell was usable meanwhile', async () => {
    const { ctx, page, requests } = await open();
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route(chunkOf('SettingsView'), async (r) => { await held; await r.continue(); });
    await page.locator(CARD).first().waitFor({ timeout: 15_000 });
    await openSettings(page);
    await page.locator('.app.settings .settings-nav .settings-navitem').first().waitFor();
    assert.equal(await page.locator('.app.settings .lazy-panel[aria-busy="true"]').count(), 1, 'the page body reserved its place');
    assert.equal(await page.locator('.app.app-suspended').count(), 1);
    await tab(page, 'Cron');
    assert.ok(await page.locator('.settings-navitem.active', { hasText: 'Cron' }).isVisible(), 'tabs work before the code is here');
    await page.locator('.brand .icon-btn[title="Back"]').click();
    await page.locator('.app:not(.settings)').waitFor();
    release();
    await sleep(800);
    assert.equal(await page.locator('.app.settings').count(), 0, 'module completion reopened Settings');
    await openSettings(page);
    await page.locator('.cron-form').waitFor({ timeout: 10_000 });
    assert.equal(requests(chunkOf('SettingsView')).length, 1, 'the landed module was reused');
    await ctx.close();
  });

  await check('two subpage switches while both chunks are in flight: the last choice wins, whatever order the code arrives in', async () => {
    const { ctx, page } = await open();
    const gates = {};
    for (const name of ['UsagePanel', 'ApiLog']) {
      gates[name] = new Promise((r) => { gates[`${name}Go`] = r; });
      await page.route(chunkOf(name), async (r) => { await gates[name]; await r.continue(); });
    }
    await page.locator(CARD).first().waitFor({ timeout: 15_000 });
    await openSettings(page);
    await page.locator('.settings-page .setting-row').first().waitFor({ timeout: 10_000 });
    await tab(page, 'Usage');
    await tab(page, 'API log');
    gates.UsagePanelGo();
    await sleep(500);
    gates.ApiLogGo();
    await page.locator('.al-tbl, .al-head').first().waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('.usage').count(), 0, 'the earlier page showed up late');
    assert.equal(await page.locator('.lazy-panel').count(), 0);
    await ctx.close();
  });

  await check('the Usage readiness marker cannot fire on skeletons: with its data held back, the frame is there and the marker is not', async () => {
    const { ctx, page } = await open();
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route(/\/api\/(usage|traces)(\?|$)/, async (r) => { await held; await r.continue(); });
    await page.locator(CARD).first().waitFor({ timeout: 15_000 });
    await openSettings(page);
    await page.locator(MARK.settings).first().waitFor({ timeout: 10_000 });
    await tab(page, 'Usage');
    await page.locator(FRAME.usage).waitFor({ timeout: 10_000 });
    await sleep(1000);
    assert.ok((await page.locator('.usage .skel').count()) > 0, 'the page shows skeletons while its data is on the way');
    assert.equal(await page.locator(MARK.usage).count(), 0, 'the usable-content marker fired on skeletons');
    release();
    await page.locator(MARK.usage).first().waitFor({ timeout: 10_000 });
    await ctx.close();
  });

  console.log('layout, storage, viewport');
  await check('at phone width the Settings shell has its Back button while the page loads, and the loaded page lands under it', async () => {
    const { ctx, page } = await open({ mobile: true });
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route(chunkOf('SettingsView'), async (r) => { await held; await r.continue(); });
    await page.locator('.sidebar .row.session').first().waitFor({ timeout: 15_000 });
    await openSettings(page);
    const back = page.locator('.app.settings .brand .icon-btn[title="Back"]');
    await back.waitFor();
    assert.ok(await back.isVisible());
    const busy = page.locator('.app.settings .lazy-panel[aria-busy="true"]');
    assert.ok(await busy.isVisible(), 'the loading placeholder is on screen');
    release();
    await page.locator('.settings-page .setting-row').first().waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('.lazy-panel').count(), 0);
    await ctx.close();
  });

  await check('with browser storage denied the app still starts and Files still opens on demand', async () => {
    const { ctx, page, requests } = await open({ storage: false });
    await row(page, 'files').waitFor({ timeout: 15_000 });
    await row(page, 'files').click();
    await page.locator('.files-body.tree .tree-row').first().waitFor({ timeout: 10_000 });
    assert.equal(requests(chunkOf('FilesPane')).length, 1);
    await ctx.close();
  });
} finally {
  await browser.close();
  await server.stop();
}

console.log(failed ? `\n${failed} failed` : '\nlazy-panels: ok');
process.exit(failed ? 1 : 0);
