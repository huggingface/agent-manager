#!/usr/bin/env node
/**
 * The remote pane's state row and its receipts, against the real server and the
 * real component:
 *   - the state sits between the log and the composer, in all three states, and
 *     the bottom context row no longer says it a second time;
 *   - the mark is the app's `.state-mark`: `working` animates the braille
 *     spinner, `listening` and `not connected` draw its completed path;
 *   - a message's receipt sits under the message, on its text's left edge, and
 *     says `pending` until a poll collects it and `delivered` after;
 *   - that transition does not move the log — the two receipts are one height,
 *     so nothing below a message shifts when its receipt lands;
 *   - the mark grows with the pane's zoom control, like the rest of the pane.
 *
 * The states are produced the way the product produces them, not by poking
 * classes on: `working` is an uncollected operator message, `listening` is the
 * agent having answered it, `not connected` is Disconnect.
 *
 * Set REMOTE_PANE_PUBLIC_DIR to a prebuilt web/dist to skip the build,
 * REMOTE_PANE_PORT to pin the port, and REMOTE_PANE_SHOTS to a directory to
 * write PNGs of each state.
 * am-test: manual — Chromium, a full web build and a free port; `npm run test:ui`.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../scripts/test-chromium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-remote-pane-'));
const DATA_DIR = path.join(TMP, 'data');
const HOME = path.join(TMP, 'home');
const PUBLIC_DIR = process.env.REMOTE_PANE_PUBLIC_DIR || path.join(TMP, 'public');
const SHOTS = process.env.REMOTE_PANE_SHOTS || '';
// A free port by default: this machine runs a fleet of these apps, and the
// fixed-port suites here have already produced flakes that read as product bugs.
const PORT = process.env.REMOTE_PANE_PORT || String(await new Promise((res) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)); });
}));
const API = `http://127.0.0.1:${PORT}`;
const NAME = 'laptop-carver';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const waitFor = async (fn, timeout = 20_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { if (await fn()) return true; } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
};

if (!process.env.REMOTE_PANE_PUBLIC_DIR) {
  const build = spawnSync('npm', ['run', 'build', '--', '--outDir', PUBLIC_DIR], {
    cwd: path.join(ROOT, 'web'), encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`web build failed:\n${build.stdout}\n${build.stderr}`);
}

// A test server must not publish skills — see migration.test.mjs for why. And
// PUBLIC_DIR is set in the Space this often runs inside: inherit it and the
// whole suite measures the deployed bundle instead of the build under test.
const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...BASE_ENV } = process.env;
const backend = spawn('node', ['src/index.js'], {
  cwd: HERE,
  env: {
    ...BASE_ENV,
    PORT, DATA_DIR, PUBLIC_DIR, HOME,
    AM_BASHRC: '/nonexistent', SPACE_HOST: '', AM_ALLOW_MISSING_ORIGIN: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
backend.stdout.on('data', (d) => { logs += d; });
backend.stderr.on('data', (d) => { logs += d; });

const json = async (p, opt) => {
  const r = await fetch(API + p, opt);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};
const post = (p, body, type = 'application/json') =>
  json(p, { method: 'POST', headers: { 'content-type': type }, body: type === 'application/json' ? JSON.stringify(body) : body });

let browser;
try {
  if (!await waitFor(() => fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false), 60_000)) {
    throw new Error(`server did not start:\n${logs.slice(-2000)}`);
  }
  await post('/api/welcome/seen', {});

  const made = await post('/api/sessions', { name: NAME, cli: 'remote' });
  if (!made.id) throw new Error(`could not create a remote agent: ${JSON.stringify(made)}`);
  const id = made.id;
  const say = (text) => post(`/api/sessions/${id}/input`, { text });
  // `agent=1` is the agent's own short poll: it stamps liveness and marks
  // everything it returns delivered. That is where a receipt comes from.
  const agentPoll = (since) => json(`/api/remote/${NAME}/messages?agent=1&since=${since}`);
  const agentSay = (text) => post(`/api/remote/${NAME}/messages`, text, 'text/plain');

  await agentPoll(0);
  await say('can you check the tokenizer on the 7B run?');
  const collected = await agentPoll(0);
  await agentSay('Checked — the merges file is stale. I rebuilt it and the eval matches now.');
  const LONG = 'when you are back: pull the new cuts and re-render scene 4 at 60fps, '
    + 'then tell me the render time and whether the audio drifted on the long take';
  await say(LONG);

  browser = await chromium.launch(chromiumLaunchOptions());
  const page = await (await browser.newContext({
    viewport: { width: 1200, height: 820 }, deviceScaleFactor: 2,
  })).newPage();

  const read = () => page.evaluate(() => {
    const row = document.querySelector('.rp-staterow');
    const mark = row?.querySelector('.state-mark');
    const log = document.querySelector('.rp-body');
    const composer = document.querySelector('.rp-composer');
    const before = mark && getComputedStyle(mark, '::before');
    const users = [...document.querySelectorAll('.rp-user')].map((u) => {
      const text = u.querySelector('.rp-user-text').getBoundingClientRect();
      const r = u.querySelector('.rp-receipt');
      const box = r.getBoundingClientRect();
      return {
        words: u.querySelector('.rp-user-text').textContent,
        receipt: r.textContent.trim(),
        kind: r.className.replace('rp-receipt', '').trim(),
        alignedLeft: Math.abs(box.x - text.x) < 1,
        below: box.y >= text.y + text.height - 1,
        height: u.getBoundingClientRect().height,
      };
    });
    return {
      state: row?.querySelector('.rp-state')?.textContent,
      markClass: mark?.className,
      markGlyph: before?.content,
      markAnimation: before?.animationName,
      markStroke: parseFloat(before?.borderTopWidth) || 0,
      markSize: mark && parseFloat(getComputedStyle(mark).fontSize),
      rowSize: row && parseFloat(getComputedStyle(row).fontSize),
      belowLog: row && log && row.getBoundingClientRect().top >= log.getBoundingClientRect().bottom - 1,
      aboveComposer: row && composer && row.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top + 1,
      bottomRow: document.querySelector('.rp-status')?.textContent || '',
      users,
      scroll: log && { top: log.scrollTop, height: log.scrollHeight },
    };
  });
  const shot = async (file) => {
    if (!SHOTS) return;
    await (await page.$('.slot')).screenshot({ path: path.join(SHOTS, file) });
  };

  await page.goto(API, { waitUntil: 'domcontentloaded' });
  const row = page.locator('.sidebar .row.session[data-ref^="s:"]').filter({ hasText: NAME }).first();
  await row.waitFor({ timeout: 20_000 });
  await row.click();
  await page.waitForSelector('.rp-staterow', { timeout: 20_000 });
  await sleep(600);

  // ---- working: the newest word is the operator's, and it is not collected ----
  const working = await read();
  await shot('01-working-pending.png');
  check('the state row is below the log', working.belowLog === true);
  check('and above the composer', working.aboveComposer === true);
  check('it says working', working.state === 'working', working.state);
  check('the mark is the app state vocabulary', working.markClass === 'state-mark working', working.markClass);
  check('working animates the shared spinner', working.markAnimation === 'ov-spin', working.markAnimation);
  check('on a braille glyph from the contract', /[⠋⠙⠹⠸⠼⠴⠦⠧]/.test(working.markGlyph || ''), working.markGlyph);
  check('the bottom row does not say the state again',
    !/working|listening|not connected/.test(working.bottomRow), working.bottomRow);
  check('and still says where the agent is, and when it was last heard from',
    /remote-agents\/laptop-carver/.test(working.bottomRow) && /last seen/.test(working.bottomRow), working.bottomRow);

  check('both messages carry a receipt', working.users.length === 2, `${working.users.length} messages`);
  check('the collected one says delivered', working.users[0]?.receipt === 'delivered', working.users[0]?.receipt);
  check('the uncollected one says pending', working.users[1]?.receipt === 'pending', working.users[1]?.receipt);
  for (const [i, u] of working.users.entries()) {
    check(`message ${i + 1}: the receipt is under its text`, u.below === true);
    check(`message ${i + 1}: on the text's left edge`, u.alignedLeft === true);
  }
  check('the long message really did wrap', (working.users[1]?.height || 0) > (working.users[0]?.height || 0),
    `${working.users[1]?.height} vs ${working.users[0]?.height}`);

  // ---- the receipt lands: the log must not move ----
  // Fill the log first. A receipt landing in a log that fits its box proves
  // nothing about a pinned one, and this pane pins to the bottom.
  for (let i = 0; i < 45; i++) {
    await agentSay(`Frame ${i + 1}: colour pass done, waiting on the audio conform before the next take.`);
  }
  if (!await waitFor(() => page.evaluate(() => document.querySelectorAll(".rp-agent").length >= 46), 25_000)) {
    throw new Error('the filler messages never arrived in the pane');
  }
  const beforeLand = await page.evaluate(() => {
    const el = document.querySelector('.rp-body');
    el.scrollTop = el.scrollHeight;      // as a pinned log sits
    return { top: el.scrollTop, height: el.scrollHeight };
  });
  await agentPoll(collected.seq ?? 1);
  if (!await waitFor(() => page.evaluate(() =>
    [...document.querySelectorAll('.rp-receipt')].every((r) => r.classList.contains('ack'))), 25_000)) {
    throw new Error('the receipt never landed');
  }
  const afterLand = await page.evaluate(() => {
    const el = document.querySelector('.rp-body');
    return { top: el.scrollTop, height: el.scrollHeight };
  });
  check('the log really is scrolled, so this measures a pinned one', beforeLand.top > 0,
    `scrollTop ${beforeLand.top}`);
  check('the log is exactly as tall after the receipt lands', beforeLand.height === afterLand.height,
    `${beforeLand.height} -> ${afterLand.height}`);
  check('and has not scrolled', beforeLand.top === afterLand.top, `${beforeLand.top} -> ${afterLand.top}`);

  // ---- listening: the agent answered, so nothing is outstanding ----
  await agentSay('Rendered scene 4 at 60fps in 3m12s. No audio drift on the long take.');
  if (!await waitFor(() => page.evaluate(() =>
    document.querySelector('.rp-staterow .rp-state')?.textContent === 'listening'), 25_000)) {
    throw new Error(`state never fell back to listening: ${(await read()).state}`);
  }
  const listening = await read();
  await shot('02-listening-delivered.png');
  check('listening keeps the mark still', listening.markAnimation === 'none', listening.markAnimation);
  check('and draws the completed path instead of a glyph',
    listening.markGlyph === '""' && listening.markStroke >= 1, `${listening.markGlyph} / ${listening.markStroke}px`);
  check('every receipt now says delivered',
    listening.users.every((u) => u.receipt === 'delivered'), JSON.stringify(listening.users.map((u) => u.receipt)));

  // ---- the pane's zoom moves the mark with everything else ----
  for (let i = 0; i < 5; i++) await page.getByTitle('Zoom in').first().click();
  await sleep(400);
  const zoomed = await read();
  await shot('03-listening-zoomed.png');
  check('zooming the pane grows the row', zoomed.rowSize > listening.rowSize,
    `${listening.rowSize}px -> ${zoomed.rowSize}px`);
  check('and grows the mark by the same ratio',
    Math.abs((zoomed.markSize / listening.markSize) - (zoomed.rowSize / listening.rowSize)) < 0.02,
    `mark ${listening.markSize}px -> ${zoomed.markSize}px`);
  for (let i = 0; i < 5; i++) await page.getByTitle('Zoom out').first().click();

  // ---- not connected: Disconnect, the operator's own off switch ----
  await post(`/api/sessions/${id}/remote/paused`, { paused: true });
  if (!await waitFor(() => page.evaluate(() =>
    document.querySelector('.rp-staterow .rp-state')?.textContent === 'not connected'), 25_000)) {
    throw new Error('state never reported the disconnection');
  }
  const off = await read();
  await shot('04-not-connected.png');
  check('not connected draws the same still path', off.markGlyph === '""' && off.markStroke >= 1,
    `${off.markGlyph} / ${off.markStroke}px`);
  check('and is muted rather than shaped differently', off.markClass === 'state-mark stopped', off.markClass);
  check('the row is still between the log and the composer', off.belowLog === true && off.aboveComposer === true);

  console.log(failures ? `\n${failures} failed` : '\nremote pane: state row and receipts ok');
} finally {
  if (browser) await browser.close();
  backend.kill('SIGKILL');
  fs.rmSync(TMP, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
