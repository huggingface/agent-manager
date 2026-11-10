// The sidebar's frame vocabulary (#242): which mark a session row gets. Rendering is covered by sidebarMark.render.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(HERE, '../node_modules/.test-build');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'row-mark.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/rowMark.ts')],
  outfile: out, format: 'esm', bundle: true, logLevel: 'error',
});
const { rowMark } = await import(pathToFileURL(out).href);

const ask = { kind: 'permission', cli: 'claude', confidence: 'high', detectedAt: '2026-11-10T00:00:00Z' };

// Each state on its own.
assert.equal(rowMark({ state: 'working' }, false), 'working');
assert.equal(rowMark({ state: 'waiting' }, false), 'read');
assert.equal(rowMark({ state: 'idle' }, false), 'read');
assert.equal(rowMark({ state: 'waiting' }, true), 'unread');
assert.equal(rowMark({ state: 'idle' }, true), 'unread');
assert.equal(rowMark({ state: 'stopped' }, false), 'off');
assert.equal(rowMark({ state: 'waiting', inputRequired: ask }, false), 'blocked');

// Precedence: off > blocked > working > unread > read.
assert.equal(rowMark({ state: 'stopped', inputRequired: ask }, true), 'off', 'a stopped agent cannot be waiting on a dialog');
assert.equal(rowMark({ state: 'working', inputRequired: ask }, true), 'blocked', 'a dialog outranks the spinner');
assert.equal(rowMark({ state: 'working' }, true), 'working', 'busy masks unread while the reply streams');
assert.equal(rowMark({ state: 'idle', inputRequired: null }, true), 'unread');

console.log('row-mark: precedence off > blocked > working > unread > read');
