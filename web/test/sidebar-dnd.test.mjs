// Where a sidebar drag lands.
//
// Every case here is one that used to fail. A group's only drop target was the
// name chip on its top border, so dragging a group past another group crossed a
// frame that answered nothing; and with every agent inside a group there was no
// top-level row left to aim at, so nothing could be dragged back out.
//
// No test runner: esbuild is already here for vite, so the module is transpiled
// and imported directly. Run with:  node test/sidebar-dnd.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-')), 'sidebar-dnd.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/components/sidebar-dnd.ts')],
  outfile: out, format: 'esm', bundle: false, logLevel: 'error',
});
const { dropZone, backgroundAnchor, isBackgroundTarget } = await import(pathToFileURL(out).href);

let failed = 0;
const check = (what, fn) => {
  try { fn(); } catch (e) { failed++; console.error(`✗ ${what}\n  ${e.message}`); return; }
  console.log(`✓ ${what}`);
};

// A group frame with two members: tall, unlike the 17px name chip it used to be.
const FRAME = { top: 100, height: 120 };
const ROW = { top: 100, height: 24 };
const frame = (extra) => ({ ref: 'g:1', kind: 'group', nested: false, box: FRAME, ...extra });
const row = (extra) => ({ ref: 's:2', kind: 'session', nested: false, box: ROW, ...extra });

check('an agent dropped on the body of a group goes into it', () => {
  assert.equal(dropZone(frame({ dragRef: 's:9', clientY: 160 })), 'on');
  // ...anywhere in the body, not just on the label
  assert.equal(dropZone(frame({ dragRef: 's:9', clientY: 120 })), 'on');
  assert.equal(dropZone(frame({ dragRef: 's:9', clientY: 200 })), 'on');
});

check('the frame keeps thin edge bands for placing a neighbour', () => {
  assert.equal(dropZone(frame({ dragRef: 's:9', clientY: 105 })), 'before');
  assert.equal(dropZone(frame({ dragRef: 's:9', clientY: 215 })), 'after');
});

check('a group dragged over another group takes the whole frame, split in half', () => {
  // This is the regression: the frame used to answer null everywhere, leaving
  // only a name chip to aim at.
  assert.equal(dropZone(frame({ dragRef: 'g:2', clientY: 105 })), 'before');
  assert.equal(dropZone(frame({ dragRef: 'g:2', clientY: 155 })), 'before');
  assert.equal(dropZone(frame({ dragRef: 'g:2', clientY: 165 })), 'after');
  assert.equal(dropZone(frame({ dragRef: 'g:2', clientY: 215 })), 'after');
});

check('a nested row declines a dragged group so the frame around it answers', () => {
  assert.equal(dropZone(row({ dragRef: 'g:2', nested: true, clientY: 110 })), null);
});

check('a nested row still takes an agent, by thirds', () => {
  assert.equal(dropZone(row({ dragRef: 's:9', nested: true, clientY: 103 })), 'before');
  assert.equal(dropZone(row({ dragRef: 's:9', nested: true, clientY: 112 })), 'on');
  assert.equal(dropZone(row({ dragRef: 's:9', nested: true, clientY: 121 })), 'after');
});

check('a group offers only its edges to an agent it already holds', () => {
  const held = { dragRef: 's:9', isMember: true };
  assert.equal(dropZone(frame({ ...held, clientY: 160 })), null); // 'into' would be a no-op
  assert.equal(dropZone(frame({ ...held, clientY: 105 })), 'before'); // pull it out, above
  assert.equal(dropZone(frame({ ...held, clientY: 215 })), 'after');
});

check('nothing is a target for itself, or when nothing is in flight', () => {
  assert.equal(dropZone(frame({ dragRef: 'g:1', clientY: 160 })), null);
  assert.equal(dropZone(frame({ dragRef: null, clientY: 160 })), null);
});

check('an empty group still has an "into" middle for its "Drag agents here"', () => {
  // The hint that literally says "drag here" carries no handlers of its own —
  // it works because the frame under it answers. A frame that short must not be
  // all edge band, or the one place the UI advertises would take nothing.
  const empty = { ref: 'g:3', kind: 'group', nested: false, box: { top: 0, height: 44 } };
  assert.equal(dropZone({ ...empty, dragRef: 's:9', clientY: 22 }), 'on');
});

check('the edge bands never eat a whole frame, however short', () => {
  // min(EDGE, height/3) is what guarantees it: at any height the middle third
  // survives, so "into" is always reachable.
  for (const height of [12, 20, 30, 44, 120, 400]) {
    const short = { ref: 'g:3', kind: 'group', nested: false, box: { top: 0, height } };
    assert.equal(dropZone({ ...short, dragRef: 's:9', clientY: height / 2 }), 'on', `height ${height}`);
  }
});

check('a row and a frame answer every point between them, so nothing is dead', () => {
  // The bug was a gap in coverage, not a wrong answer: a dragged group crossing
  // an expanded group met rows that declined (null) inside a frame that also
  // declined, and fell through to a tree that had no handler at all. Whatever
  // declines here must have something behind it that does not.
  for (let y = 100; y <= 220; y += 5) {
    const onRow = dropZone(row({ dragRef: 'g:2', nested: true, clientY: y, box: { top: y, height: 24 } }));
    const onFrame = dropZone(frame({ dragRef: 'g:2', clientY: y }));
    assert.ok(onRow || onFrame, `nothing answers at y=${y}`);
  }
});

// The tree background: top-level items at 0-100, 120-220, 240-280.
const ITEMS = [
  { ref: 'g:1', box: { top: 0, height: 100 } },
  { ref: 'g:2', box: { top: 120, height: 100 } },
  { ref: 's:3', box: { top: 240, height: 40 } },
];

check('the margin between two frames places the drop between them', () => {
  assert.deepEqual(backgroundAnchor(ITEMS, 's:9', 110), { ref: 'g:2', zone: 'before' });
});

check('the empty space below the list means "last, at the top level"', () => {
  // Without this an agent could go into a group and never come back out.
  assert.deepEqual(backgroundAnchor(ITEMS, 's:9', 600), { ref: 's:3', zone: 'after' });
});

check('above everything means first', () => {
  assert.deepEqual(backgroundAnchor(ITEMS, 's:9', 2), { ref: 'g:1', zone: 'before' });
});

check('a dragged top-level item is never its own anchor', () => {
  // The server rejects an anchor that is the moving ref itself ('bad anchor'),
  // so it has to be filtered out before the nearest-neighbour walk — including
  // when hovering the space it currently occupies.
  for (const y of [0, 110, 150, 230, 600]) {
    assert.notEqual(backgroundAnchor(ITEMS, 'g:2', y)?.ref, 'g:2', `at y=${y}`);
  }
  // Hovering its own slot resolves to the position it already has: g:1, g:2, s:3.
  assert.deepEqual(backgroundAnchor(ITEMS, 'g:2', 110), { ref: 's:3', zone: 'before' });
  // The only item there is, is the one in flight → no anchor at all.
  assert.deepEqual(backgroundAnchor([ITEMS[0]], 'g:1', 50), null);
});

check('nothing in flight, nothing to anchor', () => {
  assert.equal(backgroundAnchor(ITEMS, null, 110), null);
});

// Which events the tree answers. A tiny stand-in for the DOM: `owner` is the
// nearest ancestor carrying data-ref, which is what .closest('[data-ref]') finds.
const TREE = { closest: () => null };
const node = (owner) => ({ closest: (sel) => (sel === '[data-ref]' ? owner : null) });

check('the tree answers for its own background', () => {
  assert.equal(isBackgroundTarget(TREE, TREE), true);
});

check('a row or frame keeps its own events', () => {
  // Both the item itself and anything inside it (a name, a mini-button).
  assert.equal(isBackgroundTarget(node({}), TREE), false);
});

check('the archived note is background, not someone else\'s turf', () => {
  // Regression: this note carries no data-ref, and `margin-top: auto` parks it
  // at the BOTTOM of the tree — directly over the landing strip. Testing for
  // "the target is the tree itself" made the one place a user aims for when
  // pulling an agent out of a group silently ignore the drop.
  const archNote = node(null); // a direct child of .tree with no data-ref above it
  assert.equal(isBackgroundTarget(archNote, TREE), true);
  const emptyHint = node(null);
  assert.equal(isBackgroundTarget(emptyHint, TREE), true);
});

check('no target, no answer', () => {
  assert.equal(isBackgroundTarget(null, TREE), false);
});

if (failed) { console.error(`\n${failed} failing`); process.exit(1); }
console.log('\nall good');
