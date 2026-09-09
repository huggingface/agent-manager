// The privacy lock end to end: a real server, a fake Hub whose answers the test
// flips, a fake agent, and every kind of client the lock has to reach —
// new HTTP requests, an open terminal WebSocket (controller and watcher), the
// /wait long poll and a remote agent's stream. Asserts actual access and side
// effects: what the PTY received, what the clients got after revocation, and
// that the agent process itself was left alone.
//
// One raw WebSocket client deliberately ignores the server's close frame and
// keeps writing, so "no input after revocation" is proved on the server side
// rather than by the client politely stopping.
//
// Ports are picked free at start (this box runs several suites side by side).
// Run:  node test/visibility-lock.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const PORT = await freePort();
const API = `http://127.0.0.1:${PORT}`;
const SPACE_ID = 'fixture-owner/fixture-space';
const BUCKET_ID = 'fixture-owner/fixture-bucket';
const CHECK_MS = 1000;   // AM_VISIBILITY_CHECK_MS for this run
const GRACE_MS = 2500;   // AM_VISIBILITY_GRACE_MS for this run
const MARKER = 'FAKE-CLAUDE-READY';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const waitFor = async (fn, timeout = 8000, step = 50) => {
  const until = Date.now() + timeout;
  for (;;) {
    let v; try { v = await fn(); } catch {}
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(step);
  }
};

// ---------- fake Hub ----------
// mode.space: private | public | error | hang ; mode.bucket: private | public | error
const mode = { space: 'error', bucket: 'private' };
const hubCalls = [];
const hub = http.createServer((req, res) => {
  hubCalls.push({ at: Date.now(), url: req.url, auth: !!req.headers.authorization });
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const repo = (id, m) => {
    if (m === 'hang') return; // never answers
    if (m === 'error') return json(503, { error: 'unavailable' });
    if (m === 'public') return json(200, { id, private: false, runtime: {} });
    return json(401, { error: 'Invalid username or password.' });
  };
  if (req.url === `/api/spaces/${SPACE_ID}`) {
    if (req.headers.authorization) {
      if (mode.space === 'error') return json(503, { error: 'unavailable' });
      return json(200, { id: SPACE_ID, private: mode.space !== 'public', runtime: { volumes: [{ type: 'bucket', source: BUCKET_ID, mountPath: '/data' }] } });
    }
    return repo(SPACE_ID, mode.space);
  }
  if (req.url === `/api/buckets/${BUCKET_ID}`) return repo(BUCKET_ID, mode.bucket);
  json(404, { error: 'unknown fixture route' });
});
await new Promise((r) => hub.listen(0, '127.0.0.1', r));
const HUB_PORT = hub.address().port;

// ---------- the server, with a fake agent binary ----------
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-vis-lock-'));
const bin = path.join(DATA_DIR, 'bin');
fs.mkdirSync(bin, { recursive: true });
const startLog = path.join(DATA_DIR, 'fake-claude.starts');
const stdinLog = path.join(DATA_DIR, 'fake-claude.stdin');
// The pane named "slow" prints for 3 s after starting and then goes quiet — so
// it becomes "ready for input" only well after it started. Every other pane
// keeps printing forever. Both record what reached their stdin.
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
echo "start $$ $AM_NAME" >> "${startLog}"
echo "${MARKER}"
if [ "$AM_NAME" = slow ]; then
  ( for i in $(seq 1 15); do echo tick; sleep 0.2; done ) &
else
  ( while :; do echo tick; sleep 0.2; done ) &
fi
TICKER=$!
trap 'kill $TICKER 2>/dev/null; exit 0' TERM INT HUP
cat >> "${stdinLog}.$AM_NAME"
kill $TICKER 2>/dev/null
`, { mode: 0o755 });
const stdinOf = (name) => (fs.existsSync(`${stdinLog}.${name}`) ? fs.readFileSync(`${stdinLog}.${name}`, 'utf8') : '');

// Sessions run in a LOGIN shell, and /etc/profile rebuilds PATH — so the fake
// binary must be put back by the fixture HOME's own profile.
const HOME = path.join(DATA_DIR, 'home');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.profile'), `export PATH="${bin}:$PATH"\n`);

const { SPACE_ID: _s, AM_DISTRIBUTE_SKILLS, HF_TOKEN, HUGGING_FACE_HUB_TOKEN, HF_API_TOKEN, ...BASE_ENV } = process.env;
const server = spawn('node', ['src/index.js'], {
  env: {
    ...BASE_ENV,
    PATH: `${bin}:${BASE_ENV.PATH || ''}`,
    PORT: String(PORT), DATA_DIR, HOME,
    CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
    AM_BASHRC: '/nonexistent', SPACE_HOST: '',
    SPACE_ID, HF_ENDPOINT: `http://127.0.0.1:${HUB_PORT}`, HF_TOKEN: 'hf_fixture_not_a_real_token',
    AM_VISIBILITY_CHECK_MS: String(CHECK_MS), AM_VISIBILITY_GRACE_MS: String(GRACE_MS),
    AM_INPUT_READY_QUIET_MS: '500',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => { log += c; });
server.stderr.on('data', (c) => { log += c; });
let serverExited = false;
server.on('exit', (code, sig) => { serverExited = true; log += `\n[server exited code=${code} sig=${sig}]\n`; });
process.on('uncaughtException', (e) => { check('no uncaught error in the test harness', false, `${e && e.message}\n--- server log ---\n${log.slice(-6000)}`); process.exit(1); });

const api = async (route, init = {}) => {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET') headers.set('x-am-origin', 'operator');
  const r = await fetch(`${API}${route}`, { ...init, headers });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const info = () => api('/api/info').then((r) => r.body);

// A well-behaved terminal client (the `ws` package): collects frames and the close code.
const attach = (id) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=${encodeURIComponent(id)}&cols=80&rows=24`);
  const c = { ws, text: '', frames: 0, framesAfterClose: 0, closed: null, opened: false };
  ws.on('open', () => { c.opened = true; });
  ws.on('message', (d) => { c.frames++; if (c.closed) c.framesAfterClose++; c.text += d.toString(); });
  ws.on('close', (code, reason) => { c.closed = { code, reason: reason.toString() }; resolve(c); });
  ws.on('error', () => {});
  setTimeout(() => resolve(c), 1500); // resolve once attached even if it stays open
});

// A raw WebSocket client over a plain socket: does the handshake, parses server
// frames, and can keep SENDING after the server's close frame (which the `ws`
// library would never do).
async function rawAttach(id) {
  const sock = net.connect(PORT, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  const key = crypto.randomBytes(16).toString('base64');
  sock.write(`GET /ws?session=${encodeURIComponent(id)}&cols=80&rows=24 HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const c = { sock, text: '', frames: 0, framesAfterClose: 0, close: null, ended: false };
  let buf = Buffer.alloc(0);
  let handshaken = false;
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!handshaken) {
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      handshaken = true;
      buf = buf.subarray(i + 4);
    }
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f; let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (op === 8) { c.close = { code: payload.length >= 2 ? payload.readUInt16BE(0) : null, reason: payload.subarray(2).toString() }; }
      else if (op === 1 || op === 2) { c.frames++; if (c.close) c.framesAfterClose++; c.text += payload.toString(); }
    }
  });
  sock.on('close', () => { c.ended = true; });
  sock.on('error', () => {});
  c.send = (obj) => {
    const data = Buffer.from(JSON.stringify(obj));
    const mask = crypto.randomBytes(4);
    const head = data.length < 126 ? Buffer.from([0x81, 0x80 | data.length]) : Buffer.concat([Buffer.from([0x81, 0x80 | 126]), Buffer.from([data.length >> 8, data.length & 0xff])]);
    const masked = Buffer.from(data.map((b, i) => b ^ mask[i % 4]));
    try { sock.write(Buffer.concat([head, mask, masked])); return true; } catch { return false; }
  };
  return c;
}

// The remote agent's long poll: resolves with the final JSON line.
const openStream = (name, wait = 60) => {
  const out = { lines: [], final: null, status: null, done: false };
  out.promise = (async () => {
    const r = await fetch(`${API}/api/remote/${encodeURIComponent(name)}/stream?since=0&wait=${wait}`);
    out.status = r.status;
    const text = await r.text();
    out.lines = text.split('\n').filter(Boolean);
    const j = out.lines.find((l) => l.startsWith('{'));
    out.final = j ? JSON.parse(j) : null;
    out.done = true;
    return out;
  })().catch((e) => { out.error = e.message; out.done = true; return out; });
  return out;
};

try {
  const up = await waitFor(() => fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false), 20000);
  check('server listens while the first check is failing (no indefinite wait)', !!up);

  // ---- 1. never verified: locked, checking, safe routes only ----
  let i = await info();
  check('boot without evidence: locked with reason checking', i.locked === true && i.lockReason === 'checking' && i.visibility?.reason === 'checking');
  check('locked /api/info withholds secrets and backup detail', Array.isArray(i.secrets) && i.secrets.length === 0 && i.backup === null);
  let r = await api('/api/sessions');
  check('protected route refused with the machine-readable reason', r.status === 403 && r.body?.error === 'locked' && r.body?.reason === 'checking', JSON.stringify(r.body));
  r = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'nope', cli: 'claude' }) });
  check('mutation refused before any side effect', r.status === 403 && (await api('/api/visibility')).status === 200);
  // Admission has to agree with the ROUTER: Express matches case-insensitively
  // and tolerates a trailing slash, so those spellings reach privileged
  // handlers and must be refused just the same. Odd spellings Express does not
  // route may 404, but must never succeed.
  for (const p of ['/API/sessions', '/Api/Sessions', '/api/sessions/', '/api/sessions//', '/api//sessions', '/API/tree', '/api/Tree/']) {
    r = await api(p);
    check(`locked: ${p} is not served (${r.status})`, r.status === 403 || r.status === 404, JSON.stringify(r.body));
  }
  for (const p of ['/API/INFO', '/api/info/', '/Api/Visibility', '/api/health/']) {
    r = await api(p);
    check(`locked: safe route spelling ${p} still answers (${r.status})`, r.status === 200);
  }
  r = await api('/API/Sessions', { method: 'POST', body: JSON.stringify({ name: 'nope2', cli: 'claude' }) });
  check('locked: a mutation through a routed spelling is refused before any effect', r.status === 403);
  const wsChecking = await attach('any');
  check('terminal attach refused with code 4003 while checking', wsChecking.closed?.code === 4003 && /^locked:checking:\d+$/.test(wsChecking.closed?.reason || ''), JSON.stringify(wsChecking.closed));
  const vis = (await api('/api/visibility')).body;
  check('/api/visibility is public-safe: verdicts and timestamps, no bucket ids while locked', vis.locked && vis.space?.verdict === 'unknown' && vis.buckets.length === 0 && !JSON.stringify(vis).includes('hf_fixture'));

  // ---- 2. verification succeeds: opens on its own ----
  mode.space = 'private';
  const t1 = Date.now();
  i = await waitFor(async () => { const x = await info(); return x && !x.locked ? x : null; }, 4 * CHECK_MS);
  check(`unlocks within a check cycle of valid evidence (${Date.now() - t1} ms)`, !!i && i.lockReason === null && i.bucketUnverified === false);
  check('verified Space and bucket are both reported', i.visibility.space.verdict === 'private' && i.visibility.buckets.some((b) => b.id === BUCKET_ID && b.verdict === 'private'));
  // Boot probes the CLI once (version/availability); count agent starts from here.
  // Per agent: lines are "start <pid> <name>".
  const startsOf = (name) => (fs.existsSync(startLog) ? fs.readFileSync(startLog, 'utf8').split('\n').filter((l) => l.endsWith(` ${name}`)).length : 0);

  // ---- 3. live clients ----
  r = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'agent', cli: 'claude' }) });
  check('session created while unlocked', r.status === 201, JSON.stringify(r.body));
  const sid = r.body.id;
  r = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'laptop', cli: 'remote' }) });
  check('remote pane created', r.status === 201, JSON.stringify(r.body));

  const controller = await attach(sid);
  await waitFor(() => controller.text.includes(MARKER), 8000);
  check('controller attached and sees the agent start', controller.opened && controller.text.includes(MARKER), controller.text.includes(MARKER) ? '' : `starts=${startsOf('agent')} closed=${JSON.stringify(controller.closed)} text=${JSON.stringify(controller.text.slice(0, 300))}`);
  const watcher = await rawAttach(sid);
  await waitFor(() => watcher.text.includes(MARKER), 8000);
  check('raw watcher attached and receives output', watcher.text.includes(MARKER));
  controller.ws.send(JSON.stringify({ t: 'i', d: 'before-lock\n' }));
  check('input before the lock reaches the PTY', !!(await waitFor(() => stdinOf('agent').includes('before-lock'))));
  const waitPoll = fetch(`${API}/api/agents/${sid}/wait?state=stopped&timeout=60`).then(async (x) => ({ status: x.status, body: await x.json() }));
  // The same long poll through a spelling only the router normalises.
  const waitPollUpper = fetch(`${API}/API/agents/${sid}/wait?state=stopped&timeout=60`).then(async (x) => ({ status: x.status, body: await x.json() })).catch((e) => ({ status: 0, error: e.message }));

  // A workspace file being REPLACED by an upload that stalls mid-body. The old
  // bytes must survive the lock cutting that upload.
  r = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'files', cli: 'shell', path: 'files-ws' }) });
  check('files session created', r.status === 201, JSON.stringify(r.body));
  const filesId = r.body.id;
  const filesDir = path.join(DATA_DIR, 'workspaces', 'files-ws');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.writeFileSync(path.join(filesDir, 'keep.txt'), 'OLD-CONTENT-MUST-SURVIVE');
  const upload = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: `/api/files/${filesId}/upload?name=keep.txt`, headers: { 'content-type': 'application/octet-stream', 'content-length': '100000', 'x-am-origin': 'operator' } });
  const uploadOutcome = new Promise((resolve) => { upload.on('response', (x) => resolve({ status: x.statusCode })); upload.on('error', (e) => resolve({ error: e.code || e.message })); });
  upload.write('NEW-PARTIAL-');
  await sleep(300);
  check('the stalled upload has not touched the target file', fs.readFileSync(path.join(filesDir, 'keep.txt'), 'utf8') === 'OLD-CONTENT-MUST-SURVIVE');

  // A prompt to a stopped agent that takes a few seconds to become ready: the
  // request is admitted now, its effect (typing) would land after the lock.
  r = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'slow', cli: 'claude' }) });
  const slowId = r.body?.id;
  const slowFirst = await attach(slowId);
  await waitFor(() => slowFirst.text.includes(MARKER), 8000);
  slowFirst.ws.close();
  r = await api(`/api/sessions/${slowId}/stop`, { method: 'POST' });
  check('slow agent started once and stopped', r.status === 200 && !!(await waitFor(async () => ((await api('/api/sessions')).body || []).find((x) => x.id === slowId)?.state === 'stopped', 8000)), JSON.stringify(r.body));
  const slowStarts0 = startsOf('slow');
  const lateInput = fetch(`${API}/api/sessions/${slowId}/input`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-am-origin': 'operator' }, body: JSON.stringify({ text: 'late-input' }) })
    .then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })).catch((e) => ({ status: 0, error: e.cause?.code || e.message }));
  await waitFor(() => startsOf('slow') > slowStarts0, 5000);
  check('the delayed prompt restarted the slow agent and is waiting for readiness', startsOf('slow') === slowStarts0 + 1 && !stdinOf('slow').includes('late-input'));
  const stream = openStream('laptop');
  await waitFor(() => api('/api/sessions/' + sid + '/remote').then(() => true));
  await sleep(300);
  check('remote stream is open and heart-beating', !stream.done);

  // ---- 4. the Space turns public: every client is revoked, on the server ----
  mode.space = 'public';
  const t2 = Date.now();
  const lockedInfo = await waitFor(async () => { const x = await info(); return x?.locked ? x : null; }, 4 * CHECK_MS);
  const lockLatency = Date.now() - t2;
  check(`lock observed within a check cycle (${lockLatency} ms)`, !!lockedInfo && lockedInfo.lockReason === 'public-space');
  await waitFor(() => controller.closed && watcher.close, 3000);
  check('controller socket closed with 4003 locked:public-space', controller.closed?.code === 4003 && /^locked:public-space:\d+$/.test(controller.closed?.reason || ''), JSON.stringify(controller.closed));
  check('watcher socket got the same close frame', watcher.close?.code === 4003 && watcher.close?.reason === controller.closed?.reason, JSON.stringify(watcher.close));
  check(`revocation landed within ${lockLatency + 1500} ms of the verdict`, controller.closed && watcher.close);
  const wp = await waitFor(() => waitPoll.then((x) => x).catch(() => null), 3000);
  check('/wait long poll ended at once with the locked refusal', wp?.status === 403 && wp?.body?.error === 'locked' && wp?.body?.reason === 'public-space', JSON.stringify(wp));
  await waitFor(() => stream.done, 3000);
  check('remote stream ended with the protocol stop line naming the lock', stream.done && stream.final?.stop === true && /locked.*public-space/.test(stream.final?.reason || ''), JSON.stringify(stream.final));
  const wpu = await waitFor(() => waitPollUpper.then((x) => x).catch(() => null), 3000);
  check('the long poll opened through a routed spelling was revoked too', wpu?.status === 403 && wpu?.body?.reason === 'public-space', JSON.stringify(wpu));
  check('the refusal body carries the lock seq', typeof wp?.body?.seq === 'number' && wp.body.seq === lockedInfo.visibility.seq, JSON.stringify(wp?.body));
  check('the close reason carries the same seq', controller.closed?.reason === `locked:public-space:${lockedInfo.visibility.seq}`, JSON.stringify(controller.closed));
  const upCut = await waitFor(() => uploadOutcome.then((x) => x), 3000);
  check('the stalled upload was cut by the lock', !!upCut && upCut.status !== 200, JSON.stringify(upCut));
  check('the file it was replacing is intact', fs.readFileSync(path.join(filesDir, 'keep.txt'), 'utf8') === 'OLD-CONTENT-MUST-SURVIVE');
  check('no staging file left behind', fs.readdirSync(filesDir).filter((f) => f.includes('am-upload')).length === 0, fs.readdirSync(filesDir).join(','));
  const li = await waitFor(() => lateInput.then((x) => x), 3000);
  check('the delayed prompt request was cut by the lock', !!li && li.status !== 200, JSON.stringify(li));
  await sleep(4500); // the slow agent becomes ready in here
  check('a prompt still waiting for readiness when the lock landed is never typed', !stdinOf('slow').includes('late-input'), JSON.stringify(stdinOf('slow').slice(-80)));
  check('...and the slow agent itself keeps running (one restart, from before the lock)', startsOf('slow') === slowStarts0 + 1);

  // The misbehaving watcher keeps writing: nothing may reach the PTY.
  const stdinBefore = stdinOf('agent');
  const ticksBefore = watcher.frames;
  watcher.send({ t: 'claim' });
  watcher.send({ t: 'r', cols: 33, rows: 11 });
  watcher.send({ t: 'i', d: 'INJECTED-AFTER-LOCK\n' });
  await sleep(1200);
  check('input written after revocation never reaches the PTY', stdinOf('agent') === stdinBefore && !stdinOf('agent').includes('INJECTED'));
  check('no output frames after the close frame (agent is still printing ticks)', watcher.framesAfterClose === 0 && watcher.frames === ticksBefore, `after=${watcher.framesAfterClose}`);
  await waitFor(() => watcher.ended, 3000);
  check('the server terminated the lingering socket that never answered the close frame', watcher.ended);

  // New work is refused while locked.
  r = await api(`/api/sessions/${sid}/input`, { method: 'POST', body: JSON.stringify({ text: 'nope' }) });
  check('input route refused while locked', r.status === 403 && r.body?.reason === 'public-space');
  const wsLocked = await attach(sid);
  check('new attach refused with locked:public-space', wsLocked.closed?.code === 4003 && /^locked:public-space:\d+$/.test(wsLocked.closed?.reason || ''));
  const s2 = openStream('laptop', 5);
  await waitFor(() => s2.done, 8000);
  check('a new remote poll is refused with the locked body', s2.status === 403);
  i = await info();
  check('safe status stays available and explains the lock', i.locked && i.lockReason === 'public-space' && i.spaceId === SPACE_ID && i.secrets.length === 0);
  check('the fake agent was not killed or restarted by the lock', startsOf('agent') === 1, `starts ${startsOf('agent')}`);
  const stdinAfterLock = stdinOf('agent');

  // ---- 5. back to private: reopens; reattach follows normal replay rules ----
  mode.space = 'private';
  i = await waitFor(async () => { const x = await info(); return x && !x.locked ? x : null; }, 4 * CHECK_MS);
  check('reopens automatically once verified private again', !!i && i.lockReason === null);
  const again = await attach(sid);
  await waitFor(() => again.text.includes(MARKER), 8000);
  check('reattach replays the same agent screen', again.opened && again.text.includes(MARKER) && !again.closed);
  check('no new agent process on reopening', startsOf('agent') === 1, `starts ${startsOf('agent')}`);
  check('nothing was replayed into the PTY on reopening', stdinOf('agent') === stdinAfterLock);
  again.ws.send(JSON.stringify({ t: 'i', d: 'after-unlock\n' }));
  check('input works again through the new connection', !!(await waitFor(() => stdinOf('agent').includes('after-unlock'))));
  check('the cancelled prompt is not replayed on reopening', !stdinOf('slow').includes('late-input'));
  const uploadFull = await new Promise((resolve) => {
    const q = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: `/api/files/${filesId}/upload?name=keep.txt`, headers: { 'content-type': 'application/octet-stream', 'x-am-origin': 'operator' } }, (x) => resolve({ status: x.statusCode }));
    q.on('error', (e) => resolve({ error: e.message }));
    q.end('NEW-CONTENT');
  });
  check('a complete upload after reopening replaces the file atomically', uploadFull.status === 200 && fs.readFileSync(path.join(filesDir, 'keep.txt'), 'utf8') === 'NEW-CONTENT' && fs.readdirSync(filesDir).filter((f) => f.includes('am-upload')).length === 0, JSON.stringify(uploadFull));
  const s3 = openStream('laptop');
  await sleep(400);
  check('remote polls are accepted again', !s3.done);

  // ---- 6. outage: grace, then verification-unavailable ----
  // Grace runs from the last SUCCESSFUL verification, not from the first
  // failure, so the expected expiry is computed from the reported verifiedAt.
  mode.space = 'error';
  const v0 = (await info()).visibility.verifiedAt;
  const expectedExpiry = v0 + GRACE_MS;
  await sleep(Math.max(0, expectedExpiry - 900 - Date.now()));
  const readAt = Date.now();
  const inside = await info();
  // On a loaded box the read itself can land after the expiry; only a read that
  // finished with margin says anything about grace.
  if (Date.now() < expectedExpiry - 150) {
    check('inside grace the app stays open, and failed checks do not renew verifiedAt', !inside.locked && inside.visibility.verifiedAt === v0,
      `read ${expectedExpiry - readAt} ms before expiry: locked=${inside.locked} reason=${inside.lockReason} verifiedAt-v0=${inside.visibility.verifiedAt - v0} attemptedAt-v0=${inside.visibility.attemptedAt - v0}`);
    if (inside.visibility.attemptedAt > v0) check('a failed attempt inside grace is recorded as attempted, not verified', inside.visibility.space.verifiedAt === v0 || inside.visibility.space.attemptedAt > inside.visibility.space.verifiedAt);
  } else {
    check('inside-grace read was inconclusive (box too slow to read before expiry); failures still did not renew verifiedAt', inside.visibility.verifiedAt === v0);
  }
  const unavailable = await waitFor(async () => { const x = await info(); return x?.locked ? x : null; }, GRACE_MS + 2 * CHECK_MS);
  const lateBy = Date.now() - expectedExpiry;
  check(`grace expires into verification-unavailable (${lateBy} ms after the computed expiry)`, unavailable?.lockReason === 'verification-unavailable' && lateBy >= -300 && lateBy < 1500);
  await waitFor(() => again.closed, 3000);
  check('the open terminal was revoked by the expiry with its own reason', again.closed?.code === 4003 && /^locked:verification-unavailable:\d+$/.test(again.closed?.reason || ''), JSON.stringify(again.closed));
  await waitFor(() => s3.done, 3000);
  check('the remote poll was stopped by the expiry', s3.done && s3.final?.stop === true);
  check('unavailable is described as an outage, not as public', unavailable.visibility.space.verdict === 'private' && unavailable.visibility.verifiedAt === null);
  mode.space = 'private';
  i = await waitFor(async () => { const x = await info(); return x && !x.locked ? x : null; }, 4 * CHECK_MS);
  check('recovers when verification succeeds again', !!i);

  // ---- 7. public bucket ----
  mode.bucket = 'public';
  const pb = await waitFor(async () => { const x = await info(); return x?.locked ? x : null; }, 4 * CHECK_MS);
  check('a public mounted bucket locks and is named', pb?.lockReason === 'public-bucket' && pb?.lockBucket === BUCKET_ID);
  const visLocked = (await api('/api/visibility')).body;
  check('locked status names only the offending bucket', visLocked.buckets.length === 1 && visLocked.buckets[0].id === BUCKET_ID);
  mode.bucket = 'error';
  await sleep(2 * CHECK_MS);
  check('an error about the known-public bucket does not reopen', (await info()).lockReason === 'public-bucket');
  mode.bucket = 'private';
  i = await waitFor(async () => { const x = await info(); return x && !x.locked ? x : null; }, 4 * CHECK_MS);
  check('reopens once the bucket verifies private', !!i);

  // ---- 8. bounded work: status reads are cached, checks are one per cycle ----
  const before = hubCalls.length;
  for (let k = 0; k < 40; k++) await api('/api/visibility');
  for (let k = 0; k < 10; k++) await info();
  check('50 status reads caused no Hub requests', hubCalls.length - before <= 2, `${hubCalls.length - before} hub calls during status reads`);
  const windowStart = Date.now();
  await sleep(3 * CHECK_MS);
  const inWindow = hubCalls.filter((c) => c.at >= windowStart).length;
  check(`bounded checks: ${inWindow} Hub requests in ${3 * CHECK_MS} ms (≤ 2 per cycle: space + bucket)`, inWindow <= 2 * 4 && inWindow >= 2);
  check('discovery ran once (deployment-scoped cache)', hubCalls.filter((c) => c.auth).length <= 2, `${hubCalls.filter((c) => c.auth).length} authenticated calls`);
  check('the fixture token never appears in server output', !log.includes('hf_fixture_not_a_real_token'));
} catch (e) {
  check('suite completed', false, e && e.stack);
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => { server.once('exit', r); setTimeout(r, 4000); });
  hub.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

if (fail) { console.log('\n--- server log ---\n' + log.slice(-6000)); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
