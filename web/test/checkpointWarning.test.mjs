// The checkpoint warning, end to end: the status files scripts/agent-state.sh
// writes → /api/info → the banner in the real app, from the production build.
// A failing adapter shows nothing for its first five minutes and a clear line
// after; a healthy Space fetches no banner code at all.
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

const dist = buildWeb(spawnSync, 'am-ckpt-dist-');
let statusDir;
const server = await startFixtureServer({
  publicDir: dist, tag: 'am-ckpt-',
  seed: ({ dataDir }) => { statusDir = path.join(dataDir, 'local', 'agent-state-status'); fs.mkdirSync(statusDir, { recursive: true }); },
});
const browser = await chromium.launch(chromiumLaunchOptions());
const secondsAgo = (s) => Math.floor(Date.now() / 1000) - s;
// What a failed pass leaves behind (record_fail in scripts/agent-state.sh).
const failing = (adapter, sinceSeconds, extra = {}) => fs.writeFileSync(path.join(statusDir, adapter), Object.entries({
  adapter, last_attempt: secondsAgo(2), last_success: '', failures: Math.ceil(sinceSeconds / 15), failing_since: secondsAgo(sinceSeconds),
  rc: 23, pending: 0, untested: 12, copied: 0,
  reason: 'rsync: [sender] send_files failed to open "/home/node/local/agent-state/claude/projects/a/bad.jsonl": Permission denied (13)',
  paths: 'projects/a/bad.jsonl', ...extra,
}).map(([k, v]) => `${k}=${v}\n`).join(''));
const info = () => fetch(server.origin + '/api/info').then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const scripts = [];
  page.on('request', (r) => { if (r.resourceType() === 'script') scripts.push(r.url()); });
  await page.goto(server.origin + '/');
  await page.locator('.sidebar .row.session').first().waitFor({ timeout: 15_000 });
  return { ctx, page, scripts };
}

try {
  await check('healthy: /api/info says null, no banner, and its chunk is never fetched', async () => {
    fs.writeFileSync(path.join(statusDir, 'codex'), `adapter=codex\nlast_attempt=${secondsAgo(1)}\nlast_success=${secondsAgo(1)}\nfailures=0\n`);
    fs.writeFileSync(path.join(statusDir, '_pass'), `finished=${secondsAgo(1)}\n`);
    assert.equal((await info()).checkpoint, null);
    const { ctx, page, scripts } = await open();
    await sleep(1000);
    assert.equal(await page.locator('.ckfail').count(), 0);
    assert.deepEqual(scripts.filter((u) => /HealthBanners/.test(u)), []);
    await ctx.close();
  });

  await check('failing for one minute: still nothing', async () => {
    failing('claude', 60);
    await sleep(5500); // the server caches the status for 5 s
    assert.equal((await info()).checkpoint, null);
  });

  await check('failing for more than five minutes, with no success since boot: the warning names the adapter and the reason', async () => {
    failing('claude', 400);
    await sleep(5500);
    const h = (await info()).checkpoint;
    assert.deepEqual(h.adapters.map((a) => a.adapter), ['claude']);
    assert.equal(h.adapters[0].lastSuccessAt, null);
    assert.equal(h.adapters[0].rc, 23);
    assert.match(h.log, /state\/agent-state\.log$/);
    const { ctx, page, scripts } = await open();
    const banner = page.locator('.ckfail');
    await banner.waitFor({ timeout: 10_000 });
    const text = await banner.innerText();
    assert.match(text, /Claude Code sessions are not being saved\./);
    assert.match(text, /No complete save since this Space started/);
    assert.match(text, /Permission denied \(13\)/);
    assert.equal(scripts.filter((u) => /HealthBanners/.test(u)).length, 1);
    if (process.env.AM_CKPT_SHOT) await page.screenshot({ path: process.env.AM_CKPT_SHOT });
    await ctx.close();
  });

  await check('one stuck file while everything else is saved: the line says that instead', async () => {
    failing('claude', 400, { pending: 1, untested: 0 });
    await sleep(5500);
    const { ctx, page } = await open();
    await page.locator('.ckfail', { hasText: 'Claude Code: 1 file is not being backed up.' }).waitFor({ timeout: 10_000 });
    assert.doesNotMatch(await page.locator('.ckfail').innerText(), /sessions are not being saved/);
    await ctx.close();
  });

  await check('recovered: the warning goes away', async () => {
    fs.writeFileSync(path.join(statusDir, 'claude'), `adapter=claude\nlast_attempt=${secondsAgo(1)}\nlast_success=${secondsAgo(1)}\nfailures=0\n`);
    await sleep(5500);
    assert.equal((await info()).checkpoint, null);
  });
} finally {
  await browser.close();
  await server.stop();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checkpoint-warning checks passed');
process.exit(failed ? 1 : 0);
