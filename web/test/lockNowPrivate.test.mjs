// The locked page notices when its Space was made private (Locked.tsx,
// lib/edgeRefusal.ts), in the real app against a real backend.
//
// A tab loaded while the Space was public has no HF sign-in cookie; once the
// Space is private, HF's edge answers its polls with its own 404 text/html.
// The fixture server is a local install, so /api/info is rewritten in the
// browser: first AM's locked answer (public-space), then the edge's page.
//
//   two edge refusals in a row → "This Space is now private" + Reload
//   one refusal, or refusals broken by an AM answer / outage → still locked
//   503 (HTML or JSON), dropped connections, AM's own locked 403 → never
//   "Check now" → polls at once; the 15 s timer reaches the same verdict
//   Reload in a top-level tab → the top window reloads
//
// Run with:  node test/lockNowPrivate.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
import { startFixtureServer, buildWeb } from './helpers/fixture-server.mjs';

let failed = 0;
const check = async (what, fn) => {
  try { await fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${String(e && e.message || e).split('\n').slice(0, 3).join('\n       ')}`);
  }
};

const dist = buildWeb(spawnSync, 'am-nowprivate-dist-');
const server = await startFixtureServer({ publicDir: dist, tag: 'am-nowprivate-' });
const browser = await chromium.launch(chromiumLaunchOptions());

const EDGE_404 = { status: 404, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>404</title><h1>404</h1>' };
// What each answer mode serves for /api/info.
const ANSWERS = {
  edge: (route) => route.fulfill(EDGE_404),
  edge401: (route) => route.fulfill({ status: 401, contentType: 'text/html', body: '<h1>Sign in</h1>' }),
  html503: (route) => route.fulfill({ status: 503, contentType: 'text/html', body: '<h1>Space is restarting</h1>' }),
  json503: (route) => route.fulfill({ status: 503, json: { error: 'unavailable', code: 'unavailable' } }),
  amLocked403: (route) => route.fulfill({ status: 403, json: { error: 'locked', reason: 'public-space', bucket: null } }),
  down: (route) => route.abort('connectionrefused'),
};

/** The app locked as a public Space; `space.mode` changes what /api/info answers. */
async function open({ clock = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const space = { mode: 'locked', infoReads: 0, navigations: 0 };
  page.on('request', (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) space.navigations++; });
  await page.route('**/api/info', async (route) => {
    space.infoReads++;
    if (space.mode !== 'locked') return ANSWERS[space.mode](route);
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, spaceId: 'you/agent-manager', welcomeSeen: true,
      locked: true, lockReason: 'public-space', lockBucket: null } });
  });
  if (clock) await page.clock.install();
  await page.goto(server.origin + '/');
  await page.locator('.install-relock').waitFor({ timeout: 15_000 });
  return { ctx, page, space };
}

const NOW_PRIVATE = '[data-lock-reason="now-private"]';
const CHECK = '[data-lock-action="check-now"]';
const RELOAD = '[data-lock-action="reload"]';

/** Clicks Check now and waits for that poll to be answered. */
async function checkNow(page, space) {
  const before = space.infoReads;
  await page.locator(CHECK).click();
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-lock-action="check-now"]');
    return !b || !b.disabled;
  });
  assert.ok(space.infoReads > before, 'Check now polled /api/info at once');
}
const stillLocked = async (page, what) => {
  assert.equal(await page.locator(NOW_PRIVATE).count(), 0, `${what}: not "now private"`);
  assert.equal(await page.locator('.install-relock').count(), 1, `${what}: the install page stays`);
};

try {
  await check('"Check now" sits next to "Is this your Space?" and polls immediately', async () => {
    const { ctx, page, space } = await open();
    const relock = page.locator('.install-relock');
    assert.match(await relock.innerText(), /Is this your Space\?[\s\S]*Check now/);
    await checkNow(page, space);
    await stillLocked(page, 'AM still says locked');
    await ctx.close();
  });

  await check('AM-locked JSON, then 404 text/html twice → "This Space is now private" with Reload', async () => {
    const { ctx, page, space } = await open();
    space.mode = 'edge';
    await checkNow(page, space);
    await stillLocked(page, 'one refusal');
    await page.locator(CHECK).click();
    await page.locator(NOW_PRIVATE).waitFor({ timeout: 5000 });
    assert.equal(await page.locator(`${NOW_PRIVATE} h1`).innerText(), 'This Space is now private');
    const text = await page.locator(NOW_PRIVATE).innerText();
    assert.match(text, /Reload the page to open it\./);
    assert.match(text, /⌘R \/ Ctrl\+R/);
    assert.equal(await page.locator(RELOAD).innerText(), 'Reload');
    assert.ok(await page.locator(RELOAD).isVisible(), 'the Reload button shows');
    await ctx.close();
  });

  await check('a non-JSON 401 counts as the edge too', async () => {
    const { ctx, page, space } = await open();
    space.mode = 'edge401';
    await checkNow(page, space);
    await page.locator(CHECK).click();
    await page.locator(NOW_PRIVATE).waitFor({ timeout: 5000 });
    await ctx.close();
  });

  for (const mode of ['html503', 'json503', 'down', 'amLocked403']) {
    await check(`${mode}, three times in a row → still the locked page`, async () => {
      const { ctx, page, space } = await open();
      space.mode = mode;
      for (let i = 0; i < 3; i++) await checkNow(page, space);
      await stillLocked(page, mode);
      await ctx.close();
    });
  }

  await check('refusals broken by an outage or an AM answer do not add up', async () => {
    const { ctx, page, space } = await open();
    for (const between of ['down', 'html503', 'locked']) {
      space.mode = 'edge'; await checkNow(page, space);
      space.mode = between; await checkNow(page, space);
    }
    space.mode = 'edge'; await checkNow(page, space);
    await stillLocked(page, 'never two in a row');
    await ctx.close();
  });

  await check('the 15 s locked poll alone reaches "now private", and AM answering again undoes it', async () => {
    const { ctx, page, space } = await open({ clock: true });
    space.mode = 'edge';
    const before = space.infoReads;
    await page.clock.runFor(31_000);
    await page.locator(NOW_PRIVATE).waitFor({ timeout: 5000 });
    assert.ok(space.infoReads - before >= 2, 'two timer polls');
    space.mode = 'locked';
    await page.clock.runFor(16_000);
    await page.locator('.install-relock').waitFor({ timeout: 5000 });
    await ctx.close();
  });

  await check('Reload in a top-level tab reloads the top window', async () => {
    const { ctx, page, space } = await open();
    space.mode = 'edge';
    await checkNow(page, space);
    await page.locator(CHECK).click();
    await page.locator(NOW_PRIVATE).waitFor({ timeout: 5000 });
    space.mode = 'locked'; // signed in again by the reload
    const navigations = space.navigations;
    await Promise.all([page.waitForEvent('load'), page.locator(RELOAD).click()]);
    assert.equal(space.navigations, navigations + 1, 'one top-level navigation');
    assert.equal(new URL(page.url()).origin, server.origin, 'the same page, reloaded');
    await page.locator('.install-relock').waitFor({ timeout: 15_000 });
    await ctx.close();
  });
} finally {
  await browser.close();
  await server.stop?.();
}
if (failed) { console.log(`lock now-private: ${failed} check(s) failed`); process.exit(1); }
console.log('lock now-private: all checks passed');
