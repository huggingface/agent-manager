// What the sidebar's status column says for a row (#242).
//
// rowStatus() is the only place the precedence lives — stopped, blocked,
// working, done, idle — so every pair is pinned here, along with the rows that
// bend the rule: shells, panels, remote agents, shared Codex, and a state the
// client does not know. sidebarStatus.render.test.mjs checks that the sidebar
// draws what this returns.
//
// Run with:  node test/rowStatus.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'row-status-')), 'rowStatus.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/rowStatus.ts')],
  outfile: out, format: 'esm', bundle: true, logLevel: 'error',
});
const { rowStatus, rowStatusClass, LEGEND } = await import(pathToFileURL(out).href);

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};
const ask = (kind = 'permission') => ({ kind, cli: 'claude', confidence: 'high', detectedAt: '2026-11-10T00:00:00Z' });
const row = (state, extra = {}) => ({ cli: 'claude', state, ...extra });
const kind = (s, unread = false) => rowStatus(s, unread).kind;

console.log('\none state each');
check('working', () => assert.equal(kind(row('working')), 'working'));
check('waiting (your turn) is idle', () => assert.equal(kind(row('waiting')), 'idle'));
check('idle is idle', () => assert.equal(kind(row('idle')), 'idle'));
check('stopped', () => assert.equal(kind(row('stopped')), 'stopped'));
check('input required is blocked', () => assert.equal(kind(row('waiting', { inputRequired: ask() })), 'blocked'));
check('unread and alive is done', () => assert.equal(kind(row('waiting'), true), 'done'));
check('unread defaults to false', () => assert.equal(kind(row('waiting')), 'idle'));

console.log('\nprecedence, every pair: stopped > blocked > working > done > idle');
check('stopped beats blocked', () => assert.equal(kind(row('stopped', { inputRequired: ask() })), 'stopped'));
check('stopped beats done', () => assert.equal(kind(row('stopped'), true), 'stopped'));
check('stopped beats everything at once', () => assert.equal(kind(row('stopped', { inputRequired: ask() }), true), 'stopped'));
check('blocked beats working', () => assert.equal(kind(row('working', { inputRequired: ask() })), 'blocked'));
check('blocked beats done', () => assert.equal(kind(row('waiting', { inputRequired: ask() }), true), 'blocked'));
check('blocked beats idle', () => assert.equal(kind(row('idle', { inputRequired: ask() })), 'blocked'));
check('working beats done: a streaming reply is always "unread"', () => assert.equal(kind(row('working'), true), 'working'));
check('working beats idle', () => assert.equal(kind(row('working')), 'working'));
check('done beats idle, for both alive states', () => {
  assert.equal(kind(row('waiting'), true), 'done');
  assert.equal(kind(row('idle'), true), 'done');
});
check('inputRequired: null is not blocked', () => assert.equal(kind(row('waiting', { inputRequired: null })), 'idle'));

console.log('\nlabels (hover and screen-reader text)');
check('blocked names what is being asked', () => {
  for (const k of ['permission', 'question', 'confirmation']) {
    assert.equal(rowStatus(row('waiting', { inputRequired: ask(k) })).label, `needs input: ${k}`);
  }
});
check('local agents', () => {
  assert.equal(rowStatus(row('working')).label, 'working');
  assert.equal(rowStatus(row('waiting')).label, 'idle');
  assert.equal(rowStatus(row('stopped')).label, 'stopped');
  assert.match(rowStatus(row('waiting'), true).label, /^done/);
});

console.log('\nshells');
check('a quiet shell is ·', () => {
  assert.deepEqual(rowStatus({ cli: 'shell', state: 'idle' }), { kind: 'shell', label: 'shell, quiet' });
  assert.equal(kind({ cli: 'shell', state: 'waiting' }), 'shell');
});
check('a shell producing output still spins', () => assert.equal(kind({ cli: 'shell', state: 'working' }), 'working'));
check('a stopped shell is stopped', () => assert.equal(kind({ cli: 'shell', state: 'stopped' }), 'stopped'));
check('a shell is never done (it has no reply tracking)', () => assert.equal(kind({ cli: 'shell', state: 'idle' }, true), 'shell'));

console.log('\npanels');
check('files and trace show no mark, whatever they report', () => {
  for (const cli of ['files', 'trace']) {
    for (const state of ['idle', 'working', 'waiting', 'stopped']) {
      assert.deepEqual(rowStatus({ cli, state }, true), { kind: 'none', label: '' }, `${cli} ${state}`);
    }
  }
});

console.log('\nremote agents keep their own words');
check('working spins', () => assert.deepEqual(rowStatus({ cli: 'remote', state: 'working' }), { kind: 'working', label: 'working' }));
check('waiting / idle is idle, "listening"', () => {
  assert.deepEqual(rowStatus({ cli: 'remote', state: 'waiting' }), { kind: 'idle', label: 'listening' });
  assert.deepEqual(rowStatus({ cli: 'remote', state: 'idle' }), { kind: 'idle', label: 'listening' });
});
check('stopped is stopped, "not connected"', () => assert.deepEqual(rowStatus({ cli: 'remote', state: 'stopped' }), { kind: 'stopped', label: 'not connected' }));
check('unread is done', () => assert.equal(kind({ cli: 'remote', state: 'idle' }, true), 'done'));
check('working remote is not done', () => assert.equal(kind({ cli: 'remote', state: 'working' }, true), 'working'));

console.log('\nshared Codex: the server already folded the task into state / inputRequired');
// sessionRuntime.presentation maps working -> working, idle / needs-input ->
// waiting (+ inputRequired for needs-input), anything else -> stopped. The row
// must follow those two fields and nothing else — not running/terminalRunning.
check('needs-input', () => assert.equal(kind({ cli: 'codex', codexShared: true, state: 'waiting', inputRequired: ask(), running: true, terminalRunning: false }), 'blocked'));
check('working with no local terminal still spins', () => assert.equal(kind({ cli: 'codex', codexShared: true, state: 'working', running: true, terminalRunning: false }), 'working'));
check('idle with no local terminal is idle, not stopped', () => assert.equal(kind({ cli: 'codex', codexShared: true, state: 'waiting', running: true, terminalRunning: false }), 'idle'));
check('unloaded is stopped even if a terminal runs', () => assert.equal(kind({ cli: 'codex', codexShared: true, state: 'stopped', running: false, terminalRunning: true }), 'stopped'));
check('running: false alone does not stop a row', () => assert.equal(kind({ cli: 'claude', state: 'waiting', running: false }), 'idle'));

console.log('\na state the client does not know');
check('missing state shows nothing rather than guessing', () => {
  assert.deepEqual(rowStatus({ cli: 'claude' }), { kind: 'none', label: '' });
  assert.deepEqual(rowStatus({ cli: 'claude', state: null }, true), { kind: 'none', label: '' });
  assert.deepEqual(rowStatus({ cli: 'claude', state: 'gone' }), { kind: 'none', label: '' });
});
check('but a pending question is still shown', () => assert.equal(kind({ cli: 'claude', inputRequired: ask() }), 'blocked'));

console.log('\nrow classes and legend');
check('stopped dims the row; blocked and done brighten the name', () => {
  assert.equal(rowStatusClass({ kind: 'stopped', label: 'stopped' }), ' row-stopped');
  assert.equal(rowStatusClass({ kind: 'blocked', label: '' }), ' row-attn');
  assert.equal(rowStatusClass({ kind: 'done', label: '' }), ' row-attn');
  for (const k of ['working', 'idle', 'shell', 'none']) assert.equal(rowStatusClass({ kind: k, label: '' }), '');
});
check('the legend explains every mark that draws something', () => {
  assert.deepEqual(LEGEND.map((l) => l.kind), ['working', 'blocked', 'done', 'idle', 'shell']);
});

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
