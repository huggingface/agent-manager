// A file preview that points at a FOLDER shows the Files pane's own browser,
// rooted at that folder, read-only — through every way a preview opens:
//
//   · a reader link in a session pane (the in-pane preview),
//   · "Open in file viewer" (the retained Files pane),
//   · a shared link opened on its own (#file=…&root=…),
//   · the Files pane itself, for an entry that is a symlink to a folder (the
//     /api/files/:id/preview route answers `is-directory` for it).
//
// Then clicking a file inside shows its preview, and paths that leave the
// allowed roots are refused — in the UI and on the wire. Real server, real
// production build (helpers/fixture-server.mjs).
// Run with:  node test/folderPreview.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
import { startFixtureServer, buildWeb } from './helpers/fixture-server.mjs';

let failed = 0;
const check = async (what, fn) => {
  try { await fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${String(e && e.message || e).split('\n').slice(0, 4).join('\n       ')}`);
  }
};

const dist = buildWeb(spawnSync, 'am-folder-dist-');
const server = await startFixtureServer({ publicDir: dist, tag: 'am-folder-' });
const browser = await chromium.launch(chromiumLaunchOptions());
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'am-folder-outside-'));
const shots = process.env.FOLDER_PREVIEW_SHOTS;

// The session's folder: a docs folder with a Markdown file, an image and a
// subfolder, plus a symlink that leads out of the workspace.
const ws = path.join(server.dataDir, 'workspaces');
const cwd = path.join(ws, 'cadence');
fs.mkdirSync(path.join(cwd, 'docs', 'sub'), { recursive: true });
fs.writeFileSync(path.join(cwd, 'docs', 'alpha.md'), '# Alpha document\n\nInside the folder.\n');
fs.writeFileSync(path.join(cwd, 'docs', 'pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="teal"/></svg>');
fs.writeFileSync(path.join(cwd, 'docs', 'sub', 'beta.md'), '# Beta document\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside the roots');
fs.symlinkSync(outside, path.join(cwd, 'docs', 'escape'));
// A folder past the listing cap.
fs.mkdirSync(path.join(cwd, 'big'));
for (let i = 0; i < 2005; i++) fs.writeFileSync(path.join(cwd, 'big', `item-${String(i).padStart(4, '0')}.txt`), 'x');
// A symlink to a folder INSIDE the workspace, for the Files pane case.
fs.symlinkSync(path.join(cwd, 'docs'), path.join(ws, 'notes', 'docs-link'));
// The conversation links the folder, the way an agent would mention it.
const projects = path.join(server.cfgDir, 'projects', cwd.replace(/[/.]/g, '-'));
const transcript = path.join(projects, fs.readdirSync(projects)[0]);
fs.appendFileSync(transcript, JSON.stringify({
  type: 'assistant', uuid: 'folder-link', timestamp: new Date().toISOString(), cwd, sessionId: 'f1c7a0de-0000-4000-8000-00000000cade',
  message: { id: 'msg_folder', role: 'assistant', usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'text', text: 'The notes are in [the docs folder](./docs/).' }] },
}) + '\n');

async function open(hash = '', viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport });
  ctx.setDefaultTimeout(10_000);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((id) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('am-active-ref', `s:${id}`);
    localStorage.setItem('am-focused-id', id);
    localStorage.setItem('am-pane-mode', 'reader');
  }, server.ids.cadence);
  await page.goto(server.origin + '/' + hash);
  return { ctx, page, errors };
}
// The Files widget, rooted at the folder: its tree, its breadcrumb, its rows.
const tree = (scope, folder = 'docs') => scope.getByRole('tree', { name: `Files in ${folder}` });
const row = (scope, name) => scope.getByRole('treeitem').filter({ hasText: name });

try {
  await check('a reader link to a folder opens the Files tree in the pane; a file in it previews there', async () => {
    const { ctx, page, errors } = await open();
    await page.getByRole('link', { name: 'the docs folder' }).click();
    const dialog = page.getByRole('dialog', { name: 'File preview' });
    await tree(dialog).waitFor();
    await dialog.getByText('folder · read-only').waitFor();
    // The same widget as the Files pane: name order, a symlink listed by name
    // as Files lists it, and no write actions anywhere.
    assert.deepEqual(await dialog.getByRole('treeitem').locator('.tw-name').allTextContents(), ['alpha.md', 'escape', 'pixel.svg', 'sub']);
    for (const name of ['New folder', 'New file', 'Upload files', 'Rename', 'Delete', 'Move'])
      assert.equal(await dialog.getByRole('button', { name: new RegExp(`^${name}`) }).count(), 0, `${name} is offered`);
    assert.equal(await dialog.getByRole('button', { name: 'Up one folder' }).isDisabled(), true, 'cannot go above the linked folder');
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, 'folder-in-pane.png') }); }
    // Click a file: its preview, in the same place.
    await row(dialog, 'alpha.md').click();
    await dialog.getByRole('heading', { name: 'Alpha document' }).waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, 'folder-file-in-pane.png') });
    // Escape goes back to the listing, not out of the whole preview.
    await page.keyboard.press('Escape');
    await tree(dialog).waitFor();
    assert.equal(await dialog.isVisible(), true);
    // Expand a subfolder inline, and open it as the root with a double click.
    await row(dialog, 'sub').click();
    await row(dialog, 'beta.md').waitFor();
    await row(dialog, 'sub').first().dblclick();
    await tree(dialog, 'docs/sub').waitFor();
    await dialog.getByRole('button', { name: 'Up one folder' }).click();
    await tree(dialog).waitFor();
    await dialog.getByRole('button', { name: 'Close preview' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await check('"Open in file viewer" keeps the folder in a Files pane, with the same tree', async () => {
    const { ctx, page, errors } = await open();
    await page.getByRole('link', { name: 'the docs folder' }).click();
    const dialog = page.getByRole('dialog', { name: 'File preview' });
    await tree(dialog).waitFor();
    await dialog.getByRole('button', { name: 'Open in file viewer' }).click();
    await dialog.waitFor({ state: 'hidden' });
    const pane = page.locator('.tile .file-link-page').filter({ hasText: 'folder · read-only' });
    await tree(pane).waitFor();
    await row(pane, 'pixel.svg').click();
    // An image previews as an image, as it does in Files.
    const img = pane.locator('.files-view img');
    await img.waitFor();
    assert.ok(await img.evaluate((el) => el.complete && el.naturalWidth === 40), 'the image loads');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await check('a shared link to a folder (with a trailing slash) opens the tree on its own', async () => {
    const { ctx, page, errors } = await open('#file=cadence%2Fdocs%2F&root=workspace');
    await tree(page).waitFor();
    // The address becomes the canonical link, without the slash.
    await page.waitForFunction(() => location.hash === '#file=cadence%2Fdocs&root=workspace');
    assert.equal(await page.title(), 'docs · Agent Manager');
    await row(page, 'alpha.md').click();
    await page.getByRole('heading', { name: 'Alpha document' }).waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, 'folder-shared-link.png') });
    // And on a phone, without sideways scrolling.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Escape');
    await tree(page).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await check('in the Files pane, a symlink to a folder opens as that folder instead of an error', async () => {
    const { ctx, page, errors } = await open();
    await page.evaluate((id) => { localStorage.setItem('am-active-ref', `s:${id}`); localStorage.setItem('am-focused-id', id); }, server.ids.files);
    await page.reload();
    const pane = page.locator('.slot').filter({ has: page.getByRole('tree', { name: /^Files in / }) });
    await row(pane, 'notes').first().dblclick();
    await row(pane, 'docs-link').click();
    await row(pane, 'alpha.md').waitFor();
    await pane.getByRole('tree', { name: /notes\/docs-link$/ }).waitFor();
    assert.equal(await pane.getByRole('alert').count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await check('paths that leave the allowed roots are refused, in the UI and on the wire', async () => {
    // A link that climbs out, and a symlinked folder that leads out.
    for (const [hash, message] of [
      ['#file=..&root=workspace', /outside the available file locations/],
      ['#file=cadence%2Fdocs%2Fescape&root=workspace', /leaves its available file location/],
      [`#file=${encodeURIComponent(outside)}`, /outside the available locations/],
    ]) {
      const { ctx, page } = await open(hash);
      await page.getByRole('alert').filter({ hasText: message }).waitFor();
      assert.equal(await page.getByRole('tree').count(), 0, `${hash} shows a listing`);
      await ctx.close();
    }
    // Inside a folder view, the escaping entry is listed by name only — marked
    // as a link, with nothing of its target (no size, no date) — and opening it
    // is refused.
    const { ctx, page } = await open('#file=cadence%2Fdocs&root=workspace');
    const escape = row(page, 'escape');
    assert.equal(await escape.locator('.tw-size').textContent(), 'link');
    assert.equal(await escape.locator('.tw-time').textContent(), '');
    assert.match(await escape.getAttribute('title'), /symbolic link outside this location/);
    await escape.click();
    await page.getByText(/leaves its available file location/).waitFor();
    assert.equal(await page.getByText('secret.txt').count(), 0);
    await ctx.close();
    const get = (action, query) => fetch(`${server.origin}/api/file-links/${action}?${new URLSearchParams(query)}`);
    for (const query of [
      { root: 'workspace', file: '..' }, { root: 'workspace', file: 'cadence/../..' },
      { root: 'workspace', file: 'cadence/docs/escape' }, { root: 'workspace', file: 'cadence/docs/escape/' },
      { file: outside }, { session: server.ids.cadence, file: '../..' },
    ]) {
      const response = await get('list', query);
      assert.ok([403, 404].includes(response.status), `${JSON.stringify(query)} → ${response.status}`);
      assert.doesNotMatch(await response.text(), /secret\.txt/);
    }
    assert.equal((await get('raw', { root: 'workspace', file: 'cadence/docs/escape/secret.txt' })).status, 403);
  });
  await check('a folder past the listing cap says how much is not shown, in a folder preview and in Files', async () => {
    const { ctx, page, errors } = await open('#file=cadence%2Fbig&root=workspace');
    await tree(page, 'big').waitFor();
    await page.getByRole('status').filter({ hasText: '5 more not shown' }).waitFor();
    assert.equal(await page.getByRole('treeitem').count(), 2000);
    await page.getByText('+5 not listed').waitFor();
    // The Files pane uses the same listing, so the same cap and the same note.
    await page.evaluate((id) => { localStorage.setItem('am-active-ref', `s:${id}`); localStorage.setItem('am-focused-id', id); }, server.ids.files);
    await page.goto(server.origin + '/');
    const pane = page.locator('.slot').filter({ has: page.getByRole('tree', { name: /^Files in / }) });
    await row(pane, 'cadence').first().dblclick();
    await row(pane, 'big').first().click();
    await pane.getByRole('status').filter({ hasText: '5 more not shown' }).waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  });
} finally {
  await browser.close();
  await server.stop();
  fs.rmSync(outside, { recursive: true, force: true });
  if (!process.env.AM_TEST_DIST) fs.rmSync(dist, { recursive: true, force: true });
}
if (failed) { console.log(`folderPreview: ${failed} failed`); process.exit(1); }
console.log('folderPreview: folder previews through every entry point, file previews inside them, refused escapes, unfollowed symlinks and capped listings passed');
