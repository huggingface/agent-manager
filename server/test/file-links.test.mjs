import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { fileLinkRoots, fileLinksRouter, resolveFileLink } from '../src/file-links.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-file-links-'));
const workspace = path.join(tmp, 'workspaces'), checkouts = path.join(tmp, 'checkouts');
fs.mkdirSync(path.join(workspace, 'team', 'docs'), { recursive: true });
fs.mkdirSync(checkouts);
fs.writeFileSync(path.join(workspace, 'team', 'README.md'), '# Workspace readme');
fs.writeFileSync(path.join(workspace, 'team', 'docs', 'a #1%.md'), 'Spaces, percent and hash');
fs.writeFileSync(path.join(workspace, 'team', 'page.html'), '<script>parent.fetch("/api/sessions")</script>');
fs.writeFileSync(path.join(workspace, 'team', '.notes'), 'hidden by convention, not forbidden');
fs.writeFileSync(path.join(workspace, 'team', 'large.txt'), 'x'.repeat(600 * 1024));
fs.writeFileSync(path.join(checkouts, 'README.md'), 'Checkout readme');
fs.writeFileSync(path.join(tmp, 'private.txt'), 'not in an allowed root');
fs.symlinkSync(path.join(tmp, 'private.txt'), path.join(workspace, 'team', 'escape.txt'));
fs.symlinkSync(path.join(workspace, 'team', 'README.md'), path.join(workspace, 'team', 'safe.md'));
const roots = fileLinkRoots(workspace, JSON.stringify({ checkouts }));
const sessions = new Map([
  ['a', { id: 'a', cli: 'claude', path: 'team' }],
  ['b', { id: 'b', cli: 'codex', path: 'team/docs' }],
  ['shared', { id: 'shared', cli: 'codex', path: 'team' }],
  ['root', { id: 'root', cli: 'files', path: null }],
  ['remote', { id: 'remote', cli: 'remote', path: 'team' }],
  ['import', { id: 'import', cli: 'trace', path: 'team', traceSource: { kind: 'bundle', ref: 'bundle' } }],
  ['trace', { id: 'trace', cli: 'trace', traceSource: { kind: 'session', ref: 'a' } }],
]);
const getSession = (id) => sessions.get(id);
const resolve = (query) => resolveFileLink(roots, getSession, query);
const app = express();
app.use('/api/file-links', fileLinksRouter({ roots, getSession }));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/file-links`;
const get = (action, query) => fetch(`${base}/${action}?${new URLSearchParams(query)}`);
try {
  for (const session of ['a', 'shared', 'trace']) assert.equal(resolve({ session, file: 'README.md' }).path, 'team/README.md');
  assert.equal(resolve({ session: 'b', file: '../README.md' }).path, 'team/README.md');
  assert.equal(resolve({ session: 'a', file: 'workspace/team/README.md' }).path, 'team/README.md');
  assert.equal(resolve({ session: 'root', file: 'team/README.md' }).path, 'team/README.md');
  assert.equal(resolve({ file: path.join(checkouts, 'README.md') }).root, 'checkouts');
  assert.equal(resolve({ file: path.join(workspace, 'team/README.md') }).root, 'workspace');
  assert.equal(resolve({ root: 'workspace', file: 'team/safe.md' }).path, 'team/safe.md');
  for (const query of [
    { root: 'workspace', file: '../private.txt' },
    { root: 'workspace', file: 'team/escape.txt' },
    { root: 'workspace', file: '/etc/passwd' },
    { file: path.join(tmp, 'private.txt') },
    { file: path.join(tmp, 'workspaces-other', 'file.txt') },
    { root: 'missing', file: 'README.md' },
    { file: 'README.md' },
    { session: 'remote', file: 'README.md' },
    { session: 'import', file: path.join(workspace, 'team/README.md') },
    { session: 'deleted', file: 'README.md' },
    { file: ['README.md', 'private.txt'] },
    { root: 'workspace', file: 'team\u0000/README.md' },
    { root: 'workspace', file: 'team' },
  ]) assert.throws(() => resolve(query), undefined, JSON.stringify(query));
  for (const config of ['[]', 'null', '{"workspace":"/tmp"}', '{"all":"/"}', '{"local":"relative"}']) {
    assert.throws(() => fileLinkRoots(workspace, config));
  }
  const canonical = { root: 'workspace', file: 'team/README.md' };
  sessions.delete('a');
  assert.equal((await (await get('preview', canonical)).json()).text, '# Workspace readme', 'canonical links survive source deletion');
  const special = await get('raw', { root: 'workspace', file: 'team/docs/a #1%.md' });
  assert.equal(await special.text(), 'Spaces, percent and hash');
  const large = await (await get('preview', { root: 'workspace', file: 'team/large.txt' })).json();
  assert.equal(large.truncated, true); assert.ok(large.text.length <= 512 * 1024);
  const html = await get('raw', { root: 'workspace', file: 'team/page.html' });
  assert.match(html.headers.get('content-security-policy'), /^sandbox /);
  assert.doesNotMatch(html.headers.get('content-security-policy'), /allow-same-origin/);
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
  assert.match(html.headers.get('content-type'), /^text\/html/);
  assert.equal((await get('raw', { root: 'workspace', file: 'team/.notes' })).status, 200);
  assert.equal((await get('raw', { root: 'workspace', file: 'team/escape.txt' })).status, 403);
  assert.equal((await get('raw', { root: 'workspace', file: 'team/missing.md' })).status, 404);
  const download = await get('download', canonical);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.equal((await fetch(`${base}/write?${new URLSearchParams(canonical)}`, { method: 'PUT', body: 'bad' })).status, 404);
  assert.equal(fs.readFileSync(path.join(workspace, 'team/README.md'), 'utf8'), '# Workspace readme');
  console.log('file-links: session and canonical resolution, additional roots, bounded previews, sandboxing, and read-only access passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
