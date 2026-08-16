#!/usr/bin/env node
/**
 * The reader's info panel, in a real browser:
 *   - the bar carries controls, not facts: no model chip, count or date inline;
 *   - the `i` opens on a TAP (not hover) and holds every fact the bar used to,
 *     including the two that were title attributes a phone cannot open;
 *   - it closes on Escape and on a press outside it;
 *   - it offers the transcript as a file, and that URL really answers;
 *   - it offers Share, which is the same dialog the sidebar opens;
 *   - the sidebar no longer carries a trace widget, and Settings does.
 *
 * Set READER_INFO_PUBLIC_DIR to a prebuilt web/dist to skip the build, and
 * READER_INFO_PORT to move off the default when suites run in parallel.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../scripts/test-chromium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-reader-info-'));
const DATA_DIR = path.join(TMP, 'data');
const HOME = path.join(TMP, 'home');
const PUBLIC_DIR = process.env.READER_INFO_PUBLIC_DIR || path.join(TMP, 'public');
const PORT = process.env.READER_INFO_PORT || '7899';
const API = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(HOME, '.claude', 'projects', 'am'), { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const waitFor = async (fn, timeout = 15_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { if (await fn()) return true; } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
};

if (!process.env.READER_INFO_PUBLIC_DIR) {
  const build = spawnSync('npm', ['run', 'build', '--', '--outDir', PUBLIC_DIR], {
    cwd: path.join(ROOT, 'web'), encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`web build failed:\n${build.stdout}\n${build.stderr}`);
}

// A test server must not publish skills — see migration.test.mjs for why.
const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...BASE_ENV } = process.env;
const backend = spawn('node', ['src/index.js'], {
  cwd: HERE,
  env: {
    ...BASE_ENV,
    PORT, DATA_DIR, PUBLIC_DIR, HOME, CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
    AM_BASHRC: '/nonexistent', SPACE_HOST: '', AM_ALLOW_MISSING_ORIGIN: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
backend.stdout.on('data', (d) => { logs += d; });
backend.stderr.on('data', (d) => { logs += d; });

let browser;
try {
  if (!await waitFor(() => fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false), 60_000)) {
    throw new Error(`server did not start:\n${logs.slice(-2000)}`);
  }
  await fetch(`${API}/api/welcome/seen`, { method: 'POST' });

  const created = await (await fetch(`${API}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cli: 'claude', name: 'reader-info-e2e', path: 'ri' }),
  })).json();
  const id = created.id;

  // A real transcript on disk, so the download link is answered by the real
  // route rather than a mock: the rendering is mocked below, the file is not.
  const workdir = path.join(DATA_DIR, 'workspaces', 'ri');
  const transcript = path.join(HOME, '.claude', 'projects', 'am', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({
    type: 'user', cwd: workdir, timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  })}\n`);

  browser = await chromium.launch(chromiumLaunchOptions());
  // A touch device with no mouse: `tap()` here is a real touch sequence, which
  // is the point — the facts this panel holds were unreachable on a phone when
  // they lived in title attributes.
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, hasTouch: true });
  const page = await context.newPage();

  const startedAt = Date.UTC(2026, 0, 14, 9, 30);
  const traceTurns = [
    { role: 'user', ts: startedAt, blocks: [{ type: 'text', text: 'fixture prompt' }] },
    { role: 'assistant', kind: 'final', ts: startedAt + 1000, blocks: [{ type: 'text', text: 'fixture answer' }] },
  ];
  await page.route(`**/api/trace/${id}?*`, async (route) => {
    const common = {
      harness: 'claude', harnessLabel: 'Claude Code', sessionId: id,
      title: 'reader-info-e2e', model: 'claude-fixture-5', cwd: '.', firstTs: startedAt,
      lastTs: startedAt + 1000, usage: { in: 12_000, out: 3_400, cacheRead: 8_000 },
      note: null, total: 2, truncated: false, userTurns: [0],
    };
    if (new URL(route.request().url()).searchParams.has('summary')) return route.fulfill({ json: common });
    return route.fulfill({ json: {
      ...common, turns: traceTurns, offset: 0, limit: 2,
      window: { mode: 'index', start: 0, end: 2, atStart: true, atEnd: true },
    } });
  });

  await page.goto(API);
  await page.locator('.sidebar .row[title^="reader-info-e2e"]').first().click();
  await page.locator('.modebar button', { hasText: 'reader' }).click();
  await page.locator('.cxv-bar').waitFor({ state: 'visible', timeout: 20_000 });

  // 1. The bar is controls now. Every fact below is asserted present in the
  //    panel, so this cannot pass by the facts having been dropped.
  const barText = (await page.locator('.cxv-bar').innerText()).trim();
  check('the bar no longer carries the conversation facts',
    !barText.includes('claude-fixture-5') && !/\bturns?\b/.test(barText) && !barText.includes('Jan'),
    JSON.stringify({ barText }));
  check('search and turn navigation stay on the bar, not behind the i',
    await page.locator('.cxv-bar .cxv-search').isVisible()
      && await page.locator('.cxv-bar .cxv-nav').isVisible());

  // 2. The tap target is bigger than the circle it draws. WCAG 2.2 SC 2.5.8
  //    floors a target at 24x24, and this button is the only route to five
  //    facts that used to need no tap at all. Measured by hit-testing rather
  //    than by reading the CSS: an overlay counts as its own element, so this
  //    stays honest if the technique changes.
  const target = await page.evaluate(() => {
    const btn = document.querySelector('.cxv-info-btn');
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hits = (dx, dy) => {
      const el = document.elementFromPoint(cx + dx, cy + dy);
      return !!el && (el === btn || btn.contains(el));
    };
    let halfW = 0;
    while (halfW < 40 && hits(halfW + 1, 0) && hits(-(halfW + 1), 0)) halfW += 1;
    let halfH = 0;
    while (halfH < 40 && hits(0, halfH + 1) && hits(0, -(halfH + 1))) halfH += 1;
    return { w: halfW * 2, h: halfH * 2, circle: Math.round(r.width) };
  });
  check('the i is a 24px-plus tap target, whatever size the circle is drawn at',
    target.w >= 24 && target.h >= 24, JSON.stringify(target));

  // 3. It opens by touch, and holds what the bar used to.
  check('the info panel is shut until asked', await page.locator('.cxv-info').count() === 0);
  await page.locator('.cxv-info-btn').tap();
  await page.locator('.cxv-info').waitFor({ state: 'visible' });
  // The whole-file summary lands a moment after the first paint; the panel
  // shows what is loaded until then, and the message total once it has it.
  await waitFor(async () => (await page.locator('.cxv-info').innerText()).includes('2 messages'), 5_000);
  const facts = await page.locator('.cxv-info').innerText();
  check('the model is in the panel', facts.includes('claude-fixture-5'), JSON.stringify({ facts }));
  check('the turn and message counts are in the panel',
    /\b1 turn\b/.test(facts) && facts.includes('2 messages'), JSON.stringify({ facts }));
  check('the token counts are in the panel', /12(\.0)?k/i.test(facts) && /3(\.4)?k/i.test(facts),
    JSON.stringify({ facts }));
  // The two that used to be title attributes: on a touch device they could not
  // be read at all before, so they are plain text here.
  check('cached tokens are text, not a tooltip', /8[,.]?0?0?0?k?\s+cached/i.test(facts), JSON.stringify({ facts }));
  check('the start date is text, and the full timestamp with it',
    facts.includes('14 Jan') || facts.includes('Jan 14'),
    JSON.stringify({ facts }));
  const startedLine = facts.split('\n').find((l) => /14 Jan|Jan 14/.test(l)) || '';
  check('the full timestamp is spelled out rather than hovered',
    /\d{1,2}:\d{2}/.test(startedLine), JSON.stringify({ startedLine }));

  // 4. The transcript, as a file — and the URL really answers.
  const href = await page.locator('.cxv-info-actions a[download]').getAttribute('href');
  const downloaded = await fetch(`${API}${href}`);
  const downloadedText = await downloaded.text();
  check('the panel offers the transcript and that URL answers with the file',
    href === `/api/trace/${id}/download` && downloaded.status === 200
      && downloadedText === fs.readFileSync(transcript, 'utf8'),
    JSON.stringify({ href, status: downloaded.status, bytes: downloadedText.length }));

  // 5. Dismissal, both ways.
  await page.keyboard.press('Escape');
  check('Escape closes the panel', await page.locator('.cxv-info').count() === 0);
  await page.locator('.cxv-info-btn').tap();
  await page.locator('.cxv-info').waitFor({ state: 'visible' });
  await page.locator('.cxv-body').tap({ position: { x: 20, y: 320 } });
  check('a press outside closes the panel',
    await waitFor(async () => await page.locator('.cxv-info').count() === 0, 2_000));

  // 6. Share, from the reader — the same dialog the sidebar row opens.
  await page.locator('.cxv-info-btn').tap();
  await page.locator('.cxv-info-actions button', { hasText: 'Share' }).tap();
  const shareOpen = await waitFor(async () => await page.locator('.share-card').isVisible(), 5_000);
  check('Share in the panel opens the share dialog', shareOpen);
  check('the share dialog offers the same download',
    await page.locator('.share-card a[download]').getAttribute('href') === `/api/trace/${id}/download`);
  await page.keyboard.press('Escape');

  // 7. The sidebar widget is gone, and its one irreplaceable function is not.
  check('the sidebar has no trace widget left',
    await page.locator('.quick-add button', { hasText: 'Trace' }).count() === 0
      && await page.locator('.open-trace').count() === 0);
  await page.locator('.sidebar .set-btn, .sidebar button[title="Settings"]').first().click();
  const traceRow = page.locator('.setting-row', { hasText: 'Open a shared trace' });
  await traceRow.waitFor({ state: 'visible', timeout: 10_000 });
  check('opening a shared trace moved to Settings, with its own input',
    await traceRow.locator('input').isVisible());
} catch (e) {
  check('no exceptions', false, String(e && e.message ? e.message : e));
  console.log(`--- server log tail ---\n${logs.slice(-1200)}`);
} finally {
  try { await browser?.close(); } catch { /* already gone */ }
  backend.kill('SIGKILL');
  // The server writes repin hooks into this HOME as it dies, so the tree can
  // grow back under the walk. A leftover temp dir is not worth a failed run.
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* the OS will */ }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
