// How many session panes keep BOTH views warm, through the real App.
//
// Keeping a pane's terminal attached under its reader (and its reader mounted
// under its terminal) is what makes the reader <-> terminal toggle instant, and
// it costs a socket, an emulator and a rendered reader per pane. The App bounds
// it to the visible panes plus the last three seen (lib/warmPanes.ts). The
// review of #205 found the bound skipped on routes that show no pane at all:
// three single sessions, then a nine-agent group, then the Overview left all
// twelve warm. That path is replayed here, against a real backend and the
// production build, and counted in the DOM.
//
// Builds the web app into a temp dir (or uses $AM_TEST_DIST), boots the server
// on 7911 with the fixture fleet plus twelve stub Claude sessions.
// Run with:  node test/warmPanes.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
import { startFixtureServer, buildWeb } from './helpers/fixture-server.mjs';
import { nextWarmPanes } from '../src/lib/warmPanes.ts';

const PORT = 7911;
const LIMIT = 3;
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${String(e?.message || e).split('\n')[0]}`);
  }
};

console.log('the rule');
const ids = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);
let warm = [];
for (const id of ['a', 'b', 'c']) warm = nextWarmPanes(warm, [id], LIMIT);
warm = nextWarmPanes(warm, ids(9, 'g'), LIMIT);
check('a nine-pane page keeps its nine and the three before it', () => assert.deepEqual(warm, [...ids(9, 'g'), 'c', 'b', 'a']));
warm = nextWarmPanes(warm, [], LIMIT);
check('a route with no pane keeps only the last three', () => assert.deepEqual(warm, ['g1', 'g2', 'g3']));
check('an unchanged list is the same array (no re-render)', () => assert.equal(nextWarmPanes(warm, [], LIMIT), warm));
check('a deleted session drops out', () => assert.deepEqual(nextWarmPanes(warm, [], LIMIT, (id) => id !== 'g2'), ['g1', 'g3']));

const dist = buildWeb(spawnSync, 'am-warm-dist-');
const server = await startFixtureServer({ port: PORT, publicDir: dist, tag: 'am-warm-' });
const browser = await chromium.launch(chromiumLaunchOptions());
const errors = [];
try {
  const { api } = server;
  for (const n of ['solo-a', 'solo-b', 'solo-c']) await api('/api/sessions', 'POST', { name: n, cli: 'claude', path: n });
  const group = await api('/api/groups', 'POST', { name: 'ninegroup' });
  for (let i = 1; i <= 9; i++) await api('/api/sessions', 'POST', { name: `nine-${i}`, cli: 'claude', path: `nine-${i}`, groupId: group.id });

  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('am-active-ref', 'overview');
    localStorage.setItem('am-pane-mode', 'reader');
  });
  await page.goto(server.origin + '/');
  await page.locator('.sidebar .row').filter({ hasText: 'solo-a' }).first().waitFor({ timeout: 15_000 });

  const row = (name) => page.locator('.sidebar .row').filter({ hasText: name }).first();
  const toggle = (m) => page.locator(`.modebar button:${m === 'terminal' ? 'first-child' : 'last-child'}`).click();
  // Both views built for everything visible: reader, then terminal, then back.
  const buildBoth = async (panes) => {
    await page.waitForFunction((n) => document.querySelectorAll('.tile-terminal:not(.tile-cached) .pane-reader').length >= n, panes, { timeout: 20_000 });
    await toggle('terminal');
    await page.waitForFunction((n) => document.querySelectorAll('.tile-terminal:not(.tile-cached) .xterm').length >= n, panes, { timeout: 20_000 });
    await toggle('reader');
  };
  // Per retained tile: which views are still built.
  const census = () => page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.tile-terminal')];
    const both = tiles.filter((t) => t.querySelector('.pane-reader') && t.querySelector('.term-fill'));
    return { tiles: tiles.length, both: both.length,
      sockets: tiles.filter((t) => t.querySelector('.term-fill')).length };
  });

  console.log('\nthe App, three sessions and a nine-agent group');
  for (const n of ['solo-a', 'solo-b', 'solo-c']) { await row(n).click(); await buildBoth(1); }
  await row('ninegroup').click();
  await buildBoth(9);
  const onGroup = await census();
  check(`on the group: nine visible plus the last three keep both (${JSON.stringify(onGroup)})`, () => {
    assert.equal(onGroup.both, 12);
  });
  for (const [label, go] of [
    ['the Overview', () => page.locator('.sidebar').getByText('overview', { exact: true }).click()],
    ['Settings', () => page.locator('.sidebar button[title*="ettings"]').first().click()],
  ]) {
    await go();
    await page.waitForTimeout(400);
    const away = await census();
    check(`on ${label}: only the last ${LIMIT} keep both (${JSON.stringify(away)})`, () => {
      assert.equal(away.both, LIMIT);
      assert.ok(away.sockets <= LIMIT, 'and no other pane keeps its terminal under a hidden reader');
    });
  }
  assert.deepEqual(errors, [], 'no page errors');
} finally {
  await browser.close();
  await server.stop();
}
console.log(failed ? `\n${failed} failed` : '\nwarm-panes: both views stay warm for the visible panes and the last three only');
process.exit(failed ? 1 : 0);
