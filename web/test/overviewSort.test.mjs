// The three rules the Overview's ordering lives or dies by: a running agent is
// not ranked, a missing timestamp sinks (and is never mistaken for "oldest"),
// and ties keep the order the caller passed — the sidebar's.
//
// Same shape as sessionTitle.test.mjs — no test runner, esbuild transpiles the
// module and we import it. Run with:  node test/overviewSort.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ovsort-')), 'overviewSort.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/overviewSort.ts')],
  outfile: out, format: 'esm', bundle: false, logLevel: 'error',
});
const { rankSessions, sortTs, sortLabel } = await import(pathToFileURL(out).href);

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const a = (id, p, ans, running = false) => ({ id, lastPromptTs: p, lastAssistantTs: ans, running });
const ids = (xs) => xs.map((x) => x.id);

// A fleet with every awkward case in it, in "sidebar order".
const fleet = [
  a('old', 1_000, 2_000),          // answered long ago
  a('busy', 5_000, 4_000, true),   // at work right now
  a('fresh', 9_000, 3_000),        // you typed here last
  a('blank', 0, 0),                // no digest at all
  a('unanswered', 8_000, 0),       // you asked, nothing came back yet
  a('replied', 6_000, 9_500),      // the newest reply
];

console.log('sortTs');
check('reads the field the sort names', () => {
  assert.equal(sortTs(fleet[0], 'prompt'), 1_000);
  assert.equal(sortTs(fleet[0], 'answer'), 2_000);
});
check('the manual order reads no clock', () => assert.equal(sortTs(fleet[0], 'manual'), 0));

console.log('rankSessions · manual');
check('is the identity — the tree, untouched, one block', () => {
  const r = rankSessions(fleet, 'manual');
  assert.deepEqual(ids(r.dated), ids(fleet));
  assert.deepEqual(r.running, []);
  assert.deepEqual(r.undated, []);
});
check('does not mutate the caller\'s array', () => {
  const input = fleet.slice();
  rankSessions(input, 'answer');
  assert.deepEqual(ids(input), ids(fleet));
});

console.log('rankSessions · by last prompt');
check('newest message from you first', () => {
  const r = rankSessions(fleet, 'prompt');
  assert.deepEqual(ids(r.dated), ['fresh', 'unanswered', 'replied', 'old']);
});
check('the running agent is pinned out of the ranking, not into the top', () => {
  const r = rankSessions(fleet, 'prompt');
  assert.deepEqual(ids(r.running), ['busy']);
  assert.ok(!ids(r.dated).includes('busy'));
});
check('no timestamp sinks into its own block, and is still there', () => {
  const r = rankSessions(fleet, 'prompt');
  assert.deepEqual(ids(r.undated), ['blank']);
  const all = [...ids(r.running), ...ids(r.dated), ...ids(r.undated)].sort();
  assert.deepEqual(all, ids(fleet).sort());
});

console.log('rankSessions · by last answer');
check('newest reply first', () => {
  const r = rankSessions(fleet, 'answer');
  assert.deepEqual(ids(r.dated), ['replied', 'fresh', 'old']);
});
check('asked-but-never-answered is undated here, dated under prompt', () => {
  assert.deepEqual(ids(rankSessions(fleet, 'answer').undated), ['blank', 'unanswered']);
  assert.ok(ids(rankSessions(fleet, 'prompt').dated).includes('unanswered'));
});

console.log('rankSessions · ties and edges');
check('equal timestamps keep the order they came in', () => {
  const tied = [a('c', 5, 5), a('a', 5, 5), a('b', 5, 5)];
  assert.deepEqual(ids(rankSessions(tied, 'prompt').dated), ['c', 'a', 'b']);
});
check('the undated tail keeps the order it came in', () => {
  const none = [a('z', 0, 0), a('y', 0, 0)];
  assert.deepEqual(ids(rankSessions(none, 'answer').undated), ['z', 'y']);
});
check('a running agent with no digest is still running, not undated', () => {
  const r = rankSessions([a('n', 0, 0, true)], 'prompt');
  assert.deepEqual(ids(r.running), ['n']);
  assert.deepEqual(r.undated, []);
});
check('an empty fleet gives three empty blocks', () => {
  const r = rankSessions([], 'answer');
  assert.deepEqual([r.running, r.dated, r.undated], [[], [], []]);
});

console.log('sortLabel');
check('names what the block is sorted by', () => {
  assert.equal(sortLabel('prompt'), 'by your last message');
  assert.equal(sortLabel('answer'), 'by the last reply');
  assert.equal(sortLabel('manual'), '');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
