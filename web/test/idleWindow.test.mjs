// The idle window's verdict — road two out of the working list.
//
// This is the rule review found untested: `pinnedSessionIds` had good unit
// coverage, but nothing showed the archive verdict CONSUMED it. The skip could
// be deleted and every suite plus the typechecked build stayed green, while
// pinned sessions quietly started ageing out again — the one thing pinning
// promises not to let happen.
//
// Run with:  node test/idleWindow.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idle-window-')), 'idleWindow.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/idleWindow.ts')],
  outfile: out, format: 'esm', bundle: true, logLevel: 'error',
});
const { quietSessionIds } = await import(pathToFileURL(out).href);

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed += 1; console.log(`  FAIL ${what}\n       ${e.message}`);
  }
};

const NOW = Date.parse('2026-09-11T12:00:00Z');
const DAY = 864e5;
const session = (id, extra = {}) => ({
  id, name: id, cli: 'claude', path: null, state: 'idle',
  createdAt: new Date(NOW - 90 * DAY).toISOString(),
  everStarted: true, running: false, ...extra,
});
// Old enough that every window has passed it by.
const ancient = { };
const ages = (ids, daysAgo) => Object.fromEntries(ids.map((id) => [id, NOW - daysAgo * DAY]));

console.log('the window itself');
check('a session quiet past the window is quiet', () => {
  const quiet = quietSessionIds([session('a')], ages(['a'], 40), 'month', new Set(), NOW);
  assert.deepEqual([...quiet], ['a']);
});
check('one inside the window is not', () => {
  const quiet = quietSessionIds([session('a')], ages(['a'], 3), 'month', new Set(), NOW);
  assert.deepEqual([...quiet], []);
});
check("'week' is a shorter window than 'month'", () => {
  const at = ages(['a'], 10);
  assert.deepEqual([...quietSessionIds([session('a')], at, 'week', new Set(), NOW)], ['a']);
  assert.deepEqual([...quietSessionIds([session('a')], at, 'month', new Set(), NOW)], []);
});
check("'never' archives nothing, however old", () => {
  const quiet = quietSessionIds([session('a')], ages(['a'], 4000), 'never', new Set(), NOW);
  assert.deepEqual([...quiet], []);
});

console.log('\nwhat the window is not allowed to touch');
check('a shell has no trace clock, so it never ages out', () => {
  const quiet = quietSessionIds([session('a', { cli: 'shell' })], ages(['a'], 400), 'month', new Set(), NOW);
  assert.deepEqual([...quiet], []);
});
check('nor does one that is working right now', () => {
  const quiet = quietSessionIds([session('a', { state: 'working' })], ages(['a'], 400), 'month', new Set(), NOW);
  assert.deepEqual([...quiet], []);
});
check('an already-archived session is road one, not road two', () => {
  const s = session('a', { archivedAt: new Date(NOW - DAY).toISOString() });
  assert.deepEqual([...quietSessionIds([s], ages(['a'], 400), 'month', new Set(), NOW)], []);
});

console.log('\nthe exemption — the wiring review found untested');
check('a pinned session does not age out', () => {
  const quiet = quietSessionIds([session('a')], ages(['a'], 400), 'month', new Set(['a']), NOW);
  assert.deepEqual([...quiet], [],
    'pinning exists to keep a session in front of the operator; ageing it out is the one thing it forbids');
});
check('and the exemption is per-session, not a blanket off-switch', () => {
  const quiet = quietSessionIds(
    [session('pinned'), session('loose')],
    ages(['pinned', 'loose'], 400), 'month', new Set(['pinned']), NOW,
  );
  assert.deepEqual([...quiet], ['loose']);
});
check('a member of a pinned GROUP is exempt too — the set carries membership', () => {
  // pinnedSessionIds() puts every member of a pinned group in this set; the
  // verdict never looks at groups itself. See lib/pinned.ts for why: a pinned
  // group whose agents aged out one by one would empty and vanish.
  const members = [session('m1'), session('m2')];
  const quiet = quietSessionIds(members, ages(['m1', 'm2'], 400), 'month', new Set(['m1', 'm2']), NOW);
  assert.deepEqual([...quiet], []);
});
check('pinning does not rescue a session the operator archived', () => {
  // Road one outranks the exemption: pinning suppresses the clock's verdict,
  // not the operator's own.
  const s = session('a', { archivedAt: new Date(NOW - DAY).toISOString() });
  assert.deepEqual([...quietSessionIds([s], ages(['a'], 400), 'month', new Set(['a']), NOW)], []);
});

console.log('\nodds and ends');
check('a session with no recorded age falls back to when it was created', () => {
  const quiet = quietSessionIds([session('a')], ancient, 'month', new Set(), NOW);
  assert.deepEqual([...quiet], ['a'], 'createdAt 90 days ago is past the month window');
});
check('no sessions is an empty verdict, not a throw', () => {
  assert.deepEqual([...quietSessionIds([], {}, 'month', new Set(), NOW)], []);
});

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
