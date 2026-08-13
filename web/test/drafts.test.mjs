// The rules a remembered draft has to obey, without a browser in the way.
//
// The end-to-end behaviour (does a phone that leaves and comes back still have
// the text?) is a playwright question. These are the ones a browser test can
// only ever pass vacuously: what happens at the size cap, at the browser's
// quota, and after the expiry window.
//
// No test runner: esbuild is already here for vite, so the module is transpiled
// and imported directly. Run with:  node test/drafts.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drafts-')), 'drafts.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/components/conversation/drafts.ts')],
  outfile: out, format: 'esm', bundle: false, logLevel: 'error',
});

// A localStorage that can be told to be full, or to be denied outright.
class Store {
  constructor() { this.map = new Map(); this.limit = Infinity; this.denied = false; }
  getItem(k) { if (this.denied) throw new Error('denied'); return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    if (this.denied) throw new Error('denied');
    const size = [...this.map].reduce((n, [a, b]) => n + a.length + b.length, 0)
      - (this.map.get(k)?.length || 0) - (this.map.has(k) ? k.length : 0)
      + k.length + v.length;
    if (size > this.limit) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
    this.map.set(k, v);
  }
  removeItem(k) { if (this.denied) throw new Error('denied'); this.map.delete(k); }
}
const store = new Store();
globalThis.localStorage = store;

const { recallDraft, rememberDraft, holdDraft, forgetDraft } = await import(pathToFileURL(out).href);

const KEY = 'am.drafts';
const raw = () => { try { return JSON.parse(store.map.get(KEY)).d || {}; } catch { return {}; } };
// recallDraft prefers the in-memory copy, which is the point of it — so reading
// "what would a cold mount see?" means asking the stored blob directly.
const cold = (id) => raw()[id]?.t ?? '';
// reset() clears the disk, not the module's in-memory map (nothing exported can,
// and that map is deliberately hard to lose). So any test that reads through
// recallDraft uses ids no other test has touched.
const reset = () => { store.map.clear(); store.limit = Infinity; store.denied = false; };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a draft comes back for the session it was typed in', () => {
  reset();
  rememberDraft('a', 'for a');
  rememberDraft('b', 'for b');
  assert.equal(cold('a'), 'for a');
  assert.equal(cold('b'), 'for b');
  assert.equal(cold('c'), '');
  assert.equal(recallDraft('a'), 'for a');
});

test('an empty draft is deleted, not stored as empty', () => {
  reset();
  rememberDraft('a', 'something');
  rememberDraft('a', '');
  assert.equal(Object.keys(raw()).length, 0);
  assert.equal(recallDraft('a'), '');
  rememberDraft('a', 'again');
  forgetDraft('a');
  assert.equal(recallDraft('a'), '');
});

test('a draft past the size cap stays in memory but is not written', () => {
  reset();
  const huge = 'x'.repeat(40 * 1024);
  rememberDraft('a', huge);
  assert.equal(cold('a'), '', 'not on disk');
  assert.equal(recallDraft('a'), huge, 'still in memory, so a pane switch keeps it');
});

test('over the total budget, the oldest drafts fall off and the newest survives', () => {
  reset();
  const big = 'y'.repeat(30 * 1024);
  for (const id of ['s1', 's2', 's3', 's4', 's5', 's6']) rememberDraft(id, big);
  const kept = Object.keys(raw());
  assert.ok(kept.includes('s6'), `the newest is kept, got ${kept}`);
  assert.ok(!kept.includes('s1'), `the oldest fell off, got ${kept}`);
  assert.ok(kept.length < 6, `something was evicted, got ${kept}`);
});

test('a quota error sheds old drafts rather than throwing', () => {
  reset();
  rememberDraft('old', 'a'.repeat(2000));
  rememberDraft('mid', 'b'.repeat(2000));
  // Now there is room for roughly one draft, not three.
  store.limit = 2600;
  assert.doesNotThrow(() => rememberDraft('new', 'c'.repeat(2000)));
  assert.equal(cold('new'), 'c'.repeat(2000), 'the draft being typed is the one kept');
  assert.ok(!('old' in raw()), 'the oldest was shed');
});

test('a quota that cannot be satisfied at all degrades quietly', () => {
  reset();
  store.limit = 10;
  assert.doesNotThrow(() => rememberDraft('a', 'no room for this'));
  assert.equal(recallDraft('a'), 'no room for this', 'memory still has it');
});

test('storage denied outright never throws', () => {
  reset();
  store.denied = true;
  assert.doesNotThrow(() => rememberDraft('a', 'private mode'));
  assert.equal(recallDraft('a'), 'private mode', 'memory carries it for this page');
  assert.doesNotThrow(() => forgetDraft('a'));
});

test('a draft older than the window is not restored', () => {
  reset();
  store.map.set(KEY, JSON.stringify({
    v: 1,
    d: {
      stale: { t: 'typed two days ago', at: Date.now() - 48 * 60 * 60 * 1000 },
      fresh: { t: 'typed an hour ago', at: Date.now() - 60 * 60 * 1000 },
    },
  }));
  assert.equal(cold('stale'), 'typed two days ago', 'still on disk until something reads it');
  // A read drops it, and the next write persists that.
  rememberDraft('other', 'x');
  assert.ok(!('stale' in raw()), 'swept on the next write');
  assert.equal(raw().fresh.t, 'typed an hour ago', 'the fresh one is untouched');
});

test('a corrupt or foreign blob reads as no drafts, and is replaced', () => {
  const junks = ['not json', '{}', '[]', 'null', '{"v":99,"d":{"j0":{"t":"x","at":9e12}}}'];
  for (const [i, junk] of junks.entries()) {
    reset();
    store.map.set(KEY, junk);
    // Through the module, not through JSON.parse: refusing a blob we did not
    // write IS the behaviour under test.
    assert.equal(recallDraft(`j${i}`), '', `junk survived: ${junk}`);
    assert.doesNotThrow(() => rememberDraft(`k${i}`, 'recovers'), `threw on: ${junk}`);
    assert.deepEqual(Object.keys(raw()), [`k${i}`], `not replaced: ${junk}`);
  }
});

test('a stale draft is deleted on read, not just hidden', () => {
  reset();
  store.map.set(KEY, JSON.stringify({
    v: 1,
    d: {
      gone: { t: 'sensitive, and two days old', at: Date.now() - 48 * 60 * 60 * 1000 },
      kept: { t: 'from ten minutes ago', at: Date.now() - 10 * 60 * 1000 },
    },
  }));
  assert.equal(recallDraft('kept'), 'from ten minutes ago');
  assert.ok(!('gone' in raw()), 'reading swept it off the device');
  assert.equal(raw().kept.t, 'from ten minutes ago');
});

test('holdDraft keeps it out of storage', () => {
  reset();
  holdDraft('a', 'mid-composition');
  assert.equal(Object.keys(raw()).length, 0, 'nothing written');
  assert.equal(recallDraft('a'), 'mid-composition', 'but the box can be refilled');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok    ${name}`); } catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
