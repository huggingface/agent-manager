// AM must not type a prompt onto an input line that already holds something.
//
// Sending a prompt means typing it into the TUI and pressing Enter. Nothing
// cleared the composer first — deliberately, since clearing destroys whatever
// the operator typed — so the agent received the two glued together as one
// message (#165).
//
// Detection does not try to recognise a composer; the eight CLIs each draw one
// differently. It recognises a CHANGE in one. The instant before the first
// keystroke after a submit the line is empty by construction, so the grid then
// is that pane's picture of "empty", and anything that does not look exactly
// like it refuses the send. The screens below were captured from the eight real
// CLIs, typing `half typed thought` and never submitting it.
//
// The shell cases drive a real interactive bash, so "did both run" is answered
// by what actually executed rather than by what the screen appears to show.
//
// Run with:  node test/input-line-busy.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { composerShape, sameComposer } from '../src/runner.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREENS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/input-lines.json'), 'utf8'));

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

console.log('\n# the real screens of all eight CLIs');
for (const [harness, states] of Object.entries(SCREENS)) {
  const empty = composerShape(states.empty);
  const typed = composerShape(states.typed);
  check(`${harness}: an untouched composer matches its own picture`, () => {
    assert.equal(sameComposer(empty, composerShape(states.empty)), true);
  });
  check(`${harness}: unsent text does not`, () => {
    assert.equal(sameComposer(empty, typed), false,
      `typed composer looks identical to the empty one: ${JSON.stringify(typed)}`);
  });
}
check('a composer is compared by its cursor and the text in front of it', () => {
  const base = composerShape({ cursorRow: 3, cursorCol: 2, visibleLines: [{ row: 3, text: '> ' }] });
  // Output scrolling the composer to another row is not a change to the line.
  const moved = composerShape({ cursorRow: 9, cursorCol: 2, visibleLines: [{ row: 9, text: '> ' }] });
  assert.equal(sameComposer(base, moved), true);
  // A placeholder drawn AFTER the cursor is not text on the line either.
  const hint = composerShape({ cursorRow: 3, cursorCol: 2, visibleLines: [{ row: 3, text: '> try typing' }] });
  assert.equal(sameComposer(base, hint), true);
  // Anything in front of the cursor is.
  const typed = composerShape({ cursorRow: 3, cursorCol: 5, visibleLines: [{ row: 3, text: '> abc' }] });
  assert.equal(sameComposer(base, typed), false);
});

// ---- and the whole path, through a real server driving a real bash ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'input-line-busy-'));
const DATA_DIR = path.join(root, 'data'); fs.mkdirSync(DATA_DIR, { recursive: true });
const PUBLIC_DIR = path.join(root, 'public'); fs.mkdirSync(PUBLIC_DIR);
fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), '<html>fixture</html>');
const OUT = path.join(root, 'ran.txt'); fs.writeFileSync(OUT, '');
const ran = () => fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean);
const runs = (marker) => `echo ${marker} >> ${OUT}`;

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(String(port))); });
});
const PORT = await freePort();
const API = `http://127.0.0.1:${PORT}`;
const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...BASE } = process.env;
const backend = spawn('node', ['src/index.js'], {
  cwd: path.join(HERE, '..'), stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...BASE, PORT, DATA_DIR, PUBLIC_DIR, AM_BASHRC: '/nonexistent', SPACE_HOST: '',
    AM_ALLOW_MISSING_ORIGIN: '1', AM_TEST_REPAINT_CMD: 'bash --noprofile --norc -i' },
});
let logs = '';
backend.stdout.on('data', (d) => { logs += d; });
backend.stderr.on('data', (d) => { logs += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(200); }
  return false;
};
const post = (p, body) => fetch(API + p, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-am-request': '1' },
  body: body === undefined ? undefined : JSON.stringify(body) });

try {
  if (!await until(() => fetch(`${API}/api/health`).then((r) => r.ok), 60_000)) throw new Error(`server did not start:\n${logs.slice(-1200)}`);
  await post('/api/welcome/seen');
  const open = async (name, cols = 100) => {
    const made = await (await post('/api/sessions', { cli: 'test-repaint', name, path: '.' })).json();
    const ws = new WebSocket(`${API.replace('http', 'ws')}/ws?session=${made.id}&cols=${cols}&rows=30`,
      { headers: { 'x-am-request': '1' } });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await sleep(2500);
    return { id: made.id, ws, type: (d) => ws.send(JSON.stringify({ t: 'i', d })) };
  };
  const pane = await open('busy-line');
  const peer = await (await post('/api/sessions', { cli: 'test-repaint', name: 'peer', path: '.' })).json();

  console.log('\n# an input line with nothing on it');
  const clean = await post(`/api/sessions/${pane.id}/input`, { text: runs('CLEAN') });
  await until(() => ran().includes('CLEAN'), 8000);
  check('still takes a prompt', () => {
    assert.equal(clean.status, 200, `POST /input answered ${clean.status}`);
    assert.deepEqual(ran(), ['CLEAN']);
  });

  console.log('\n# text the operator typed and did not submit');
  pane.type(runs('THEIRS'));
  await sleep(900);
  let at = ran().length;
  const refused = await post(`/api/sessions/${pane.id}/input`, { text: runs('MERGED') });
  const body = await refused.json().catch(() => ({}));
  await sleep(1500);
  check('is refused rather than merged', () => {
    assert.equal(refused.status, 409, `POST /input answered ${refused.status}`);
    assert.deepEqual(ran().slice(at), [], 'something executed anyway');
  });
  check('and the refusal says what is in the way', () => {
    const message = String(body.error || body.message || '');
    assert.ok(message.includes('unsent text'), `unhelpful refusal: ${JSON.stringify(message)}`);
    assert.ok(message.includes('THEIRS'), `the refusal does not quote the line: ${JSON.stringify(message)}`);
  });
  const peerTry = await fetch(`${API}/api/agents/${pane.id}/prompt?from=${peer.id}`, {
    method: 'POST', headers: { 'content-type': 'text/plain', 'x-am-request': '1' },
    body: runs('PEER') });
  await sleep(1200);
  check('a peer agent is refused the same way', () => {
    assert.equal(peerTry.status, 409, `peer prompt answered ${peerTry.status}`);
    assert.deepEqual(ran().slice(at), [], 'a peer prompt merged into the operator\'s line');
  });
  pane.type('\r');
  await until(() => ran().includes('THEIRS'), 8000);
  const afterTheirs = ran().length;
  const again = await post(`/api/sessions/${pane.id}/input`, { text: runs('AFTER') });
  await until(() => ran().includes('AFTER'), 8000);
  check('once they submit it themselves, both ran separately', () => {
    assert.equal(again.status, 200, `POST /input answered ${again.status}`);
    assert.deepEqual(ran().slice(at, afterTheirs), ['THEIRS']);
    assert.deepEqual(ran().slice(afterTheirs), ['AFTER']);
  });

  console.log('\n# a keystroke arriving DURING the send');
  at = ran().length;
  const racing = post(`/api/sessions/${pane.id}/input`, { text: runs('APISIDE') });
  await sleep(100);                       // inside the gap before our Enter
  pane.type(runs('RACER'));
  const raced = await racing;
  await until(() => ran().includes('APISIDE'), 8000);
  await sleep(1200);
  check('does not get submitted by our Enter', () => {
    assert.equal(raced.status, 200, `POST /input answered ${raced.status}`);
    assert.deepEqual(ran().slice(at), ['APISIDE'], 'the operator\'s keystrokes were swept into our prompt');
  });
  // Held, not dropped: it is still on the line, and submitting it runs it.
  pane.type('\r');
  await until(() => ran().includes('RACER'), 8000);
  check('and is not lost — it lands on a line of its own', () => {
    assert.deepEqual(ran().slice(at), ['APISIDE', 'RACER']);
  });

  console.log('\n# a line the operator did not type a character of');
  at = ran().length;
  pane.type('\x1b[A');                    // Up: the last command is back on the line
  await sleep(900);
  const recalled = await post(`/api/sessions/${pane.id}/input`, { text: runs('AFTERRECALL') });
  await sleep(1500);
  check('recalled history is still something on the line', () => {
    assert.equal(recalled.status, 409, `POST /input answered ${recalled.status}`);
    assert.deepEqual(ran().slice(at), [], 'a recalled command was merged with the prompt');
  });
  pane.type('\x15');                      // ctrl-U: the line is genuinely empty now
  await sleep(900);
  const afterClear = await post(`/api/sessions/${pane.id}/input`, { text: runs('AFTERCLEAR') });
  await until(() => ran().includes('AFTERCLEAR'), 8000);
  check('and clearing it lets the next prompt through', () => {
    assert.equal(afterClear.status, 200, `POST /input answered ${afterClear.status} after the line was cleared`);
    assert.deepEqual(ran().slice(at), ['AFTERCLEAR']);
  });

  console.log('\n# a narrow terminal, where the line wraps');
  const narrow = await open('narrow', 30);
  const long = `echo ${'W'.repeat(60)} >> ${OUT}`;
  assert.ok(long.length > 60, 'the probe line must be longer than one 30-column row');
  narrow.type(long);
  await sleep(900);
  const atNarrow = ran().length;
  const wrapped = await post(`/api/sessions/${narrow.id}/input`, { text: runs('WRAPPED') });
  await sleep(1500);
  check('a wrapped line is still seen', () => {
    assert.equal(wrapped.status, 409, `POST /input answered ${wrapped.status} at 30 columns`);
    assert.deepEqual(ran().slice(atNarrow), [], 'a wrapped line was merged with the prompt');
  });
  // Wrapping onto the same column the empty prompt sits at: the cursor is in an
  // identical position, and only the text in front of it says otherwise.
  narrow.type('\x15');
  await sleep(600);
  const atExact = ran().length;
  narrow.type('z'.repeat(30));
  await sleep(900);
  const sameColumn = await post(`/api/sessions/${narrow.id}/input`, { text: runs('SAMECOL') });
  await sleep(1500);
  check('a wrap landing on the same column is still seen', () => {
    assert.equal(sameColumn.status, 409, `POST /input answered ${sameColumn.status}`);
    assert.deepEqual(ran().slice(atExact), [], 'a line wrapped to the same column was merged');
  });
  narrow.ws.close();

  // The 409 tells the operator to "send or clear that line". Submitting it is
  // covered above; this is the other half of its own advice.
  console.log('\n# clearing input that was held during a send');
  at = ran().length;
  const held = post(`/api/sessions/${pane.id}/input`, { text: runs('APICLEAR') });
  await sleep(100);                       // inside the gap, so it is held
  pane.type(runs('CLEARED_RACER'));
  await held;
  await until(() => ran().includes('APICLEAR'), 8000);
  await sleep(1200);                      // the replayed text is on a fresh line
  pane.type('\x15');                      // and the operator clears it
  await sleep(1200);
  const afterHeldClear = await post(`/api/sessions/${pane.id}/input`, { text: runs('AFTERHELDCLEAR') });
  await until(() => ran().includes('AFTERHELDCLEAR'), 8000);
  check('clearing it lets the next prompt through', () => {
    assert.equal(afterHeldClear.status, 200,
      `POST /input answered ${afterHeldClear.status} against a line the operator had just cleared`);
    assert.deepEqual(ran().slice(at), ['APICLEAR', 'AFTERHELDCLEAR']);
  });

  // A phone rotating, or a pane narrowing. The prompt reflows, so an empty line
  // stops looking like the picture taken of it at the old width.
  console.log('\n# the terminal is resized while the line is empty');
  at = ran().length;
  await post(`/api/sessions/${pane.id}/input`, { text: `PS1='${'p'.repeat(28)}$ '` });
  await sleep(1200);
  pane.type('discard me');
  await sleep(600);
  pane.type('\x15');                      // cleared, so the line is empty again
  await sleep(600);
  pane.ws.send(JSON.stringify({ t: 'r', cols: 20, rows: 30 }));
  await sleep(1500);
  const afterResize = await post(`/api/sessions/${pane.id}/input`, { text: runs('AFTERRESIZE') });
  await until(() => ran().includes('AFTERRESIZE'), 8000);
  check('a reflowed empty prompt still takes a prompt', () => {
    assert.equal(afterResize.status, 200,
      `POST /input answered ${afterResize.status} after the pane was narrowed`);
    assert.ok(ran().slice(at).includes('AFTERRESIZE'), 'the prompt never ran');
  });
  pane.ws.send(JSON.stringify({ t: 'r', cols: 100, rows: 30 }));
  await sleep(800);

  // Recalling what AM itself just sent is still the operator's unsent input.
  // The guard briefly matched the line against the last prompt it had sent, as
  // a second way to recognise its own echo, and that let this merge through.
  console.log('\n# the operator recalls the command AM just sent');
  at = ran().length;
  await post(`/api/sessions/${pane.id}/input`, { text: runs('FIRST') });
  await until(() => ran().includes('FIRST'), 8000);
  pane.type('\x1b[A');                    // Up: that exact command is back on the line
  await sleep(1200);
  const afterRecall = await post(`/api/sessions/${pane.id}/input`, { text: runs('SECOND') });
  await sleep(1500);
  check('the recalled command is not merged with the next prompt', () => {
    assert.equal(afterRecall.status, 409, `POST /input answered ${afterRecall.status}`);
    assert.deepEqual(ran().slice(at), ['FIRST'], 'bash ran a merged line');
  });
  pane.type('\x15');                      // clear it again
  await sleep(900);

  // The same, typed out by hand rather than recalled.
  at = ran().length;
  await post(`/api/sessions/${pane.id}/input`, { text: runs('THIRD') });
  await until(() => ran().includes('THIRD'), 8000);
  pane.type(runs('THIRD'));               // retyped, character for character
  await sleep(900);
  const afterRetype = await post(`/api/sessions/${pane.id}/input`, { text: runs('FOURTH') });
  await sleep(1500);
  check('retyping it is not merged either', () => {
    assert.equal(afterRetype.status, 409, `POST /input answered ${afterRetype.status}`);
    assert.deepEqual(ran().slice(at), ['THIRD'], 'bash ran a merged line');
  });
  pane.type('\x15');
  await sleep(900);

  console.log('\n# a line that only LOOKS busy');
  // Scrollback ending in the same words is not the composer: this used to
  // refuse a send against an empty prompt, then tell the operator to clear it.
  at = ran().length;
  await post(`/api/sessions/${pane.id}/input`, { text: `echo busyword | tee -a ${OUT}` });
  await until(() => ran().includes('busyword'), 8000);
  pane.type('busyword');
  await sleep(600);
  pane.type('\x01\x0b');                  // ctrl-A ctrl-K: the operator clears it
  await sleep(900);
  const notBusy = await post(`/api/sessions/${pane.id}/input`, { text: runs('NOTBUSY') });
  await until(() => ran().includes('NOTBUSY'), 8000);
  check('sends, because the composer is empty', () => {
    assert.equal(notBusy.status, 200, `POST /input answered ${notBusy.status} against an empty line`);
    assert.ok(ran().includes('NOTBUSY'), 'the prompt never ran');
  });
  pane.ws.close();
} finally {
  backend.kill('SIGTERM');
  await sleep(1200);
  try { backend.kill('SIGKILL'); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}

if (failed) { console.log(`\ninput-line-busy: ${failed} failed`); process.exit(1); }
console.log('\ninput-line-busy: prompts never land on a line that already holds something');
