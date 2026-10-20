// Reading the TAIL of a trace: a negative offset counts back from the end.
//
// The Overview card and RENDER mode both show the end of a conversation. Without
// this they would have to fetch once just to learn `total`, then fetch again —
// two round trips per card, on a FUSE-backed transcript. Run with:
//   node test/trace-tail.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-tail-'));
process.env.DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const { readTraceByPath } = await import('../src/traces.js');

// A minimal Claude transcript: 12 alternating turns, each one identifiable.
const file = path.join(TMP, 'session.jsonl');
const lines = [];
for (let i = 0; i < 12; i++) {
  const user = i % 2 === 0;
  lines.push(JSON.stringify({
    type: user ? 'user' : 'assistant',
    cwd: TMP,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    message: {
      role: user ? 'user' : 'assistant',
      content: [{ type: 'text', text: `turn ${i}` }],
    },
  }));
}
fs.writeFileSync(file, `${lines.join('\n')}\n`);

const textOf = (t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');

const all = await readTraceByPath(file, { offset: 0, limit: 200 });
assert.equal(all.total, 12, 'twelve turns were written');

// The tail: the last four turns, in order, without knowing `total` first.
const tail = await readTraceByPath(file, { offset: -4, limit: 4 });
assert.equal(tail.offset, 8, 'a negative offset resolves against the end');
assert.deepEqual(tail.turns.map(textOf), ['turn 8', 'turn 9', 'turn 10', 'turn 11']);

// Asking for more tail than exists starts at the beginning rather than wrapping.
const over = await readTraceByPath(file, { offset: -500, limit: 500 });
assert.equal(over.offset, 0, 'a too-large tail clamps to the start');
assert.equal(over.turns.length, 12);

// Positive offsets are untouched by the change.
const mid = await readTraceByPath(file, { offset: 4, limit: 2 });
assert.equal(mid.offset, 4);
assert.deepEqual(mid.turns.map(textOf), ['turn 4', 'turn 5']);

// `userTurns` indexes the WHOLE conversation, not the page — jumping to a prompt
// has to work before the page holding it has been fetched.
assert.deepEqual(tail.userTurns, [0, 2, 4, 6, 8, 10]);

fs.rmSync(TMP, { recursive: true, force: true });
console.log('trace-tail: ok');
