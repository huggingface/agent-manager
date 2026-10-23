// The digest's compaction bookkeeping must not walk history.
//
// Telling a compaction record and opencode's replayed prompt apart from real
// prompts needs a look at the messages around each compaction. The first cut
// walked every compacted session from its first compaction onwards with one
// parts query per message, on every uncached refresh, synchronously: 2.9 s
// against 0.4 s without it on a 100-session / 100k-message database. This
// compares a database full of compactions with the same database without any;
// the bookkeeping is a few indexed reads per compaction, plus a per-session
// cache for the sessions that did not change.
//
// Run with:  node test/opencode-compaction-perf.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-compaction-perf-'));
process.env.DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const { __readOpencodeForTest: readOpencode } = await import('../src/traces.js');

const SESSIONS = 20;
const MESSAGES = 1_000; // per session: 20k in all
const BLOCK = 50;       // a prompt every 50 messages; with compactions, one per prompt

function generate(name, compacted) {
  const xdg = path.join(tmp, name);
  fs.mkdirSync(path.join(xdg, 'opencode'), { recursive: true });
  const db = new DatabaseSync(path.join(xdg, 'opencode', 'opencode.db'));
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, model TEXT, tokens_input INTEGER,
      tokens_output INTEGER, tokens_cache_read INTEGER, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
    CREATE INDEX part_message_id_id_idx ON part (message_id, id);
    CREATE INDEX part_session_idx ON part (session_id);`);
  const addSession = db.prepare('INSERT INTO session VALUES (?,?,?,?,0,0,0,?,?)');
  const addMessage = db.prepare('INSERT INTO message VALUES (?,?,?,?)');
  const addPart = db.prepare('INSERT INTO part VALUES (?,?,?,?,?)');
  const output = 'o'.repeat(300);
  db.exec('BEGIN');
  for (let s = 0; s < SESSIONS; s++) {
    const sid = `ses_${s}`;
    let t = 1_000_000 + s * 1_000_000;
    addSession.run(sid, '/w', 'T', '{"id":"m"}', t, t);
    let prompt = '';
    for (let i = 0; i < MESSAGES; i++) {
      const id = `${sid}_${i}`;
      const k = i % BLOCK;
      t += 10;
      const msg = (data, ...parts) => {
        addMessage.run(id, sid, t, JSON.stringify(data));
        parts.forEach((p, j) => addPart.run(`${id}_${j}`, id, sid, t + 1 + j, JSON.stringify(p)));
      };
      if (k === 0) { prompt = `prompt ${i}`; msg({ role: 'user' }, { type: 'text', text: prompt }); }
      else if (compacted && k === 25) msg({ role: 'user' }, { type: 'compaction', auto: true, overflow: true });
      else if (compacted && k === 26) msg({ role: 'assistant', mode: 'compaction', summary: true, parentID: `${sid}_${i - 1}` }, { type: 'text', text: '## Objective' });
      else if (compacted && k === 27) msg({ role: 'user' }, { type: 'text', text: prompt });
      else msg({ role: 'assistant', mode: 'build' }, { type: 'step-start' },
        { type: 'tool', tool: 'bash', state: { input: { command: 'ls' }, output } }, { type: 'step-finish', tokens: { total: 1 } });
    }
  }
  db.exec('COMMIT');
  db.close();
  return xdg;
}

// readOpencode serves its previous rows while the file looks freshly written.
const settle = (xdg) => {
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(xdg, 'opencode', 'opencode.db'), old, old);
};
function timed(xdg) {
  settle(xdg);
  process.env.XDG_DATA_HOME = xdg;
  const t0 = performance.now();
  const rows = readOpencode();
  return { ms: performance.now() - t0, rows };
}

const plain = [generate('plain-a', false), generate('plain-b', false)];
const dense = [generate('dense-a', true), generate('dense-b', true)];
for (const x of [...plain, ...dense]) timed(x); // warm the page cache and the module

// A fresh path per sample: each dense read below is cold for the per-session cache too.
const freshDense = [generate('dense-c', true), generate('dense-d', true)];
const plainMs = Math.min(...plain.map((x) => timed(x).ms));
const cold = freshDense.map((x) => timed(x));
const coldMs = Math.min(...cold.map((c) => c.ms));

const sample = cold[0].rows.find((r) => r.sessionId === 'ses_0').parsed;
assert.equal(sample.stats.prompts, MESSAGES / BLOCK, 'the generated compactions are recognised (one prompt per block)');

console.log(`opencode digest: plain ${plainMs.toFixed(0)} ms, ${SESSIONS * MESSAGES / BLOCK} compactions cold ${coldMs.toFixed(0)} ms`);
assert.ok(coldMs < plainMs * 2 + 100,
  `compaction bookkeeping must not walk history: ${coldMs.toFixed(0)} ms vs ${plainMs.toFixed(0)} ms without compactions`);

// A refresh after ONE session changed recomputes only that session's bookkeeping.
const db = new DatabaseSync(path.join(freshDense[0], 'opencode', 'opencode.db'));
db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('late', 'ses_3', 9_000_000_000, '{"role":"assistant"}');
db.close();
const refreshMs = timed(freshDense[0]).ms;
console.log(`opencode digest: refresh after one session changed ${refreshMs.toFixed(0)} ms`);
assert.ok(refreshMs < plainMs * 1.6 + 60,
  `unchanged sessions reuse their bookkeeping: ${refreshMs.toFixed(0)} ms vs ${plainMs.toFixed(0)} ms without compactions`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('opencode-compaction-perf: ok');
