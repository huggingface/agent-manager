// Telling HF's edge refusing an unsigned request (the Space was just made
// private under an open locked tab) from AM's own answers and from outages,
// and the Reload button's three ways out (lib/edgeRefusal.ts).
// Run:  node test/edgeRefusal.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'edgerefusal-')), 'edgeRefusal.mjs');
await build({ entryPoints: [path.join(HERE, '../src/lib/edgeRefusal.ts')], outfile: out, format: 'esm', bundle: false, logLevel: 'error' });
const { isEdgeRefusal, reloadThroughHub } = await import(pathToFileURL(out).href);

const res = (status, type) => ({ status, headers: { get: (n) => (n.toLowerCase() === 'content-type' ? type : null) } });

// The edge's refusals: its own page, never JSON.
for (const [status, type] of [[404, 'text/html; charset=utf-8'], [401, 'text/html'], [403, 'text/html'], [404, null], [401, 'text/plain'], [200, 'text/html']]) {
  assert.equal(isEdgeRefusal(res(status, type)), true, `${status} ${type}: the edge`);
}
// AM's answers, and outages: never "now private".
for (const [status, type] of [[200, 'application/json; charset=utf-8'], [403, 'application/json'], [404, 'application/json'],
  [503, 'text/html'], [502, 'text/html'], [500, null], [503, 'application/json'], [200, null], [204, null]]) {
  assert.equal(isEdgeRefusal(res(status, type)), false, `${status} ${type}: not the edge`);
}

// Reload: the top window first, then the Hub page, then this frame.
const win = ({ topReload = () => {}, topHref = () => {} } = {}) => {
  const calls = [];
  const dataset = {};
  const top = { location: { reload: () => { calls.push('top.reload'); topReload(); },
    replace: (v) => { calls.push(`top.replace=${v}`); topHref(v); } } };
  return { calls, dataset, w: { top, location: { reload: () => calls.push('self.reload') }, document: { documentElement: { dataset } } } };
};
const crossOrigin = () => { throw new DOMException('Blocked a frame from accessing a cross-origin frame', 'SecurityError'); };
{
  const { w, calls, dataset } = win();
  assert.equal(reloadThroughHub(w, 'you/am'), 'top');
  assert.deepEqual(calls, ['top.reload']);
  assert.equal(dataset.amReload, 'top');
}
{
  const { w, calls, dataset } = win({ topReload: crossOrigin });
  assert.equal(reloadThroughHub(w, 'you/am'), 'hub');
  assert.deepEqual(calls, ['top.reload', 'top.replace=https://huggingface.co/spaces/you/am']);
  assert.equal(dataset.amReload, 'hub');
}
{
  const { w, calls, dataset } = win({ topReload: crossOrigin, topHref: crossOrigin });
  assert.equal(reloadThroughHub(w, 'you/am'), 'self');
  assert.deepEqual(calls, ['top.reload', 'top.replace=https://huggingface.co/spaces/you/am', 'self.reload']);
  assert.equal(dataset.amReload, 'self');
}
for (const id of [null, '', 'not a space', 'a/b/../../evil', 'javascript:alert(1)']) {
  const { w, calls } = win({ topReload: crossOrigin });
  assert.equal(reloadThroughHub(w, id), 'self', `${id}: no Hub URL built from it`);
  assert.deepEqual(calls, ['top.reload', 'self.reload']);
}
{ // no top window at all (detached)
  const { w, calls } = win();
  w.top = null;
  assert.equal(reloadThroughHub(w, 'you/am'), 'self');
  assert.deepEqual(calls, ['self.reload']);
}
console.log('edge refusal: all checks passed');
