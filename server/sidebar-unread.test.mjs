#!/usr/bin/env node
/**
 * The sidebar's unread frame (#242) clears when the reply is read, in the real
 * app: real server, real web build, a real session row. Only the read tracking's
 * inputs are faked — /api/meta says the session has a reply, /api/read records
 * the acknowledgement, and the trace returns that reply — so the path under test
 * is App's own: reader shows the reply -> markSeen -> readLocal -> unreadIds ->
 * the row's frame.
 *
 *   - unread reply: the row has the accent ("done") frame;
 *   - selecting the row counts as reading it and clears the frame at once;
 *   - a newer reply brings it back, and the terminal view alone (the pane is
 *     already selected) does not clear it;
 *   - the reader showing the reply clears it;
 *   - a turn ending goes straight from the working spinner to done, with no
 *     bare-logo frame while /api/meta catches up with the tree.
 *
 * Set AM_TEST_DIST to a prebuilt web/dist to skip the build.
 * am-test: manual — Chromium and a full web build; `npm run test:ui`.
 */
import { nativeFetch as fetch } from './test/native-client.mjs';
import { freePort } from './test/free-port.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../scripts/test-chromium.mjs';
import { outputHash } from './src/output-id.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-sidebar-unread-'));
const DATA_DIR = path.join(TMP, 'data');
const HOME = path.join(TMP, 'home');
const PUBLIC_DIR = process.env.AM_TEST_DIST || path.join(TMP, 'public');
const PORT = String(await freePort());
const API = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });

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

if (!process.env.AM_TEST_DIST) {
  const build = spawnSync('npm', ['run', 'build', '--', '--outDir', PUBLIC_DIR], {
    cwd: path.join(ROOT, 'web'), encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`web build failed:\n${build.stdout}\n${build.stderr}`);
}

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
  const NAME = 'unread-e2e';
  const { id } = await (await fetch(`${API}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cli: 'claude', name: NAME, path: 'su' }),
  })).json();

  // The reply the session "has", and what the operator has read of it.
  const reply = (seq, text) => ({ text, version: { src: 'gen1', seq, hash: outputHash(text) } });
  let current = reply(2, 'fixture answer');
  let readMark = null;
  const acks = [];
  let treeState = 'waiting';

  browser = await chromium.launch(chromiumLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });

  // The agent is alive and (until the last step) waiting, so only unread
  // decides its frame.
  await page.route('**/api/tree', async (route) => {
    const tree = await (await route.fetch()).json();
    for (const s of tree.sessions) if (s.id === id) { s.state = treeState; s.inputRequired = null; }
    return route.fulfill({ json: tree });
  });
  await page.route('**/api/meta', async (route) => {
    const body = await (await route.fetch()).json();
    for (const s of body.sessions) if (s.id === id) { s.state = 'waiting'; s.output = current.version; s.read = readMark; }
    return route.fulfill({ json: body });
  });
  await page.route(`**/api/meta/${id}`, (route) => route.fulfill({ json: { id, digest: null, output: current.version, read: readMark } }));
  await page.route('**/api/read', async (route) => {
    const { marks } = route.request().postDataJSON();
    acks.push(...marks);
    const results = {};
    for (const m of marks) {
      const ok = m.id === id && m.src === current.version.src && m.seq === current.version.seq && m.hash === current.version.hash;
      if (ok) readMark = { ...current.version, at: new Date().toISOString() };
      results[m.id] = ok ? 'ok' : 'stale';
    }
    return route.fulfill({ json: { results } });
  });
  await page.route(`**/api/trace/${id}?*`, (route) => {
    const t0 = Date.UTC(2026, 10, 10, 9, 0);
    const common = {
      harness: 'claude', harnessLabel: 'Claude Code', sessionId: id, title: NAME, model: 'claude-fixture',
      cwd: '.', firstTs: t0, lastTs: t0 + 1000, usage: null, note: null, total: 2, truncated: false, userTurns: [0],
    };
    if (new URL(route.request().url()).searchParams.has('summary')) return route.fulfill({ json: common });
    return route.fulfill({ json: {
      ...common, offset: 0, limit: 2,
      turns: [
        { role: 'user', ts: t0, blocks: [{ type: 'text', text: 'fixture prompt' }] },
        { role: 'assistant', kind: 'final', ts: t0 + 1000, blocks: [{ type: 'text', text: current.text }] },
      ],
      window: { mode: 'index', start: 0, end: 2, atStart: true, atEnd: true },
    } });
  });

  // Start in the terminal view, which must NOT count as reading.
  await page.addInitScript(() => { try { localStorage.setItem('am-pane-mode', 'terminal'); } catch {} });
  await page.goto(API);
  const row = page.locator(`.sidebar .tree .row.session[title^="${NAME}"]`).first();
  const mark = () => row.locator('.state-logo').getAttribute('class');

  check('an unread reply gives the row the accent frame',
    await waitFor(async () => / unread/.test(await mark()), 15_000), await mark());
  check('and brightens its name', await row.evaluate((el) => el.classList.contains('attention')));

  await row.click();
  const acked = (v) => acks.some((m) => m.id === id && m.hash === v.hash);
  check('selecting the row acknowledges the reply', await waitFor(() => acked(current.version), 10_000), JSON.stringify(acks));
  check('and the frame clears', await waitFor(async () => / read/.test(await mark()), 5_000), await mark());
  check('the name goes back to muted', !(await row.evaluate((el) => el.classList.contains('attention'))));

  // A newer reply while the pane is already open in the terminal view.
  current = reply(3, 'a newer answer');
  check('a newer reply brings the frame back',
    await waitFor(async () => / unread/.test(await mark()), 20_000), await mark());
  await sleep(2_500);
  check('the terminal view alone does not clear it', / unread/.test(await mark()) && !acked(current.version),
    JSON.stringify({ cls: await mark(), acks: acks.length }));

  await page.locator('button[title^="Reader mode"]').first().click();
  check('the reader showing the reply acknowledges it', await waitFor(() => acked(current.version), 15_000), JSON.stringify(acks));
  check('and the frame clears again', await waitFor(async () => / read/.test(await mark()), 5_000), await mark());

  // A new turn. The tree and meta are polled separately (2.5s and 8s off the
  // Overview), so the tree reports the turn over before meta has seen the
  // reply; every painted frame from then on is recorded. Back in the terminal
  // view (the init script), where nothing else fetches meta for this session.
  await page.reload();
  await waitFor(async () => / read/.test(await mark()), 15_000);
  treeState = 'working';
  check('a new turn shows the spinner', await waitFor(async () => / working/.test(await mark()), 10_000), await mark());
  await page.evaluate((name) => {
    window.__marks = [];
    const tick = () => {
      const el = document.querySelector(`.sidebar .tree .row.session[title^="${name}"] .state-logo`);
      const m = el && / (working|blocked|unread|read|off)\b/.exec(el.getAttribute('class'));
      const last = window.__marks[window.__marks.length - 1];
      if (m && m[1] !== last) window.__marks.push(m[1]);
      window.__marksRaf = requestAnimationFrame(tick);
    };
    tick();
  }, NAME);
  current = reply(4, 'the answer to the new turn');
  treeState = 'waiting';
  check('the finished turn shows done', await waitFor(async () => / unread/.test(await mark()), 15_000), await mark());
  const seen = await page.evaluate(() => { cancelAnimationFrame(window.__marksRaf); return window.__marks; });
  check('working goes straight to done, never through a bare logo',
    JSON.stringify(seen) === JSON.stringify(['working', 'unread']), JSON.stringify(seen));
} catch (error) {
  failures += 1;
  console.log(`FAIL  ${error.stack || error}`);
  console.log(logs.slice(-1500));
} finally {
  await browser?.close();
  backend.kill('SIGTERM');
  await sleep(300);
  fs.rmSync(TMP, { recursive: true, force: true });
}
if (failures) { console.log(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nsidebar unread: selecting the row or reading the reply clears the frame; a newer reply brings it back');
