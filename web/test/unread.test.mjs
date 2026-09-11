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
const { isUnread, sectionOf, markFor, furtherMark, retireLocal, applyAck, outputHash, answerMatches } = await import(pathToFileURL(out).href);
const { outputHash: serverHash } = await import(pathToFileURL(path.join(HERE, '../../server/src/output-id.js')).href);

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
check('a mark that has read FURTHER than the newest output is unread', () => {
  // Not the impossibility it looks like: a rotated or replaced transcript
  // restarts its sequence at 1, and a harness whose runs cannot be told apart
  // from the pane record alone presents that new reply under the same key.
  // Reading "seq 5 >= seq 1, so seen it" hides genuinely new output behind a
  // cursor from a transcript that no longer exists.
  assert.equal(isUnread(S(v(1, 'freshstart'), v(5))), true);
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
check('the generation in front of us decides, not which argument came second', () => {
  // This used to return whichever mark was passed second, on the assumption it
  // was the newly learned one. App passes its RETAINED local mark there, so a
  // stale local generation was overriding fresh server state forever.
  const oldMark = { src: 'old', seq: 99, hash: 'x' };
  const newMark = { src: 'new', seq: 1, hash: 'y' };
  assert.deepEqual(furtherMark(oldMark, newMark, { src: 'new', seq: 1, hash: 'y' }), newMark);
  assert.deepEqual(furtherMark(newMark, oldMark, { src: 'new', seq: 1, hash: 'y' }), newMark);
});
check('the same version twice is the same mark', () => {
  const a = { src: 'g', seq: 3, hash: 'h' };
  assert.equal(furtherMark(a, { src: 'g', seq: 3, hash: 'h' }), a);
});

console.log('\nthe two copies of the read state, and which one wins');
check('a local mark from a dead generation cannot shout down the server\'s current one', () => {
  // Tab A acknowledged g1; the transcript rolled to g2; tab B read g2. Every
  // poll in A must converge on g2, not keep restoring its own stale g1.
  const server = { src: 'g2', seq: 1, hash: 'b' };
  const local = { src: 'g1', seq: 9, hash: 'a' };
  assert.deepEqual(furtherMark(server, local, { src: 'g2', seq: 1, hash: 'b' }), server);
});
check('a local mark for the CURRENT generation still wins over an older server copy', () => {
  const server = { src: 'g2', seq: 1, hash: 'a' };
  const local = { src: 'g2', seq: 3, hash: 'c' };
  assert.deepEqual(furtherMark(server, local, { src: 'g2', seq: 3, hash: 'c' }), local);
});
check('with no output to arbitrate, the server is the authority', () => {
  assert.deepEqual(furtherMark({ src: 'g2', seq: 1, hash: 'b' }, { src: 'g1', seq: 9, hash: 'a' }, null),
    { src: 'g2', seq: 1, hash: 'b' });
});
check('a local mark is retired once the server has caught up', () => {
  const local = { s1: { src: 'g', seq: 3, hash: 'c' } };
  const after = retireLocal(local, [{ id: 's1', output: v(3, 'c'), read: { src: 'g', seq: 3, hash: 'c' } }]);
  assert.deepEqual(after, {});
});
check('…and when its generation is gone, so polling can converge', () => {
  const local = { s1: { src: 'g1', seq: 9, hash: 'a' } };
  assert.deepEqual(retireLocal(local, [{ id: 's1', output: v(1, 'b', 'g2'), read: null }]), {});
});
check('but one the server has not seen yet is kept', () => {
  const local = { s1: { src: 'gen1', seq: 3, hash: 'h3' } };
  assert.equal(retireLocal(local, [{ id: 's1', output: v(3), read: null }]), local,
    'same object, so holding it costs no re-render');
});

console.log('\nnaming the reply that was actually rendered');
check('the browser hash agrees with the server\'s, byte for byte', () => {
  for (const t of ['', 'Done.', 'a'.repeat(500), 'unicode ✓ ⠋ é', '# Heading\n\nbody\n', JSON.stringify({ a: 1 })]) {
    assert.equal(outputHash(t), serverHash(t), `diverged on ${JSON.stringify(t.slice(0, 20))}`);
  }
});
check('a rendered answer matching the version is accepted', () => {
  assert.equal(answerMatches(['the whole reply'], serverHash('the whole reply')), true);
});
check('two replies sharing a long prefix are NOT confused', () => {
  // The bug this replaced: a 279-character prefix comparison called these the
  // same reply, so the Reader displaying A acknowledged B.
  const a = `${'x'.repeat(400)} TAIL A`;
  const b = `${'x'.repeat(400)} TAIL B`;
  assert.equal(answerMatches([a], serverHash(b)), false, 'displaying A must not acknowledge B');
  assert.equal(answerMatches([b], serverHash(b)), true);
});
check('a multi-block answer matches on its last block or its join', () => {
  assert.equal(answerMatches(['one', 'two'], serverHash('two')), true);
  assert.equal(answerMatches(['one', 'two'], serverHash('one\ntwo')), true);
});
check('nothing rendered matches nothing', () => {
  assert.equal(answerMatches([], serverHash('anything')), false);
  assert.equal(answerMatches(['x'], ''), false);
});

console.log('\nthe race the whole design exists for');
check('B lands while the acknowledgement for A is in flight — B stays unread', () => {
  // A was displayed and acknowledged; B arrived before the answer came back.
  let s = S(v(1, 'A'), null);
  assert.equal(isUnread(s), true);
  const sent = [markFor(s)];
  s = S(v(2, 'B'), null);                       // B arrives
  const local = applyAck({}, sent, { s1: 'ok' }); // A's acknowledgement lands
  s = { ...s, read: furtherMark(s.read, local.s1, s.output) };
  assert.equal(isUnread(s), true, 'B has not been shown to anyone');
  assert.equal(s.read.seq, 1, 'and A is correctly recorded as read');
});

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
