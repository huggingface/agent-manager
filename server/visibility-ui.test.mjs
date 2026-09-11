#!/usr/bin/env node
/**
 * The privacy lock as a browser sees it: a real Chromium against a real server
 * whose fake Hub the test flips between private, public and unreachable.
 *   - first load while unverified shows the "checking" page, then the app opens
 *     by itself, without a reload
 *   - an open terminal tab locks while it is open: protected view torn down, the
 *     socket closed by the server with 4003, no output after the close
 *   - a stale "unlocked" status answer arriving after the lock cannot reopen it
 *   - a hidden Reader-only tab learns the lock when it comes back, and keeps its
 *     unsent draft and selected session across lock and reopen
 *   - a verification outage is explained as an outage, not as exposure
 *   - the backend restarts under an open app: the new generation's first
 *     refusal locks it (nothing cached stays mounted), its verification reopens
 *     it, and a delayed refusal from the OLD generation cannot wedge it
 *   - the unverified-bucket warning clears in a visible, unlocked tab once the
 *     bucket verifies, without a reload or tab switch
 *
 * Set VISUI_PUBLIC_DIR to a prebuilt web/dist to skip the build.
 * am-test: manual — Chromium, a full web build and a fake Hub; run by hand.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { nativeFetch as fetch } from './test/native-client.mjs';
import { chromiumLaunchOptions } from '../scripts/test-chromium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-visui-'));
const PUBLIC_DIR = process.env.VISUI_PUBLIC_DIR || path.join(DATA_DIR, 'public');
const SPACE_ID = 'fixture-owner/fixture-space';
const BUCKET_ID = 'fixture-owner/fixture-bucket';
const CHECK_MS = 1000;
const GRACE_MS = 2500;
const MARKER = 'FAKE-CLAUDE-READY';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};
const waitFor = async (fn, timeout = 10_000, step = 100) => {
  const until = Date.now() + timeout;
  for (;;) {
    let v; try { v = await fn(); } catch {}
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(step);
  }
};
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

if (!process.env.VISUI_PUBLIC_DIR) {
  const build = spawnSync('npm', ['run', 'build', '--', '--outDir', PUBLIC_DIR], { cwd: path.join(ROOT, 'web'), encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`web build failed:\n${build.stdout}\n${build.stderr}`);
}

// ---------- fake Hub ----------
// mode.auth: 'ok' | 'unauthorized' — whether the fixture token may read the Space.
const mode = { space: 'error', bucket: 'private', auth: 'ok' };
const hub = http.createServer((req, res) => {
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const repo = (id, m) => {
    if (m === 'error') return json(503, { error: 'unavailable' });
    if (m === 'public') return json(200, { id, private: false, runtime: {} });
    return json(401, { error: 'Invalid username or password.' });
  };
  if (req.url === `/api/spaces/${SPACE_ID}`) {
    if (req.headers.authorization) {
      if (mode.auth === 'unauthorized') return json(401, { error: 'Invalid username or password.' });
      if (mode.space === 'error') return json(503, { error: 'unavailable' });
      return json(200, { id: SPACE_ID, private: mode.space !== 'public', runtime: { volumes: [{ type: 'bucket', source: BUCKET_ID, mountPath: '/data' }] } });
    }
    return repo(SPACE_ID, mode.space);
  }
  if (req.url === `/api/buckets/${BUCKET_ID}`) return repo(BUCKET_ID, mode.bucket);
  json(404, { error: 'unknown fixture route' });
});
await new Promise((r) => hub.listen(0, '127.0.0.1', r));

// ---------- server + fake agent ----------
const PORT = await freePort();
const API = `http://127.0.0.1:${PORT}`;
const bin = path.join(DATA_DIR, 'bin');
fs.mkdirSync(bin, { recursive: true });
const startLog = path.join(DATA_DIR, 'fake-claude.starts');
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
echo "start $$" >> "${startLog}"
echo "${MARKER}"
( while :; do echo tick; sleep 0.3; done ) &
TICKER=$!
trap 'kill $TICKER 2>/dev/null; exit 0' TERM INT HUP
cat > /dev/null
kill $TICKER 2>/dev/null
`, { mode: 0o755 });
const HOME = path.join(DATA_DIR, 'home');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.profile'), `export PATH="${bin}:$PATH"\n`);
const starts = () => (fs.existsSync(startLog) ? fs.readFileSync(startLog, 'utf8').trim().split('\n').filter(Boolean).length : 0);

const { SPACE_ID: _s, AM_DISTRIBUTE_SKILLS, HF_TOKEN, HUGGING_FACE_HUB_TOKEN, HF_API_TOKEN, ...BASE_ENV } = process.env;
let logs = '';
let backend;
const startBackend = () => {
  backend = spawn('node', ['src/index.js'], {
    cwd: HERE,
    env: {
      ...BASE_ENV, PATH: `${bin}:${BASE_ENV.PATH || ''}`,
      PORT: String(PORT), DATA_DIR, PUBLIC_DIR, HOME, CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
      AM_BASHRC: '/nonexistent', SPACE_HOST: 'fixture-owner-fixture-space.hf.space',
      // The browser fixture is served on this exact local origin (#130).
      AM_ALLOWED_ORIGINS: API,
      SPACE_ID, HF_ENDPOINT: `http://127.0.0.1:${hub.address().port}`, HF_TOKEN: 'hf_fixture_not_a_real_token',
      AM_VISIBILITY_CHECK_MS: String(CHECK_MS), AM_VISIBILITY_GRACE_MS: String(GRACE_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (d) => { logs += d; });
  backend.stderr.on('data', (d) => { logs += d; });
  return backend;
};
const stopBackend = () => new Promise((resolve) => { const b = backend; b.once('exit', resolve); b.kill('SIGTERM'); setTimeout(() => { try { b.kill('SIGKILL'); } catch {} resolve(); }, 6000); });
startBackend();

const api = async (route, init = {}) => {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET') headers.set('x-am-origin', 'operator');
  const r = await fetch(`${API}${route}`, { ...init, headers });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const info = () => api('/api/info').then((r) => r.body);
const lockedPage = (page) => page.locator('.locked-app');
const lockReason = (page) => page.locator('.locked-app .install').getAttribute('data-lock-reason').catch(() => null);

let browser;
try {
  const up = await waitFor(() => fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false), 60_000);
  if (!up) throw new Error(`server did not start:\n${logs.slice(-2000)}`);

  browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Record every terminal socket the page opens, and stamp the page load so a
  // forced reload would show up as a changed stamp.
  await context.addInitScript(() => {
    window.__boot = Date.now() + Math.random();
    const Native = window.WebSocket;
    window.__sockets = [];
    class Recorded extends Native {
      constructor(url, protocols) {
        super(url, protocols);
        if (String(url).includes('/ws?session=')) {
          const rec = { url: String(url), messages: 0, text: '', afterClose: 0, close: null };
          window.__sockets.push(rec);
          this.addEventListener('message', (e) => { rec.messages++; if (rec.close) rec.afterClose++; if (typeof e.data === 'string') rec.text += e.data; else rec.text += new TextDecoder().decode(e.data); });
          this.addEventListener('close', (e) => { rec.close = { code: e.code, reason: e.reason }; });
        }
      }
    }
    window.WebSocket = Recorded;
  });
  const pageA = await context.newPage();
  const errorsA = [];
  pageA.on('pageerror', (e) => errorsA.push(String(e)));

  // ---- 1. first load, unverified ----
  await pageA.goto(`${API}/`);
  await lockedPage(pageA).waitFor({ timeout: 10_000 });
  check('first load while unverified shows the lock page', await lockedPage(pageA).count() === 1);
  check('...with the "checking" explanation, not the public-Space setup guide', (await lockReason(pageA)) === 'checking' && (await pageA.locator('.locked-app .install h1').innerText()).includes('Checking'));
  check('no terminal or protected view is mounted beneath it', await pageA.locator('.xterm, .tile-terminal').count() === 0);
  const bootA = await pageA.evaluate(() => window.__boot);

  // ---- 2. verification succeeds: reopens on its own ----
  mode.space = 'private';
  const t1 = Date.now();
  await lockedPage(pageA).waitFor({ state: 'detached', timeout: 20_000 });
  check(`app reopened by itself once verified (${Date.now() - t1} ms)`, await pageA.locator('.sidebar:not(.mock-side)').count() === 1);
  check('no forced reload on reopening', (await pageA.evaluate(() => window.__boot)) === bootA);
  await api('/api/welcome/seen', { method: 'POST' });
  await pageA.keyboard.press('Escape'); // the first-run welcome, if it showed

  // ---- 3. a terminal, open ----
  const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'agent', cli: 'claude' }) });
  const sid = created.body?.id;
  if (!sid) throw new Error(`session creation failed: ${JSON.stringify(created)}`);
  await pageA.locator('.sidebar .row').filter({ hasText: 'agent' }).first().click();
  await pageA.locator('.tile-terminal:not(.tile-cached) .xterm-screen').waitFor({ state: 'visible', timeout: 15_000 });
  const sawMarker = await waitFor(() => pageA.evaluate(() => (window.__sockets.at(-1)?.text || '').includes('FAKE-CLAUDE-READY')), 10_000);
  check('terminal attached and shows the agent output', !!sawMarker);
  const startsAfterAttach = starts();

  // A second tab in Reader mode, with a draft, then hidden.
  const pageB = await context.newPage();
  await pageB.goto(`${API}/`);
  await pageB.evaluate(() => localStorage.setItem('am-pane-mode', 'reader'));
  await pageB.reload();
  await pageB.locator('.sidebar .row').filter({ hasText: 'agent' }).first().click();
  const composer = pageB.locator('.ov-composer textarea');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await composer.fill('draft-kept-across-the-lock');
  check('reader tab has a terminal-free view with a draft', await pageB.locator('.xterm').count() === 0 && (await composer.inputValue()) === 'draft-kept-across-the-lock');
  await pageB.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  // Stale-status trap for tab A: the first /api/info after the flip is answered
  // late, with the pre-lock "unlocked" body. It must not reopen the app.
  const staleUnlocked = await info();
  let trapArmed = true; let trapFired = false;
  await pageA.route('**/api/info', async (route) => {
    if (trapArmed && mode.space === 'public') {
      trapArmed = false; trapFired = true;
      await sleep(2500);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(staleUnlocked) });
    }
    return route.continue();
  });

  // Tab A's polls are cut off, so the ONLY way it can learn the lock is the
  // server closing its terminal socket. (Restored once the lock page is up.)
  const blocked = ['**/api/tree*', '**/api/meta*'];
  for (const pattern of blocked) await pageA.route(pattern, (route) => route.abort());

  // ---- 4. the Space turns public while the terminal is open ----
  mode.space = 'public';
  const t2 = Date.now();
  await lockedPage(pageA).waitFor({ timeout: 10_000 });
  check(`open terminal tab locked (${Date.now() - t2} ms after the flip), learned from the socket close alone`, (await lockReason(pageA)) === null && (await pageA.locator('.locked-app').innerText()).includes('public'));
  // From here on, the lock page must never disappear until the fixture is private again.
  await pageA.evaluate(() => {
    window.__unlockedFlicker = 0;
    new MutationObserver(() => { if (!document.querySelector('.locked-app')) window.__unlockedFlicker++; }).observe(document.body, { childList: true, subtree: true });
  });
  check('the setup guide is shown for a public Space', (await pageA.locator('.locked-app').innerText()).includes('Duplicate this Space'));
  check('protected view torn down: no terminal in the DOM', await pageA.locator('.xterm, .tile-terminal, .ov-composer').count() === 0);
  const sockA = await waitFor(() => pageA.evaluate(() => { const s = window.__sockets.at(-1); return s && s.close ? s : null; }), 5000);
  check('the server closed the terminal socket with 4003 locked:public-space:<seq>:<boot>', sockA?.close?.code === 4003 && /^locked:public-space:\d+:[\w-]+$/.test(sockA?.close?.reason || ''), JSON.stringify(sockA?.close));
  await sleep(1500);
  const sockA2 = await pageA.evaluate(() => window.__sockets.at(-1));
  check('no terminal frames after the close, and no reconnect attempt', sockA2.afterClose === 0 && (await pageA.evaluate(() => window.__sockets.length)) === 1, `afterClose=${sockA2.afterClose} sockets=${await pageA.evaluate(() => window.__sockets.length)}`);
  await waitFor(() => trapFired, 5000);
  await sleep(3200);
  const flicker = await pageA.evaluate(() => window.__unlockedFlicker);
  check('a stale "unlocked" status answer arriving after the lock does not reopen the app, not even briefly', trapFired && flicker === 0 && await lockedPage(pageA).count() === 1, `flicker=${flicker}`);
  await pageA.unroute('**/api/info');
  for (const pattern of blocked) await pageA.unroute(pattern);
  check('hidden reader tab: nothing protected can be fetched (server refuses)', (await api('/api/tree')).status === 403);
  // The hidden tab comes back.
  await pageB.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await lockedPage(pageB).waitFor({ timeout: 10_000 });
  check('returning reader tab learns the lock on return', await lockedPage(pageB).count() === 1 && await pageB.locator('.ov-composer').count() === 0);
  check('the agent process was left alone by the lock', starts() === startsAfterAttach);

  // ---- 5. private again: both tabs reopen where they were ----
  const staleLocked = await info(); // captured while locked, replayed after the reopen below
  mode.space = 'private';
  const t3 = Date.now();
  await lockedPage(pageA).waitFor({ state: 'detached', timeout: 20_000 });
  await lockedPage(pageB).waitFor({ state: 'detached', timeout: 20_000 });
  check(`both tabs reopened automatically (${Date.now() - t3} ms)`, true);
  // The reverse ordering: a delayed LOCKED status answer arriving after the
  // reopen must not lock the app again (it would otherwise stay locked until
  // the next server transition).
  await pageA.evaluate(() => {
    window.__relockFlicker = 0;
    new MutationObserver(() => { if (document.querySelector('.locked-app')) window.__relockFlicker++; }).observe(document.body, { childList: true, subtree: true });
  });
  let staleArmed = true; let staleFired = false;
  await pageA.route('**/api/info', async (route) => {
    if (staleArmed) { staleArmed = false; staleFired = true; await sleep(300); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(staleLocked) }); }
    return route.continue();
  });
  await pageA.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // a return-to-tab re-read
  await waitFor(() => staleFired, 5000);
  await sleep(2500);
  const relock = await pageA.evaluate(() => window.__relockFlicker);
  check('a stale "locked" status answer arriving after the reopen does not lock the app again', staleFired && relock === 0 && await lockedPage(pageA).count() === 0, `relock=${relock}`);
  await pageA.unroute('**/api/info');
  check('...and the app is still reading live state afterwards', !(await info()).locked);
  check('no forced reload across lock and reopen', (await pageA.evaluate(() => window.__boot)) === bootA);
  await pageA.locator('.tile-terminal:not(.tile-cached) .xterm-screen').waitFor({ state: 'visible', timeout: 15_000 });
  const reattached = await waitFor(() => pageA.evaluate(() => { const s = window.__sockets.at(-1); return s && !s.close && s.text.includes('FAKE-CLAUDE-READY'); }), 10_000);
  check('terminal tab reattached to the same agent and replayed its screen', !!reattached && (await pageA.locator('.sidebar .row.session.active').innerText()).includes('agent'));
  check('reattach started no new agent process', starts() === startsAfterAttach, `starts ${starts()} vs ${startsAfterAttach}`);
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  check('reader tab kept its selected session and unsent draft', (await composer.inputValue()) === 'draft-kept-across-the-lock');

  // ---- 6. verification outage ----
  mode.space = 'error';
  await lockedPage(pageA).waitFor({ timeout: GRACE_MS + 3 * CHECK_MS + 5000 });
  const outageText = await pageA.locator('.locked-app').innerText();
  check('an outage locks with its own explanation', (await lockReason(pageA)) === 'verification-unavailable' && /not a sign that anything\s+is public/.test(outageText.replace(/\s+/g, ' ')));
  check('...and does not tell the operator to duplicate the Space', !outageText.includes('Duplicate this Space') && !outageText.includes('Make the bucket private'));
  mode.space = 'private';
  await lockedPage(pageA).waitFor({ state: 'detached', timeout: 20_000 });
  check('recovers when verification succeeds again', await pageA.locator('.sidebar:not(.mock-side)').count() === 1);

  // ---- 7. the backend restarts under the open app ----
  // (i) The new generation starts unverified. Its first refusal must lock the
  // tab even though its counter (1) is far below the old generation's.
  const oldBoot = (await info()).visibility.boot;
  await pageA.locator('.tile-terminal:not(.tile-cached) .xterm-screen').waitFor({ state: 'visible', timeout: 15_000 });
  mode.space = 'error'; // the new process cannot verify yet
  await stopBackend();
  startBackend();
  const up2 = await waitFor(() => fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false), 60_000);
  check('backend restarted on the same port', !!up2);
  const newBoot = (await info()).visibility.boot;
  check('a new process has a new generation id', typeof newBoot === 'string' && newBoot !== oldBoot);
  await lockedPage(pageA).waitFor({ timeout: 15_000 });
  check('the open tab locks on the new generation\'s first refusal (checking)', (await lockReason(pageA)) === 'checking');
  check('protected cached views are unmounted', await pageA.locator('.xterm, .tile-terminal, .ov-composer').count() === 0);
  mode.space = 'private';
  await lockedPage(pageA).waitFor({ state: 'detached', timeout: 25_000 });
  check('the new generation\'s verification reopens the tab', await pageA.locator('.sidebar:not(.mock-side)').count() === 1);
  // (ii) Reverse ordering: a delayed refusal from the OLD generation, with a
  // high counter, arrives after the new generation's status was applied. It
  // must neither lock the tab nor wedge it.
  await pageA.evaluate(() => {
    window.__oldGenRelock = 0;
    new MutationObserver(() => { if (document.querySelector('.locked-app')) window.__oldGenRelock++; }).observe(document.body, { childList: true, subtree: true });
  });
  let oldGenArmed = true; let oldGenFired = false;
  await pageA.route('**/api/tree*', async (route) => {
    if (oldGenArmed) { oldGenArmed = false; oldGenFired = true; return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'locked', reason: 'public-space', seq: 999, boot: oldBoot }) }); }
    return route.continue();
  });
  await waitFor(() => oldGenFired, 8000);
  await sleep(3000);
  const oldGenRelock = await pageA.evaluate(() => window.__oldGenRelock);
  check('a stale refusal from the previous generation does not lock the tab', oldGenFired && oldGenRelock === 0 && await lockedPage(pageA).count() === 0, `relock=${oldGenRelock}`);
  await pageA.unroute('**/api/tree*');
  check('...and the tab still tracks live state (a real lock still lands)', await (async () => {
    mode.space = 'public';
    const locked = await lockedPage(pageA).waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    mode.space = 'private';
    await lockedPage(pageA).waitFor({ state: 'detached', timeout: 25_000 });
    return locked;
  })());

  // ---- 8. the unverified-bucket warning clears in a visible, unlocked tab ----
  // Restart with a refused credential: warning-only mode after three refusals.
  mode.auth = 'unauthorized';
  await stopBackend();
  startBackend();
  await waitFor(() => fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false), 60_000);
  const warned = await waitFor(async () => { const x = await info(); return x && !x.locked && x.bucketUnverified ? x : null; }, 20_000);
  check('server in warning-only mode (Space private, bucket unverifiable)', !!warned);
  await lockedPage(pageA).waitFor({ state: 'detached', timeout: 25_000 });
  await pageA.locator('button[title="Settings"]').click();
  const bucketWarn = pageA.locator('.s-warn', { hasText: 'storage bucket' });
  await bucketWarn.waitFor({ timeout: 35_000 });
  check('Settings shows the unverified-bucket warning', await bucketWarn.count() === 1);
  const bootAtWarn = await pageA.evaluate(() => window.__boot);
  // The token's access is fixed on the Hub; the server re-tries and verifies.
  mode.auth = 'ok';
  const verified = await waitFor(async () => { const x = await info(); return x && !x.locked && x.bucketUnverified === false ? x : null; }, 30_000);
  check('server verified the bucket once the credential worked again', !!verified);
  await bucketWarn.waitFor({ state: 'detached', timeout: 45_000 });
  check('the warning cleared in the open, visible tab without reload or tab switch', await bucketWarn.count() === 0 && (await pageA.evaluate(() => window.__boot)) === bootAtWarn);
  check('no page errors during the run', errorsA.length === 0, errorsA.join(' | '));
  check('the fixture token never reached the browser or the log', !logs.includes('hf_fixture_not_a_real_token') && !(await pageA.content()).includes('hf_fixture'));
} catch (e) {
  check('suite completed', false, `${e && e.stack}\n--- server log ---\n${logs.slice(-4000)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  backend.kill('SIGTERM');
  await new Promise((r) => { backend.once('exit', r); setTimeout(r, 4000); });
  hub.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall browser lock checks passed');
process.exit(failures ? 1 : 0);
