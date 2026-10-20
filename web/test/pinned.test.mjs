// Pinning: the four decisions, pinned down.
//
// Every one of these is a judgement rather than a mechanism, and each has a
// cheaper wrong answer that would pass a casual read. So they are asserted
// against the rule they implement, not against the code that happens to be
// there:
//
//   1. a session inside a group cannot be pinned at all — its group is the
//      thing that gets pinned, and a stray pinnedAt on one is ignored rather
//      than honoured
//   2. pinning a group exempts its MEMBERS from the idle window, or a pinned
//      group hollows out and vanishes, which is what pinning it forbade
//   3. pinning partitions the one manual order and preserves it inside each
//      half, so there is no second ordering to fight with the first
//   4. an empty pinned half is empty, so the sidebar can decide to draw nothing
//
// Run with:  node test/pinned.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-')), 'pinned.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/pinned.ts')],
  outfile: out, format: 'esm', bundle: true, logLevel: 'error',
});
const { pinnedSessionIds, canPin, partitionByPin, pinAfterDrop } = await import(pathToFileURL(out).href);

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const S = (id, extra = {}) => ({ id, name: id, cli: 'claude', ...extra });
const G = (id, sessionIds, extra = {}) => ({ id, name: id, sessionIds, ...extra });

// deploy and infra loose; triage+billing in `fleet`; docs in `release`.
const world = (over = {}) => ({
  sessions: [S('deploy'), S('infra'), S('triage'), S('billing'), S('docs'), ...(over.sessions || [])],
  groups: [G('fleet', ['triage', 'billing']), G('release', ['docs'])],
  order: ['g:release', 'g:fleet', 's:infra', 's:deploy'],
  ...over,
});
const withPinned = (w, { sessions = [], groups = [] }) => ({
  ...w,
  sessions: w.sessions.map((s) => (sessions.includes(s.id) ? { ...s, pinnedAt: '2026-01-01T00:00:00Z' } : s)),
  groups: w.groups.map((g) => (groups.includes(g.id) ? { ...g, pinnedAt: '2026-01-01T00:00:00Z' } : g)),
});

console.log('\n1. only an ungrouped session or a whole group can be pinned');
{
  const w = world();
  check('an ungrouped session can be pinned', () => assert.equal(canPin('s:deploy', w.groups), true));
  check('a group can be pinned', () => assert.equal(canPin('g:fleet', w.groups), true));
  check('a session inside a group cannot', () => {
    assert.equal(canPin('s:billing', w.groups), false);
    assert.equal(canPin('s:triage', w.groups), false);
    assert.equal(canPin('s:docs', w.groups), false);
  });
  check('a session in no group at all can', () => assert.equal(canPin('s:ghost', w.groups), true));
}

console.log('\n   a stray pinnedAt on a grouped session is ignored, never honoured');
{
  // The state the rule says cannot exist: pinned, and in a group.
  const w = withPinned(world(), { sessions: ['billing'] });
  check('it buys no exemption from the idle window', () => {
    assert.equal(pinnedSessionIds(w.sessions, w.groups).has('billing'), false);
  });
  check('and it cannot put the session above the rule — it is not in `order` to begin with', () => {
    const { pinned, rest } = partitionByPin(w.order, w.sessions, w.groups);
    assert.ok(!pinned.includes('s:billing'));
    assert.ok(!rest.includes('s:billing'));
  });
  check('its group being pinned is what would exempt it', () => {
    const w2 = withPinned(world(), { sessions: ['billing'], groups: ['fleet'] });
    assert.ok(pinnedSessionIds(w2.sessions, w2.groups).has('billing'));
  });
}

console.log('\n2. pinning a group exempts its members from the idle window');
{
  const w = withPinned(world(), { groups: ['fleet'] });
  const ids = pinnedSessionIds(w.sessions, w.groups);
  check('every member is exempt', () => {
    assert.ok(ids.has('triage'));
    assert.ok(ids.has('billing'));
  });
  check('and nobody else is', () => {
    assert.equal(ids.has('docs'), false);
    assert.equal(ids.has('deploy'), false);
  });
  check('a pinned session alone is exempt too', () => {
    const w2 = withPinned(world(), { sessions: ['deploy'] });
    assert.ok(pinnedSessionIds(w2.sessions, w2.groups).has('deploy'));
  });
  check('unpinning the group hands every member straight back', () => {
    assert.equal(pinnedSessionIds(world().sessions, world().groups).size, 0);
  });
  check('a member cannot hold a pin of its own to survive with', () => {
    // The old design let a member be pinned individually; it cannot now, and a
    // record that says otherwise is ignored.
    const w2 = withPinned(world(), { sessions: ['triage'] });
    assert.equal(pinnedSessionIds(w2.sessions, w2.groups).has('triage'), false);
  });
}

console.log('\n3. pinning partitions the manual order, it does not replace it');
{
  const w = withPinned(world(), { sessions: ['deploy'], groups: ['release'] });
  const { pinned, rest } = partitionByPin(w.order, w.sessions, w.groups);
  check('both halves keep the order they had', () => {
    const asOrdered = (half) => half.filter((r) => w.order.includes(r));
    const idx = (r) => w.order.indexOf(r);
    for (const half of [asOrdered(pinned), asOrdered(rest)]) {
      for (let i = 1; i < half.length; i++) assert.ok(idx(half[i - 1]) < idx(half[i]), `${half}`);
    }
  });
  check('every ref is in exactly one half', () => {
    assert.deepEqual([...pinned, ...rest].filter((r) => w.order.includes(r)).sort(), [...w.order].sort());
  });
  check('the halves do not overlap', () => {
    assert.equal(pinned.filter((r) => rest.includes(r)).length, 0);
  });
  check('reordering the manual order reorders both halves with it', () => {
    const flipped = { ...w, order: ['s:deploy', 'g:fleet', 's:infra', 'g:release'] };
    const p = partitionByPin(flipped.order, flipped.sessions, flipped.groups);
    assert.deepEqual(p.pinned, ['s:deploy', 'g:release']);
    assert.deepEqual(p.rest, ['g:fleet', 's:infra']);
  });
}

console.log('\n4. nothing pinned means an empty half, so the sidebar draws no rule');
{
  const w = world();
  const { pinned, rest } = partitionByPin(w.order, w.sessions, w.groups);
  check('the pinned half is empty', () => assert.deepEqual(pinned, []));
  check('and everything is still in the list', () => assert.deepEqual(rest, w.order));
  check('an empty workspace is empty, not broken', () => {
    const p = partitionByPin([], [], []);
    assert.deepEqual(p, { pinned: [], rest: [] });
  });
}

console.log('\n3b. dragging across the rule decides the side — the two axes never fight');
{
  // deploy and release are pinned; fleet and infra are not.
  const pinnedRefs = new Set(['s:deploy', 'g:release']);
  const isPinned = (ref) => pinnedRefs.has(ref);
  check('a pinned row dropped beside an unpinned one unpins', () => {
    assert.equal(pinAfterDrop('s:deploy', { ref: 's:infra' }, isPinned), false);
  });
  check('an unpinned row dropped beside a pinned one pins', () => {
    assert.equal(pinAfterDrop('s:infra', { ref: 's:deploy' }, isPinned), true);
  });
  check('a group crossing the rule crosses it too', () => {
    assert.equal(pinAfterDrop('g:release', { ref: 'g:fleet' }, isPinned), false);
    assert.equal(pinAfterDrop('g:fleet', { ref: 'g:release' }, isPinned), true);
  });
  check('reordering WITHIN a block changes nothing', () => {
    assert.equal(pinAfterDrop('s:infra', { ref: 'g:fleet' }, isPinned), null);
    assert.equal(pinAfterDrop('s:deploy', { ref: 'g:release' }, isPinned), null);
  });
  check('a row dropped on itself changes nothing', () => {
    assert.equal(pinAfterDrop('s:deploy', { ref: 's:deploy' }, isPinned), null);
  });
  check('the answer is always the side it landed on, never the side it left', () => {
    for (const dragged of ['s:deploy', 's:infra', 'g:release', 'g:fleet']) {
      for (const target of ['s:deploy', 's:infra', 'g:release', 'g:fleet']) {
        const got = pinAfterDrop(dragged, { ref: target }, isPinned);
        if (got !== null) assert.equal(got, isPinned(target), `${dragged} -> ${target}`);
      }
    }
  });

  // The other boundary, and the same rule: it lands where pins cannot exist.
  check('a pinned session dragged INTO a group unpins', () => {
    assert.equal(pinAfterDrop('s:deploy', { landsInGroup: true }, isPinned), false);
  });
  check('an unpinned one dragged in needs no change', () => {
    assert.equal(pinAfterDrop('s:infra', { landsInGroup: true }, isPinned), null);
  });
  check('dragging OUT of a group leaves it unpinned, not pinned', () => {
    // A grouped session reads as unpinned however its record looks, so coming
    // out it takes the state of wherever it lands — never a stale `true`.
    const groupedReadsUnpinned = (ref) => (ref === 's:billing' ? false : pinnedRefs.has(ref));
    assert.equal(pinAfterDrop('s:billing', { ref: 's:infra' }, groupedReadsUnpinned), null);
    assert.equal(pinAfterDrop('s:billing', { ref: 's:deploy' }, groupedReadsUnpinned), true,
      'dropping it into the pinned block is a deliberate act and should pin it');
  });
}

console.log('\nodds and ends');
check('a ref pointing at nothing is not pinned by accident', () => {
  const p = partitionByPin(['s:ghost', 'g:ghost'], [], []);
  assert.deepEqual(p.pinned, []);
  assert.deepEqual(p.rest, ['s:ghost', 'g:ghost']);
});
check('canPin on a ref pointing at nothing does not throw', () => {
  assert.equal(canPin('s:ghost', []), true);
  assert.equal(canPin('g:ghost', []), true);
});

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
