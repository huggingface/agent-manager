// Which sessions come back after a restart.
//
// The server owns every PTY, so a sleep or reboot ends all of them. The runstate
// snapshot records what was alive and what had work running in it; this is the
// rule that reads it back. Two ways to qualify — you prompted it recently, or
// something was still running in it — and everything else must stay stopped, so
// a restart never boots every agent you ever created.
// Run with: node test/revive.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'revive-'));
process.env.DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const { selectRevivable, isTerminalReply } = await import('../src/runstate.js');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`}`);
};

const NOW = Date.parse('2026-08-08T12:00:00Z');
const ago = (days) => NOW - days * 864e5;

const sessions = [
  { id: 'typed-today', name: 'claude-1', cli: 'claude', lastInputAt: ago(0.5) },
  { id: 'typed-5d', name: 'claude-2', cli: 'claude', lastInputAt: ago(5) },
  { id: 'busy-shell', name: 'busy shell', cli: 'shell' },   // no clock of its own
  { id: 'idle-shell', name: 'idle shell', cli: 'shell' },
  { id: 'digest-2d', name: 'codex-1', cli: 'codex' },       // clock via its transcript
  // Given a fresh clock on purpose: without one it would be excluded by the
  // window anyway, and the passive-panel guard would never be under test.
  { id: 'panel', name: 'files', cli: 'files', lastInputAt: ago(0.1) },
  { id: 'laptop', name: 'remote-agent-1', cli: 'remote', lastInputAt: ago(0.1) },
  { id: 'was-stopped', name: 'stopped one', cli: 'claude', lastInputAt: ago(0.1) },
  { id: 'still-up', name: 'survivor', cli: 'claude', lastInputAt: ago(0.1) },
  // A launcher-shaped CLI reports a child forever (codex is a node launcher;
  // `cont || exec run` leaves bash as the pane root). An old snapshot may
  // carry that as work — it must not resurrect a long-quiet agent.
  { id: 'stale-work', name: 'quiet codex', cli: 'codex', lastInputAt: ago(40) },
];
// Only the digest-backed session has a transcript timestamp.
const digests = new Map([['digest-2d', { lastPromptTs: ago(2) }]]);
const snapshot = {
  at: new Date(NOW - 3600e3).toISOString(),
  sessions: {
    'typed-today': { running: true },
    'typed-5d': { running: true },
    'busy-shell': { running: true, work: true },  // a background job outlived you
    'idle-shell': { running: true },              // sitting at its prompt
    'digest-2d': { running: true },
    panel: { running: true },                     // a view, not a process
    laptop: { running: true },                    // runs on someone's machine
    'was-stopped': { running: false },            // you stopped it before the reboot
    'still-up': { running: true },                // somehow already back
    'stale-work': { running: true, work: true },  // a flag that never meant anything here
    'deleted-since': { running: true },           // no session record any more
  },
};
const ids = (days) => selectRevivable({
  snapshot, sessions, digests, alive: new Set(['still-up']), days, now: NOW,
}).map((p) => p.id);

console.log('\nthe window decides who counts as still yours');
check('3 days: today\'s agent, the busy shell, and the 2-day-old codex', ids(3),
  ['typed-today', 'digest-2d', 'busy-shell']);
check('1 day: the 2-day-old codex drops out, the busy shell does not', ids(1),
  ['typed-today', 'busy-shell']);
check('7 days: the 5-day-old agent joins, newest first', ids(7),
  ['typed-today', 'digest-2d', 'typed-5d', 'busy-shell']);

console.log('\nwork in flight qualifies on its own — a shell has no transcript');
const plan = selectRevivable({ snapshot, sessions, digests, alive: new Set(['still-up']), days: 3, now: NOW });
check('and it says so', plan.find((p) => p.id === 'busy-shell')?.why, 'work in flight');
check('recency says so too', plan.find((p) => p.id === 'typed-today')?.why, 'prompted recently');
check('an idle shell nobody touched stays down', ids(7).includes('idle-shell'), false);
check('but only for a shell — an agent\'s "work" flag is not a reason',
  ids(7).includes('stale-work'), false);

console.log('\nwhat is never started');
check('a session stopped before the reboot', ids(7).includes('was-stopped'), false);
check('a passive panel', ids(7).includes('panel'), false);
check('a remote agent on its own machine', ids(7).includes('laptop'), false);
check('one already running', ids(7).includes('still-up'), false);
check('a session deleted since the snapshot', ids(7).includes('deleted-since'), false);

console.log('\nthe window boundary is inclusive');
check('exactly on the cutoff still counts', selectRevivable({
  snapshot: { at: snapshot.at, sessions: { edge: { running: true } } },
  sessions: [{ id: 'edge', name: 'edge', cli: 'claude', lastInputAt: ago(3) }],
  digests: new Map(), alive: new Set(), days: 3, now: NOW,
}).map((p) => p.id), ['edge']);
check('a hair past it does not', selectRevivable({
  snapshot: { at: snapshot.at, sessions: { edge: { running: true } } },
  sessions: [{ id: 'edge', name: 'edge', cli: 'claude', lastInputAt: ago(3) - 1 }],
  digests: new Map(), alive: new Set(), days: 3, now: NOW,
}).map((p) => p.id), []);

console.log('\nthe emulator answering the TUI is not you typing');
check('device attributes', isTerminalReply('\x1b[?62;c'), true);
check('cursor position report', isTerminalReply('\x1b[24;80R'), true);
check('a DCS version answer', isTerminalReply('\x1bP>|xterm(1)\x1b\\'), true);
check('several replies in one frame', isTerminalReply('\x1b[?62;c\x1b[24;80R'), true);
check('a typed character is not', isTerminalReply('a'), false);
check('a return is not', isTerminalReply('\\r'), false);
check('an arrow key is not', isTerminalReply('\x1b[C'), false);
check('ctrl-arrow is not', isTerminalReply('\x1b[1;5C'), false);
check('a delete key is not', isTerminalReply('\x1b[3~'), false);
check('ctrl-c is not', isTerminalReply('\x03'), false);
check('a reply with typing after it counts as typing', isTerminalReply('\x1b[?62;chello'), false);
check('an empty frame is not a reply', isTerminalReply(''), false);

console.log('\nnothing running at shutdown means nothing to start');
check('an empty snapshot', selectRevivable({
  snapshot: { at: snapshot.at, sessions: {} }, sessions, digests, alive: new Set(), days: 7, now: NOW,
}), []);
check('a missing snapshot', selectRevivable({
  snapshot: null, sessions, digests, alive: new Set(), days: 7, now: NOW,
}), []);

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
