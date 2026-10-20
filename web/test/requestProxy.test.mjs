import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
import { requestFixture } from '../../server/test/request-fixture.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = async (server) => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-request-proxy-'));
let browser, fixture, proxy, parent, vite, devFixture;
try {
  // Ephemeral fixture TLS material only; no real endpoint or credentials.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem')], { stdio: 'ignore' });
  let preserveHost = true;
  let upstream;
  const allowedAtEdge = (req) => req.headers.cookie?.includes('fixture-edge=accepted') || req.headers.authorization === 'Bearer fixture-access';
  const headersFor = (req) => ({ ...req.headers,
    host: preserveHost ? req.headers.host : `127.0.0.1:${fixture.port}`,
    'x-forwarded-host': 'untrusted.fixture', 'x-forwarded-proto': 'http',
  });
  proxy = https.createServer({ key: fs.readFileSync(path.join(tmp, 'key.pem')), cert: fs.readFileSync(path.join(tmp, 'cert.pem')) }, (req, res) => {
    if (!allowedAtEdge(req)) { res.writeHead(401); res.end(); return; }
    const next = http.request(upstream + req.url, { method: req.method, headers: headersFor(req) }, (reply) => {
      res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
    });
    next.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(next);
  });
  const proxyPort = await listen(proxy);
  const origin = `https://localhost:${proxyPort}`;
  fixture = await requestFixture({ env: (port) => ({ NODE_ENV: 'production', PORT: String(port), SPACE_HOST: `localhost:${proxyPort}` }),
    configure(app) { app.get('/', (_req, res) => res.type('html').send('<!doctype html><title>App fixture</title>')); },
  });
  upstream = fixture.origin;
  proxy.on('upgrade', (req, socket, head) => {
    if (!allowedAtEdge(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    const next = http.request(upstream + req.url, { headers: headersFor(req) });
    next.on('upgrade', (res, target, targetHead) => {
      const raw = res.rawHeaders.reduce((text, value, i) => text + (i % 2 ? `${value}\r\n` : `${value}: `), '');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${raw}\r\n`);
      if (targetHead.length) socket.write(targetHead);
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
      socket.on('close', () => target.destroy());
      target.on('error', () => socket.destroy());
    });
    next.on('response', (res) => { res.resume(); socket.end(`HTTP/1.1 ${res.statusCode} Refused\r\nConnection: close\r\n\r\n`); });
    next.on('error', () => socket.destroy()); next.end();
  });
  browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([{ name: 'fixture-edge', value: 'accepted', url: origin, sameSite: 'None', secure: true }]);
  const page = await context.newPage();
  parent = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<iframe src="${origin}"></iframe>`); });
  const parentPort = await listen(parent);
  const exercise = (frame) => frame.evaluate(async () => {
    const write = await fetch('/api/fixture', { method: 'POST', headers: { 'X-AM-Request': '1' } });
    const read = await fetch('/api/remote/fixture/messages?agent=1', { headers: { 'X-AM-Request': '1' } });
    const socket = await new Promise((resolve) => {
      const ws = new WebSocket(location.origin.replace('https:', 'wss:') + '/ws');
      ws.onmessage = () => { ws.close(); resolve(true); }; ws.onerror = () => resolve(false);
    });
    return [write.status, read.status, socket];
  });
  for (const embedded of [false, true]) {
    await page.goto(embedded ? `http://127.0.0.1:${parentPort}` : origin);
    const frame = embedded ? page.frames().find((item) => item.url().startsWith(origin)) : page;
    assert.ok(frame);
    for (preserveHost of [true, false]) assert.deepEqual(await exercise(frame), [200, 200, true]);
  }
  const request = (headers) => new Promise((resolve, reject) => {
    const req = https.request(origin + '/api/fixture', { rejectUnauthorized: false, method: 'POST', headers }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(await request({ 'X-AM-Request': '1', authorization: 'Bearer arbitrary' }), 401);
  assert.equal(await request({ authorization: 'Bearer fixture-access' }), 403);
  assert.equal(await request({ 'X-AM-Request': '1', authorization: 'Bearer fixture-access' }), 200);
  assert.equal(await request({ 'X-AM-Request': '1', authorization: 'Bearer fixture-access', origin: 'null' }), 403);
  console.log('PASS fixture HTTPS termination, preserved/rewritten configured Host, embedded Space origin, mocked private edge, native intent');

  // Exercise the actual Vite proxy configuration at explicit alternate ports.
  const reservation = http.createServer();
  const devPort = await listen(reservation); await close(reservation);
  devFixture = await requestFixture({ env: (port) => ({ PORT: String(port), AM_DEV_PORT: String(devPort) }) });
  process.env.AM_API_PORT = String(devFixture.port);
  process.env.AM_DEV_PORT = String(devPort);
  vite = await createViteServer({ configFile: path.resolve('vite.config.ts'), plugins: [{ name: 'request-test-page', configureServer(server) {
    server.middlewares.use('/__request_fixture', (_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Vite fixture</title>'); });
  } }] });
  await vite.listen();
  const devPage = await context.newPage();
  await devPage.goto(`http://localhost:${devPort}/__request_fixture`);
  const devResult = await devPage.evaluate(async () => {
    const api = await import('/src/api.ts');
    await api.stopSession('fixture');
    return new Promise((resolve) => {
      const ws = new WebSocket(location.origin.replace('http:', 'ws:') + '/ws');
      ws.onmessage = () => { ws.close(); resolve(true); }; ws.onerror = () => resolve(false);
    });
  });
  assert.ok(devResult);
  assert.equal(devFixture.state.writes, 1);
  assert.equal(devFixture.state.upgrades, 1);
  console.log('PASS real Vite API/socket proxy at explicit alternate ports');
} finally {
  await browser?.close();
  await vite?.close();
  await devFixture?.close();
  await fixture?.close();
  if (proxy) await close(proxy);
  if (parent) await close(parent);
  fs.rmSync(tmp, { recursive: true, force: true });
}
