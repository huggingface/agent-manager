// The bucket question before getting started (BucketPrompt.tsx), in the real
// app against a real backend.
//
// A freshly duplicated Space runs with no bucket and loses everything on the
// next restart; the app has to say so before it walks anyone through setup.
// The fixture server is a local install, so /api/info is rewritten in the
// browser to describe a Space (spaceId + storage) with the welcome unseen;
// everything else is the server's own answer.
//
//   persistent  → the getting-started window directly, no question, no banner
//   ephemeral   → "Have you attached a bucket?" first, the welcome behind it
//   "Continue without a bucket" → the welcome, plus a banner that reopens it
//   "Yes, I've attached it" while still ephemeral → the restart wait, which
//                 rides out the Space being down and reloads once the server
//                 reports the bucket
//
// Set AM_SHOTS=<dir> to also write the screenshots (light, dark, phone).
// Run with:  node test/bucketPrompt.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

const SHOTS = process.env.AM_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), animations: 'disabled' }); };

const dist = buildWeb(spawnSync, 'am-bucket-dist-');
const server = await startFixtureServer({ publicDir: dist, tag: 'am-bucket-' });
const browser = await chromium.launch(chromiumLaunchOptions());

const EPHEMERAL = { persistent: false, dataDir: '/home/node/data', reason: 'fallback' };
const MOUNTED = { persistent: true, dataDir: '/data', reason: 'mounted' };

/** The app as a Space with `storage`; `space.storage` / `space.down` change it live. */
async function open({ storage, mobile = false, theme = 'light' }) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const space = { storage, down: false, infoReads: 0 };
  await page.route('**/api/info', async (route) => {
    space.infoReads++;
    if (space.down) return route.abort('connectionrefused');
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, spaceId: 'you/agent-manager', welcomeSeen: false, storage: space.storage } });
  });
  // While "down", the liveness probe fails too, the way a restarting Space does.
  await page.route('**/api/visibility', (route) => (space.down ? route.abort('connectionrefused') : route.fallback()));
  await page.addInitScript((t) => { localStorage.setItem('am-theme', t); localStorage.setItem('am-active-ref', 'overview'); }, theme);
  await page.goto(server.origin + '/');
  return { ctx, page, space };
}

const BUCKET = '[aria-labelledby="bucket-title"]';
const WELCOME = '[aria-labelledby="welcome-title"]';
const BANNER = '.nobucket';

try {
  await check('a bucket attached: straight to getting started, no question, no banner', async () => {
    const { ctx, page } = await open({ storage: MOUNTED });
    await page.locator(WELCOME).waitFor({ timeout: 15_000 });
    assert.equal(await page.locator(BUCKET).count(), 0, 'no bucket question');
    assert.equal(await page.locator(BANNER).count(), 0, 'no banner');
    await ctx.close();
  });

  await check('no bucket: the question comes first, with the steps and the picture', async () => {
    const { ctx, page } = await open({ storage: EPHEMERAL });
    const card = page.locator(BUCKET);
    await card.waitFor({ timeout: 15_000 });
    assert.equal(await page.locator(WELCOME).count(), 0, 'the welcome waits behind it');
    assert.equal(await card.locator('h2').innerText(), 'Have you attached a bucket?');
    const text = await card.innerText();
    for (const s of ['Settings → Storage → Mount a bucket', 'Create new bucket', 'Private', '/data', 'Read & Write',
      "your agents' work, logins and history are lost on every restart or update"]) {
      assert.ok(text.includes(s), `says ${JSON.stringify(s)}`);
    }
    assert.equal(await card.locator('svg.hf-header-icon').count(), 1, 'points at the Space header button');
    assert.equal(await card.locator('img').getAttribute('src'), '/install/mount-bucket.png');
    assert.ok(await card.locator('img').evaluate((i) => i.complete && i.naturalWidth > 0), 'the picture loads');
    assert.equal(await page.locator(BANNER).count(), 0, 'no banner while asking');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Yes, I've attached it", 'focus on the answer');
    await shot(page, 'bucket-light');
    await ctx.close();
  });

  await check('dark mode and phone width render the question without overflow', async () => {
    for (const [mobile, theme, name] of [[false, 'dark', 'bucket-dark'], [true, 'light', 'bucket-phone-light'], [true, 'dark', 'bucket-phone-dark']]) {
      const { ctx, page } = await open({ storage: EPHEMERAL, mobile, theme });
      const card = page.locator(BUCKET);
      await card.waitFor({ timeout: 15_000 });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      const { scroll, client } = await card.evaluate((c) => ({ scroll: c.scrollWidth, client: c.clientWidth }));
      assert.ok(scroll <= client, `${name}: no sideways scroll (${scroll} > ${client})`);
      const box = await card.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= (mobile ? 390 : 1280), `${name}: card inside the viewport`);
      await shot(page, name);
      await ctx.close();
    }
  });

  await check('"Continue without a bucket": the welcome, and a banner that brings the question back', async () => {
    const { ctx, page } = await open({ storage: EPHEMERAL });
    await page.locator(BUCKET).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Continue without a bucket' }).click();
    await page.locator(WELCOME).waitFor();
    assert.equal(await page.locator(BUCKET).count(), 0);
    const banner = page.locator(BANNER);
    assert.match(await banner.innerText(), /Not saved: no bucket attached/);
    await shot(page, 'welcome-after-skip');
    await page.keyboard.press('Escape');
    await page.locator(WELCOME).waitFor({ state: 'detached' });
    assert.equal(await banner.count(), 1, 'the banner stays after the welcome closes');
    await shot(page, 'banner');
    await banner.getByRole('button', { name: 'how to attach one' }).click();
    await page.locator(BUCKET).waitFor();
    assert.equal(await page.locator(BANNER).count(), 0, 'banner hidden while the question is open');
    await page.getByRole('button', { name: 'Continue without a bucket' }).click();
    await page.locator(BUCKET).waitFor({ state: 'detached' });
    assert.equal(await page.locator(WELCOME).count(), 0, 'reopened from the banner, it does not bring the welcome back');
    await ctx.close();
  });

  await check('"Yes" with no bucket yet: waits through the restart, then reloads into getting started', async () => {
    const { ctx, page, space } = await open({ storage: EPHEMERAL });
    await page.locator(BUCKET).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: "Yes, I've attached it" }).click();
    const wait = page.locator('.bucket-wait');
    await wait.waitFor();
    assert.match(await wait.innerText(), /The Space is restarting to mount it…/);
    assert.equal(await page.locator(WELCOME).count(), 0, 'no getting started without storage');
    assert.equal(await page.getByRole('button', { name: "Yes, I've attached it" }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Continue without a bucket' }).count(), 1, 'still a way out');
    await shot(page, 'bucket-waiting');
    // Still ephemeral for a few polls: nothing moves.
    let reads = space.infoReads;
    await new Promise((r) => setTimeout(r, 3500));
    assert.ok(space.infoReads > reads, 'polls /api/info while waiting');
    assert.equal(await wait.count(), 1, 'still waiting while the server sees no bucket');
    // The Space goes down to mount it…
    space.down = true;
    reads = space.infoReads;
    await new Promise((r) => setTimeout(r, 3500));
    assert.ok(space.infoReads > reads, 'keeps asking while the Space is down');
    assert.equal(await wait.count(), 1, 'an outage is not an answer');
    // …and comes back with the bucket: the page reloads by itself.
    const reloaded = page.waitForEvent('framenavigated', { timeout: 15_000 });
    space.storage = MOUNTED;
    space.down = false;
    await reloaded;
    await page.locator(WELCOME).waitFor({ timeout: 15_000 });
    assert.equal(await page.locator(BUCKET).count(), 0, 'no question once the bucket is there');
    assert.equal(await page.locator(BANNER).count(), 0, 'no banner once the bucket is there');
    await ctx.close();
  });
} finally {
  await browser.close();
  await server.stop();
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nbucket prompt: all checks passed');
