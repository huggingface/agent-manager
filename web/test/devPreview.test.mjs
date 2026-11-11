// "Pull latest" on a dev-preview Space: the one comparison the Settings panel
// and the sidebar row share. It decides whether the running PR build is behind
// GitHub (a PR's head or main moved), or cannot be pulled at all (a running PR
// was merged, closed or is now refused), so the two places never disagree.
// Run:  node test/devPreview.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-preview-lib-'));
const out = path.join(tmp, 'devPreview.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/devPreview.ts')],
  outfile: out, format: 'esm', bundle: false, logLevel: 'error',
});
const { compareRunning, canPullLatest, newCommitsText, prList } = await import(pathToFileURL(out).href);
fs.rmSync(tmp, { recursive: true, force: true });

const A = 'a'.repeat(40), A2 = '1'.repeat(40), B = 'b'.repeat(40), B2 = '2'.repeat(40), M = 'c'.repeat(40), M2 = '3'.repeat(40);
const running = (prs, base = M) => ({ kind: 'prs', label: prs.map((p) => `#${p.number}`).join(' + '), id: 'rel', base, prs });
const listed = (prs, main = M) => ({ ok: true, main: { sha: main }, prs: prs.map((p) => ({ allowed: true, ...p })) });
const none = { newer: [], mainMoved: false, closed: [], refused: [] };

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) { failed += 1; console.log(`  FAIL ${what}\n       ${e.message}`); }
};

check('nothing moved: up to date, nothing to pull', () => {
  const f = compareRunning(running([{ number: 244, sha: A }]), listed([{ number: 244, sha: A }, { number: 190, sha: B2 }]));
  assert.deepEqual(f, none);
  assert.equal(canPullLatest(f), false);
});
check('the PR moved', () => {
  const f = compareRunning(running([{ number: 244, sha: A }]), listed([{ number: 244, sha: A2 }]));
  assert.deepEqual(f, { ...none, newer: [244] });
  assert.equal(canPullLatest(f), true);
  assert.equal(newCommitsText(f), '#244 has new commits');
});
check('main moved', () => {
  const f = compareRunning(running([{ number: 244, sha: A }]), listed([{ number: 244, sha: A }], M2));
  assert.deepEqual(f, { ...none, mainMoved: true });
  assert.equal(canPullLatest(f), true);
  assert.equal(newCommitsText(f), 'main has new commits');
});
check('both moved', () => {
  const f = compareRunning(running([{ number: 244, sha: A }]), listed([{ number: 244, sha: A2 }], M2));
  assert.deepEqual(f, { ...none, newer: [244], mainMoved: true });
  assert.equal(canPullLatest(f), true);
  assert.equal(newCommitsText(f), '#244 and main have new commits');
});
check('a running PR missing from the open list is closed or merged: nothing to pull, even if main moved', () => {
  const f = compareRunning(running([{ number: 244, sha: A }]), listed([{ number: 190, sha: B }], M2));
  assert.deepEqual(f, { ...none, closed: [244], mainMoved: true });
  assert.equal(canPullLatest(f), false);
});
check('a running PR the server now refuses is not pullable', () => {
  const f = compareRunning(running([{ number: 244, sha: A }]), listed([{ number: 244, sha: A2, allowed: false, refusal: 'its author has read permission' }]));
  assert.deepEqual(f, { ...none, refused: [244] });
  assert.equal(canPullLatest(f), false);
});
check('a stack of two PRs: each is compared, in running order', () => {
  const run = running([{ number: 190, sha: B }, { number: 182, sha: A }]);
  // the list is GitHub's order (most recently updated first), not the stack's
  const f = compareRunning(run, listed([{ number: 182, sha: A2 }, { number: 190, sha: B2 }]));
  assert.deepEqual(f, { ...none, newer: [190, 182] });
  assert.equal(newCommitsText(f), '#190 and #182 have new commits');
  const g = compareRunning(run, listed([{ number: 182, sha: A2 }, { number: 190, sha: B }], M2));
  assert.deepEqual(g, { ...none, newer: [182], mainMoved: true });
  const h = compareRunning(run, listed([{ number: 190, sha: B2 }]));
  assert.deepEqual(h, { ...none, newer: [190], closed: [182] });
  assert.equal(canPullLatest(h), false, 'one closed PR in the stack blocks the pull');
  assert.equal(newCommitsText({ ...none, newer: [190, 182], mainMoved: true }), '#190, #182 and main have new commits');
});
check('running = main (or an unknown release): no comparison, no action', () => {
  const main = { kind: 'main', label: 'main', id: 'image', image: true, prs: [] };
  assert.equal(compareRunning(main, listed([{ number: 244, sha: A2 }], M2)), null);
  assert.equal(compareRunning({ kind: 'unknown', label: 'unknown release', id: 'x', prs: [] }, listed([], M2)), null);
  assert.equal(canPullLatest(null), false);
});
check('a list that did not load: no comparison', () => {
  const run = running([{ number: 244, sha: A }]);
  assert.equal(compareRunning(run, null), null);
  assert.equal(compareRunning(run, { ok: false, error: 'rate limited' }), null);
  assert.equal(compareRunning(null, listed([])), null);
});
check('main counts as moved only when both SHAs are known', () => {
  assert.equal(compareRunning(running([{ number: 244, sha: A }]), listed([{ number: 244, sha: A }], null)).mainMoved, false);
  const { base, ...noBase } = running([{ number: 244, sha: A }]);
  assert.equal(compareRunning(noBase, listed([{ number: 244, sha: A }], M2)).mainMoved, false);
});
check('PR lists read as prose', () => {
  assert.equal(prList([244]), '#244');
  assert.equal(prList([244, 190]), '#244 and #190');
  assert.equal(prList([244, 190, 191]), '#244, #190 and #191');
});

if (failed) { console.log(`# ${failed} failed`); process.exit(1); }
console.log('# all passed');
