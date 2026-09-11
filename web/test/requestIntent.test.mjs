import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
import { requestFixture } from '../../server/test/request-fixture.mjs';
import { REQUEST_HEADER, REQUEST_VALUE, rejection } from '../../server/src/request-admission.js';

const bundle = await build({
  stdin: { contents: `import * as api from './src/api'; import * as intent from './src/requestIntent'; import { terminalRetryDelay } from './src/terminalRetry'; window.api=api; window.intent=intent; window.terminalRetryDelay=terminalRetryDelay;`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'iife', platform: 'browser',
});
const fixture = await requestFixture({ configure(app, state) {
  app.get('/client.js', (_req, res) => res.type('js').send(bundle.outputFiles[0].text));
  app.get('/', (_req, res) => res.type('html').send('<!doctype html><script src="/client.js"></script>'));
  app.post('/api/sessions/refused/stop', (_req, res) => res.status(403).json(rejection('untrusted-origin')));
  state.canceled = 0;
  app.post('/api/sessions/cancel/attachments', (req, res) => {
    req.resume();
    res.on('close', () => { state.canceled++; });
    // Keep confirmation pending so the real XHR cancellation path is exercised.
  });
} });
const parent = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><iframe src="${fixture.origin}"></iframe>`);
});
await new Promise((resolve) => parent.listen(0, '127.0.0.1', resolve));
const parentOrigin = `http://localhost:${parent.address().port}`;
let browser;
try {
  browser = await chromium.launch(chromiumLaunchOptions());
  console.log(`request intent browser fixtures: ${browser.version()}`);
  const context = await browser.newContext();
  const page = await context.newPage();
  const runUI = async (frame) => {
    await frame.waitForFunction(() => !!window.api);
    const before = fixture.state.writes;
    const result = await frame.evaluate(async () => {
      const progress = [];
      await window.api.createSession('fixture', 'shell');
      await window.api.stopSession('fixture');
      await window.api.saveConfig({ artifacts: { enabled: false } });
      await window.api.writeFile('fixture', 'fixture.txt', 'fixture edit', 'base-fixture');
      await window.api.uploadFile('fixture', '.', new File(['fixture raw'], 'raw.txt'));
      await window.api.sendInput('fixture', 'fixture first prompt');
      await window.api.checkUpdate();
      await window.api.uploadAttachment('fixture', new File(['fixture file'], 'fixture.txt', { type: 'text/plain' }), {
        onProgress: (event) => progress.push(event.loaded),
      });
      const abort = new AbortController(); abort.abort();
      const canceled = await window.api.uploadAttachment('fixture', new File(['unused'], 'unused.txt'), { signal: abort.signal }).then(() => false, () => true);
      const socket = await new Promise((resolve) => {
        const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws');
        ws.onmessage = () => { ws.close(); resolve(true); };
        ws.onerror = () => resolve(false);
      });
      return { progress, canceled, socket, marker: [window.intent.REQUEST_HEADER, window.intent.REQUEST_VALUE],
        delays: [1, 2, 3, 4, 5, 6].map((n) => window.terminalRetryDelay(n, 1006)),
        deniedDelay: window.terminalRetryDelay(1, 1008),
      };
    });
    assert.deepEqual(result.marker, [REQUEST_HEADER, REQUEST_VALUE]);
    assert.equal(fixture.state.writes, before + 7);
    assert.ok(fixture.state.bodies.includes('fixture edit'));
    assert.ok(fixture.state.bodies.includes('fixture raw'));
    assert.ok(result.progress.includes('fixture file'.length));
    assert.ok(result.canceled);
    assert.ok(result.socket);
    assert.deepEqual(result.delays.slice(4), [null, null]);
    assert.equal(result.deniedDelay, null);
    const sent = fixture.state.headers.filter((h) => h['x-am-origin'] === 'operator').slice(-3);
    assert.equal(sent.length, 3);
    assert.ok(sent.every((h) => h.origin === fixture.origin && h[REQUEST_HEADER] === REQUEST_VALUE));
    console.log('UI context:', sent.map((h) => h['sec-fetch-site']).join(', '));
  };
  await page.goto(fixture.origin);
  await runUI(page);
  const rejectedBefore = fixture.state.writes;
  const refusal = await page.evaluate(() => window.api.stopSession('refused').then(() => '', (error) => error.message));
  assert.match(refusal, /Reload the app/);
  assert.equal(fixture.state.writes, rejectedBefore, 'no automatic action replay');
  const canceled = await page.evaluate(async () => {
    const abort = new AbortController();
    return window.api.uploadAttachment('cancel', new File(['fixture cancellation'], 'cancel.txt'), {
      signal: abort.signal, onProgress: ({ loaded }) => { if (loaded > 0) abort.abort(); },
    }).then(() => '', (error) => error.message);
  });
  assert.match(canceled, /canceled/);
  for (let n = 0; !fixture.state.canceled && n < 20; n++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(fixture.state.canceled, 1);
  // A second tab/reload needs no secret provisioning and does not replay work.
  const tab = await context.newPage();
  await tab.goto(fixture.origin);
  const beforeReload = fixture.state.writes;
  await tab.reload();
  assert.equal(fixture.state.writes, beforeReload);
  await runUI(tab);
  await page.goto(parentOrigin);
  const appFrame = page.frames().find((frame) => frame.url().startsWith(fixture.origin));
  assert.ok(appFrame);
  await runUI(appFrame);

  // No privileged handler may run, even if the browser cannot read the reply.
  const before = { writes: fixture.state.writes, reads: fixture.state.reads, upgrades: fixture.state.upgrades };
  await page.evaluate(async (origin) => {
    await fetch(origin + '/api/fixture', { method: 'POST', mode: 'no-cors', body: 'fixture' }).catch(() => {});
    await fetch(origin + '/api/fixture', { method: 'POST', headers: { 'X-AM-Request': '1' }, body: 'fixture' }).catch(() => {});
    await fetch(origin + '/api/remote/fixture/stream', { mode: 'no-cors' }).catch(() => {});
    await new Promise((resolve) => {
      const ws = new WebSocket(origin.replace('http', 'ws') + '/ws');
      ws.onclose = resolve; ws.onerror = () => {};
    });
    const frame = document.createElement('iframe'); frame.name = 'form-result'; document.body.append(frame);
    const form = document.createElement('form'); form.method = 'POST'; form.action = origin + '/api/fixture'; form.target = frame.name;
    document.body.append(form);
    await new Promise((resolve) => { frame.onload = resolve; form.submit(); });
  }, fixture.origin);
  assert.deepEqual({ writes: fixture.state.writes, reads: fixture.state.reads, upgrades: fixture.state.upgrades }, before);

  // Match FilesPane's scripts-only sandbox: the preview has an opaque origin,
  // not the app's origin. Read-only content remains navigable.
  await tab.evaluate((origin) => {
    const preview = document.createElement('iframe'); preview.setAttribute('sandbox', 'allow-scripts');
    preview.srcdoc = `<script>fetch(${JSON.stringify(origin + '/api/fixture')},{method:'POST',mode:'no-cors',body:'fixture'}).finally(()=>parent.postMessage('preview-done','*'))<\/script>`;
    window.previewDone = new Promise((resolve) => window.addEventListener('message', (event) => { if (event.data === 'preview-done') resolve(); }));
    document.body.append(preview);
  }, fixture.origin);
  await tab.evaluate(() => window.previewDone);
  assert.equal(fixture.state.writes, before.writes);
  assert.equal((await context.request.get(fixture.origin + '/api/files/fixture/raw')).status(), 200);
  console.log('PASS standalone, multiple tabs, HF-style cross-site ancestor, fetch/XHR/WS, progress/cancel, unrelated page and opaque preview');
} finally {
  await browser?.close();
  await fixture.close();
  parent.closeAllConnections();
  await new Promise((resolve) => parent.close(resolve));
}
