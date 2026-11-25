import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { fileLinkRoots, fileLinksRouter, resolveFileLink } from '../src/file-links.js';
import { listDirectory, LIST_MAX } from '../src/preview.js';

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
fs.mkdirSync(path.join(tmp, 'outside'));
fs.writeFileSync(path.join(tmp, 'outside', 'secret.txt'), 'outside the roots');
fs.symlinkSync(path.join(tmp, 'outside'), path.join(workspace, 'team', 'outside-dir'));
fs.symlinkSync(path.join(workspace, 'team', 'docs'), path.join(workspace, 'team', 'docs-link'));
fs.symlinkSync(path.join(workspace, 'team', 'gone.md'), path.join(workspace, 'team', 'dangling.md'));
const big = path.join(workspace, 'big');
fs.mkdirSync(path.join(big, 'zz-folder'), { recursive: true });
for (let i = 0; i < LIST_MAX + 25; i++) fs.writeFileSync(path.join(big, `f${String(i).padStart(5, '0')}.txt`), '');
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
  // Folders resolve, with or without a trailing slash, and list read-only.
  for (const query of [
    { root: 'workspace', file: 'team' }, { root: 'workspace', file: 'team/' },
    { session: 'shared', file: '.' }, { session: 'shared', file: './' }, { file: path.join(workspace, 'team') + '/' },
  ]) assert.deepEqual({ ...resolve(query), real: undefined, stat: undefined },
    { root: 'workspace', path: 'team', absolute: path.join(workspace, 'team'), dir: true, real: undefined, stat: undefined }, JSON.stringify(query));
  assert.equal(resolve({ root: 'workspace', file: '.' }).path, '.', 'a root itself keeps a non-empty canonical path');
  assert.deepEqual(await (await get('resolve', { root: 'workspace', file: 'team/docs/' })).json(),
    { root: 'workspace', path: 'team/docs', absolute: path.join(workspace, 'team/docs'), dir: true });
  const listing = await (await get('list', { session: 'b', file: '.' })).json();
  assert.equal(listing.path, 'team/docs'); assert.equal(listing.root, 'workspace');
  assert.deepEqual(listing.entries.map((e) => [e.name, e.dir, e.kind]), [['a #1%.md', false, 'markdown']]);
  const team = await (await get('list', { root: 'workspace', file: 'team' })).json();
  assert.deepEqual(team.entries.filter((e) => e.dir).map((e) => e.name), ['docs', 'docs-link'], 'folders first, like the Files pane');
  assert.equal(team.truncated, undefined, 'a small folder is complete');
  // A symlink is followed only while its real path stays in the root. One that
  // leads out (or nowhere) is a name and nothing else: no size, date or type
  // of whatever it points at.
  const byName = Object.fromEntries(team.entries.map((e) => [e.name, e]));
  for (const name of ['escape.txt', 'outside-dir', 'dangling.md']) {
    assert.deepEqual(byName[name], { name, dir: false, size: 0, mtime: 0, symlink: true }, name);
  }
  assert.equal(byName['safe.md'].size, '# Workspace readme'.length, 'a link inside the root is followed');
  assert.equal(byName['safe.md'].symlink, undefined);
  assert.equal(byName['docs-link'].dir, true);
  assert.deepEqual((await (await get('list', { root: 'workspace', file: 'team/docs-link' })).json()).entries.map((e) => e.name), ['a #1%.md']);
  // The Files pane's own listing (no confinement) is unchanged.
  assert.equal(listDirectory(path.join(workspace, 'team')).entries.find((e) => e.name === 'escape.txt').size, 'not in an allowed root'.length);
  // Large folders: capped, in the same order as before, with the rest counted.
  const capped = await (await get('list', { root: 'workspace', file: 'big' })).json();
  assert.equal(capped.entries.length, LIST_MAX);
  assert.equal(capped.truncated, 26);
  assert.equal(capped.entries[0].name, 'zz-folder', 'folders still come first');
  assert.equal(capped.entries[1].name, 'f00000.txt');
  assert.equal(capped.entries.at(-1).name, `f${String(LIST_MAX - 2).padStart(5, '0')}.txt`);
  const small = listDirectory(big, { max: 3 });
  assert.deepEqual([small.entries.map((e) => e.name), small.truncated], [['zz-folder', 'f00000.txt', 'f00001.txt'], LIST_MAX + 23]);
  assert.equal((await (await get('list', { root: 'workspace', file: '.' })).json()).path, '');
  // Bytes are only ever served for files; listings only for folders.
  for (const action of ['preview', 'raw', 'download']) {
    const response = await get(action, { root: 'workspace', file: 'team/docs' });
    assert.equal(response.status, 400); assert.equal((await response.json()).code, 'is-directory');
  }
  assert.equal((await get('list', canonical)).status, 400);
  // No listing outside the roots: not by `..`, not by an absolute path, not
  // through a symlinked folder, and not from inside one.
  for (const query of [
    { root: 'workspace', file: '..' }, { root: 'workspace', file: 'team/../..' },
    { file: tmp }, { file: path.join(tmp, 'outside') },
    { root: 'workspace', file: 'team/outside-dir' }, { root: 'workspace', file: 'team/outside-dir/' },
  ]) {
    const response = await get('list', query);
    assert.ok([403, 404].includes(response.status), `${JSON.stringify(query)} → ${response.status}`);
    assert.doesNotMatch(await response.text(), /secret\.txt|private\.txt/);
  }
  assert.equal((await get('raw', { root: 'workspace', file: 'team/outside-dir/secret.txt' })).status, 403);
  console.log('file-links: session and canonical resolution, additional roots, bounded previews, sandboxing, and read-only access passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
