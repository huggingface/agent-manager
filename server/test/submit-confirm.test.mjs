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
import { composerShape, composerBody } from '../src/runner.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

// ---- reading the composer: the input guard's own locator (composerShape) ----
const SCREENS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/input-lines.json'), 'utf8'));
const body = (snap) => { const shape = composerShape(snap); return shape && (shape.located || shape.marked) ? composerBody(shape) : null; };
const snap = (rows, cursorRow, cursorCol) => ({ cursorRow, cursorCol, isAltScreen: false, visibleLines: rows.map((text, row) => ({ row, text })) });
console.log('\n# composers, read with the input guard\'s locator');
for (const cli of ['claude', 'codex']) {
  check(`${cli} (captured screens): typed text is the composer's body, an empty one has none`, () => {
    assert.equal(body(SCREENS[cli].typed), 'half typed thought');
    assert.equal(body(SCREENS[cli].empty), '');
  });
}
check('a placeholder wrapped over two rows of a narrow pane is read whole', () => {
  // Codex at 20 columns, cursor after the placeholder on the second row.
  const b = body(snap(['  >_ OpenAI Codex', '› [Pasted Content 1', '169 chars]'], 2, 10));
  assert.equal(b.replace(/\s+/g, ''), '[PastedContent1169chars]');
});
check('a cursor on a line that opens with no prompt marker is not a composer', () => {
  assert.equal(body(snap(['  Resuming session…', ''], 0, 19)), null);
});
// codex-cli 0.162.1 shows a paste under 1000 chars as its text, not a
// placeholder: 791 chars over four lines took eleven rows at 100 columns, and
// a blank line in a paste is a blank row. The cursor sits at the end of it.
// Read from the bottom, as the input guard does, neither was a composer, and
// a delivered prompt was never confirmed. Screens captured from the real TUI.
const tallBody = (s) => { const shape = composerShape(s, { tall: true }); return shape && (shape.located || shape.marked) ? composerBody(shape) : null; };
const CODEX_TALL = [
  '  >_ OpenAI Codex (v0.162.1)', '', '',
  '› [message from carbon-video-lead:] Lead here (carbon-video-lead). First full cut of the Carbon-X',
  '  film is ready for ONE round of blunt feedback.',
  '  Video: /data/workspaces/carbon-video/edit/carbon-x-v2.mp4 (30.4 s). Contact sheet every 0.5 s is',
  '  next to it. Please look at pacing, the type treatment and whether the ending lands. Please look',
  '  at pacing, the type treatment and whether the ending lands. Please look at pacing, the type',
  '  treatment and whether the ending lands. Please look at pacing, the type treatment and whether the',
  '  ending lands. Please look at pacing, the type treatment and whether the ending lands. Please look',
  '  at pacing, the type treatment and whether the ending lands. Please look at pacing, the type',
  '  treatment and whether the ending lands.',
  '  Answer in under 150 words.',
  '  Thanks!', '',
  '  GPT-6.1-Sol default · /data/workspaces/w',
  '                                                                           ⚠ 1 warning · f2 to view'];
const CODEX_BLANKS = ['  >_ OpenAI Codex (v0.162.1)', '', '', '› [message from x:] Para one.', '', '  Para two is here.', '', '  - a', '  - b', '',
  '  GPT-6.1-Sol default · /data/workspaces/w'];
check('codex 0.162: a paste shown as eleven rows of text is read whole by the submit check', () => {
  const b = tallBody(snap(CODEX_TALL, 13, 9));
  assert.match(b, /^\[message from carbon-video-lead:\] Lead here/);
  assert.match(b, /Answer in under 150 words\. Thanks!$/);
  assert.equal(body(snap(CODEX_TALL, 13, 9)), null, 'the input guard\'s reading changed');
});
check('codex 0.162: blank rows inside a pasted prompt do not end the composer', () => {
  assert.equal(tallBody(snap(CODEX_BLANKS, 8, 5)), '[message from x:] Para one. Para two is here. - a - b');
});
check('codex 0.162: the submit check still reads an empty composer as empty', () => {
  assert.equal(tallBody(snap(['  >_ OpenAI Codex (v0.162.1)', '', '› hello', '• Working (0s • esc to interrupt)', '', '› Ask Codex to do anything', '',
    '  GPT-6.1-Sol default · /data/workspaces/w'], 5, 2)), '');
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
    AM_ALLOW_MISSING_ORIGIN: '1', AM_SUBMIT_CONFIRM_TIMEOUT_MS: '1500', AM_PASTE_SHOWN_TIMEOUT_MS: '3000', AM_STARTUP_WAIT_MS: '8000',
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
const openPane = async (name, cols = 100) => {
  const made = await (await post('/api/sessions', { cli: 'test-submit', name, path: '.' })).json();
  const ws = new WebSocket(`${API.replace('http', 'ws')}/ws?session=${made.id}&cols=${cols}&rows=30`, { headers: { 'x-am-request': '1' } });
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

  // codex-cli 0.162.1 forms of a delivered prompt (fixtures/fake-submit-tui.mjs).
  const sendText = async (text) => { const r = await post(`/api/sessions/${pane.id}/input`, { text }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const WORDS = 'please look at pacing, the type treatment and whether the ending lands. ';
  const MID = `[message from carbon-video-lead:] Lead here. First full cut is ready.\n${WORDS.repeat(9)}\nAnswer in under 150 words.\nThanks!`;
  console.log('\n# a multi-line prompt under 1000 chars, shown as text over eleven rows');
  setMode({});
  const tall = await sendText(MID);
  check('is seen in the composer and submitted with one Enter', () => {
    assert.ok(MID.length < 1000);
    assert.equal(tall.status, 200, JSON.stringify(tall.body));
    assert.equal(read('submitted').length, 1);
    assert.deepEqual(read('enters'), ['with-text']);
  });
  setMode({ swallow: 1 });
  const tallRetry = await sendText(MID);
  check('and when its first Enter is lost, AM still sees it there and presses again', () => {
    assert.equal(tallRetry.status, 200, JSON.stringify(tallRetry.body));
    assert.equal(read('submitted').length, 1);
    assert.deepEqual(read('enters'), ['with-text', 'with-text']);
  });

  console.log('\n# a short prompt with blank lines in it');
  setMode({});
  const blanks = await sendText('[message from x:] Para one.\n\nPara two is here.\n\n- a\n- b');
  check('the blank rows do not hide it: submitted with one Enter', () => {
    assert.equal(blanks.status, 200, JSON.stringify(blanks.body));
    assert.equal(read('submitted').length, 1);
    assert.deepEqual(read('enters'), ['with-text']);
  });

  console.log('\n# a single-line prompt over 1000 chars');
  setMode({});
  const LINE = `[message from lead:] ${WORDS.repeat(16)}END`;
  const single = await sendText(LINE);
  check('goes in as a paste, so the Enter submits it whole instead of becoming a newline', () => {
    assert.ok(LINE.length > 1000 && !LINE.includes('\n'));
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.deepEqual(read('submitted'), [JSON.stringify(`[Pasted Content ${LINE.length} chars]`)]);
    assert.deepEqual(read('enters'), ['with-text']);
  });

  console.log('\n# a narrow pane, where the placeholder wraps over two rows');
  pane.ws.close();
  pane = await openPane('fake-codex-narrow', 20);
  setMode({ swallow: 1 });
  const narrow = await send();
  check('the wrapped placeholder is still seen: the swallowed Enter is retried and the prompt submitted', () => {
    assert.equal(narrow.status, 200, JSON.stringify(narrow.body));
    assert.equal(read('submitted').length, 1, 'nothing was submitted');
    assert.deepEqual(read('enters'), ['with-text', 'with-text']);
  });

  console.log('\n# an Enter that opens a dialog over the composer instead of submitting');
  pane.ws.close();
  pane = await openPane('fake-codex-dialog');
  setMode({ dialog: true });
  const modal = await send();
  check('is not a submit: the send fails, and no second Enter goes into the dialog', () => {
    assert.equal(modal.status, 409, `answered ${modal.status}: ${JSON.stringify(modal.body)}`);
    assert.equal(modal.body.code, 'input-not-submitted');
    assert.equal(read('submitted').length, 0);
    assert.deepEqual(read('enters'), ['with-text'], 'an Enter was pressed into the dialog');
  });

  console.log('\n# a paste painted later than AM watches for it');
  pane.ws.close();
  pane = await openPane('fake-codex-late');
  setMode({ paintMs: 5000 });
  const unseen = await send();
  await sleep(2500);                      // let the late paint land
  check('is not reported delivered, and AM presses no Enter into a screen it could not read', () => {
    assert.equal(unseen.status, 409, `answered ${unseen.status}: ${JSON.stringify(unseen.body)}`);
    assert.equal(unseen.body.code, 'input-not-confirmed');
    assert.equal(read('submitted').length, 0);
    assert.deepEqual(read('enters'), [], 'an Enter was pressed without the prompt in view');
  });
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
