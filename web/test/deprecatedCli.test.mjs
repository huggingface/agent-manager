// A deprecated CLI in the real app: offered nowhere new, noticed everywhere old.
//
// Gemini CLI is deprecated (Google replaced it with Antigravity CLI). Its entry
// stays in GET /api/clis with `deprecated: true`, and the UI keys off that: no
// picker offers it for a new session, while an existing Gemini session stays in
// the sidebar and Overview with a tag and shows the notice in its pane.
//
// The existing session is seeded into sessions.json before the server starts,
// because the API refuses to create one now. A stub `gemini` makes the CLI
// "installed", so it is hidden for being deprecated, not for being absent.
// Run with:  node test/deprecatedCli.test.mjs
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

const GEMINI_ID = 'old-gemini-abc123';
const dist = buildWeb(spawnSync, 'am-deprecated-dist-');
const server = await startFixtureServer({
  publicDir: dist, tag: 'am-deprecated-',
  seed: ({ dataDir, binDir }) => {
    fs.writeFileSync(path.join(binDir, 'gemini'), '#!/bin/sh\n[ "$1" = --version ] && echo 0.0.0 && exit 0\necho "fixture gemini stub"; sleep 3600\n', { mode: 0o755 });
    fs.mkdirSync(path.join(dataDir, 'workspaces', 'gem'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify([{
      id: GEMINI_ID, name: 'old-gemini', cli: 'gemini', path: 'gem',
      sessionUuid: '00000000-0000-4000-8000-0000000ge001', createdAt: '2026-10-01T00:00:00.000Z', everStarted: true,
    }]));
  },
});
const browser = await chromium.launch(chromiumLaunchOptions());

async function open(restore = 'overview') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.addInitScript((ref) => { localStorage.setItem('am-active-ref', ref); }, restore);
  await page.goto(server.origin + '/');
  await page.locator('.sidebar .row.session').first().waitFor({ timeout: 15_000 });
  return { ctx, page };
}
const geminiRow = (page) => page.locator('.sidebar .row.session').filter({ has: page.locator('.name', { hasText: /^old-gemini$/ }) });

try {
  console.log('the catalog says so');
  await check('gemini is deprecated in GET /api/clis, and still installed', async () => {
    const gemini = (await server.api('/api/clis')).find((c) => c.id === 'gemini');
    assert.equal(gemini.deprecated, true);
    assert.equal(gemini.replacement, 'antigravity');
    assert.equal(gemini.available, true);
  });

  console.log('\nno picker offers it');
  await check('the quick-start row has Claude and no Gemini', async () => {
    const { ctx, page } = await open();
    await page.locator('.icon-btn[title="New agent or group"]').click();
    await page.locator('.quick-cli[title^="Claude Code"]').waitFor();
    assert.equal(await page.locator('.quick-cli[title^="Gemini"]').count(), 0);
    await ctx.close();
  });
  await check('the group cart has Claude and no Gemini', async () => {
    const { ctx, page } = await open();
    await page.locator('.icon-btn[title="New agent or group"]').click();
    await page.locator('.quick-grp').click();
    await page.locator('.cart-row .cart-name', { hasText: 'Claude Code' }).waitFor();
    assert.equal(await page.locator('.cart-row .cart-name', { hasText: 'Gemini' }).count(), 0);
    await ctx.close();
  });

  console.log('\nthe existing session stays, with the notice');
  await check('its sidebar row is there and tagged', async () => {
    const { ctx, page } = await open();
    const tag = geminiRow(page).locator('.deprecated-tag');
    await tag.waitFor();
    assert.match(await tag.getAttribute('title'), /Gemini CLI is deprecated: Google replaced it with Antigravity CLI/);
    // Only the deprecated one: a Claude row carries no tag.
    assert.equal(await page.locator('.sidebar .row.session').filter({ has: page.locator('.name', { hasText: /^cadence$/ }) }).locator('.deprecated-tag').count(), 0);
    await ctx.close();
  });
  await check('its Overview card is tagged', async () => {
    const { ctx, page } = await open();
    const card = page.locator('.ovt-tile, .ov-card').filter({ hasText: 'old-gemini' });
    await card.locator('.deprecated-tag').waitFor({ timeout: 15_000 });
    await ctx.close();
  });
  await check('its pane opens and shows the notice under the header', async () => {
    const { ctx, page } = await open();
    await geminiRow(page).click();
    const banner = page.locator('.slot .deprecated-banner');
    await banner.waitFor({ timeout: 15_000 });
    assert.match(await banner.textContent(), /This session still works; start new ones with Antigravity\./);
    await page.locator('.slot .pane-head .ph-name', { hasText: 'old-gemini' }).waitFor();
    await ctx.close();
  });
} finally {
  await browser.close();
  await server.stop();
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
