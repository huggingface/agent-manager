// What an unreadable /data/codex-bindings.json may and may not stop.
//
// The file is AM's own record of which AM session owns which shared Codex
// thread, and it is consulted on EVERY Codex launch — before the pilot flags
// are looked at. So one malformed byte used to refuse every Codex session on
// the box, on hosts that had never enabled the pilot, with a bare 503 that
// named neither the file nor the repair.
//
// It cannot simply fail open. A binding written while the pilot was on outlives
// the flag, and sessions.json and codex-bindings.json are separate durable
// files that are not restored together — so the session ROW is not evidence
// either: a partial restore can leave a row with no thread pin beside a record
// that still binds it.
//
// The evidence that holds is the COMMAND. Only a resume can attach to an
// existing conversation (`resume <id>`, or `resume --last`, which scopes to the
// cwd and can land on a bound thread). A session that has never started, with
// no pin and no rollout, gets a fresh `codex` — which cannot become a second
// writer whatever the file says. So: refuse what could resume, allow what
// cannot.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REQUEST_HEADERS } from '../src/request-admission.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-bindings-unreadable-'));
process.env.DATA_DIR = dir;
delete process.env.AM_CODEX_BINDINGS_PILOT;
delete process.env.AM_CODEX_SHARED_CREATE;
fs.mkdirSync(path.join(dir, 'workspaces', 'w'), { recursive: true });
const FILE = path.join(dir, 'codex-bindings.json');

const { assertCodexLaunchAllowed, boundOrUnknown, unsafeWithoutBindings } = await import('../src/codex-launch-policy.js');
const { CodexBindings, endpointIdentity } = await import('../src/codex-bindings.js');
const { commandFor } = await import('../src/runner.js');
const { SessionRuntime } = await import('../src/session-runtime.js');

const THREAD = '11111111-1111-4111-8111-111111111111';
const codex = (extra = {}) => ({ id: `s-${crypto.randomBytes(4).toString('hex')}`, cli: 'codex',
  sessionUuid: crypto.randomUUID(), path: 'w', everStarted: true, ...extra });
const corrupt = () => fs.writeFileSync(FILE, '{"version":1,"bindings":[');
const clear = () => { try { fs.unlinkSync(FILE); } catch {} };
const refusal = (session) => {
  try { assertCodexLaunchAllowed(session); return null; } catch (error) { return error; }
};

test('with no bindings file, an ordinary Codex session launches', () => {
  clear();
  assert.equal(refusal(codex()), null);
  assert.equal(refusal(codex({ codexSessionId: THREAD })), null);
});

test('an unreadable bindings file still lets a fresh Codex conversation start', () => {
  corrupt();
  // Never started, no pin, no rollout: commandFor can only give it a new
  // conversation, which is not a second writer on anything.
  const fresh = codex({ everStarted: false });
  assert.equal(unsafeWithoutBindings(fresh), false);
  assert.equal(refusal(fresh), null, 'a new Codex session still opens');
  assert.doesNotMatch(commandFor(fresh), /resume/, 'and what it opens is a fresh conversation');
  assert.equal(refusal({ ...codex(), cli: 'claude' }), null, 'other agents were never affected');
});

test('an unreadable bindings file refuses every launch that could resume', () => {
  corrupt();
  for (const [what, session] of [
    // The restore case: sessions.json came back from an older copy without the
    // pin, codex-bindings.json did not. The row says "unbound"; it is not
    // evidence. `resume --last` scopes to the cwd and can land on the bound
    // thread, so this must refuse even though the row looks clean.
    ['a started session whose row lost its pin', codex({ everStarted: true })],
    ['a pinned session', codex({ codexSessionId: THREAD })],
    ['a session with a rollout on disk', codex({ codexRollout: '/tmp/rollout.jsonl' })],
  ]) {
    assert.equal(unsafeWithoutBindings(session), true, what);
    assert.equal(refusal(session)?.code, 'codex-bindings-unreadable', what);
  }
});

test('an unreadable bindings file refuses an import reference and a shared host', () => {
  corrupt();
  const imported = codex({ codexSharedOnly: true });
  const byImport = refusal(imported);
  assert.equal(byImport?.code, 'codex-bindings-unreadable');
  // 409, not 503: errorEnvelope replaces every 5xx body, so a 503 could not
  // tell the operator what to repair however it was worded.
  assert.equal(byImport?.statusCode, 409);

  process.env.AM_CODEX_BINDINGS_PILOT = '1';
  try { assert.equal(refusal(codex())?.code, 'codex-bindings-unreadable', 'with the pilot on, nothing is assumed'); }
  finally { delete process.env.AM_CODEX_BINDINGS_PILOT; }
});

test('the refusal names the file and what repairing it costs', () => {
  corrupt();
  const error = refusal(codex({ codexSessionId: THREAD }));
  assert.match(error.message, /codex-bindings\.json/);
  assert.match(error.message, /remove it to unbind every shared task/);
  assert.match(error.message, /will not resume one that could become a second writer/);
  // The file name survives errorEnvelope's 5xx/4xx filtering; an absolute path
  // would not, which is why it goes to the log instead.
  assert.deepEqual(error.data?.details, [{ field: 'path', message: 'codex-bindings.json' }]);
  assert.ok(error.statusCode < 500, 'a 5xx body would be replaced wholesale');
});

test('background bookkeeping treats an unreadable file as bound, and never throws', () => {
  corrupt();
  const session = codex();
  // The rollout re-pin, breadcrumb capture and stale-pin clear ask this. They
  // run on timers with no request to answer, and re-pinning a bound session is
  // the harmful direction.
  assert.equal(boundOrUnknown(session), true);
  assert.equal(boundOrUnknown(session.id), true);
  clear();
  assert.equal(boundOrUnknown(session), false);
});

test('a real binding still keeps its session off the standalone launch path', () => {
  clear();
  const bindings = new CodexBindings(FILE);
  const session = codex({ codexSessionId: THREAD });
  bindings.bind({ session, threadId: THREAD, expectedRevision: 0,
    cwd: fs.realpathSync(path.join(dir, 'workspaces', 'w')),
    endpointId: endpointIdentity({ socket: '/tmp/s.sock', home: '/tmp/codex-home', uid: process.getuid() }) });
  const command = commandFor(session);
  assert.match(command, /am-codex-context\.mjs/, 'a bound session launches through the shared client');
  assert.doesNotMatch(command, /exec codex/, 'never a standalone writer');
});

test('the runtime answers "not shared" rather than throwing, for every caller', () => {
  corrupt();
  const bindings = new CodexBindings(FILE);
  const runtime = new SessionRuntime({ bindings, codex: { status() { throw new Error('must not connect'); } } });
  // shared() is on the prompt, coordination and trace paths too, not only the
  // roster — presentation()'s own guard would otherwise hide this.
  assert.equal(runtime.shared(codex()), false);
  assert.equal(runtime.shared(codex({ codexSharedOnly: true })), true, 'the session row still counts');
  assert.equal(runtime.presentation(codex()), null);
});

// The whole app, booted against the bad file. The helpers above are called
// directly, so they cannot see this: /api/tree is the sidebar's bootstrap and
// it reads the bindings file for the whole roster before any per-session
// policy runs. One malformed byte used to make it a sanitized 500, which left
// the operator unable to see the session at all — let alone reach the refusal
// that tells them which file to repair.
test('the app still loads, and still lists its Codex sessions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-bindings-http-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(data, 'workspaces', 'w'), { recursive: true });
  const session = { id: 'ordinary-codex', name: 'codex-1', cli: 'codex', path: 'w',
    sessionUuid: crypto.randomUUID(), everStarted: true, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([session], null, 2));
  fs.writeFileSync(path.join(data, 'codex-bindings.json'), '{"version":1,"bindings":[');

  const reserve = http.createServer();
  await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const origin = `http://127.0.0.1:${port}`;
  // cwd, not the runner's: `node --test server/test/...` runs from the repo root.
  const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const server = spawn(process.execPath, ['src/index.js'], { cwd: serverDir, stdio: ['ignore', 'ignore', 'ignore'], env: {
    PATH: process.env.PATH, HOME: home, DATA_DIR: data, PORT: String(port),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'), AM_REPIN_DIR: path.join(root, 'repin'),
    AM_INPUT_REQUIRED_DIR: path.join(root, 'input-required'), AM_BASHRC: '/nonexistent',
  } });
  try {
    for (let n = 0; ; n++) {
      if (await fetch(`${origin}/api/health`).then((r) => r.ok).catch(() => false)) break;
      assert.ok(n < 150 && server.exitCode === null, 'isolated backend started');
      await new Promise((r) => setTimeout(r, 100));
    }
    const get = async (route) => {
      const res = await fetch(origin + route, { headers: REQUEST_HEADERS });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const tree = await get('/api/tree');
    assert.equal(tree.status, 200, `the sidebar bootstrap: ${JSON.stringify(tree.body)}`);
    assert.ok(tree.body.sessions.some((s) => s.id === session.id), 'the Codex session is in the tree');

    const sessions = await get('/api/sessions');
    assert.equal(sessions.status, 200, JSON.stringify(sessions.body));
    const row = sessions.body.find((s) => s.id === session.id);
    assert.ok(row, 'and in the roster');
    assert.notEqual(row.codexShared, true, 'an unreadable file is not evidence that it is shared');

    // Clicking the row. share.findRollout asks the shared resolver BEFORE the
    // ordinary pinned/CWD paths, so a throw there made the default request for
    // every Codex session a sanitized 500: listed in the sidebar, impossible to
    // open. Falling through, this fixture has no transcript at all, and "no
    // trace" is the ordinary answer for that.
    const trace = await get(`/api/trace/${session.id}`);
    assert.notEqual(trace.status, 500, `the reader could not open it: ${JSON.stringify(trace.body)}`);
    assert.equal(trace.status, 404, JSON.stringify(trace.body));
    assert.equal(trace.body.code, 'no-trace');
  } finally {
    if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
