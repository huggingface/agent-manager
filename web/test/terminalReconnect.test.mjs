// A terminal resumes by itself after a server outage (operator report,
// 2026-10-20).
//
// The live Space restarted under open terminal panes. Each reconnect failed
// while it booted (~45s), every failure reached the browser as a bare 1006, and
// the retry budget meant for refused upgrades ran out in ~13s. The server came
// back and every terminal view stayed "Terminal connection paused", on every
// pane, until the page was reloaded. Reproduced locally against a SIGKILLed
// server: five 1006 closes in 12.9s, paused, still paused after the restart.
//
// Real Chromium, the real TerminalPane, a real WebSocket and a real fixture
// server that is actually stopped and started again on the same port:
//   1. kill it: the pane says the server is unreachable (it is not charged to
//      the refusal budget, so it never pauses); restart it: the terminal
//      reconnects and repaints without a reload;
//   2. a server that answers but refuses the socket still pauses after the same
//      five attempts — and that pause resumes on the next return to the app;
//   3. twelve retained panes share one health poll during the outage and do
//      not all reconnect in the same instant when it ends.
// Never starts an agent; the only PTY-shaped thing is the fixture's banner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WebSocketServer } from '../../server/node_modules/ws/wrapper.mjs';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-reconnect-'));
const bundle = path.join(tmp, 'fixture.js');
await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
    import TerminalPane from './src/components/TerminalPane';
    import { serverReach } from './src/lib/serverReach';
    window.serverReach = serverReach;
    const W = window.WebSocket;
    window.opens = [];
    window.WebSocket = class extends W { constructor(u, p) { super(u, p);
      this.addEventListener('open', () => window.opens.push({ id: new URL(u).searchParams.get('session'), t: performance.now() })); } };
    const panes = Number(new URLSearchParams(location.search).get('panes') || 1);
    const root = createRoot(document.getElementById('fixture-root'));
    flushSync(() => root.render(<>{Array.from({ length: panes }, (_, i) => (
      <div key={i} className="tile" data-pane={'p' + i} style={{position:'relative',flex:1,minWidth:0,minHeight:120}}><TerminalPane
        session={{id:'p'+i,cli:'shell',name:'Pane '+i,state:'idle',running:true,everStarted:true,path:null,createdAt:new Date().toISOString()}}
        cli={{id:'shell',label:'Shell',color:'#777'}} mode="terminal" theme="light" zoom={100}
        isMobile={false} focused={i===0} active={i===0} visible onClose={()=>{}} /></div>))}</>));
  ` }, bundle: true, outfile: bundle, format: 'iife', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
});
const css = fs.readFileSync(path.join(web, 'src/styles.css'), 'utf8');
const js = fs.readFileSync(bundle, 'utf8');
const bundleCss = fs.existsSync(bundle.replace(/\.js$/, '.css')) ? fs.readFileSync(bundle.replace(/\.js$/, '.css'), 'utf8') : '';

// The fixture backend: the page, /api/visibility, and /ws. `refuse` answers
// HTTP but refuses every upgrade, the way an admission refusal does.
const fixture = { up: false, port: 0, server: null, wss: null, boot: 0, refuse: false, probes: 0, upgrades: 0 };
const BANNER = 'fixture shell ready $ ';
function start() {
  fixture.boot++; fixture.up = true; fixture.refuse = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); return res.end(`<!doctype html><style>${css}${bundleCss}</style><div id="fixture-root" style="display:flex;flex-wrap:wrap;position:absolute;inset:4px"></div><script src="/client.js"></script>`); }
    if (url.pathname === '/client.js') { res.setHeader('content-type', 'text/javascript'); return res.end(js); }
    if (url.pathname === '/api/visibility') { fixture.probes++; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ boot: `b${fixture.boot}` })); }
    res.statusCode = 404; res.end('{}');
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    fixture.upgrades++;
    if (fixture.refuse) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send('\x00\x00AM:' + JSON.stringify({ t: 'restore', cols: 80, rows: 24, viewers: 1, controller: true, reset: true }));
      ws.send(`${BANNER}boot ${fixture.boot}\r\n`);
      ws.on('message', () => {});
    });
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  fixture.server = server; fixture.wss = wss; fixture.sockets = sockets;
  return new Promise((resolve) => server.listen(fixture.port, '127.0.0.1', () => { fixture.port = server.address().port; resolve(); }));
}
async function kill() {
  if (!fixture.up) return;
  fixture.up = false;
  // Like a container going away: no close handshake, every socket just dies.
  for (const c of fixture.wss.clients) c.terminate();
  for (const s of fixture.sockets) s.destroy();
  await new Promise((resolve) => fixture.server.close(resolve));
}

let failed = 0;
const check = async (what, fn) => {
  // A failed case must not take the next one down with it.
  if (!fixture.up) await start();
  fixture.refuse = false;
  try { await fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};
const text = (p) => p.evaluate(() => document.body.innerText);
const until = async (p, what, test, timeout = 30_000) => {
  const end = Date.now() + timeout;
  for (;;) {
    if (await test()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; page says: ${(await text(p)).replace(/\s+/g, ' ').slice(0, 160)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const shows = (p, s) => async () => (await text(p)).includes(s);

await start();
const browser = await chromium.launch(chromiumLaunchOptions());
const errors = [];
const openPage = async (panes = 1) => {
  const p = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  p.on('pageerror', (error) => errors.push(error.message));
  p.on('console', (m) => { if (process.env.DEBUG) console.log('[page]', m.type(), m.text().slice(0, 200)); });
  p.on('requestfailed', (r) => { if (process.env.DEBUG) console.log('[reqfail]', r.url(), r.failure()?.errorText); });
  await p.goto(`http://127.0.0.1:${fixture.port}/?panes=${panes}`, { waitUntil: 'domcontentloaded' });
  return p;
};

try {
  await check('a killed and restarted server: the terminal resumes without a reload', async () => {
    const p = await openPage();
    await until(p, 'the first connection', shows(p, `${BANNER}boot ${fixture.boot}`));
    const opened = await p.evaluate(() => window.opens.length);
    await kill();
    await until(p, 'the outage notice', shows(p, 'Server unreachable'));
    // Well past the ~13s the refusal budget allowed before this fix.
    await new Promise((r) => setTimeout(r, 16_000));
    assert.ok(!(await text(p)).includes('connection paused'), 'paused during the outage');
    await start();
    await until(p, 'the reconnect after the restart', shows(p, `${BANNER}boot ${fixture.boot}`), 30_000);
    assert.ok(!(await text(p)).includes('Server unreachable'), 'outage notice left up');
    assert.equal(await p.evaluate(() => window.opens.length), opened + 1, 'one reconnect, no storm');
    await p.close();
  });

  await check('a refusing server still pauses after five attempts, and the pause resumes on return', async () => {
    const p = await openPage();
    await until(p, 'the first connection', shows(p, BANNER));
    const before = fixture.upgrades;
    fixture.refuse = true;
    for (const c of fixture.wss.clients) c.terminate();
    await until(p, 'the pause', shows(p, 'connection paused'), 30_000);
    assert.equal(fixture.upgrades - before, 4, 'retries after the drop (the drop is the first failure)');
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(fixture.upgrades - before, 4, 'kept retrying after pausing');
    // The end of an outage says nothing new about a server that was answering
    // while it refused (review P2): an outage noticed elsewhere on the page
    // ends, and this pane stays paused until the operator comes back.
    await p.evaluate(() => window.serverReach.reportOutage());
    await until(p, 'the outage to end', () => p.evaluate(() => !window.serverReach.down), 10_000);
    await new Promise((r) => setTimeout(r, 2500));   // past the 1.5s spread
    assert.equal(fixture.upgrades - before, 4, 'the end of an outage resumed a refusal pause');
    assert.ok((await text(p)).includes('connection paused'), 'no longer paused');
    fixture.refuse = false;
    await p.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(p, 'the resume on return', async () => !(await text(p)).includes('connection paused')
      && (await p.evaluate(() => window.opens.length)) >= 2, 10_000);
    await p.close();
  });

  await check('twelve panes share one health poll and spread their reconnects', async () => {
    const p = await openPage(12);
    await until(p, 'twelve connections', async () => (await p.evaluate(() => window.opens.length)) === 12);
    await kill();
    const probesAtKill = fixture.probes;      // the server is down: nothing is counted until it is back
    await until(p, 'twelve outage notices', async () => (await text(p)).split('Server unreachable').length - 1 === 12);
    await new Promise((r) => setTimeout(r, 8000));
    await start();
    await until(p, 'twelve reconnects', async () => (await p.evaluate(() => window.opens.length)) === 24, 30_000);
    // Polls that reached the restarted server, before every pane was back:
    // one shared poll answers, then the panes reconnect — not twelve probes.
    assert.ok(fixture.probes - probesAtKill <= 3, `${fixture.probes - probesAtKill} health probes for 12 panes`);
    const times = await p.evaluate(() => window.opens.slice(12).map((o) => o.t));
    const spread = Math.max(...times) - Math.min(...times);
    assert.ok(spread > 150, `all twelve reconnected within ${Math.round(spread)}ms`);
    await p.close();
  });
} finally {
  await browser.close();
  await kill().catch(() => {});
}
assert.deepEqual(errors, [], 'page errors');
if (failed) { console.log(`terminal reconnect: ${failed} failed`); process.exit(1); }
console.log('terminal reconnect: all passed');
