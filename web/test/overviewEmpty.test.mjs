// An empty Overview must always say which control emptied it.
//
// Three can — the state chip, the search box, and the `unread` sort option —
// and the operator can see two of them. A blank feed with no sentence reads as
// a bug, and the reflex is to reload rather than to widen the filter that was
// just set. Every branch below is a way to reach that blank feed.
//
// Run with:  node test/overviewEmpty.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ovempty-')), 'overviewEmpty.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/overviewEmpty.ts')],
  outfile: out, format: 'esm', bundle: false, logLevel: 'error',
});
const { emptyMessage, narrowedBy } = await import(pathToFileURL(out).href);

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};
const base = { onlyUnread: false, chip: 'all', query: '', hiddenCount: 0, showHidden: false };
const msg = (over) => emptyMessage({ ...base, ...over });

console.log('\nevery empty feed says something');
check('there is no state that produces an empty string', () => {
  for (const onlyUnread of [true, false]) {
    for (const chip of ['all', 'done', 'running', 'started', 'stopped']) {
      for (const query of ['', 'needle']) {
        for (const hiddenCount of [0, 3]) {
          for (const showHidden of [true, false]) {
            const m = msg({ onlyUnread, chip, query, hiddenCount, showHidden });
            assert.ok(typeof m === 'string' && m.trim().length > 10,
              `blank for ${JSON.stringify({ onlyUnread, chip, query, hiddenCount, showHidden })}`);
          }
        }
      }
    }
  }
});

console.log('\nthe unread option names whatever else is narrowing');
check('nothing else narrowing: it says the fleet is caught up', () => {
  assert.match(msg({ onlyUnread: true }), /every agent’s latest reply has been seen/);
});
check('a state chip is named, so the operator knows what to clear', () => {
  assert.equal(msg({ onlyUnread: true, chip: 'stopped' }),
    'nothing unread under state: stopped. clear it to see the rest.');
});
check('the search box is named', () => {
  assert.match(msg({ onlyUnread: true, query: 'needle' }), /under the search box\. clear it/);
});
check('both are named, and the sentence stays grammatical', () => {
  assert.equal(msg({ onlyUnread: true, chip: 'done', query: 'needle' }),
    'nothing unread under state: done and the search box. clear them to see the rest.');
});
check('`all` is not a narrowing state and is not named', () => {
  assert.deepEqual(narrowedBy({ chip: 'all', query: '' }), []);
  assert.deepEqual(narrowedBy({ chip: 'all', query: '  ' }), [], 'whitespace is not a query');
});

console.log('\nthe other three orders keep their existing messages');
check('a search that matches nothing', () => {
  assert.match(msg({ query: 'needle' }), /no recent activity matches “needle”/);
});
check('everything hidden', () => {
  assert.match(msg({ hiddenCount: 3 }), /3 hidden\. reveal them/);
});
check('revealed, so hiding is not the reason', () => {
  assert.match(msg({ hiddenCount: 3, showHidden: true }), /no agents yet/);
});
check('an empty fleet', () => assert.match(msg({}), /no agents yet/));
check('a state with nobody in it', () => assert.match(msg({ chip: 'stopped' }), /nothing in this state/));

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
