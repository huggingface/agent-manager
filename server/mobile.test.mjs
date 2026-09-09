// Browser-level mobile terminal invariants.
//
// This deliberately starts with a desktop controller so opening the same
// session on a phone exercises the watcher -> controller handoff. Chromium's
// visual viewport is replaced with a controllable EventTarget so the keyboard
// test covers both viewport height and iOS's non-zero offsetTop.
//
// am-test: manual — Chromium, a full web build and port 7896; `npm run test:mobile`.
//   npm run test:mobile
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../scripts/test-chromium.mjs';
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

// A test server must not publish skills — the same strip migration.test.mjs and
// resize.test.mjs already do, and for the same reason: `SPACE_ID` is set when this
// runs inside the Space itself, and skillTargetDirs() then fans this checkout's
// skill templates into every live agent's skills dir. Those paths come from $HOME,
// NOT from DATA_DIR, so a throwaway DATA_DIR does not contain the damage.
const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...BASE_ENV } = process.env;

const backend = spawn('node', ['src/index.js'], {
  cwd: HERE,
  // Do not inherit the production Space hostname: this backend is deliberately
  // reached through localhost, and the origin guard should validate it as such.
  env: {
    ...BASE_ENV,
    PORT: '7896', DATA_DIR, PUBLIC_DIR, AM_BASHRC: '/nonexistent', SPACE_HOST: '', AM_ALLOW_MISSING_ORIGIN: '1',
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
let secondId;
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
  const second = await (await fetch(`${API}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cli: 'shell', name: 'mobile-terminal-second', path: '.' }),
  })).json();
  secondId = second.id;
  if (!secondId) throw new Error(`second session creation failed: ${JSON.stringify(second)}`);

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

  browser = await chromium.launch(chromiumLaunchOptions());
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
          Object.defineProperty(record, 'sendRaw', {
            value: (data) => this.send(data),
          });
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
    class OfflineWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = OfflineWebSocket.CONNECTING;
      binaryType = 'blob';
      send() {}
      close() { this.readyState = OfflineWebSocket.CLOSED; }
    }
    let offline = false;
    try { offline = localStorage.getItem('__am_test_offline_sockets') === '1'; } catch {}
    window.WebSocket = offline ? OfflineWebSocket : RecordedWebSocket;

    const viewport = new EventTarget();
    Object.assign(viewport, {
      width: 375, height: 667, offsetLeft: 0, offsetTop: 0,
      pageLeft: 0, pageTop: 0, scale: 1,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true, value: viewport,
    });
    const virtualKeyboard = new EventTarget();
    virtualKeyboard.boundingRect = new DOMRect(0, 667, 375, 0);
    Object.defineProperty(navigator, 'virtualKeyboard', {
      configurable: true, value: virtualKeyboard,
    });
    window.__setVirtualKeyboard = (top, height, width = viewport.width) => {
      virtualKeyboard.boundingRect = new DOMRect(0, top, width, height);
      virtualKeyboard.dispatchEvent(new Event('geometrychange'));
    };
    window.__setVisualViewport = (height, offsetTop, width = viewport.width) => {
      viewport.width = width;
      viewport.height = height;
      viewport.offsetTop = offsetTop;
      viewport.pageTop = offsetTop;
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    };
    // Safari can fire with the final height but a stale zero offset, then update
    // offsetTop without another event. Focus stabilization must catch that.
    window.__setVisualViewportLate = (height, offsetTop, delay = 80) => {
      viewport.height = height;
      viewport.offsetTop = 0;
      viewport.pageTop = 0;
      viewport.dispatchEvent(new Event('resize'));
      setTimeout(() => {
        viewport.offsetTop = offsetTop;
        viewport.pageTop = offsetTop;
      }, delay);
    };
  });
  const page = await context.newPage();
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.locator('.sidebar .row').filter({ hasText: 'mobile-terminal-e2e' }).first().click();
  await page.locator('.tile-terminal:not(.tile-cached) .xterm-screen').waitFor({ state: 'visible' });

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
    const host = document.querySelector('.tile-terminal:not(.tile-cached) .term-host').getBoundingClientRect();
    const screen = document.querySelector('.tile-terminal:not(.tile-cached) .xterm-screen').getBoundingClientRect();
    return { host: { width: host.width, height: host.height }, screen: { width: screen.width, height: screen.height } };
  });
  check('the initial mobile terminal fits its panel in both dimensions',
    initialFit.screen.width <= initialFit.host.width + 1
      && initialFit.screen.height <= initialFit.host.height + 1,
    JSON.stringify(initialFit));

  // Switching to another session and back must retain the original xterm and
  // WebSocket. A mobile Back alone was never sufficient to catch this: it only
  // hides the whole stage without changing activeRef.
  const firstSocketUrl = initialSocket.url;
  await page.getByTitle('Back to list').click();
  await page.locator('.sidebar .row').filter({ hasText: 'mobile-terminal-second' }).first().click();
  await page.locator('.tile-terminal:not(.tile-cached) .xterm-screen').waitFor({ state: 'visible' });
  const secondOpened = await waitFor(() => page.evaluate(() => window.__terminalSockets.length === 2));

  // Keep writing to the first session while its retained xterm is under
  // display:none. xterm keeps the logical viewport at the live bottom, but a
  // hidden DOM viewport cannot accept that pixel scrollTop. Re-activation must
  // reconcile the two before the first wheel event uses the stale DOM value.
  await page.evaluate(({ sessionId, input }) => {
    const socket = window.__terminalSockets.find((item) => item.url.includes(`session=${sessionId}`));
    socket?.sendRaw(JSON.stringify({ t: 'i', d: input }));
  }, {
    sessionId: id,
    input: "printf '\\033[?1000l\\033[?1006l'; for i in $(seq 221 280); do printf 'MOBILE-HISTORY-%04d\\n' \"$i\"; done\r",
  });
  const hiddenOutputReady = await waitFor(async () => {
    const body = await (await fetch(`${API}/api/agents/${id}/tail?lines=400`)).json();
    return body.text?.includes('MOBILE-HISTORY-0280');
  });
  await page.getByTitle('Back to list').click();
  await page.locator('.sidebar .row').filter({ hasText: 'mobile-terminal-e2e' }).first().click();
  await page.locator('.tile-terminal:not(.tile-cached) .xterm-screen').waitFor({ state: 'visible' });
  await sleep(250);
  const retained = await page.evaluate((url) => {
    const matching = window.__terminalSockets.filter((socket) => socket.url === url);
    const cachedTiles = [...document.querySelectorAll('.tile-terminal')];
    return {
      matching: matching.length,
      closed: matching.flatMap((socket) => socket.events).some((event) => event.type === 'close'),
      terminals: document.querySelectorAll('.tile-terminal .xterm').length,
      hidden: cachedTiles.filter((tile) => getComputedStyle(tile).display === 'none').length,
    };
  }, firstSocketUrl);
  check('switching sessions reuses the original terminal and socket',
    secondOpened && retained.matching === 1 && !retained.closed
      && retained.terminals === 2 && retained.hidden === 1,
    JSON.stringify({ secondOpened, retained }));
  const reactivatedScroll = await page.locator('.tile-terminal:not(.tile-cached) .xterm-viewport').evaluate((node) => ({
    top: node.scrollTop,
    max: node.scrollHeight - node.clientHeight,
  }));
  check('a retained terminal restores its DOM viewport before wheel input',
    hiddenOutputReady && reactivatedScroll.max > 0
      && Math.abs(reactivatedScroll.top - reactivatedScroll.max) <= 1,
    JSON.stringify({ hiddenOutputReady, reactivatedScroll }));
  await page.locator('.tile-terminal:not(.tile-cached) .xterm').dispatchEvent('wheel', {
    deltaY: -96, deltaMode: 0,
  });
  await sleep(100);
  const wheelTop = await page.locator('.tile-terminal:not(.tile-cached) .xterm-viewport').evaluate((node) => node.scrollTop);
  check('the first upward wheel after re-activation scrolls into history',
    wheelTop < reactivatedScroll.top - 1,
    JSON.stringify({ before: reactivatedScroll.top, after: wheelTop }));
  await page.locator('.tile-terminal:not(.tile-cached) .xterm-viewport').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await sleep(100);
  const hiddenMessagesBeforeZoom = await page.evaluate((sessionId) => {
    const socket = window.__terminalSockets.find((item) => item.url.includes(`session=${sessionId}`));
    return socket?.sent?.length ?? -1;
  }, secondId);
  await page.getByTitle('Zoom in').click();
  await page.getByTitle('Zoom out').click();
  await sleep(250);
  const hiddenMessagesAfterZoom = await page.evaluate((sessionId) => {
    const socket = window.__terminalSockets.find((item) => item.url.includes(`session=${sessionId}`));
    return socket?.sent?.length ?? -1;
  }, secondId);
  check('zooming the active pane does not claim or resize a hidden cached pane',
    hiddenMessagesBeforeZoom >= 0 && hiddenMessagesAfterZoom === hiddenMessagesBeforeZoom,
    JSON.stringify({ hiddenMessagesBeforeZoom, hiddenMessagesAfterZoom }));

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
    const host = document.querySelector('.tile-terminal:not(.tile-cached) .term-host').getBoundingClientRect();
    const screen = document.querySelector('.tile-terminal:not(.tile-cached) .xterm-screen').getBoundingClientRect();
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

  await waitFor(() => page.locator('.tile-terminal:not(.tile-cached) .xterm-viewport').evaluate((node) =>
    node.scrollHeight > node.clientHeight));
  const returnedToBottom = await waitFor(() => page.locator('.tile-terminal:not(.tile-cached) .xterm-viewport').evaluate((node) =>
    Math.abs(node.scrollTop - (node.scrollHeight - node.clientHeight)) <= 1));
  check('returning to portrait keeps a live terminal anchored at the bottom', returnedToBottom);

  const beforeScroll = await page.locator('.tile-terminal:not(.tile-cached) .xterm-viewport').evaluate((node) => ({
    top: node.scrollTop, max: node.scrollHeight - node.clientHeight,
    area: node.querySelector('.xterm-scroll-area')?.getBoundingClientRect().height || 0,
  }));
  const messagesBeforeScroll = await page.evaluate(() =>
    window.__terminalSockets.reduce((count, socket) => count + socket.sent.length, 0));
  await page.evaluate((sessionId) => {
    const original = Storage.prototype.setItem;
    window.__previewWritesDuringGesture = 0;
    Storage.prototype.setItem = function instrumentPreviewWrite(key, value) {
      if (key === `am-terminal-preview:${sessionId}`) window.__previewWritesDuringGesture++;
      return original.call(this, key, value);
    };
  }, id);
  const hostBox = await page.locator('.tile-terminal:not(.tile-cached) .term-host').boundingBox();
  const x = hostBox.x + hostBox.width / 2;
  const y = hostBox.y + Math.min(120, hostBox.height / 3);
  const dragDistance = 96;
  const dragSteps = 16;
  await page.locator('.tile-terminal:not(.tile-cached) .term-host').dispatchEvent('touchstart', {
    touches: [{ identifier: 1, clientX: x, clientY: y }],
  });
  for (let step = 1; step <= dragSteps; step++) {
    await page.locator('.tile-terminal:not(.tile-cached) .term-host').dispatchEvent('touchmove', {
      touches: [{
        identifier: 1, clientX: x, clientY: y + (dragDistance * step / dragSteps),
      }],
    });
    // Keep the gesture active beyond the preview debounce. A throttle would
    // write synchronously during this loop; a true debounce must stay silent.
    await sleep(60);
  }
  const writesBeforeTouchEnd = await page.evaluate(() => window.__previewWritesDuringGesture);
  await page.locator('.tile-terminal:not(.tile-cached) .term-host').dispatchEvent('touchend', { touches: [] });
  await sleep(800);
  const historyTop = await page.locator('.tile-terminal:not(.tile-cached) .xterm-viewport').evaluate((node) => node.scrollTop);
  const writesAfterTouchEnd = await page.evaluate(() => window.__previewWritesDuringGesture);
  const messagesAfterScroll = await page.evaluate(() =>
    window.__terminalSockets.reduce((count, socket) => count + socket.sent.length, 0));
  const scrolledPixels = beforeScroll.top - historyTop;
  check('small mobile touch moves track the finger through mouse-mode history',
    beforeScroll.max > 0
      && scrolledPixels >= dragDistance * 0.8
      && scrolledPixels <= dragDistance * 1.2,
    JSON.stringify({ beforeScroll, historyTop, scrolledPixels, dragDistance }));
  check('terminal preview persistence waits until the touch gesture is idle',
    writesBeforeTouchEnd === 0 && writesAfterTouchEnd >= 1,
    JSON.stringify({ writesBeforeTouchEnd, writesAfterTouchEnd }));
  check('local history scrolling sends no PTY control or resize messages',
    messagesAfterScroll === messagesBeforeScroll,
    JSON.stringify({ messagesBeforeScroll, messagesAfterScroll }));

  await page.locator('.tile-terminal:not(.tile-cached) .term-host').dispatchEvent('touchstart', {
    touches: [{ identifier: 2, clientX: x, clientY: y + dragDistance }],
  });
  for (let step = 1; step <= dragSteps; step++) {
    await page.locator('.tile-terminal:not(.tile-cached) .term-host').dispatchEvent('touchmove', {
      touches: [{
        identifier: 2, clientX: x,
        clientY: y + dragDistance - (dragDistance * step / dragSteps),
      }],
    });
  }
  await page.locator('.tile-terminal:not(.tile-cached) .term-host').dispatchEvent('touchend', { touches: [] });
  await sleep(100);
  const returnedScroll = await page.locator('.tile-terminal:not(.tile-cached) .xterm-viewport').evaluate((node) => ({
    top: node.scrollTop, max: node.scrollHeight - node.clientHeight,
  }));
  check('the reverse touch drag returns to the live bottom',
    Math.abs(returnedScroll.top - returnedScroll.max) < 2,
    JSON.stringify(returnedScroll));

  const fullKeyboardGrid = latestGrid();
  await page.locator('.tile-terminal:not(.tile-cached) .term-host').click();
  const mobileInputAnchor = await page.evaluate(() => {
    const host = document.querySelector('.tile-terminal:not(.tile-cached) .term-host').getBoundingClientRect();
    const node = document.querySelector('.tile-terminal:not(.tile-cached) .xterm-helper-textarea');
    const input = node.getBoundingClientRect();
    return {
      ok: input.width >= 1 && input.height >= 1
        && input.top >= host.bottom - 5 && input.left > host.left && input.right < host.right,
      host: { top: host.top, right: host.right, bottom: host.bottom, left: host.left },
      input: { top: input.top, right: input.right, bottom: input.bottom, left: input.left,
        width: input.width, height: input.height },
      style: node.getAttribute('style'),
    };
  });
  check('the focused xterm input is anchored at the mobile terminal bottom',
    mobileInputAnchor.ok, JSON.stringify(mobileInputAnchor));

  // A direct .hf.space app receives real viewport geometry on the affected
  // devices. Even if a test browser emits no change, focus alone must not
  // invoke the Hub-iframe fallback outside an iframe.
  await sleep(650);
  const directNoSignalLayout = await page.locator('.app').evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    strategy: document.documentElement.dataset.keyboardLayout ?? null,
  }));
  check('direct app does not guess a keyboard height without a browser signal',
    Math.abs(directNoSignalLayout.height - 667) < 1 && directNoSignalLayout.strategy === null,
    JSON.stringify(directNoSignalLayout));

  // Embedded Chromium can leave the child visual viewport unchanged but expose
  // the OSK rectangle. Ensure that independent signal clips the app and PTY.
  await page.evaluate(() => window.__setVirtualKeyboard(430, 237));
  const geometryResized = await waitFor(() => latestGrid()?.rows < fullKeyboardGrid.rows);
  const geometryLayout = await page.locator('.app').evaluate((node) => {
    const box = node.getBoundingClientRect();
    const keybar = document.querySelector('.tile-terminal:not(.tile-cached) .term-keybar')?.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, height: box.height, keybarBottom: keybar?.bottom ?? null };
  });
  check('keyboard geometry resizes an embedded mobile terminal without viewport changes',
    geometryResized && Math.abs(geometryLayout.height - 430) < 1
      && geometryLayout.keybarBottom <= 430,
    JSON.stringify({ geometryResized, geometryLayout, grid: latestGrid() }));
  await page.evaluate(() => window.__setVirtualKeyboard(667, 0));
  const geometryClosed = await waitFor(() => latestGrid()?.rows >= fullKeyboardGrid.rows);
  check('clearing embedded keyboard geometry restores the terminal', geometryClosed,
    JSON.stringify(latestGrid()));

  const beforeKeyboardGrid = latestGrid();
  await page.evaluate(() => window.__setVisualViewportLate(360, 118));
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
    const host = rect('.tile-terminal:not(.tile-cached) .term-host');
    const keybar = rect('.tile-terminal:not(.tile-cached) .term-keybar');
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

  // The huggingface.co Space page is a cross-origin wrapper around the actual
  // app iframe. Mobile Safari does not propagate its keyboard viewport into
  // that child, so verify the focus-derived fallback with every geometry signal
  // deliberately left unchanged.
  const embeddedPage = await context.newPage();
  await embeddedPage.setContent(
    `<style>html,body{margin:0}iframe{display:block;width:375px;height:667px;border:0}</style>`
      + `<iframe src="${WEB}"></iframe>`,
  );
  const embeddedReady = await waitFor(() => embeddedPage.frames().some((frame) =>
    frame !== embeddedPage.mainFrame() && frame.url().startsWith(WEB)));
  const embeddedFrame = embeddedPage.frames().find((frame) =>
    frame !== embeddedPage.mainFrame() && frame.url().startsWith(WEB));
  if (!embeddedReady || !embeddedFrame) throw new Error('embedded app frame did not load');
  await embeddedFrame.locator('.sidebar .row').filter({ hasText: 'mobile-terminal-e2e' }).first().click();
  await embeddedFrame.locator('.tile-terminal:not(.tile-cached) .xterm-screen').waitFor({ state: 'visible' });
  await embeddedFrame.locator('.tile-terminal:not(.tile-cached) .term-host').click();
  // 07ad947 "Mobile keyboard: stop estimating a height nobody can measure"
  // deliberately DELETED the focus fallback: when the browser reports no keyboard
  // geometry the app must not guess one, because the strip it hid behind an
  // imagined keyboard was visibly abandoned. This check kept asserting the removed
  // behaviour and could not pass — it went unnoticed because the suite could not
  // launch a browser here at all. Same purpose, current contract: no guess.
  const embeddedNoGuess = await waitFor(() => embeddedFrame.evaluate(() =>
    !document.documentElement.dataset.keyboardLayout));
  const embeddedLayout = await embeddedFrame.locator('.app').evaluate((node) => {
    const app = node.getBoundingClientRect();
    const keybar = document.querySelector('.tile-terminal:not(.tile-cached) .term-keybar')
      ?.getBoundingClientRect();
    return {
      height: app.height,
      bottom: app.bottom,
      keybarBottom: keybar?.bottom ?? null,
      strategy: document.documentElement.dataset.keyboardLayout ?? null,
      visualViewportHeight: window.visualViewport?.height ?? null,
      innerHeight: window.innerHeight,
    };
  });
  check('a Hub iframe with no keyboard geometry does not guess one',
    embeddedNoGuess
      // Full height: the app leaves the frame alone rather than shrinking to a
      // made-up 54%, and the keybar stays inside it.
      && Math.abs(embeddedLayout.height - 667) < 1
      && embeddedLayout.keybarBottom <= embeddedLayout.bottom
      && embeddedLayout.visualViewportHeight === 667
      && embeddedLayout.innerHeight === 667,
    JSON.stringify(embeddedLayout));
  await embeddedFrame.locator('.xterm-helper-textarea').evaluate((node) => node.blur());
  const embeddedRestored = await waitFor(() => embeddedFrame.evaluate(() => {
    const app = document.querySelector('.app')?.getBoundingClientRect();
    return !document.documentElement.dataset.keyboardLayout && Math.abs((app?.height ?? 0) - 667) < 1;
  }));
  check('blurring an embedded prompt restores the full iframe height', embeddedRestored);
  await embeddedPage.close();

  // A compact last-frame preview should survive a full page reload and remain
  // available while the backend/Space is unavailable. This deliberately blocks
  // terminal sockets after reload, so success cannot come from a fast restore.
  const previewSaved = await waitFor(() => page.evaluate((sessionId) => {
    try {
      const saved = JSON.parse(localStorage.getItem(`am-terminal-preview:${sessionId}`) || 'null');
      return saved?.rows?.some((line) => String(line).includes('MOBILE-HISTORY-0280'));
    } catch { return false; }
  }, id), 5_000);
  await page.evaluate(() => localStorage.setItem('__am_test_offline_sockets', '1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  // Coming back on a phone restores the pane you were reading, so `.app.m-stage`
  // hides the sidebar and its rows are unclickable. Return to the list the way a
  // user does. (The app gained that restore after this check was written.)
  const backToList = page.locator('.mback');
  if (await backToList.isVisible().catch(() => false)) await backToList.click();
  await page.locator('.sidebar .row').filter({ hasText: 'mobile-terminal-e2e' }).first().click();
  const previewVisible = await page.locator('.term-preview').filter({ hasText: 'MOBILE-HISTORY-0280' })
    .isVisible().catch(() => false);
  check('the last terminal view survives reload while the backend is unavailable',
    previewSaved && previewVisible, JSON.stringify({ previewSaved, previewVisible }));

  await context.close();

  // The pane deck is shared by desktop group layouts too. Put the two existing
  // sessions in one group and verify explicit grid placement plus persistence
  // across Overview and Settings (both used to tear terminal panes down).
  const group = await (await fetch(`${API}/api/groups`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'cache-layout-group' }),
  })).json();
  for (const sessionId of [id, secondId]) {
    await fetch(`${API}/api/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: `s:${sessionId}`, to: { kind: 'into', groupId: group.id } }),
    });
  }
  const desktopContext = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const desktopPage = await desktopContext.newPage();
  await desktopPage.goto(WEB, { waitUntil: 'domcontentloaded' });
  await desktopPage.locator('.row.group-head').filter({ hasText: 'cache-layout-group' }).click();
  const groupTerms = desktopPage.locator('.tile-terminal:not(.tile-cached) .xterm');
  await groupTerms.first().waitFor({ state: 'visible' });
  const groupReady = await waitFor(() => groupTerms.count().then((count) => count === 2));
  const groupLayout = await desktopPage.locator('.tile-terminal:not(.tile-cached)').evaluateAll((tiles) =>
    tiles.map((tile) => {
      const box = tile.getBoundingClientRect();
      tile.setAttribute('data-cache-probe', 'retained');
      return { left: box.left, top: box.top, width: box.width, height: box.height };
    }));
  check('retained terminals occupy the desktop group grid', groupReady
    && groupLayout.length === 2 && Math.abs(groupLayout[0].top - groupLayout[1].top) < 1
    && groupLayout[1].left > groupLayout[0].left + groupLayout[0].width,
  JSON.stringify(groupLayout));

  await desktopPage.locator('.ov-row').click();
  const overviewRetained = await desktopPage.locator('.tile-terminal[data-cache-probe="retained"]')
    .count() === 2;
  await desktopPage.locator('.row.group-head').filter({ hasText: 'cache-layout-group' }).click();
  const groupRestored = await waitFor(() => desktopPage
    .locator('.tile-terminal:not(.tile-cached)[data-cache-probe="retained"]')
    .count().then((count) => count === 2));
  check('Overview hides group terminals without recreating them', overviewRetained && groupRestored,
    JSON.stringify({ overviewRetained, groupRestored }));

  await desktopPage.getByTitle('Settings').click();
  await desktopPage.locator('.app.settings').waitFor({ state: 'visible' });
  const settingsRetained = await desktopPage
    .locator('.app.app-suspended .tile-terminal[data-cache-probe="retained"] .xterm').count() === 2;
  await desktopPage.locator('.app.settings').getByTitle('Back').click();
  const settingsRestored = await waitFor(() => desktopPage
    .locator('.tile-terminal:not(.tile-cached)[data-cache-probe="retained"] .xterm')
    .count().then((count) => count === 2));
  check('Settings hides group terminals without recreating them', settingsRetained && settingsRestored,
    JSON.stringify({ settingsRetained, settingsRestored }));
  await desktopContext.close();
} catch (error) {
  check('mobile browser test completes', false, String(error?.stack || error));
  console.log(logs.slice(-3000));
} finally {
  try { desktop?.close(); } catch {}
  try { await browser?.close(); } catch {}
  if (id) await fetch(`${API}/api/sessions/${id}/stop`, { method: 'POST' }).catch(() => {});
  if (secondId) await fetch(`${API}/api/sessions/${secondId}/stop`, { method: 'POST' }).catch(() => {});
  backend.kill('SIGTERM');
  await sleep(400);
  backend.kill('SIGKILL');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
