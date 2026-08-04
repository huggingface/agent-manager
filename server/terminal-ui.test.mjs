#!/usr/bin/env node
/**
 * Desktop terminal UX, in a real browser:
 *   - URLs in agent output are clickable and open in a new tab
 *   - copying a selection LEAVES the highlight up (it used to vanish instantly,
 *     which reads as "did that work?")
 *   - ...without letting that lingering selection shadow Ctrl+C's SIGINT
 *
 * Set TERMUI_PUBLIC_DIR to a prebuilt web/dist to skip the build.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-termui-'));
const PUBLIC_DIR = process.env.TERMUI_PUBLIC_DIR || path.join(DATA_DIR, 'public');
const API = 'http://127.0.0.1:7897';
const LINK = 'https://example.com/probe-link';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};
const waitFor = async (fn, timeout = 15_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { if (await fn()) return true; } catch {}
    await sleep(100);
  }
  return false;
};
const tail = async (id, lines = 400) =>
  (await (await fetch(`${API}/api/agents/${id}/tail?lines=${lines}`)).json()).text || '';

if (!process.env.TERMUI_PUBLIC_DIR) {
  const build = spawnSync('npm', ['run', 'build', '--', '--outDir', PUBLIC_DIR], {
    cwd: path.join(ROOT, 'web'), encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`web build failed:\n${build.stdout}\n${build.stderr}`);
}

const backend = spawn('node', ['src/index.js'], {
  cwd: HERE,
  env: { ...process.env, PORT: '7897', DATA_DIR, PUBLIC_DIR, AM_BASHRC: '/nonexistent', SPACE_HOST: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
backend.stdout.on('data', (d) => { logs += d; });
backend.stderr.on('data', (d) => { logs += d; });

let browser;
let feed;
let id;
try {
  if (!await waitFor(() => fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false), 60_000)) {
    throw new Error(`server did not start:\n${logs.slice(-2000)}`);
  }
  await fetch(`${API}/api/welcome/seen`, { method: 'POST' });
  const created = await (await fetch(`${API}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cli: 'shell', name: 'terminal-ui-e2e', path: '.' }),
  })).json();
  id = created.id;
  if (!id) throw new Error(`session creation failed: ${JSON.stringify(created)}`);

  // Put the fixture text on screen before any browser attaches, so the pane is
  // painted from the server's grid exactly as a reattaching client would be.
  feed = new WebSocket(`ws://127.0.0.1:7897/ws?session=${id}&cols=120&rows=30`);
  await new Promise((resolve, reject) => { feed.once('open', resolve); feed.once('error', reject); });
  await sleep(400);
  feed.send(JSON.stringify({ t: 'i', d: `printf 'docs at ${LINK} end\\nSELECT-ME-9137 tail\\n'\r` }));
  if (!await waitFor(async () => (await tail(id)).includes('SELECT-ME-9137 tail'))) {
    throw new Error('fixture output never reached the terminal');
  }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  // Serve the link locally: the assertion is about which URL was opened, and a
  // test must not depend on reaching the public internet.
  await context.route('https://example.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>probe</title>ok' }));

  const page = await context.newPage();
  await page.goto(API, { waitUntil: 'domcontentloaded' });
  await page.locator('.sidebar .row').filter({ hasText: 'terminal-ui-e2e' }).first().click();
  const screen = page.locator('.tile-terminal:not(.tile-cached) .xterm-screen');
  await screen.waitFor({ state: 'visible' });
  await waitFor(async () => await page.evaluate(() =>
    document.querySelector('.xterm-rows')?.textContent?.includes('SELECT-ME-9137')));

  // Exact pixel rect of a substring on screen, via a DOM Range over the text
  // node that holds it — no cell-size arithmetic to get wrong.
  const rectOf = (needle) => page.evaluate((text) => {
    const rows = [...document.querySelectorAll('.tile-terminal:not(.tile-cached) .xterm-rows > div')];
    for (const row of rows) {
      if (!row.textContent.includes(text)) continue;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent.indexOf(text);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        const r = range.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }
    }
    return null;
  }, needle);

  // ---------- 1. clickable links ----------
  const linkRect = await rectOf(LINK);
  let opened = null;
  context.on('page', (p) => { opened = p; });
  if (linkRect) {
    await page.mouse.move(linkRect.x + linkRect.width / 2, linkRect.y + linkRect.height / 2);
    await sleep(150); // let the link layer resolve the hover
    await page.mouse.click(linkRect.x + linkRect.width / 2, linkRect.y + linkRect.height / 2);
  }
  await waitFor(() => opened !== null, 5_000);
  const openedUrl = opened ? opened.url() : null;
  check('clicking a URL in terminal output opens it in a new tab',
    openedUrl === LINK, JSON.stringify({ openedUrl, hadRect: !!linkRect }));
  if (opened) await opened.close();

  // ---------- 2. a copy keeps the selection ----------
  // Something long-running to interrupt later, started before the selection so
  // the Ctrl+C presses below have a real process to reach.
  // The marker is split with bash quoting on purpose: the tty echoes the typed
  // command, so a verbatim marker would appear on screen without ever running.
  // Only actual execution prints the joined string.
  await page.keyboard.type('sleep 60 && echo NOT_""INTERRUPTED\n');
  await sleep(600);
  const wordRect = await rectOf('SELECT-ME-9137');
  if (!wordRect) throw new Error('fixture word not found on screen');
  const midY = wordRect.y + wordRect.height / 2;
  await page.mouse.move(wordRect.x + 1, midY);
  await page.mouse.down();
  await page.mouse.move(wordRect.x + wordRect.width - 1, midY, { steps: 8 });
  await page.mouse.up();
  await sleep(200);
  const selectionRects = () => page.evaluate(() =>
    document.querySelectorAll('.tile-terminal:not(.tile-cached) .xterm-selection div').length);
  const beforeCopy = await selectionRects();
  await page.keyboard.press('Control+c');
  await sleep(300);
  const afterCopy = await selectionRects();
  const clipboard = await page.evaluate(() =>
    navigator.clipboard.readText().catch((e) => `ERR:${e.message}`));
  check('copying a selection leaves the highlight in place',
    beforeCopy > 0 && afterCopy > 0,
    JSON.stringify({ beforeCopy, afterCopy }));
  check('the copy still reaches the clipboard',
    clipboard.includes('SELECT-ME-9137'), JSON.stringify({ clipboard: clipboard.slice(0, 60) }));

  // ---------- 3. the copied selection stops shadowing SIGINT ----------
  await page.keyboard.press('Control+c');
  await sleep(800);
  await page.keyboard.type('echo AFTER_""INTERRUPT\n');
  const backAtPrompt = await waitFor(async () => (await tail(id)).includes('AFTER_INTERRUPT'));
  const text = await tail(id);
  check('a second Ctrl+C interrupts instead of copying again',
    backAtPrompt && !text.includes('NOT_INTERRUPTED'),
    JSON.stringify({ backAtPrompt, sleepSurvived: text.includes('NOT_INTERRUPTED') }));

  // ---------- 4. Cmd+C is never an interrupt ----------
  const second = await rectOf('AFTER_INTERRUPT');
  if (second) {
    const y2 = second.y + second.height / 2;
    await page.mouse.move(second.x + 1, y2);
    await page.mouse.down();
    await page.mouse.move(second.x + second.width - 1, y2, { steps: 8 });
    await page.mouse.up();
    await sleep(200);
    await page.keyboard.press('Meta+c');
    await sleep(200);
    await page.keyboard.press('Meta+c');
    await sleep(200);
    check('repeated Cmd+C keeps copying and keeps the selection',
      (await selectionRects()) > 0, JSON.stringify({ rects: await selectionRects() }));
  } else {
    check('repeated Cmd+C keeps copying and keeps the selection', false, 'second fixture not found');
  }
} finally {
  try { feed?.close(); } catch {}
  try { await browser?.close(); } catch {}
  backend.kill('SIGKILL');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
