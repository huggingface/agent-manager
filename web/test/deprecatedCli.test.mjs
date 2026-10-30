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
    // A cron saved on gemini before the deprecation: still editable, never re-typed.
    fs.writeFileSync(path.join(dataDir, 'crons.json'), JSON.stringify([{
      id: 'cron_gem', name: 'gem-job', agent: { name: 'old-gemini', cli: 'gemini' }, prompt: 'Run gem-job.',
      schedule: { cron: '0 0 1 1 *', tz: 'UTC' }, runOnRestart: false, state: 'running',
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
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

  await check('the group row + (contextual NewSession) has Claude and no Gemini', async () => {
    const { ctx, page } = await open();
    await page.locator('.g-add').first().click();
    await page.locator('.agent-pick', { hasText: 'Claude Code' }).waitFor();
    assert.equal(await page.locator('.agent-pick', { hasText: 'Gemini' }).count(), 0);
    await ctx.close();
  });

  const openCron = async () => {
    const opened = await open();
    await opened.page.locator('.icon-btn[title="Settings"]').click();
    await opened.page.locator('.settings-navitem', { hasText: 'Cron' }).click();
    await opened.page.locator('.cron-table tbody tr').first().waitFor({ timeout: 15_000 });
    return opened;
  };
  const cronTypes = (page) => page.locator('.cron-clis button').allTextContents();
  await check('a new cron job is not offered Gemini', async () => {
    const { ctx, page } = await openCron();
    const types = await cronTypes(page);
    assert.ok(types.some((t) => /Claude Code/.test(t)), types.join('|'));
    assert.ok(!types.some((t) => /Gemini/.test(t)), types.join('|'));
    await ctx.close();
  });
  await check('editing a saved Gemini cron keeps its type, and Cancel hides it again', async () => {
    const { ctx, page } = await openCron();
    // The name cell: the row's middle is its action buttons, which stop the click.
    await page.locator('.cron-table tbody td.cron-name', { hasText: 'gem-job' }).click();
    await page.locator('.cron-clis button[aria-pressed="true"]', { hasText: 'Gemini' }).waitFor();
    await page.locator('#cron-job-name').fill('gem-job renamed');
    await page.getByRole('button', { name: 'Update job' }).click();
    await page.locator('.cron-table tbody tr', { hasText: 'gem-job renamed' }).waitFor();
    const job = (await server.api('/api/crons')).crons.find((j) => j.id === 'cron_gem');
    assert.equal(job.name, 'gem-job renamed');
    assert.equal(job.agent.cli, 'gemini');
    await page.getByRole('button', { name: 'Cancel' }).click();
    assert.ok(!(await cronTypes(page)).some((t) => /Gemini/.test(t)));
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

  console.log('\nthe UI follows the catalog, not the id');
  await check('a catalog that deprecates Claude hides Claude and tags its session with that note', async () => {
    const NOTE = 'Claude is deprecated in this test catalog.';
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.route('**/api/clis', async (route) => {
      const clis = await (await route.fetch()).json();
      await route.fulfill({ json: clis.map((c) => c.id === 'claude' ? { ...c, deprecated: true, replacement: 'codex', deprecationNote: NOTE } : c) });
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => { localStorage.setItem('am-active-ref', 'overview'); });
    await page.goto(server.origin + '/');
    const tag = page.locator('.sidebar .row.session').filter({ has: page.locator('.name', { hasText: /^cadence$/ }) }).locator('.deprecated-tag');
    await tag.waitFor({ timeout: 15_000 });
    assert.equal(await tag.getAttribute('title'), NOTE);
    await page.locator('.icon-btn[title="New agent or group"]').click();
    await page.locator('.quick-cli').first().waitFor();
    assert.equal(await page.locator('.quick-cli[title^="Claude Code"]').count(), 0);
    await ctx.close();
  });
} finally {
  await browser.close();
  await server.stop();
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
