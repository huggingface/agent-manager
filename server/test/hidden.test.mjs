// Refs hidden from the Overview: what survives a restart, and what gets pruned.
//
// The pruning is the part worth a test. Hidden refs outlive the things they name
// — delete a group and its `g:<id>` is still on disk — and a ref that outlives its
// target would hide whatever later takes that id. But pruning too eagerly is the
// worse bug: prune against the refs `tree.order` holds and every hidden agent
// un-hides itself the moment it is dragged into a group; prune against the tree
// demo mode is showing and the operator's choices are erased for everything demo
// mode is covering up.
// Run with: node test/hidden.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-'));
process.env.DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const hidden = await import('../src/hidden.js');
hidden.init();

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`}`);
};

console.log('\nhiding and unhiding');
check('nothing is hidden to start with', hidden.list(), []);
check('a group ref is accepted', hidden.set('g:cats', true), true);
check('an agent ref is accepted', hidden.set('s:kimi-cat-1', true), true);
check('both are hidden', hidden.list().sort(), ['g:cats', 's:kimi-cat-1']);
check('has() sees a hidden ref', hidden.has('g:cats'), true);
check('has() is false for one that is not', hidden.has('g:Prose'), false);
check('unhiding removes it', (hidden.set('g:cats', false), hidden.has('g:cats')), false);
check('hiding twice is not two entries', (hidden.set('s:kimi-cat-1', true), hidden.list()), ['s:kimi-cat-1']);

console.log('\nonly refs, so a client bug cannot write junk into the file');
check('no prefix', hidden.set('cats', true), false);
check('unknown prefix', hidden.set('x:cats', true), false);
check('empty id', hidden.set('g:', true), false);
check('a path traversal is not a ref', hidden.set('g:../../etc/passwd', true), false);
check('not a string', hidden.set(null, true), false);
check('the list is unchanged by all of that', hidden.list(), ['s:kimi-cat-1']);

console.log('\nit survives a restart');
hidden.set('g:cats', true);
const before = hidden.list().sort();
hidden.init();   // as if the server had just booted
check('same refs after re-init', hidden.list().sort(), before);

console.log('\npruning drops refs that no longer name anything');
hidden.set('g:deleted-group', true);
const live = new Set(['g:cats', 's:kimi-cat-1']);
check('something was dropped', hidden.retain(live), true);
check('the dead ref is gone', hidden.list().sort(), ['g:cats', 's:kimi-cat-1']);
check('a second pass has nothing to do', hidden.retain(live), false);
hidden.init();
check('the prune was persisted, not just in memory', hidden.list().sort(), ['g:cats', 's:kimi-cat-1']);

console.log('\npruning must be given every session, not just the loose ones');
// `tree.order` lists loose sessions only. If retain() were fed those refs, an
// agent hidden on its own would un-hide itself as soon as it joined a group.
check('a grouped agent keeps its own hidden ref',
  (hidden.retain(new Set(['g:cats', 's:kimi-cat-1'])), hidden.has('s:kimi-cat-1')), true);

console.log(`\n${pass}/${pass + fail} passed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
