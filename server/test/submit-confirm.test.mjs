// A prompt AM types into Codex or Claude Code must actually be submitted — or
// the send says it was not.
//
// Delivered prompts were left sitting in the composer (Codex showing
// `› [Pasted Content 1063 chars]`, a Claude pane likewise) with the session
// `waiting`, after AM pressed Enter and answered ok — several times a day,
// each fixed only by the operator pressing Enter. Against a local Codex TUI an
// Enter while it shows "Waiting for startup" does nothing; an idle pane took
// the Enter every time tried, so the cause of the real cases is not known.
//
// So for these CLIs AM reads the composer back off the screen: it waits for
// the prompt to show there and for startup to end, presses Enter, checks the
// composer no longer holds the prompt, presses once more only while it still
// visibly does, and reports a failure if that did not take either. Driven here
// through a real server and a fake TUI (fixtures/fake-submit-tui.mjs) that
// loses Enters on demand; the composer readers are checked on screens captured
// from the real CLIs.
//
// Run with:  node test/submit-confirm.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { codexComposer, claudeComposer } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

// ---- reading the composer, on screens captured from the real CLIs ----
const SCREENS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/input-lines.json'), 'utf8'));
const asText = (snap) => { const rows = []; for (const l of snap.visibleLines) rows[l.row] = l.text; return Array.from(rows, (v) => v || '').join('\n'); };
console.log('\n# composers, read off real screens');
for (const [cli, read] of [['claude', claudeComposer], ['codex', codexComposer]]) {
  check(`${cli}: the typed text is in the composer, and only there`, () => {
    assert.match(read(asText(SCREENS[cli].typed)), /^half typed thought/);
    assert.doesNotMatch(read(asText(SCREENS[cli].empty)), /half typed thought/);
  });
}
// Captured from Codex 0.162.1 (conversation text redacted).
check('codex: a prompt left unsubmitted is in the composer', () => {
  assert.match(codexComposer('  >_ OpenAI Codex (v0.162.1)\n› [Pasted Content 1169 chars]\n  Waiting for startup  · esc cancel'),
    /^\[Pasted Content 1169 chars\]/);
});
check('codex: after a submit the composer is the fresh line below the conversation', () => {
  const c = codexComposer([
    '› [message from manager:] **Review PR #N** … redacted …',
    '  … redacted … nonce-178881',
    '• Working (1s • esc to interrupt)',
    '› Ask Codex to do anything',
    '  gpt-5 default · ~/work · ⠸',
  ].join('\n'));
  assert.match(c, /^Ask Codex to do anything/);
  assert.doesNotMatch(c, /nonce-178881|Pasted Content/);
});
check('claude: the composer ends at its closing rule, below the conversation', () => {
  const c = claudeComposer(['❯ an earlier prompt', '⏺ Done.', '─'.repeat(40), '❯ [Pasted text #1 +40 lines]', '─'.repeat(40), '  ⏵⏵ auto mode on'].join('\n'));
  assert.equal(c, '[Pasted text #1 +40 lines]');
});
check('a screen without a composer reads as none', () => {
  assert.equal(codexComposer('  >_ OpenAI Codex (v0.162.1)\n  Resuming session…'), null);
});

// ---- and the whole path, through a real server and a fake TUI ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'submit-confirm-'));
const DATA_DIR = path.join(root, 'data'); fs.mkdirSync(DATA_DIR, { recursive: true });
const PUBLIC_DIR = path.join(root, 'public'); fs.mkdirSync(PUBLIC_DIR);
fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), '<html>fixture</html>');
const FAKE_DIR = path.join(root, 'fake'); fs.mkdirSync(FAKE_DIR);
const read = (f) => { try { return fs.readFileSync(path.join(FAKE_DIR, f), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const setMode = (m) => {
  fs.writeFileSync(path.join(FAKE_DIR, 'mode'), JSON.stringify(m));
  for (const f of ['enters', 'submitted']) fs.rmSync(path.join(FAKE_DIR, f), { force: true });
};

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(String(port))); });
});
const PORT = await freePort();
const API = `http://127.0.0.1:${PORT}`;
// An allowlist, not process.env: inside a Space the shell exports live agent
// state paths that a child must never inherit.
const inherited = Object.fromEntries(['PATH', 'LANG', 'TZ'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
const home = path.join(root, 'home'); fs.mkdirSync(home);
const backend = spawn('node', ['src/index.js'], {
  cwd: path.join(HERE, '..'), stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...inherited, HOME: home, PORT, DATA_DIR, PUBLIC_DIR, AM_BASHRC: '/nonexistent', SPACE_HOST: '',
    AM_ALLOW_MISSING_ORIGIN: '1', AM_SUBMIT_CONFIRM_TIMEOUT_MS: '1500', AM_PASTE_SHOWN_TIMEOUT_MS: '3000',
    // One command: the pane runs `exec <run>`, and the login shell may drop
    // a fixture's PATH, so the interpreter is named absolutely.
    AM_TEST_SUBMIT_CMD: `env FAKE_DIR=${FAKE_DIR} ${process.execPath} ${path.join(HERE, 'fixtures', 'fake-submit-tui.mjs')}` },
});
let logs = '';
backend.stdout.on('data', (d) => { logs += d; });
backend.stderr.on('data', (d) => { logs += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(150); }
  return false;
};
const post = (p, body) => fetch(API + p, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-am-request': '1' },
  body: body === undefined ? undefined : JSON.stringify(body) });
const PROMPT = `[message from manager:] **Review PR #197**\n${'Check the install page and report. '.repeat(30)}`;
const openPane = async (name) => {
  const made = await (await post('/api/sessions', { cli: 'test-submit', name, path: '.' })).json();
  const ws = new WebSocket(`${API.replace('http', 'ws')}/ws?session=${made.id}&cols=100&rows=30`, { headers: { 'x-am-request': '1' } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await sleep(2500);
  return { id: made.id, ws };
};

try {
  if (!await until(() => fetch(`${API}/api/health`).then((r) => r.ok), 60_000)) throw new Error(`server did not start:\n${logs.slice(-1200)}`);
  await post('/api/welcome/seen');
  let pane = await openPane('fake-codex');
  const send = async () => { const r = await post(`/api/sessions/${pane.id}/input`, { text: PROMPT }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  console.log('\n# a TUI that takes the first Enter');
  setMode({});
  const ok = await send();
  check('the prompt is submitted once, with one Enter', () => {
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(read('submitted').length, 1);
    assert.deepEqual(read('enters'), ['with-text'], 'no second Enter after a submit that took');
  });

  console.log('\n# a TUI that swallows the first Enter');
  setMode({ swallow: 1 });
  const retried = await send();
  check('AM notices the prompt is still in the composer, presses again, and it is submitted', () => {
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(read('submitted').length, 1, 'submitted exactly once');
    assert.deepEqual(read('enters'), ['with-text', 'with-text']);
  });

  console.log('\n# a TUI that draws the paste late and loses an Enter before that');
  setMode({ paintMs: 900 });
  const late = await send();
  check('AM waits for the paste to show before pressing Enter', () => {
    assert.equal(late.status, 200, JSON.stringify(late.body));
    assert.equal(read('submitted').length, 1);
    assert.deepEqual(read('enters'), ['with-text'], 'Enter pressed before the paste was drawn');
  });

  console.log('\n# a TUI still starting up (Codex "Waiting for startup")');
  setMode({ startMs: 2000 });
  const booting = await send();
  check('AM waits for startup to finish, then submits with one Enter', () => {
    assert.equal(booting.status, 200, JSON.stringify(booting.body));
    assert.equal(read('submitted').length, 1);
    assert.deepEqual(read('enters'), ['with-text'], 'Enter pressed while it was still starting');
  });

  console.log('\n# an Enter that opens a dialog over the composer instead of submitting');
  setMode({ dialog: true });
  await send();
  check('gets no second Enter pressed into the dialog', () => {
    assert.equal(read('submitted').length, 0);
    assert.deepEqual(read('enters'), ['with-text'], 'an Enter was pressed into the dialog');
  });
  // That pane is wedged in its dialog now; the rest get a fresh one.
  pane.ws.close();
  pane = await openPane('fake-codex-2');

  console.log('\n# a TUI that swallows every Enter AM sends');
  setMode({ swallow: 5 });
  const stuck = await send();
  check('the send fails instead of answering ok', () => {
    assert.equal(stuck.status, 409, `answered ${stuck.status}: ${JSON.stringify(stuck.body)}`);
    assert.equal(stuck.body.code, 'input-not-submitted');
    assert.equal(read('submitted').length, 0);
    assert.equal(read('enters').length, 2, 'exactly one retry');
    assert.match(String(stuck.body.error || ''), /did not submit it/);
  });
  const next = await send();
  check('and the next send is refused, not glued onto the unsent prompt', () => {
    assert.equal(next.status, 409, `answered ${next.status}: ${JSON.stringify(next.body)}`);
    assert.match(String(next.body.error || ''), /unsent text/);
  });
  pane.ws.close();
} catch (error) {
  failed++; console.log(`  FAIL no unexpected exception\n       ${error.stack}`);
} finally {
  backend.kill('SIGTERM');
  await new Promise((r) => { backend.once('exit', r); setTimeout(r, 2000); });
  fs.rmSync(root, { recursive: true, force: true });
}
if (failed) { console.log(`\n${failed} check(s) failed\n${logs.slice(-1500)}`); process.exit(1); }
console.log('\nsubmit-confirm: all checks passed');
