// The < 10 GB local-disk / boot-headroom warning, end to end:
// disk-health.js probe -> /api/info.disk -> lazy HealthBanners -> DiskBanner
// in the real production build.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
import { startFixtureServer, buildWeb } from './helpers/fixture-server.mjs';

const MiB = 1024 * 1024;
const LIMIT_BYTES = 20 * MiB;
const WARN_BYTES = 10 * MiB;

let failed = 0;
const check = async (what, fn) => {
  try { await fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${String((e && e.message) || e).split('\n').slice(0, 3).join('\n       ')}`);
  }
};

// Configure quota + fast 1s check interval before starting the fixture server.
process.env.AM_DISK_LIMIT_BYTES = String(LIMIT_BYTES);
process.env.AM_DISK_WARN_BYTES = String(WARN_BYTES);
process.env.AM_DISK_CHECK_SECONDS = '1';

const dist = buildWeb(spawnSync, 'am-disk-dist-');
let localDir;
const server = await startFixtureServer({
  publicDir: dist,
  tag: 'am-disk-',
  seed: ({ dataDir }) => {
    localDir = path.join(dataDir, 'local');
    fs.mkdirSync(localDir, { recursive: true });
  },
});
const browser = await chromium.launch(chromiumLaunchOptions());
const info = () => fetch(`${server.origin}/api/info`).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await pred();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for condition (last=${JSON.stringify(last)})`);
}

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const scripts = [];
  page.on('request', (r) => { if (r.resourceType() === 'script') scripts.push(r.url()); });
  await page.goto(`${server.origin}/`);
  await page.locator('.sidebar .row.session').first().waitFor({ timeout: 15_000 });
  return { ctx, page, scripts };
}

try {
  await check('healthy local disk: /api/info.disk is null, no banner renders, and HealthBanners is not fetched', async () => {
    await sleep(1200);
    assert.equal((await info()).disk, null);
    const { ctx, page, scripts } = await open();
    await sleep(800);
    assert.equal(await page.locator('.diskfail').count(), 0);
    assert.deepEqual(scripts.filter((u) => /HealthBanners/.test(u)), []);
    await ctx.close();
  });

  const filler = path.join(localDir, 'large-cache.bin');
  await check('crossing below free-space threshold: /api/info.disk reports lowDisk and the banner warns about boot risk', async () => {
    // 13 MiB used of 20 MiB limit => ~7 MiB free (< 10 MiB threshold).
    fs.writeFileSync(filler, Buffer.alloc(13 * MiB, 0x5a));
    const d = await waitUntil(async () => (await info()).disk);
    assert.equal(d.lowDisk, true);
    assert.equal(d.source, 'space-quota');
    assert.ok(d.freeBytes < WARN_BYTES, `freeBytes=${d.freeBytes}`);

    const { ctx, page, scripts } = await open();
    const banner = page.locator('.diskfail');
    await banner.waitFor({ timeout: 10_000 });
    const text = await banner.innerText();
    assert.match(text, /Local disk has .* left/);
    assert.match(text, /risks not being able to boot after a restart/);
    assert.match(text, /\$AM_LOCAL/);
    assert.equal(scripts.filter((u) => /HealthBanners/.test(u)).length, 1);
    await ctx.close();
  });

  await check('freeing local disk clears /api/info.disk back to null', async () => {
    fs.unlinkSync(filler);
    await waitUntil(async () => (await info()).disk === null);
    assert.equal((await info()).disk, null);
  });
} finally {
  await browser.close();
  await server.stop();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall disk-warning checks passed');
process.exit(failed ? 1 : 0);
