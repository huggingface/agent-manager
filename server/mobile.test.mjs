// Browser-level mobile terminal invariants.
//
// This deliberately starts with a desktop controller so opening the same
// session on a phone exercises the watcher -> controller handoff. Chromium's
// visual viewport is replaced with a controllable EventTarget so the keyboard
// test covers both viewport height and iOS's non-zero offsetTop.
//
//   npm run test:mobile
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-mobile-'));
const PUBLIC_DIR = process.env.MOBILE_PUBLIC_DIR || path.join(DATA_DIR, 'public');
const API = 'http://127.0.0.1:7896';
const WEB = API;
const CTRL = '\x00\x00AM:';
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

if (!process.env.MOBILE_PUBLIC_DIR) {
  const build = spawnSync('npm', ['run', 'build', '--', '--outDir', PUBLIC_DIR], {
    cwd: path.join(ROOT, 'web'), encoding: 'utf8',
  });
  if (build.status !== 0) {
    throw new Error(`mobile test web build failed:\n${build.stdout}\n${build.stderr}`);
  }
}

const backend = spawn('node', ['src/index.js'], {
  cwd: HERE,
  // Do not inherit the production Space hostname: this backend is deliberately
  // reached through localhost, and the origin guard should validate it as such.
  env: {
    ...process.env,
    PORT: '7896', DATA_DIR, PUBLIC_DIR, AM_BASHRC: '/nonexistent', SPACE_HOST: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
for (const child of [backend]) {
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
}

let browser;
let desktop;
let id;
try {
  const ready = await waitFor(async () => {
    return fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false);
  }, 60_000);
  if (!ready) throw new Error(`test servers did not start:\n${logs.slice(-2000)}`);
  await fetch(`${API}/api/welcome/seen`, { method: 'POST' });
  const created = await (await fetch(`${API}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cli: 'shell', name: 'mobile-terminal-e2e', path: '.' }),
  })).json();
  id = created.id;
  if (!id) throw new Error(`session creation failed: ${JSON.stringify(created)}`);

  const desktopFrames = [];
  desktop = new WebSocket(`ws://127.0.0.1:7896/ws?session=${id}&cols=140&rows=45`);
  desktop.on('message', (raw) => {
    const text = raw.toString();
    if (text.startsWith(CTRL)) desktopFrames.push(JSON.parse(text.slice(CTRL.length)));
  });
  await new Promise((resolve, reject) => {
    desktop.once('open', resolve);
    desktop.once('error', reject);
  });
  await sleep(400);
  desktop.send(JSON.stringify({
    t: 'i',
    d: "for i in $(seq 1 220); do printf 'MOBILE-HISTORY-%04d\\n' \"$i\"; done; printf '\\033[?1000h\\033[?1006h'\r",
  }));
  const historyReady = await waitFor(async () => {
    const body = await (await fetch(`${API}/api/agents/${id}/tail?lines=400`)).json();
    return body.text?.includes('MOBILE-HISTORY-0220');
  });
  if (!historyReady) throw new Error('history did not reach the terminal');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 },
    screen: { width: 375, height: 667 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  });
  await context.addInitScript(() => {
    const nativeWebSocket = window.WebSocket;
    window.__terminalSockets = [];
    class RecordedWebSocket extends nativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        if (String(url).includes('/ws?session=')) {
          const record = { url: String(url), sent: [], events: [] };
          window.__terminalSockets.push(record);
          this.addEventListener('open', () => record.events.push({ type: 'open' }));
          this.addEventListener('close', (event) => record.events.push({
            type: 'close', code: event.code, reason: event.reason,
          }));
          this.addEventListener('error', () => record.events.push({ type: 'error' }));
          this.addEventListener('message', (event) => {
            record.events.push({ type: 'message', dataType: typeof event.data });
            if (typeof event.data === 'string' && event.data.startsWith('\x00\x00AM:')) {
              try { record.lastFrame = JSON.parse(event.data.slice(5)); } catch {}
            }
          });
          const nativeSend = this.send;
          this.send = (data) => {
            try { record.sent.push(JSON.parse(String(data))); } catch {}
            return nativeSend.call(this, data);
          };
        }
      }
    }
    window.WebSocket = RecordedWebSocket;

    const viewport = new EventTarget();
    Object.assign(viewport, {
      width: 375, height: 667, offsetLeft: 0, offsetTop: 0,
      pageLeft: 0, pageTop: 0, scale: 1,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true, value: viewport,
    });
    window.__setVisualViewport = (height, offsetTop, width = viewport.width) => {
      viewport.width = width;
      viewport.height = height;
      viewport.offsetTop = offsetTop;
      viewport.pageTop = offsetTop;
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    };
  });
  const page = await context.newPage();
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.locator('.sidebar .row').filter({ hasText: 'mobile-terminal-e2e' }).first().click();
  await page.locator('.term-host .xterm-screen').waitFor({ state: 'visible' });

  const latestGrid = () => [...desktopFrames].reverse().find((frame) =>
    frame.t === 'grid' || frame.t === 'restore');
  const mobileClaimed = await waitFor(() => desktopFrames.some((frame) =>
    frame.t === 'grid' && frame.controller === false && frame.cols < 60));
  const initialSocket = await page.evaluate(() => window.__terminalSockets.at(-1));
  check('opening a session on mobile claims geometry before resizing',
    mobileClaimed && initialSocket?.sent?.some((message) => message.t === 'claim'),
    JSON.stringify({
      mobileClaimed,
      id,
      mobileUrl: initialSocket?.url,
      mobileFrame: initialSocket?.lastFrame,
      mobileEvents: initialSocket?.events,
      sent: initialSocket?.sent,
      desktopState: desktop.readyState,
      desktopLast: latestGrid(),
    }));

  const initialFit = await page.evaluate(() => {
    const host = document.querySelector('.term-host').getBoundingClientRect();
    const screen = document.querySelector('.term-host .xterm-screen').getBoundingClientRect();
    return { host: { width: host.width, height: host.height }, screen: { width: screen.width, height: screen.height } };
  });
  check('the initial mobile terminal fits its panel in both dimensions',
    initialFit.screen.width <= initialFit.host.width + 1
      && initialFit.screen.height <= initialFit.host.height + 1,
    JSON.stringify(initialFit));

  // If the initial-claim assertion failed, take control through the existing
  // explicit zoom path so scrolling and keyboard assertions remain diagnostic.
  if (!mobileClaimed) {
    await page.getByTitle('Zoom in').click();
    await page.getByTitle('Zoom out').click();
    await waitFor(() => desktopFrames.some((frame) => frame.controller === false));
  }
  await sleep(500);

  const portraitGrid = latestGrid();
  await page.setViewportSize({ width: 667, height: 375 });
  await page.evaluate(() => window.__setVisualViewport(375, 0, 667));
  const landscapeResized = await waitFor(() => {
    const frame = latestGrid();
    return frame?.cols > portraitGrid.cols && frame?.rows < portraitGrid.rows;
  });
  const landscapeFit = await page.evaluate(() => {
    const host = document.querySelector('.term-host').getBoundingClientRect();
    const screen = document.querySelector('.term-host .xterm-screen').getBoundingClientRect();
    return { host: { width: host.width, height: host.height }, screen: { width: screen.width, height: screen.height } };
  });
  check('orientation changes refit mobile rows and columns',
    landscapeResized && landscapeFit.screen.width <= landscapeFit.host.width + 1
      && landscapeFit.screen.height <= landscapeFit.host.height + 1,
    JSON.stringify({ landscapeResized, portraitGrid, landscape: latestGrid(), landscapeFit }));
  await page.setViewportSize({ width: 375, height: 667 });
  await page.evaluate(() => window.__setVisualViewport(667, 0, 375));
  await waitFor(() => {
    const frame = latestGrid();
    return frame?.cols === portraitGrid.cols && frame?.rows === portraitGrid.rows;
  });

  await waitFor(() => page.locator('.xterm-viewport').evaluate((node) =>
    node.scrollHeight > node.clientHeight));
  const returnedToBottom = await waitFor(() => page.locator('.xterm-viewport').evaluate((node) =>
    Math.abs(node.scrollTop - (node.scrollHeight - node.clientHeight)) <= 1));
  check('returning to portrait keeps a live terminal anchored at the bottom', returnedToBottom);

  const beforeScroll = await page.locator('.xterm-viewport').evaluate((node) => ({
    top: node.scrollTop, max: node.scrollHeight - node.clientHeight,
    area: node.querySelector('.xterm-scroll-area')?.getBoundingClientRect().height || 0,
  }));
  const hostBox = await page.locator('.term-host').boundingBox();
  const x = hostBox.x + hostBox.width / 2;
  const y = hostBox.y + Math.min(120, hostBox.height / 3);
  await page.locator('.term-host').dispatchEvent('touchstart', {
    touches: [{ identifier: 1, clientX: x, clientY: y }],
  });
  await page.locator('.term-host').dispatchEvent('touchmove', {
    touches: [{ identifier: 1, clientX: x, clientY: y + 96 }],
  });
  await page.locator('.term-host').dispatchEvent('touchend', { touches: [] });
  await sleep(100);
  const historyTop = await page.locator('.xterm-viewport').evaluate((node) => node.scrollTop);
  check('a downward touch drag enters local history even with mouse tracking enabled',
    beforeScroll.max > 0 && historyTop < beforeScroll.top,
    JSON.stringify({ beforeScroll, historyTop }));

  await page.locator('.term-host').dispatchEvent('touchstart', {
    touches: [{ identifier: 2, clientX: x, clientY: y + 96 }],
  });
  await page.locator('.term-host').dispatchEvent('touchmove', {
    touches: [{ identifier: 2, clientX: x, clientY: y }],
  });
  await page.locator('.term-host').dispatchEvent('touchend', { touches: [] });
  await sleep(100);
  const returnedScroll = await page.locator('.xterm-viewport').evaluate((node) => ({
    top: node.scrollTop, max: node.scrollHeight - node.clientHeight,
  }));
  check('the reverse touch drag returns to the live bottom',
    Math.abs(returnedScroll.top - returnedScroll.max) < 2,
    JSON.stringify(returnedScroll));

  const beforeKeyboardGrid = latestGrid();
  await page.locator('.term-host').click();
  await page.evaluate(() => window.__setVisualViewport(360, 118));
  const keyboardResized = await waitFor(() => {
    const frame = latestGrid();
    return frame?.controller === false && frame?.rows < beforeKeyboardGrid.rows;
  });
  const keyboardLayout = await page.evaluate(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return {
        top: box.top, right: box.right, bottom: box.bottom, left: box.left,
        width: box.width, height: box.height,
      };
    };
    const app = rect('.app');
    const host = rect('.term-host');
    const keybar = rect('.term-keybar');
    return {
      app,
      hostBottom: host?.bottom ?? null,
      keybarBottom: keybar?.bottom ?? null,
      vvh: getComputedStyle(document.documentElement).getPropertyValue('--vvh').trim(),
      vvtop: getComputedStyle(document.documentElement).getPropertyValue('--vv-top').trim(),
      pageScroll: window.scrollY,
    };
  });
  check('the app follows the keyboard-shrunken visual viewport',
    Math.abs(keyboardLayout.app.top - 118) < 1
      && Math.abs(keyboardLayout.app.height - 360) < 1
      && Math.abs(keyboardLayout.app.bottom - 478) < 1
      && Math.abs(keyboardLayout.app.left) < 1
      && Math.abs(keyboardLayout.app.width - 375) < 1,
    JSON.stringify(keyboardLayout));
  check('terminal input controls remain above the keyboard',
    keyboardResized && keyboardLayout.hostBottom <= 478 && keyboardLayout.keybarBottom <= 478,
    JSON.stringify({ keyboardResized, beforeKeyboardGrid, after: latestGrid(), keyboardLayout }));

  await page.evaluate(() => window.__setVisualViewport(667, 0));
  const keyboardClosed = await waitFor(() => latestGrid()?.rows >= beforeKeyboardGrid.rows);
  const restoredLayout = await page.locator('.app').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, height: rect.height };
  });
  check('closing the keyboard restores viewport and terminal geometry',
    keyboardClosed && Math.abs(restoredLayout.top) < 1 && Math.abs(restoredLayout.height - 667) < 1,
    JSON.stringify({ keyboardClosed, restoredLayout, grid: latestGrid() }));

  await context.close();
} catch (error) {
  check('mobile browser test completes', false, String(error?.stack || error));
  console.log(logs.slice(-3000));
} finally {
  try { desktop?.close(); } catch {}
  try { await browser?.close(); } catch {}
  if (id) await fetch(`${API}/api/sessions/${id}/stop`, { method: 'POST' }).catch(() => {});
  backend.kill('SIGTERM');
  await sleep(400);
  backend.kill('SIGKILL');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
