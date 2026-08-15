// Which mobile surface carries its own way back, and which still needs the bar
// above it. The rule decides whether a phone spends a row of vertical space on
// chrome, and the cases that matter are the ones where dropping the bar would
// leave no way back at all.
//
// Same shape as sessionTitle.test.mjs, bundled because the rule shares the
// passive-CLI list with types.ts rather than restating it. Run with:
//   node test/mobileBack.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mback-')), 'mobileBack.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/mobileBack.ts')],
  outfile: out, format: 'esm', bundle: true, logLevel: 'error',
});
const { paneOwnsBack } = await import(pathToFileURL(out).href);

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};
// A staged agent on a phone, unless a case below says otherwise.
const staged = { isMobile: true, staged: true, inGroup: false, cli: 'claude' };

console.log('an agent pane carries its own way back');
check('a staged agent', () => assert.equal(paneOwnsBack(staged), true));
check('whichever agent it is', () => assert.equal(paneOwnsBack({ ...staged, cli: 'codex' }), true));
check('a remote agent too — same header, same identity block',
  () => assert.equal(paneOwnsBack({ ...staged, cli: 'remote' }), true));
check('a shell', () => assert.equal(paneOwnsBack({ ...staged, cli: 'shell' }), true));

console.log('\nand the bar stays wherever nothing else can hold the arrow');
check('a group — its bar is also the pager between its agents',
  () => assert.equal(paneOwnsBack({ ...staged, inGroup: true }), false));
check('the files pane — its own leftmost button already means "back to the files"',
  () => assert.equal(paneOwnsBack({ ...staged, cli: 'files' }), false));
check('the trace pane — a flat header with no identity block',
  () => assert.equal(paneOwnsBack({ ...staged, cli: 'trace' }), false));
check('the overview — no pane header at all, so no cli either',
  () => assert.equal(paneOwnsBack({ ...staged, cli: null }), false));
check('…and undefined reads the same as null',
  () => assert.equal(paneOwnsBack({ ...staged, cli: undefined }), false));

console.log('\nand nowhere it would be meaningless');
check('not on the list itself, where there is nothing to go back from',
  () => assert.equal(paneOwnsBack({ ...staged, staged: false }), false));
check('not on desktop, where the sidebar never leaves',
  () => assert.equal(paneOwnsBack({ ...staged, isMobile: false }), false));
check('not on a desktop group either',
  () => assert.equal(paneOwnsBack({ ...staged, isMobile: false, inGroup: true }), false));

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
