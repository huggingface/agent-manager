// What counts as unread, and what an acknowledgement is allowed to cover.
//
// Every case here is a way the feature could quietly lie to the operator —
// either by hiding a reply they have not read, or by claiming they read one
// they never saw. The second is the worse failure and most of these guard it.
//
// Run with:  node test/unread.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'unread-')), 'unread.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/unread.ts')],
  outfile: out, format: 'esm', bundle: true, logLevel: 'error',
});
const { isUnread, sectionOf, markFor, furtherMark, applyAck } = await import(pathToFileURL(out).href);

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};
const S = (output, read) => ({ id: 's1', output, read });
const v = (seq, hash = `h${seq}`, src = 'gen1') => ({ src, seq, hash });

console.log('\nwhat makes a session unread');
check('output the mark already describes is read', () => {
  assert.equal(isUnread(S(v(3), v(3))), false);
});
check('a newer reply is unread', () => {
  assert.equal(isUnread(S(v(4), v(3))), true);
});
check('never having read anything here is unread', () => {
  assert.equal(isUnread(S(v(1), null)), true);
});
check('an agent that has never spoken is NOT unread', () => {
  assert.equal(isUnread(S(null, null)), false);
  assert.equal(isUnread(S({ src: 'gen1', seq: 0, hash: '' }, null)), false);
});
check('a streaming answer that grew is unread again at the same position', () => {
  // Same reply, more text: the operator was shown less than there is now.
  assert.equal(isUnread(S(v(3, 'grown'), v(3, 'short'))), true);
});
check('two replies with identical text are still two replies', () => {
  // Only the sequence separates them; the hash is the same by construction.
  assert.equal(isUnread(S(v(4, 'same'), v(3, 'same'))), true);
});
check('a mark from a replaced transcript does not cover the new one', () => {
  // A new run repins the rollout: seq restarts, and an old seq 9 must not
  // swallow the new file's first nine replies.
  assert.equal(isUnread(S(v(1, 'h1', 'gen2'), v(9, 'h9', 'gen1'))), true);
});
check('a mark that has read further than the newest output is not unread', () => {
  // Can only happen from a stale poll; it must not flicker the card.
  assert.equal(isUnread(S(v(3), v(5))), false);
});

console.log('\nwhich block a session belongs in');
check('running wins over unread, and keeps the unread state', () => {
  const s = S(v(4), v(3));
  assert.equal(sectionOf(s, true), 'running');
  assert.equal(isUnread(s), true, 'still unread underneath');
  assert.equal(sectionOf(s, false), 'unread', 'and lands in Unread when it stops');
});
check('read and idle is the remainder', () => {
  assert.equal(sectionOf(S(v(3), v(3)), false), 'rest');
});

console.log('\nwhat an acknowledgement claims');
check('it names the version on screen, not "whatever is newest"', () => {
  assert.deepEqual(markFor(S(v(7, 'seven'))), { id: 's1', src: 'gen1', seq: 7, hash: 'seven' });
});
check('there is nothing to acknowledge without output', () => {
  assert.equal(markFor(S(null)), null);
});

console.log('\nreconciling the server, the local view and a poll in flight');
check('a rejected acknowledgement changes nothing — the reply stays unread', () => {
  const prev = {};
  const sent = [{ id: 's1', src: 'gen1', seq: 3, hash: 'h3' }];
  assert.equal(applyAck(prev, sent, { s1: 'mismatch' }), prev, 'same object: no re-render');
  assert.equal(applyAck(prev, sent, { s1: 'stale' }), prev);
  assert.equal(applyAck(prev, sent, { s1: 'future' }), prev);
});
check('an accepted one advances the local view', () => {
  const next = applyAck({}, [{ id: 's1', src: 'gen1', seq: 3, hash: 'h3' }], { s1: 'ok' });
  assert.deepEqual(next.s1, { src: 'gen1', seq: 3, hash: 'h3' });
});
check('an accepted OLDER acknowledgement cannot pull progress back', () => {
  const prev = { s1: { src: 'gen1', seq: 5, hash: 'h5' } };
  const next = applyAck(prev, [{ id: 's1', src: 'gen1', seq: 2, hash: 'h2' }], { s1: 'ok' });
  assert.equal(next.s1.seq, 5);
});
check('a poll that overtook an acknowledgement does not flash the card', () => {
  // Server copy is behind the local one; the further of the two survives.
  assert.deepEqual(furtherMark({ src: 'g', seq: 2, hash: 'b' }, { src: 'g', seq: 5, hash: 'e' }), { src: 'g', seq: 5, hash: 'e' });
  assert.deepEqual(furtherMark({ src: 'g', seq: 5, hash: 'e' }, { src: 'g', seq: 2, hash: 'b' }), { src: 'g', seq: 5, hash: 'e' });
});
check('a mark for a new generation replaces one for the old, whatever its number', () => {
  assert.deepEqual(furtherMark({ src: 'old', seq: 99, hash: 'x' }, { src: 'new', seq: 1, hash: 'y' }), { src: 'new', seq: 1, hash: 'y' });
});
check('the same version twice is the same mark', () => {
  const a = { src: 'g', seq: 3, hash: 'h' };
  assert.equal(furtherMark(a, { src: 'g', seq: 3, hash: 'h' }), a);
});

console.log('\nthe race the whole design exists for');
check('B lands while the acknowledgement for A is in flight — B stays unread', () => {
  // A was displayed and acknowledged; B arrived before the answer came back.
  let s = S(v(1, 'A'), null);
  assert.equal(isUnread(s), true);
  const sent = [markFor(s)];
  s = S(v(2, 'B'), null);                       // B arrives
  const local = applyAck({}, sent, { s1: 'ok' }); // A's acknowledgement lands
  s = { ...s, read: furtherMark(s.read, local.s1) };
  assert.equal(isUnread(s), true, 'B has not been shown to anyone');
  assert.equal(s.read.seq, 1, 'and A is correctly recorded as read');
});

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
