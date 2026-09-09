#!/usr/bin/env node
/**
 * The reader's info panel, in a real browser:
 *   - the bar carries controls, not facts: no model chip, count or date inline;
 *   - the `i` opens on a TAP (not hover) and holds every fact the bar used to,
 *     including the two that were title attributes a phone cannot open;
 *   - it closes on Escape and on a press outside it;
 *   - it offers the transcript as a file, and that URL really answers;
 *   - it offers Share, which is the only place that dialog opens from now;
 *   - the sidebar no longer carries a trace widget, and Settings does.
 *
 * Set READER_INFO_PUBLIC_DIR to a prebuilt web/dist to skip the build, and
 * READER_INFO_PORT to move off the default when suites run in parallel.
 * am-test: manual — Chromium, a full web build and READER_INFO_PORT; `npm run test:ui`.
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
  let summaryCalls = 0;
  let releaseSummary = null;
  const holdSummary = () => new Promise((resolve) => { releaseSummary = resolve; });
  let summaryGate = null;
  await page.route(`**/api/trace/${id}?*`, async (route) => {
    const common = {
      harness: 'claude', harnessLabel: 'Claude Code', sessionId: id,
      title: 'reader-info-e2e', model: 'claude-fixture-5', cwd: '.', firstTs: startedAt,
      lastTs: startedAt + 1000, usage: { in: 12_000, out: 3_400, cacheRead: 8_000 },
      note: null, total: 2, truncated: false, userTurns: [0],
    };
    if (new URL(route.request().url()).searchParams.has('summary')) {
      summaryCalls += 1;
      if (summaryGate) await summaryGate;
      return route.fulfill({ json: common });
    }
    return route.fulfill({ json: {
      ...common, turns: traceTurns, offset: 0, limit: 2,
      window: { mode: 'index', start: 0, end: 2, atStart: true, atEnd: true },
    } });
  });

  // Panes are retained, so once a second session is opened `.pane-head` matches
  // more than one. Scope every header lookup to the pane that owns the name.
  const paneOf = (name) => page.locator('.slot', { has: page.locator('.ph-name', { hasText: name }) });
  const infoOf = (name) => paneOf(name).locator('.pane-head .tinfo-btn');

  await page.goto(API);
  await page.locator('.sidebar .row[title^="reader-info-e2e"]').first().click();

  // ---- the terminal view, which is where this had to become reachable -------
  // The pane opens on the terminal. The `i` is in the header, so it is here
  // too — and nothing has read the transcript yet, which is the point of the
  // lazy load: a whole-file parse for a panel nobody opened is a tax on every
  // pane. (docs/conversation-view.md §5)
  await infoOf('reader-info-e2e').waitFor({ state: 'visible', timeout: 20_000 });
  await sleep(1_200);
  check('a terminal pane reads nothing until the panel is opened',
    summaryCalls === 0, JSON.stringify({ summaryCalls }));
  check('the reader is not mounted, so this is the terminal view',
    await page.locator('.cxv-bar').count() === 0);

  // Every button in the header, not only the `i`: they lost their boxes, so the
  // target is invisible and the only way to know it is there is to hit-test it.
  // A neighbour's overlay can also steal an edge — at a 4px gap each of these
  // measured 20 across, under the floor — so this measures all of them.
  const sweep = () => page.evaluate(() => [...document.querySelectorAll('.pane-head .ph-btn')].map((btn) => {
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hits = (dx, dy) => {
      const el = document.elementFromPoint(cx + dx, cy + dy);
      return !!el && (el === btn || btn.contains(el));
    };
    let hw = 0;
    while (hw < 40 && hits(hw + 1, 0) && hits(-(hw + 1), 0)) hw += 1;
    let hh = 0;
    while (hh < 40 && hits(0, hh + 1) && hits(0, -(hh + 1))) hh += 1;
    return { cls: btn.className.replace('ph-btn ', ''), w: hw * 2, h: hh * 2, ink: Math.round(r.width) };
  }));
  const termTargets = await sweep();
  check('every header button is a 24px-plus tap target in the terminal view',
    termTargets.length >= 3 && termTargets.every((b) => b.w >= 24 && b.h >= 24),
    JSON.stringify(termTargets));
  check('and they are all one size, with no boxes',
    new Set(termTargets.map((b) => b.ink)).size === 1, JSON.stringify(termTargets.map((b) => b.ink)));

  // Hold the read so the in-flight state is observable: it must say what it is
  // doing rather than show a panel of blanks or a confident row of zeros.
  summaryGate = holdSummary();
  await infoOf('reader-info-e2e').tap();
  await page.locator('.tinfo').waitFor({ state: 'visible' });
  const loadingText = (await page.locator('.tinfo').innerText()).trim();
  check('while it reads, the panel says so instead of showing blanks',
    /reading the transcript/i.test(loadingText) && !loadingText.includes('Model'),
    JSON.stringify({ loadingText }));
  releaseSummary();
  summaryGate = null;
  // NOT `.tinfo-facts` — the Folder line renders that list before the read
  // returns, so waiting for it would prove nothing. Wait for a fact the file
  // has to answer for.
  await waitFor(async () => /Model/.test(await page.locator('.tinfo').innerText()), 8_000);
  const termFacts = await page.locator('.tinfo').innerText();
  check('and then the terminal view has the same facts the reader does',
    termFacts.includes('claude-fixture-5') && termFacts.includes('2 messages')
      && /8\.0k\s+cached/i.test(termFacts) && termFacts.includes('Jan 14'),
    JSON.stringify({ termFacts }));
  check('with the transcript offered from here as well',
    await page.locator('.tinfo-actions a[download]').getAttribute('href') === `/api/trace/${id}/download`);
  const afterFirstOpen = summaryCalls;
  await page.keyboard.press('Escape');
  await infoOf('reader-info-e2e').tap();
  await page.locator('.tinfo-facts').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  check('re-opening it does not read the file again', summaryCalls === afterFirstOpen,
    JSON.stringify({ afterFirstOpen, summaryCalls }));

  // ---- and the reader, which hands its own head to the same panel ----------
  await page.locator('.modebar button', { hasText: 'reader' }).click();
  // Wait for the independent reader surface.
  await page.locator('.cxv-body').waitFor({ state: 'visible', timeout: 20_000 });

  // The rearrangement the operator asked for: the working directory beside the
  // agent icon, the state mark immediately left of the centred name, and the
  // four controls together on the right.
  const layout = await page.evaluate(() => ({
    pathInLeft: !!document.querySelector('.pane-head .ph-left .ph-path'),
    pathInRight: !!document.querySelector('.pane-head .ph-right .ph-path'),
    // #92 moved state off a standalone dot and onto the CLI tile's frame, so it
    // now leads the row from `.ph-left` rather than the centred title. The old
    // shape of this assertion has been failing on main since that merged.
    stateOnTile: !!document.querySelector('.pane-head .ph-left .state-logo'),
    strayStatusDot: !!document.querySelector('.pane-head .status'),
    stateLeadsRow: (() => {
      const frame = document.querySelector('.pane-head .ph-left .state-logo');
      const name = document.querySelector('.pane-head .ph-name');
      return !!frame && !!name && frame.getBoundingClientRect().right <= name.getBoundingClientRect().left + 1;
    })(),
    rightOrder: [...document.querySelectorAll('.pane-head .ph-right .ph-btn')]
      .map((b) => b.className.replace('ph-btn ', '').split(' ')[0]),
  }));
  check('the working directory sits with the agent icon, not with the controls',
    layout.pathInLeft && !layout.pathInRight, JSON.stringify(layout));
  check('state rides the CLI tile at the head of the row, with no dot left behind',
    layout.stateOnTile && layout.stateLeadsRow && !layout.strayStatusDot, JSON.stringify(layout));
  check('attach, search, info and close are one cluster in that order',
    JSON.stringify(layout.rightOrder) === JSON.stringify(['ph-image', 'ph-search', 'tinfo-btn', 'ph-close']),
    JSON.stringify(layout.rightOrder));

  // Recovery/navigation stay available; search remains a deliberate disclosure.
  check('the reader opens with recovery controls and no search box',
    await page.locator('.cxv-status').count() === 1 && await page.locator('.cxv-search').count() === 0);
  await page.locator('.pane-head .ph-search').tap();
  await page.locator('.cxv-bar .cxv-search').waitFor({ state: 'visible', timeout: 5_000 });
  const barText = (await page.locator('.cxv-bar:not(.cxv-status)').innerText()).trim();
  check('the revealed bar carries search and the turn keys, and no facts',
    await page.getByRole('button', { name: 'Next matching turn', exact: true }).isVisible()
      && !barText.includes('claude-fixture-5') && !barText.includes('Jan'),
    JSON.stringify({ barText }));
  check('the search box takes focus when it appears',
    await page.evaluate(() => document.activeElement?.className?.includes('cxv-search')));

  // Closing search CLEARS the query. A live filter with no visible box is a
  // reader that looks broken — which is how a reviewer read it last round.
  await page.locator('.cxv-search').fill('nothing-matches-this');
  await waitFor(async () => await page.locator('.cxv-body .cx').count() === 0, 4_000);
  const filteredAway = await page.locator('.cxv-body .cx').count();
  await page.locator('.pane-head .ph-search').tap();
  await waitFor(async () => await page.locator('.cxv-search').count() === 0, 4_000);
  await waitFor(async () => await page.locator('.cxv-body .cx').count() > 0, 4_000);
  const backAgain = await page.locator('.cxv-body .cx').count();
  check('closing search clears the filter as well as the box',
    filteredAway === 0 && backAgain > 0,
    JSON.stringify({ filteredAway, backAgain }));
  await page.locator('.pane-head .ph-search').tap();
  await page.locator('.cxv-bar .cxv-search').waitFor({ state: 'visible' });
  check('and it comes back empty, not with the old query',
    (await page.locator('.cxv-search').inputValue()) === '');
  await page.locator('.pane-head .ph-search').tap();

  // 2. The tap target is bigger than the circle it draws. WCAG 2.2 SC 2.5.8
  //    floors a target at 24x24, and this button is the only route to five
  //    facts that used to need no tap at all. Measured by hit-testing rather
  //    than by reading the CSS: an overlay counts as its own element, so this
  //    stays honest if the technique changes.
  const readerTargets = await sweep();
  check('every header button keeps its target in the reader, search included',
    readerTargets.length >= 4 && readerTargets.every((b) => b.w >= 24 && b.h >= 24),
    JSON.stringify(readerTargets));

  // 3. It opens by touch, and holds what the bar used to.
  check('the info panel is shut until asked', await page.locator('.tinfo').count() === 0);
  await page.locator('.tinfo-btn').tap();
  await page.locator('.tinfo').waitFor({ state: 'visible' });
  // The whole-file summary lands a moment after the first paint; the panel
  // shows what is loaded until then, and the message total once it has it.
  await waitFor(async () => (await page.locator('.tinfo').innerText()).includes('2 messages'), 5_000);
  const facts = await page.locator('.tinfo').innerText();
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
  const href = await page.locator('.tinfo-actions a[download]').getAttribute('href');
  const downloaded = await fetch(`${API}${href}`);
  const downloadedText = await downloaded.text();
  check('the panel offers the transcript and that URL answers with the file',
    href === `/api/trace/${id}/download` && downloaded.status === 200
      && downloadedText === fs.readFileSync(transcript, 'utf8'),
    JSON.stringify({ href, status: downloaded.status, bytes: downloadedText.length }));

  // 5. Dismissal, both ways.
  await page.keyboard.press('Escape');
  check('Escape closes the panel', await page.locator('.tinfo').count() === 0);
  await page.locator('.tinfo-btn').tap();
  await page.locator('.tinfo').waitFor({ state: 'visible' });
  await page.locator('.cxv-body').tap({ position: { x: 20, y: 320 } });
  check('a press outside closes the panel',
    await waitFor(async () => await page.locator('.tinfo').count() === 0, 2_000));

  // 6. Share, from the reader. The sidebar row used to open this dialog too;
  //    since #86 the panel is the one place it comes from.
  await page.locator('.tinfo-btn').tap();
  await page.locator('.tinfo-actions button', { hasText: 'Share' }).tap();
  const shareOpen = await waitFor(async () => await page.locator('.share-card').isVisible(), 5_000);
  check('Share in the panel opens the share dialog', shareOpen);
  check('the share dialog offers the same download',
    await page.locator('.share-card a[download]').getAttribute('href') === `/api/trace/${id}/download`);
  await page.keyboard.press('Escape');

  // The reply row fills the composer. It stopped when the paperclip left column
  // 1 of that grid: auto-placed, the row took the `auto` track and sized to its
  // own content, leaving the send key stranded ~650px from the right edge. A
  // rendered measurement, because the CSS pin in composerAlign.test.mjs cannot
  // see what the browser actually laid out.
  const reach = async (label) => page.evaluate(() => {
    const comp = document.querySelector('.pane-reader .ov-composer');
    const live = comp?.querySelector('.ov-live');
    const send = comp?.querySelector('.ov-send');
    if (!comp || !live) return null;
    const c = comp.getBoundingClientRect();
    const l = live.getBoundingClientRect();
    const sd = send?.getBoundingClientRect();
    return { toEdge: Math.round(c.right - l.right), sendToEdge: sd ? Math.round(c.right - sd.right) : null,
      width: Math.round(l.width), of: Math.round(c.width) };
  }).then((v) => ({ label, ...v }));
  const emptyReach = await reach('empty');
  await page.locator('.pane-reader .ov-live textarea').fill('hello');
  await sleep(300);
  const typedReach = await reach('typed');
  check('the reply row reaches the composer edge, empty and typed',
    emptyReach.toEdge <= 24 && typedReach.toEdge <= 24
      && emptyReach.width > emptyReach.of / 2 && typedReach.width > typedReach.of / 2,
    JSON.stringify([emptyReach, typedReach]));
  check('so the send key sits at that edge, not in the middle of the row',
    typedReach.sendToEdge != null && typedReach.sendToEdge <= 24,
    JSON.stringify(typedReach));
  await page.locator('.pane-reader .ov-live textarea').fill('');

  // An agent that has not spoken has no transcript, and the panel's actions are
  // about a file that does not exist yet. Say that, and do not offer a link the
  // route would answer with `no-trace` (server/test/trace-download.test.mjs).
  const quiet = await (await fetch(`${API}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cli: 'claude', name: 'not-spoken-yet', path: 'ri2' }),
  })).json();
  await page.locator('.sidebar .row[title^="not-spoken-yet"]').first()
    .waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('.sidebar .row[title^="not-spoken-yet"]').first().click();
  await infoOf('not-spoken-yet').waitFor({ state: 'visible', timeout: 15_000 });
  await infoOf('not-spoken-yet').tap();
  await page.locator('.tinfo').waitFor({ state: 'visible' });
  const quietText = await waitFor(async () =>
    /no transcript yet/i.test(await page.locator('.tinfo').innerText()), 8_000);
  const quietFacts = (await page.locator('.tinfo').innerText()).trim();
  check('a session that has not spoken says so instead of showing zeros',
    quietText && !/Turns|Tokens|Started/.test(quietFacts) && /Folder/.test(quietFacts),
    JSON.stringify({ text: quietFacts, id: quiet.id }));
  check('and offers no download for a file that is not there',
    await page.locator('.tinfo-actions a[download]').count() === 0);
  await page.keyboard.press('Escape');

  // 7. The sidebar widget is gone, and its one irreplaceable function is not.
  check('the sidebar has no trace widget left',
    await page.locator('.quick-add button', { hasText: 'Trace' }).count() === 0
      && await page.locator('.open-trace').count() === 0);
  // …and the row is down to one control. Read-trace and Share left it because
  // the panel above now holds both; start and stop left it because the row
  // itself opens the pane and Ctrl-C interrupts a runaway better than a button.
  // What remains is archive, which is also the only route to deleting a
  // session. (docs/conversation-view.md §3.4)
  const rowActions = page.locator('.sidebar .row[title^="reader-info-e2e"]')
    .first().locator('.row-actions button');
  check('the session row carries exactly one control', await rowActions.count() === 1,
    `titles: ${JSON.stringify(await rowActions.evaluateAll((bs) => bs.map((b) => b.title)))}`);
  check('and that control archives',
    /archive/i.test(await rowActions.first().getAttribute('title') || ''));
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
