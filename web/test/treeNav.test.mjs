// What a key means in the Files listing, and where the focus goes when the row
// that had it is gone. Both are pure functions over the rows on screen, so they
// are checked here in milliseconds; the browser suite (filesKeyboard) then
// checks that the listing really produces those rows and really obeys them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(HERE, '../node_modules/.test-build');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'treeNav.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/treeNav.ts')],
  outfile: out, format: 'esm', bundle: false, logLevel: 'error',
});
const { keyIntent, survivingFocus } = await import(pathToFileURL(out).href);

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

// The listing of the fixture used throughout: two files, a folder expanded to
// show a file and a folder of its own, and a folder that is still closed.
//   alpha.txt
//   docs            (open)
//     docs/deep     (closed)
//     docs/guide.md
//   images          (closed)
const ROWS = [
  { path: 'alpha.txt', dir: false, open: false },
  { path: 'docs', dir: true, open: true },
  { path: 'docs/deep', dir: true, open: false },
  { path: 'docs/guide.md', dir: false, open: false },
  { path: 'images', dir: true, open: false },
];
const at = (current, key) => keyIntent(ROWS, current, key);

console.log('up and down walk the rows that are on screen');
{
  check('down goes to the next one', () => assert.deepEqual(at('alpha.txt', 'ArrowDown'), { kind: 'focus', path: 'docs' }));
  check('…including into an open folder', () => assert.deepEqual(at('docs', 'ArrowDown'), { kind: 'focus', path: 'docs/deep' }));
  check('up goes back', () => assert.deepEqual(at('docs/deep', 'ArrowUp'), { kind: 'focus', path: 'docs' }));
  check('the ends hold still', () => {
    assert.deepEqual(at('alpha.txt', 'ArrowUp'), { kind: 'focus', path: 'alpha.txt' });
    assert.deepEqual(at('images', 'ArrowDown'), { kind: 'focus', path: 'images' });
  });
  check('Home and End reach them', () => {
    assert.deepEqual(at('docs', 'Home'), { kind: 'focus', path: 'alpha.txt' });
    assert.deepEqual(at('docs', 'End'), { kind: 'focus', path: 'images' });
  });
  check('with nothing focused, down enters at the top and up at the bottom', () => {
    assert.deepEqual(at(null, 'ArrowDown'), { kind: 'focus', path: 'alpha.txt' });
    assert.deepEqual(at(null, 'ArrowUp'), { kind: 'focus', path: 'images' });
  });
  check('a focus that is no longer drawn does not wedge the keys', () =>
    assert.deepEqual(at('deleted.txt', 'ArrowDown'), { kind: 'focus', path: 'alpha.txt' }));
}

console.log('\nright and left are the hierarchy');
{
  check('right opens a closed folder', () => assert.deepEqual(at('images', 'ArrowRight'), { kind: 'expand', path: 'images' }));
  check('right on an open one steps into its first child', () =>
    assert.deepEqual(at('docs', 'ArrowRight'), { kind: 'focus', path: 'docs/deep' }));
  check('right on an open but EMPTY folder stays put — the next row is not its child', () => {
    const rows = [{ path: 'images', dir: true, open: true }, { path: 'zeta.txt', dir: false, open: false }];
    assert.equal(keyIntent(rows, 'images', 'ArrowRight'), null);
  });
  check('right does nothing on a file', () => assert.equal(at('alpha.txt', 'ArrowRight'), null));
  check('left closes an open folder', () => assert.deepEqual(at('docs', 'ArrowLeft'), { kind: 'collapse', path: 'docs' }));
  check('left on a child goes up to its folder', () =>
    assert.deepEqual(at('docs/guide.md', 'ArrowLeft'), { kind: 'focus', path: 'docs' }));
  check('left at the top level has nowhere to go', () => assert.equal(at('alpha.txt', 'ArrowLeft'), null));
}

console.log('\nEnter is the only key that acts, and only on the focused row');
{
  check('a file is a preview', () => assert.deepEqual(at('alpha.txt', 'Enter'), { kind: 'activate', path: 'alpha.txt', dir: false }));
  check('a folder is a folder', () => assert.deepEqual(at('docs', 'Enter'), { kind: 'activate', path: 'docs', dir: true }));
  check('with nothing focused it activates nothing', () => assert.equal(at(null, 'Enter'), null));
}

console.log('\nkeys this tree does not claim are left alone');
{
  for (const key of ['Tab', ' ', 'a', 'Delete', 'Backspace', 'PageDown', 'Escape'])
    check(`${JSON.stringify(key)} is not ours`, () => assert.equal(at('alpha.txt', key), null));
  check('and an empty listing claims nothing at all', () => assert.equal(keyIntent([], null, 'ArrowDown'), null));
}

console.log('\nwhen the focused row disappears, the focus lands nearby');
{
  const before = ['alpha.txt', 'docs', 'docs/deep', 'docs/guide.md', 'images'];
  check('the next row in the same folder', () =>
    assert.equal(survivingFocus(before, ['alpha.txt', 'docs', 'docs/guide.md', 'images'], 'docs/deep'), 'docs/guide.md'));
  check('…else the previous one in the same folder', () =>
    assert.equal(survivingFocus(before, ['alpha.txt', 'docs', 'docs/deep', 'docs/guide.md'], 'images'), 'docs'));
  check('…else the folder it was in — the case where a collapse took every sibling', () =>
    assert.equal(survivingFocus(before, ['alpha.txt', 'docs', 'images'], 'docs/guide.md'), 'docs'));
  check('…else any row that is still nearby', () =>
    assert.equal(survivingFocus(['a/one.txt', 'b.txt'], ['b.txt'], 'a/one.txt'), 'b.txt'));
  check('…else the top of the listing', () =>
    assert.equal(survivingFocus(before, ['zeta.txt'], 'docs/guide.md'), 'zeta.txt'));
  check('and nothing at all when the listing is empty', () =>
    assert.equal(survivingFocus(before, [], 'alpha.txt'), null));
  check('a row that is still there keeps the focus', () =>
    assert.equal(survivingFocus(before, before, 'docs'), 'docs'));
  check('a neighbour is a PATH, not a position — a re-sort must not move the focus', () => {
    const sorted = ['images', 'docs', 'docs/guide.md', 'alpha.txt'];
    assert.equal(survivingFocus(before, sorted, 'docs/guide.md'), 'docs/guide.md');
  });
}

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
