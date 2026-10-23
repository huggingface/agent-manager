// Reader images load on demand. The production build against a real backend,
// over a Claude transcript that viewed a dozen ~300 KB screenshots:
//   - the conversation responses stay small (refs, not base64);
//   - no image is fetched until its step is opened, and then only that one,
//     as <img loading="lazy" decoding="async"> laid out at its final aspect
//     before the bytes arrive;
//   - a ref the server cannot serve shows "image unavailable";
//   - an inline data-URL `src` (an older server) still renders.
//
// Builds the web app into a temp dir (or uses $AM_TEST_DIST) and boots the
// server on a free port with the fixture fleet from helpers/fixture-server.mjs.
// Run with:  node test/traceImages.browser.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
import { startFixtureServer, buildWeb } from './helpers/fixture-server.mjs';

let failed = 0;
const check = async (what, fn) => {
  try { await fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${String(e && e.message || e).split('\n').slice(0, 4).join('\n       ')}`);
  }
};

// A real, decodable 320x180 PNG per screenshot, padded after IEND with
// incompressible bytes (a decoder stops at IEND): big enough that a dozen of
// them inline would be megabytes of JSON.
const W = 320, H = 180;
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
};
const screenshot = (seed) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) raw.set([(x + seed * 20) & 255, y & 255, seed * 20 & 255], y * (W * 3 + 1) + 1 + x * 3);
  const pad = Buffer.alloc(300_000);
  let v = (seed + 1) * 2654435761 >>> 0;
  for (let i = 0; i < pad.length; i++) { v = (v * 1103515245 + 12345) >>> 0; pad[i] = v >>> 24; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)), pad]);
};
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const SHOTS = 12;
const shots = Array.from({ length: SHOTS }, (_, i) => screenshot(i));

const dist = buildWeb(spawnSync, 'am-images-dist-');
const server = await startFixtureServer({ publicDir: dist, tag: 'am-images-' });
const browser = await chromium.launch(chromiumLaunchOptions());

try {
  const pane = await server.api('/api/sessions', 'POST', { name: 'shots', cli: 'claude', path: 'shots' });
  const cwd = path.join(server.dataDir, 'workspaces', 'shots');
  const UUID = 'f1c7a0de-0000-4000-8000-0000000005a7';
  const at = (i) => new Date(Date.parse('2026-08-06T21:14:00Z') + i * 1000).toISOString();
  const lines = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'screenshot every page' }] } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__browser__screenshot', input: { pages: SHOTS } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1',
      content: shots.map((b) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b.toString('base64') } })) }] } },
    { type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'All twelve pages render.' }], stop_reason: 'end_turn' } },
  ].map((l, i) => JSON.stringify({ cwd, sessionId: UUID, timestamp: at(i), uuid: `x${i}`, ...l }));
  const dir = path.join(server.cfgDir, 'projects', cwd.replace(/[/.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, `${UUID}.jsonl`);
  fs.writeFileSync(transcript, `${lines.join('\n')}\n`);
  const transcriptBytes = fs.statSync(transcript).size;

  async function open({ dataUrls = false, breakRef = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const conversations = [];
    const images = [];
    page.on('request', (r) => { if (/\/image\//.test(new URL(r.url()).pathname)) images.push(new URL(r.url()).pathname); });
    page.on('response', async (r) => {
      const u = new URL(r.url());
      if (u.pathname === `/api/trace/${pane.id}` && r.ok()) conversations.push((await r.body()).length);
    });
    if (dataUrls) {
      // What an older server sent: the image inline, as a data URL, no ref.
      await page.route(`**/api/trace/${pane.id}?*`, async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        for (const t of body.turns || []) for (const b of t.blocks) {
          if (b.type === 'image') { delete b.ref; delete b.width; delete b.height; b.src = `data:image/png;base64,${PNG_1PX.toString('base64')}`; }
        }
        await route.fulfill({ response: res, json: body });
      });
    }
    if (breakRef) await page.route('**/image/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"no-image"}' }));
    await page.addInitScript((id) => {
      localStorage.setItem('am-active-ref', `s:${id}`);
      localStorage.setItem('am-pane-mode', 'reader');
    }, pane.id);
    await page.goto(server.origin + '/');
    await page.locator('.pane-reader .cx-prompt', { hasText: 'screenshot every page' }).first().waitFor({ timeout: 20_000 });
    return { ctx, page, conversations, images };
  }

  // The reader folds a turn's work behind "Show the work"; unfold it.
  const imageRows = async (page) => {
    const rows = page.locator('.pane-reader .cs.image');
    const fold = page.locator('.pane-reader button.cx-fold:not(.on)').first();
    if (!(await rows.count()) && await fold.count()) await fold.click();
    await rows.first().waitFor({ timeout: 10_000 });
    return rows;
  };

  await check('the conversation responses stay small: refs, not base64', async () => {
    const { ctx, page, conversations, images } = await open();
    const rows = await imageRows(page);
    assert.equal(await rows.count(), SHOTS, 'one image step per screenshot');
    assert.ok(conversations.length >= 1, 'the reader fetched its conversation');
    const largest = Math.max(...conversations);
    assert.ok(largest < 64 * 1024, `largest conversation response ${largest} bytes, transcript ${transcriptBytes}`);
    assert.ok(transcriptBytes > 3_000_000, 'and the images it refers to are megabytes');
    assert.deepEqual(images, [], 'no image fetched before one is opened');
    console.log(`       conversation ${largest} bytes for a ${transcriptBytes}-byte transcript`);
    await ctx.close();
  });

  await check('an opened image loads lazily, alone, at its final aspect', async () => {
    const { ctx, page, images } = await open();
    const rows = await imageRows(page);
    await rows.nth(0).locator('.cs-head').click();
    const img = rows.nth(0).locator('img.cs-img');
    await img.waitFor();
    assert.equal(await img.getAttribute('loading'), 'lazy');
    assert.equal(await img.getAttribute('decoding'), 'async');
    assert.equal(await img.getAttribute('width'), String(W));
    assert.equal(await img.getAttribute('height'), String(H));
    const box = await img.boundingBox();
    assert.ok(box && Math.abs(box.width / box.height - 16 / 9) < 0.02, `laid out 16:9, got ${box && (box.width / box.height).toFixed(3)}`);
    await page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await img.elementHandle(), { timeout: 10_000 });
    assert.equal(images.length, 1, `exactly the opened image was fetched: ${images.join(', ')}`);
    assert.match(images[0], new RegExp(`^/api/trace/${pane.id}/image/[0-9a-z]+\\.[0-9a-f]{24}$`));
    const after = await img.boundingBox();
    assert.ok(Math.abs(after.height - box.height) < 1, 'no jump when the bytes arrive');
    const r = await page.request.get(server.origin + images[0]);
    assert.ok((await r.body()).equals(shots[0]), 'the bytes are the screenshot');
    assert.match(r.headers()['cache-control'] || '', /immutable/);
    await ctx.close();
  });

  await check('opening every image fetches only those near the screen', async () => {
    const { ctx, page, images } = await open();
    const rows = await imageRows(page);
    // Opened in one go, without scrolling any of them into view.
    await page.locator('.pane-reader .cs.image .cs-head').evaluateAll((els) => els.forEach((el) => el.click()));
    await page.locator('.pane-reader .cs.image img').nth(SHOTS - 1).waitFor({ state: 'attached' });
    await page.waitForTimeout(1500);
    const near = images.length;
    assert.ok(near >= 1 && near < SHOTS, `${near} of ${SHOTS} fetched with all of them open`);
    // Scrolling the rest into view fetches them.
    for (let i = 0; i < SHOTS; i++) await rows.nth(i).locator('img').scrollIntoViewIfNeeded();
    await page.waitForFunction((n) => [...document.querySelectorAll('.pane-reader .cs.image img')].filter((i) => i.complete && i.naturalWidth > 0).length === n, SHOTS, { timeout: 15_000 });
    assert.equal(new Set(images).size, SHOTS, 'each image fetched once it is on screen');
    console.log(`       ${near} of ${SHOTS} fetched before scrolling`);
    await ctx.close();
  });

  await check('a Trace pane over the session draws them the same way', async () => {
    const tracePane = await server.api('/api/sessions', 'POST', { name: 'shots-trace', cli: 'trace' });
    await server.api(`/api/trace/${tracePane.id}/source`, 'PUT', { kind: 'session', ref: pane.id });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const images = [];
    page.on('request', (r) => { if (/\/image\//.test(new URL(r.url()).pathname)) images.push(new URL(r.url()).pathname); });
    await page.addInitScript((id) => { localStorage.setItem('am-active-ref', `s:${id}`); }, tracePane.id);
    await page.goto(server.origin + '/');
    const imgs = page.locator('img.tv-img');
    await imgs.first().waitFor({ timeout: 20_000 });
    // The pane opens at the end of the conversation, so it is the images near
    // there that load.
    await page.waitForFunction(() => [...document.querySelectorAll('img.tv-img')].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 10_000 });
    assert.equal(await imgs.count(), SHOTS);
    // Shown expanded, all twelve sit within Chrome's lazy-load distance, so how
    // many load here says nothing; what is checked is how each is drawn.
    const attrs = await imgs.evaluateAll((els) => els.map((e) => [e.loading, e.decoding, e.getAttribute('width'), e.getAttribute('height')].join()));
    assert.deepEqual(new Set(attrs), new Set([`lazy,async,${W},${H}`]));
    assert.ok(images.every((u) => u.startsWith(`/api/trace/${tracePane.id}/image/`)), 'through the pane\'s own route');
    await ctx.close();
  });

  await check('an image the server cannot serve says so', async () => {
    const { ctx, page } = await open({ breakRef: true });
    const rows = await imageRows(page);
    await rows.nth(0).locator('.cs-head').click();
    await rows.nth(0).locator('.trace-img-missing', { hasText: 'image unavailable' }).waitFor({ timeout: 10_000 });
    await ctx.close();
  });

  await check('an inline data-URL image from an older server still renders', async () => {
    const { ctx, page, images } = await open({ dataUrls: true });
    const rows = await imageRows(page);
    await rows.nth(0).locator('.cs-head').click();
    const img = rows.nth(0).locator('img.cs-img');
    await img.waitFor();
    assert.match(await img.getAttribute('src'), /^data:image\/png;base64,/);
    await page.waitForFunction((el) => el.complete && el.naturalWidth === 1, await img.elementHandle(), { timeout: 10_000 });
    assert.deepEqual(images, []);
    await ctx.close();
  });
} finally {
  await browser.close();
  await server.stop();
}

if (failed) { console.log(`traceImages: ${failed} failed`); process.exit(1); }
console.log('traceImages: ok');
