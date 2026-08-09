// The length budget, which is the part of `[Group] name` that is easy to get
// wrong: a prefix that pushes the agent's own name out of a browser tab has
// made the title worse than it was before.
//
// Same shape as exchanges.test.mjs — no test runner, esbuild transpiles the
// module and we import it. Run with:  node test/sessionTitle.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'title-')), 'sessionTitle.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/sessionTitle.ts')],
  outfile: out, format: 'esm', bundle: false, logLevel: 'error',
});
const { groupLabel, sessionTitle, TAB_BUDGET } = await import(pathToFileURL(out).href);

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

console.log('groupLabel');
check('a real group is itself', () => assert.equal(groupLabel('Agent-manager'), 'Agent-manager'));
check('no group is null, not a word', () => {
  assert.equal(groupLabel(null), null);
  assert.equal(groupLabel(undefined), null);
  assert.equal(groupLabel(''), null);
  assert.equal(groupLabel('   '), null);
});

console.log('sessionTitle');
check('the example from the request', () => {
  assert.equal(sessionTitle('claude-code-7', 'Agent-manager'), '[Agent-manager] claude-code-7');
});
check('ungrouped degrades to a bare name', () => {
  for (const g of [null, undefined, '', '  ']) assert.equal(sessionTitle('claude-code-7', g), 'claude-code-7');
});
check('an over-budget pair keeps the name whole and elides the group', () => {
  const t = sessionTitle('claude-code-7', 'a-very-long-group-name-that-will-not-fit', 30);
  assert.ok(t.endsWith('claude-code-7'), `name survived: ${t}`);
  assert.ok(t.startsWith('[') && t.includes('…]'), `group elided: ${t}`);
  assert.ok(t.length <= 30, `within budget: ${t.length}`);
});
check('when the group can only show a stub, it is dropped instead', () => {
  const t = sessionTitle('a-session-name-of-exactly-this-length', 'Agent-manager', 42);
  assert.equal(t, 'a-session-name-of-exactly-this-length');
});
check('a name that blows the budget alone is still returned whole', () => {
  const name = 'x'.repeat(80);
  assert.equal(sessionTitle(name, 'Agent-manager', 42), name);
});
check('the budget is respected exactly at the boundary', () => {
  // '[g] name' is 8 chars: fits a budget of 8, elides at 7.
  assert.equal(sessionTitle('name', 'g', 8), '[g] name');
  assert.equal(sessionTitle('name', 'group', 8), 'name');
});
check('the default budget fits a realistic pair', () => {
  assert.ok(sessionTitle('claude-code-7', 'Agent-manager').length <= TAB_BUDGET);
});

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
