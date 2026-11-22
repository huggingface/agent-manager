#!/usr/bin/env node
/**
 * Selecting a quiet agent must not make it look busy (#242).
 *
 * "working" means the agent's screen changed in the last BUSY_SECS. Selecting a
 * pane whose size differs from its PTY's resizes the PTY, and the TUI repaints
 * itself at the new size: that repaint used to count as a change, so every
 * agent you clicked on spun for ~4 s. This runs three real Claude Code panes
 * (no login, isolated HOME: the first-run screen is enough of a TUI), changes
 * the window size, then clicks between them while sampling /api/tree.
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-pane-switch-'));
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
  const NAMES = ['sw-a', 'sw-b', 'sw-c'];
  for (const name of NAMES) {
    await fetch(`${API}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cli: 'claude', name, path: name }) });
  }
  const states = async () => Object.fromEntries((await (await fetch(`${API}/api/tree`)).json()).sessions.map((s) => [s.name, s.state]));
  const rowOf = (name) => page.locator(`.sidebar .tree .row.session[title^="${name}"]`).first();

  browser = await chromium.launch(chromiumLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.addInitScript(() => { try { localStorage.setItem('am-pane-mode', 'terminal'); } catch {} });
  await page.goto(API);
  for (const name of NAMES) { await rowOf(name).click(); await sleep(1_000); }

  // Settled: every agent waiting, and still waiting five seconds later.
  const settled = async () => {
    if (!Object.values(await states()).every((s) => s === 'waiting')) return false;
    await sleep(5_000);
    return Object.values(await states()).every((s) => s === 'waiting');
  };
  check('three idle Claude panes settle', await waitFor(settled, 60_000), JSON.stringify(await states()));

  // A different window size: each pane now resizes its PTY when it is selected.
  await page.setViewportSize({ width: 900, height: 700 });
  const busy = Object.fromEntries(NAMES.map((n) => [n, 0]));
  for (let round = 0; round < 6; round++) {
    await rowOf(NAMES[round % NAMES.length]).click();
    for (let i = 0; i < 10; i++) {
      for (const [name, state] of Object.entries(await states())) if (state === 'working') busy[name] += 1;
      await sleep(300);
    }
  }
  check('switching between quiet agents never shows working', Object.values(busy).every((v) => v === 0), JSON.stringify(busy));
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
console.log('\npane switch: a resize repaint is not activity');
