// `[Group] name`, and the case that is easy to get wrong: an agent with no
// group must read as a bare name, never `[None] foo` or `[] foo`.
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
const { groupLabel, sessionTitle } = await import(pathToFileURL(out).href);

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

console.log('groupLabel');
check('a real group is itself', () => assert.equal(groupLabel('Agent-manager'), 'Agent-manager'));
check('a padded name is trimmed', () => assert.equal(groupLabel('  Agent-manager  '), 'Agent-manager'));
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
check('nothing is ever shortened — this string is the tooltip', () => {
  const group = 'a-very-long-group-name-that-nobody-would-choose';
  const name = 'an-equally-unreasonable-agent-name';
  assert.equal(sessionTitle(name, group), `[${group}] ${name}`);
});

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
