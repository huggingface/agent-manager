// The Files listing, driven by the keyboard only — the real FilesPane, real
// stylesheet, real React, in Chromium. Nothing here clicks or hovers a row to
// prepare it: every row it acts on was reached by Tab and the arrow keys, which
// is the whole point. The file APIs are a fixture, so no test can touch a real
// workspace, and every mutation is counted.
//
// What it is pinning, in one line each:
//   · the listing is one widget with one tab stop, not N rows × 4 invisible ones
//   · moving the focus is not an action — nothing opens, nothing is written
//   · every existing row action (download, rename, Move, Delete) has a key path
//   · the focus survives renames, deletes, sorts, previews and slow folders,
//     and a late directory response never takes the keyboard off another pane
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'files-keyboard-'));
const bundle = path.join(tmp, 'app.js');
const stub = path.join(tmp, 'api-stub.ts');

// The fixture workspace. Sorted by name (the default), the root reads:
//   alpha.txt · beta.md · broken · docs · images · slow
// `broken` fails to list, `slow` answers only when the test says so, `images`
// is empty, and `docs` has a folder of its own — the four states a listing has
// to keep navigable.
fs.writeFileSync(stub, `
  export class TraceUnavailable extends Error {}
  const f = (name, extra = {}) => ({ name, dir: false, size: 10, mtime: 1, kind: 'text', ...extra });
  const d = (name) => ({ name, dir: true, size: 0, mtime: 2 });
  const FRESH = () => ({
    '': [f('alpha.txt'), f('beta.md', { kind: 'markdown' }), d('broken'), d('docs'), d('images'), d('slow')],
    'docs': [d('docs/deep'), f('guide.md', { kind: 'markdown' })].map((e) => ({ ...e, name: e.name.split('/').pop() })),
    'docs/deep': [f('note.txt')],
    'images': [],
    'slow': [f('later.txt')],
  });
  const api = {
    tree: FRESH(),
    calls: [],
    holdSlow: true,
    slowWaiters: [],
    reset() { this.tree = FRESH(); this.calls = []; this.holdSlow = true; this.slowWaiters = []; },
    settleSlow() { const w = this.slowWaiters; this.slowWaiters = []; this.holdSlow = false; w.forEach((r) => r()); },
    count(op) { return this.calls.filter((c) => c.op === op).length; },
  };
  window.__api = api;
  // Fresh objects every time, exactly as parsing a JSON response gives you. The
  // fixture used to hand back its own live array, so a rename that edited an
  // entry in place also edited the listing the pane was already showing — which
  // hid a real bug: in production that stale listing still holds the OLD name.
  const snapshot = (entries) => (entries || []).map((entry) => ({ ...entry }));
  export const listFiles = (id, p = '') => {
    api.calls.push({ op: 'list', id, p });
    if (p === 'broken') return Promise.reject(new Error('EACCES'));
    if (p === 'slow' && api.holdSlow) {
      return new Promise((resolve) => api.slowWaiters.push(() => resolve({ root: 'workspace', entries: snapshot(api.tree.slow) })));
    }
    return Promise.resolve({ root: 'workspace', entries: snapshot(api.tree[p]) });
  };
  export const previewFile = (id, p) => {
    api.calls.push({ op: 'preview', id, p });
    return Promise.resolve({ kind: 'text', name: p.split('/').pop(), mime: 'text/plain', size: 4, mtime: 1, tag: 't1', text: 'body' });
  };
  export const rawUrl = (_id, p) => 'data:text/plain,' + encodeURIComponent(p);
  export const downloadUrl = (_id, p) => 'blob:download/' + p;
  export const uploadFile = (id, p, file) => { api.calls.push({ op: 'upload', id, p, name: file.name }); return Promise.resolve({}); };
  export const createFolder = (id, parent, name) => { api.calls.push({ op: 'mkdir', id, parent, name }); return Promise.resolve({}); };
  export const createFile = (id, parent, name) => { api.calls.push({ op: 'touch', id, parent, name }); return Promise.resolve({}); };
  export const renameEntry = (id, p, name) => {
    api.calls.push({ op: 'rename', id, p, name });
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const next = dir ? dir + '/' + name : name;
    const list = api.tree[dir] || [];
    const hit = list.find((e) => e.name === p.split('/').pop());
    if (hit) hit.name = name;
    return Promise.resolve({ path: next });
  };
  export const moveEntry = (id, p, to) => {
    api.calls.push({ op: 'move', id, p, to });
    const from = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const name = p.split('/').pop();
    api.tree[from] = (api.tree[from] || []).filter((e) => e.name !== name);
    const moved = { name, dir: false, size: 10, mtime: 1, kind: 'text' };
    api.tree[to] = [...(api.tree[to] || []), moved];
    return Promise.resolve({ path: to ? to + '/' + name : name });
  };
  export const deleteEntry = (id, p) => {
    api.calls.push({ op: 'delete', id, p });
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const name = p.split('/').pop();
    api.tree[dir] = (api.tree[dir] || []).filter((e) => e.name !== name);
    return Promise.resolve({});
  };
  export const writeFile = () => Promise.resolve({ size: 4, mtime: 2, tag: 't2' });
  export const getFileTraceWindow = () => new Promise(() => {});
  export const getFileTraceSummary = () => new Promise(() => {});
`);

await build({
  stdin: { resolveDir: WEB, loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import FilesPane from './src/components/FilesPane.tsx';

    const root = createRoot(document.getElementById('root'));
    // Every case mounts a pane with its OWN session id: the pane remembers where
    // it was (filesMemory) per session, and a shared id would carry one case's
    // open file into the next.
    window.__mount = (id) => {
      window.__api.reset();
      const session = { id, name: id, cli: 'files', path: '', createdAt: '', everStarted: false, running: false, state: 'idle' };
      // The key prop matters here: without it React keeps the same FilesPane
      // instance and the next case inherits the last one's folder and open file.
      root.render(<div className="tile">
        <button id="outside">another pane</button>
        <FilesPane
          key={id} session={session} focused
          onFocus={() => { window.__paneFocused = (window.__paneFocused || 0) + 1; }}
          onClose={() => { window.__closed = true; }}
        />
      </div>);
    };
    window.__closed = false;
    // Downloads leave the page in a real browser; record the click instead.
    window.__downloads = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (this.download) { window.__downloads.push({ href: this.href, name: this.download }); return; }
      return realClick.call(this);
    };
  ` },
  outfile: bundle, bundle: true, format: 'iife', platform: 'browser', logLevel: 'error',
  plugins: [{ name: 'stub-api', setup(b) { b.onResolve({ filter: /(^|\/)\.\.?\/api$/ }, () => ({ path: stub })); } }],
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
let failed = 0;
page.on('pageerror', (e) => { console.log('  PAGE ERROR', String(e).slice(0, 200)); failed++; });
// Async on purpose: nearly every assertion here has to ask the page something,
// and a `check` that did not await would report ok and then blow up as an
// unhandled rejection somewhere else entirely.
const check = async (what, fn) => {
  try { await fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    const why = String(e.message).split('\n').filter(Boolean).slice(0, 6).join('\n       ');
    console.log(`  FAIL ${what}\n       ${why}`);
  }
};

// ── driving the page ────────────────────────────────────────────────────────
const settle = (ms = 90) => page.waitForTimeout(ms);
const press = async (key, times = 1) => { for (let i = 0; i < times; i++) await page.keyboard.press(key); await settle(); };
/** What has the focus, described the way a person would: row path, or button name. */
const active = () => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return 'body';
  const row = a.getAttribute?.('data-path');
  if (row !== null && row !== undefined) return `row:${row}`;
  return `${a.getAttribute?.('aria-label') || a.textContent?.trim().slice(0, 24) || a.getAttribute?.('title') || a.tagName}`;
});
/** Tab until something matches, so no test ever hand-focuses a row. */
const tabTo = async (want, { shift = false, max = 24 } = {}) => {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
    await settle(40);
    const now = await active();
    if (now === want || (want instanceof RegExp && want.test(now))) return now;
  }
  throw new Error(`Tab never reached ${want} (stopped at ${await active()})`);
};
const rows = () => page.evaluate(() => Array.from(document.querySelectorAll('[role="treeitem"]')).map((el) => ({
  path: el.dataset.path, level: Number(el.getAttribute('aria-level')), open: el.getAttribute('aria-expanded'),
  tab: el.tabIndex, pos: el.getAttribute('aria-posinset'), size: el.getAttribute('aria-setsize'),
})));
const calls = (op) => page.evaluate((o) => window.__api.calls.filter((c) => c.op === o), op);
const mount = async (id) => {
  await page.evaluate((sid) => window.__mount(sid), id);
  await page.waitForFunction(() => document.querySelectorAll('.tree-row').length > 0);
  await settle(120);
  await page.evaluate(() => document.getElementById('outside').focus());
};
/** Into the listing the way a person gets there: Tab until a row has the focus. */
const enterTree = async () => tabTo(/^row:/);
/** …and to a particular row with the arrow keys, never by focusing it directly. */
const toRow = async (want) => {
  if (!/^row:/.test(await active())) await enterTree();
  await press('Home');
  for (let i = 0; i < 30; i++) {
    if (await active() === `row:${want}`) return;
    await press('ArrowDown');
  }
  throw new Error(`the arrows never reached ${want} (stopped at ${await active()})`);
};

await page.setContent(`<style>${css}
  html, body, #root { margin: 0; height: 100%; }
  .tile { height: 600px; display: flex; flex-direction: column; }
  .slot { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  #outside { flex: none; }
</style><div id="root"></div>`);
await page.addScriptTag({ path: bundle });
await page.waitForFunction(() => !!window.__mount);

// ── 1 · basic navigation ────────────────────────────────────────────────────
console.log('the listing is one widget with one way in');
await mount('kb-nav');
{
  const shape = await rows();
  await check('every row is a treeitem, with its place in the hierarchy on it', () => {
    assert.deepEqual(shape.map((r) => r.path), ['alpha.txt', 'beta.md', 'broken', 'docs', 'images', 'slow']);
    assert.deepEqual(shape.map((r) => r.level), [1, 1, 1, 1, 1, 1]);
    assert.deepEqual(shape.map((r) => r.pos), ['1', '2', '3', '4', '5', '6']);
    assert.equal(shape[0].size, '6');
    assert.deepEqual(shape.map((r) => r.open), [null, null, 'false', 'false', 'false', 'false']);
  });
  const role = await page.evaluate(() => {
    const t = document.querySelector('[role="tree"]');
    return { role: t?.getAttribute('role'), label: t?.getAttribute('aria-label'), tab: t?.tabIndex };
  });
  await check('…a labelled tree, and not itself a tab stop while it has rows', () => {
    assert.equal(role.role, 'tree');
    assert.match(role.label, /^Files in workspace/);
    assert.equal(role.tab, -1);
  });
  await check('exactly one row is in the tab order', () => assert.equal(shape.filter((r) => r.tab === 0).length, 1));

  await page.evaluate(() => { window.__paneFocused = 0; });
  const landed = await enterTree();
  await check('Tab from outside lands on a row', () => assert.equal(landed, 'row:alpha.txt'));
  await check('…and the app now treats this pane as the focused one', async () =>
    assert.ok(await page.evaluate(() => window.__paneFocused > 0), 'the pane never reported focus'));
  await press('ArrowDown');
  await check('down moves one row', async () => assert.equal(await active(), 'row:beta.md'));
  await press('End');
  await check('End reaches the last row', async () => assert.equal(await active(), 'row:slow'));
  await press('Home');
  await check('Home reaches the first', async () => assert.equal(await active(), 'row:alpha.txt'));

  // expansion: right opens, right again steps in, left collapses
  await press('ArrowDown', 3);            // alpha → beta → broken → docs
  await check('down four times is the first folder', async () => assert.equal(await active(), 'row:docs'));
  await press('ArrowRight');
  await page.waitForFunction(() => document.querySelectorAll('.tree-row').length > 6);
  const opened = await rows();
  await check('right expands a folder in place and stays on it', async () => {
    assert.equal(await active(), 'row:docs');
    assert.equal(opened.find((r) => r.path === 'docs').open, 'true');
    assert.deepEqual(opened.filter((r) => r.level === 2).map((r) => r.path), ['docs/deep', 'docs/guide.md']);
  });
  await press('ArrowRight');
  await check('right again steps into the first child', async () => assert.equal(await active(), 'row:docs/deep'));
  await press('ArrowLeft');
  await check('left from a child goes back to the folder', async () => assert.equal(await active(), 'row:docs'));
  await press('ArrowLeft');
  await check('left again collapses it, and its children stop being destinations', async () => {
    assert.equal(await active(), 'row:docs');
    const now = await rows();
    assert.equal(now.find((r) => r.path === 'docs').open, 'false');
    assert.deepEqual(now.filter((r) => r.path.startsWith('docs/')), []);
  });
  await press('ArrowDown');
  await check('…and down from the collapsed folder is the next sibling, not a hidden child', async () =>
    assert.equal(await active(), 'row:images'));

  // Enter opens — once
  await press('Home');
  await press('Enter');
  await page.waitForFunction(() => !!document.querySelector('.files-view'));
  const previews = await calls('preview');
  await check('Enter on a file opens the preview, exactly once', () => {
    assert.equal(previews.length, 1);
    assert.equal(previews[0].p, 'alpha.txt');
  });
  await press('Escape');
  await page.waitForFunction(() => !document.querySelector('.files-view'));
  await press('ArrowDown', 3);
  await check('Escape from the preview put the focus back, so the arrows resume from it',
    async () => assert.equal(await active(), 'row:docs'));
  await press('Enter');
  await settle(150);
  await check('Enter on a folder opens it as the listing root', async () => {
    const where = await page.evaluate(() => document.querySelector('.fi-where').textContent);
    assert.equal(where, 'workspace/docs');
    assert.deepEqual((await rows()).map((r) => r.path), ['docs/deep', 'docs/guide.md']);
  });
  await check('…and the focus enters the new listing rather than falling on the floor', async () =>
    assert.equal(await active(), 'row:docs/deep'));
}

// ── 1b · what a screen reader is handed ─────────────────────────────────────
console.log('\nand the accessibility tree says the same thing the DOM does');
await mount('kb-a11y');
{
  await enterTree();
  await press('ArrowDown', 3);
  await press('ArrowRight');                 // docs, expanded
  await settle(200);
  // Read the browser's own accessibility tree, not our attributes back: this is
  // what a screen reader is actually handed. (Chromium's CDP — Playwright's
  // page.accessibility was removed in 1.60.)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Accessibility.enable');
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const prop = (n, want) => n.properties?.find((x) => x.name === want)?.value?.value;
  const flat = nodes
    .filter((n) => !n.ignored)
    .map((n) => ({ role: n.role?.value, name: (n.name?.value || '').trim(), expanded: prop(n, 'expanded'), level: prop(n, 'level') }));
  const items = flat.filter((n) => n.role === 'treeitem');
  await check('the widget is announced as a tree, by name', () => {
    const trees = flat.filter((n) => n.role === 'tree');
    assert.equal(trees.length, 1);
    assert.match(trees[0].name, /^Files in workspace/);
  });
  await check('its rows are treeitems, named after the file, at the right level', () => {
    assert.equal(items.length, 8);
    assert.match(items[0].name, /alpha\.txt/);
    assert.equal(items[0].level, 1);
    const child = items.find((i) => /guide\.md/.test(i.name));
    assert.equal(child.level, 2, `guide.md announced at level ${child.level}`);
  });
  await check('a folder announces whether it is open, and a file has no such state', () => {
    const docs = items.find((i) => /^docs/.test(i.name));
    const images = items.find((i) => /^images/.test(i.name));
    assert.equal(docs.expanded, true);
    assert.equal(images.expanded, false);
    assert.equal(items[0].expanded, undefined);
  });
  await check('and the row’s actions are named buttons inside it', () => {
    const names = flat.filter((n) => n.role === 'button').map((n) => n.name);
    for (const want of ['Download alpha.txt', 'Rename alpha.txt', 'Delete alpha.txt'])
      assert.ok(names.includes(want), `${want} not in the accessibility tree`);
  });
}

// ── 2 · focus is not an action ──────────────────────────────────────────────
console.log('\nmoving the focus does not do anything to anything');
await mount('kb-focus');
{
  await enterTree();
  await press('ArrowDown', 5);
  await press('ArrowUp', 2);
  const after = await page.evaluate(() => ({
    calls: window.__api.calls.filter((c) => c.op !== 'list'),
    preview: !!document.querySelector('.files-view'),
    target: document.querySelector('.tree-row.target')?.textContent || null,
    moving: !!document.querySelector('.files-new .tw-warn'),
  }));
  await check('nothing was previewed, written, moved or deleted', () => {
    assert.deepEqual(after.calls, []);
    assert.equal(after.preview, false);
    assert.equal(after.moving, false);
  });
  await check('and the folder new files land in did not move under the focus', () =>
    assert.equal(after.target, null));

  await settle(250);   // the reveal is a CSS fade; read it once it has finished
  await check('the focused row shows its actions, named, without any hover', async () => {
    const acts = await page.evaluate(() => {
      const row = document.querySelector('[role="treeitem"][tabindex="0"]');
      return Array.from(row.querySelectorAll('button.tw-act')).map((b) => ({
        name: b.getAttribute('aria-label'), opacity: getComputedStyle(b).opacity, tab: b.tabIndex,
      }));
    });
    assert.deepEqual(acts.map((a) => a.name), [
      'Rename folder docs',
      'Move folder docs — then pick a destination folder',
      'Delete folder docs and everything in it',
    ]);
    assert.ok(acts.every((a) => a.opacity === '1'), `hidden while focused: ${JSON.stringify(acts)}`);
    assert.ok(acts.every((a) => a.tab === 0));
  });
  await check('…and an unfocused row keeps its buttons out of the tab order', async () => {
    const others = await page.evaluate(() => Array.from(document.querySelectorAll('[role="treeitem"]:not([tabindex="0"]) .tw-act'))
      .map((b) => b.tabIndex));
    assert.ok(others.length >= 12, `only ${others.length} buttons on the other rows`);
    assert.ok(others.every((t) => t === -1));
  });

  const seen = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); await settle(40); seen.push(await active()); }
  await check('Tab leaves through this row’s actions and then out of the pane', () => {
    assert.deepEqual(seen.slice(0, 3), [
      'Rename folder docs',
      'Move folder docs — then pick a destination folder',
      'Delete folder docs and everything in it',
    ]);
    assert.equal(seen[3], 'body');
  });
  await tabTo('row:docs', { shift: true, max: 8 });
  await page.keyboard.press('Shift+Tab'); await settle(40);
  await check('Shift+Tab comes back through them and out the top, without trapping', async () =>
    assert.match(await active(), /Modified|Size|Name|Sort by/i));
}

// ── 3 · lazy, empty and unreadable folders ──────────────────────────────────
console.log('\nfolders that are slow, empty or unreadable stay navigable');
await mount('kb-lazy');
{
  await enterTree();
  await press('ArrowDown', 4);                    // alpha, beta, broken, docs → images
  await check('at the empty folder', async () => assert.equal(await active(), 'row:images'));
  await press('ArrowRight');
  await check('an empty folder says so and adds no destinations', async () => {
    const msg = await page.evaluate(() => Array.from(document.querySelectorAll('.tree-msg')).map((m) => m.textContent));
    assert.ok(msg.includes('empty'), msg.join('|'));
    assert.deepEqual((await rows()).map((r) => r.path), ['alpha.txt', 'beta.md', 'broken', 'docs', 'images', 'slow']);
  });
  await press('ArrowDown');
  await check('…so down goes to the next row, not into the message', async () => assert.equal(await active(), 'row:slow'));

  await press('ArrowRight');                      // slow: the listing has not answered yet
  await check('a slow folder shows that it is loading and stays the focused row', async () => {
    const msg = await page.evaluate(() => Array.from(document.querySelectorAll('.tree-msg[role="status"]')).map((m) => m.textContent));
    assert.ok(msg.includes('…'), msg.join('|'));
    assert.equal(await active(), 'row:slow');
  });
  await press('ArrowLeft');                       // collapse before the answer arrives
  await page.evaluate(() => document.getElementById('outside').focus());
  await page.evaluate(() => window.__api.settleSlow());
  await settle(200);
  await check('collapsing before the answer is fine, and the answer does not take the keyboard', async () => {
    assert.equal(await active(), 'another pane');
    assert.deepEqual((await rows()).filter((r) => r.path.startsWith('slow/')), []);
  });
}
await mount('kb-broken');
{
  await enterTree();
  await press('ArrowDown', 2);
  await press('ArrowRight');
  await settle(150);
  await check('an unreadable folder says so and keeps the focus on itself', async () => {
    const msg = await page.evaluate(() => Array.from(document.querySelectorAll('.tree-msg')).map((m) => m.textContent));
    assert.ok(msg.some((m) => /can't read folder/.test(m)), msg.join('|'));
    assert.equal(await active(), 'row:broken');
  });
  await press('ArrowDown');
  await check('…and the row after it is the next entry', async () => assert.equal(await active(), 'row:docs'));
}

// ── 4 · sorting under the focus ─────────────────────────────────────────────
console.log('\nthe focus is a path, so re-sorting cannot hand it to another file');
await mount('kb-sort');
{
  await enterTree();
  await press('ArrowDown');                       // beta.md
  await page.evaluate(() => document.querySelector('.fc-btn.tw-name').click());
  await settle(200);
  await check('the same file still owns the tab stop after the order flips', async () => {
    const now = await rows();
    assert.deepEqual(now.map((r) => r.path), ['slow', 'images', 'docs', 'broken', 'beta.md', 'alpha.txt']);
    assert.equal(now.find((r) => r.tab === 0)?.path, 'beta.md');
  });
  await tabTo('row:beta.md');
  await press('ArrowDown');
  await check('…and the arrows follow the order on screen', async () => assert.equal(await active(), 'row:alpha.txt'));
}

// ── 5 · the existing row actions, from the keyboard ─────────────────────────
console.log('\nevery action a mouse can reach, a keyboard can reach');
await mount('kb-download');
{
  await enterTree();
  await tabTo('Download alpha.txt');
  await press('Enter');
  await check('Download saves the focused file, once', async () => {
    const got = await page.evaluate(() => window.__downloads.splice(0));
    assert.deepEqual(got, [{ href: 'blob:download/alpha.txt', name: 'alpha.txt' }]);
  });
}
await mount('kb-rename');
{
  await enterTree();
  await tabTo('Rename alpha.txt');
  await press('Enter');
  await check('Rename opens the field on the row itself, with the stem selected', async () => {
    const state = await page.evaluate(() => {
      const i = document.querySelector('.tw-rename');
      return i ? { focused: document.activeElement === i, value: i.value, sel: [i.selectionStart, i.selectionEnd] } : null;
    });
    assert.deepEqual(state, { focused: true, value: 'alpha.txt', sel: [0, 5] });
  });
  await page.keyboard.type('renamed');
  await press('ArrowLeft');            // a cursor key inside the field is the field's
  await check('typing and cursor keys stay in the field', async () => {
    assert.ok(await page.evaluate(() => document.activeElement.classList.contains('tw-rename')));
    assert.deepEqual((await rows()).map((r) => r.path)[0], 'alpha.txt');   // nothing moved
  });
  await press('Enter');
  await settle(200);
  await check('Enter commits it once — the typing replaced the stem, not the suffix', async () => {
    assert.deepEqual(await calls('rename'), [{ op: 'rename', id: 'kb-rename', p: 'alpha.txt', name: 'renamed.txt' }]);
  });
  await check('…and the focus follows the file to its new name', async () =>
    assert.equal(await active(), 'row:renamed.txt'));

  await toRow('beta.md');
  await tabTo('Rename beta.md');
  await press('Enter');
  await page.keyboard.type('zzz');
  await press('Escape');
  await settle(150);
  await check('Escape abandons a rename, writes nothing, and hands the row back', async () => {
    assert.equal((await calls('rename')).length, 1);
    assert.equal(await active(), 'row:beta.md');
  });
}
await mount('kb-move');
{
  await enterTree();
  await tabTo('Move alpha.txt — then pick a destination folder');
  await press('Enter');
  await check('Move arms the existing move flow and gives the row back to the arrows', async () => {
    const bar = await page.evaluate(() => document.querySelector('.files-new .tw-warn')?.textContent || '');
    assert.match(bar, /Moving\s+alpha\.txt/);
    assert.equal(await active(), 'row:alpha.txt');
    assert.equal((await calls('move')).length, 0);       // arming is not moving
  });
  await press('ArrowDown', 3);                            // → docs
  await check('arrowing over a destination does not commit anything', async () => {
    assert.equal(await active(), 'row:docs');
    assert.equal((await calls('move')).length, 0);
  });
  await press('Enter');
  await settle(250);
  await check('Enter on the folder performs exactly one move, to that folder', async () =>
    assert.deepEqual(await calls('move'), [{ op: 'move', id: 'kb-move', p: 'alpha.txt', to: 'docs' }]));
  // `docs` is closed, so the moved file has no row to stand on. The folder it
  // went into is the nearest thing that is on screen, and it is where the file
  // now is — better than the top of the listing, and better than expanding a
  // folder the operator did not ask to open.
  await check('…and the focus lands on the folder it went into', async () =>
    assert.equal(await active(), 'row:docs'));
  await check('…and the move bar is gone', async () =>
    assert.equal(await page.evaluate(() => !!document.querySelector('.files-new .tw-warn')), false));
}
await mount('kb-move-invalid');
{
  await enterTree();
  await press('ArrowDown', 3);                            // docs
  await tabTo('Move folder docs — then pick a destination folder');
  await press('Enter');
  await press('Enter');                                   // docs into itself: not a destination
  await settle(200);
  await check('a destination that would eat itself moves nothing and cancels', async () => {
    assert.deepEqual(await calls('move'), []);
    assert.equal(await page.evaluate(() => !!document.querySelector('.files-new .tw-warn')), false);
    assert.equal(await active(), 'row:docs');
  });
}
await mount('kb-move-root');
{
  await enterTree();
  await press('ArrowDown', 3);
  await press('ArrowRight');                              // open docs
  await settle(150);
  await press('ArrowRight');                              // docs/deep
  await press('ArrowDown');                               // docs/guide.md
  await tabTo('Move guide.md — then pick a destination folder');
  await press('Enter');
  await tabTo(/^Move here/);
  await press('Enter');
  await settle(250);
  await check('“Move here” puts it in the folder the breadcrumb names', async () =>
    assert.deepEqual(await calls('move'), [{ op: 'move', id: 'kb-move-root', p: 'docs/guide.md', to: '' }]));
  await check('…and the focus is on the file that moved, not on whatever row took its place', async () =>
    assert.equal(await active(), 'row:guide.md'));
}
await mount('kb-move-cancel');
{
  await enterTree();
  await tabTo('Move alpha.txt — then pick a destination folder');
  await press('Enter');
  await press('Escape');
  await settle(150);
  await check('Escape cancels an armed move and nothing else', async () => {
    assert.deepEqual(await calls('move'), []);
    assert.equal(await page.evaluate(() => !!document.querySelector('.files-new .tw-warn')), false);
    assert.equal(await page.evaluate(() => window.__closed), false);
    assert.equal(await active(), 'row:alpha.txt');
  });
}
await mount('kb-move-bar-cancel');
{
  await enterTree();
  await tabTo('Move alpha.txt — then pick a destination folder');
  await press('Enter');
  await tabTo('Cancel');
  await press('Enter');
  await settle(150);
  await check('the move bar’s own Cancel button cancels the move', async () => {
    assert.deepEqual(await calls('move'), []);
    assert.equal(await page.evaluate(() => !!document.querySelector('.files-new .tw-warn')), false);
  });
  await check('…and gives the keyboard back to the row instead of dropping it', async () =>
    assert.equal(await active(), 'row:alpha.txt'));
}
await mount('kb-delete');
{
  await toRow('beta.md');
  await tabTo('Delete beta.md');
  await page.keyboard.press('Space');                     // the trap: Space fires on the way UP
  await settle(200);
  await check('the key that opens the confirmation does not also answer it', async () => {
    assert.deepEqual(await calls('delete'), []);
    const warn = await page.evaluate(() => document.querySelector('.tw-warn')?.textContent || '');
    assert.match(warn, /Delete "beta\.md"\?/);
  });
  await check('…and the confirmation opens on Cancel, not on Delete', async () =>
    assert.equal(await active(), 'Cancel'));
  // Escape is promised to cancel an open confirmation, and the focus is on the
  // confirmation bar at that moment — which is not inside the tree.
  await press('Escape');
  await settle(150);
  await check('Escape from the confirmation closes it and deletes nothing', async () => {
    assert.deepEqual(await calls('delete'), []);
    assert.equal(await page.evaluate(() => !!document.querySelector('.tw-confirm')), false);
  });
  await check('…and hands the row back', async () => assert.equal(await active(), 'row:beta.md'));
  await tabTo('Delete beta.md');
  await press('Enter');
  await settle(150);
  await press('Enter');
  await settle(200);
  await check('Cancel deletes nothing and returns to the row', async () => {
    assert.deepEqual(await calls('delete'), []);
    assert.equal(await page.evaluate(() => !!document.querySelector('.tw-confirm')), false);
    assert.equal(await active(), 'row:beta.md');
  });
  await toRow('beta.md');
  await tabTo('Delete beta.md');
  await press('Enter');
  await tabTo('Delete', { shift: true, max: 4 });
  await press('Enter');
  await settle(300);
  await check('confirming deletes that one path, exactly once', async () =>
    assert.deepEqual(await calls('delete'), [{ op: 'delete', id: 'kb-delete', p: 'beta.md' }]));
  await check('…and the focus lands on a row that survived', async () => {
    assert.equal(await active(), 'row:broken');
    assert.deepEqual((await rows()).map((r) => r.path), ['alpha.txt', 'broken', 'docs', 'images', 'slow']);
  });
  await press('Escape');
  await check('a stray Escape afterwards closes nothing', async () =>
    assert.equal(await page.evaluate(() => window.__closed), false));
}

// ── 6 · preview and back ────────────────────────────────────────────────────
console.log('\nopening a file and coming back lands where you left');
await mount('kb-preview');
{
  await enterTree();
  await press('ArrowDown', 3);
  await press('ArrowRight');                        // expand docs, so there is expansion to lose
  await settle(150);
  await press('ArrowDown', 2);                      // docs/guide.md
  await check('at the nested file', async () => assert.equal(await active(), 'row:docs/guide.md'));
  await press('Enter');
  await page.waitForFunction(() => !!document.querySelector('.files-view'));
  await check('it opens, and the listing is only hidden', async () => {
    const state = await page.evaluate(() => ({
      viewing: !!document.querySelector('.files-view'),
      stackHidden: document.querySelector('.files-stack').hasAttribute('hidden'),
      rowsStillMounted: document.querySelectorAll('[role="treeitem"]').length,
    }));
    assert.equal(state.viewing, true);
    assert.equal(state.stackHidden, true);
    assert.ok(state.rowsStillMounted >= 7, `rows unmounted: ${state.rowsStillMounted}`);
  });
  await press('Escape');
  await page.waitForFunction(() => !document.querySelector('.files-view'));
  await settle(150);
  await check('Escape comes back to the row it was opened from', async () =>
    assert.equal(await active(), 'row:docs/guide.md'));
  await check('…with the folder still expanded', async () =>
    assert.equal((await rows()).find((r) => r.path === 'docs')?.open, 'true'));
}

// ── 6b · scrolling: the listing moves, the app does not ─────────────────────
console.log('\nthe focused row is kept in view by scrolling the listing alone');
await mount('kb-scroll');
{
  // A pane shorter than its listing — the tile owns its height, so shrink that
  // rather than the window, which is also what a tiled layout does.
  await page.evaluate(() => { document.querySelector('.tile').style.height = '150px'; });
  await settle(150);
  await enterTree();
  await press('ArrowDown', 3);
  await press('ArrowRight');                                  // docs, expanded
  await settle(150);
  const scrolled = await page.evaluate(() => ({
    body: document.querySelector('.files-body').scrollTop,
    win: window.scrollY,
    docTop: document.documentElement.scrollTop,
  }));
  await press('End');
  const atEnd = await page.evaluate(() => ({
    body: document.querySelector('.files-body').scrollTop,
    win: window.scrollY,
    docTop: document.documentElement.scrollTop,
    visible: (() => {
      const row = document.activeElement.getBoundingClientRect();
      const box = document.querySelector('.files-body').getBoundingClientRect();
      return row.top >= box.top - 1 && row.bottom <= box.bottom + 1;
    })(),
  }));
  await check('End scrolls the listing to show the last row', () => {
    assert.ok(atEnd.body > scrolled.body, `listing did not scroll (${scrolled.body} → ${atEnd.body})`);
    assert.equal(atEnd.visible, true);
  });
  await check('…and nothing else on the page moved', () => {
    assert.equal(atEnd.win, scrolled.win);
    assert.equal(atEnd.docTop, scrolled.docTop);
  });
  await press('ArrowUp', 2);            // back up to a file, without leaving the bottom
  const before = await page.evaluate(() => document.querySelector('.files-body').scrollTop);
  await check('the row the preview is opened from is a file down here', async () =>
    assert.equal(await active(), 'row:docs/guide.md'));
  await press('Enter');
  await page.waitForFunction(() => !!document.querySelector('.files-view'));
  await press('Escape');
  await page.waitForFunction(() => !document.querySelector('.files-view'));
  await settle(150);
  await check('and a preview gives the listing back at the same scroll position', async () => {
    const now = await page.evaluate(() => document.querySelector('.files-body').scrollTop);
    assert.equal(now, before);
  });
  await page.evaluate(() => { document.querySelector('.tile').style.height = ''; });
}

// ── 7 · identity changes and late answers ───────────────────────────────────
console.log('\nthe listing changing underneath does not lose or steal the keyboard');
await mount('kb-identity');
{
  await enterTree();
  await press('ArrowDown');                          // beta.md
  await page.evaluate(() => { window.__api.tree[''] = window.__api.tree[''].filter((e) => e.name !== 'beta.md'); });
  await tabTo('Refresh the listing');
  await press('Enter');
  await settle(300);
  await check('a refresh that drops the focused row moves the tab stop to a neighbour', async () => {
    const now = await rows();
    assert.deepEqual(now.map((r) => r.path), ['alpha.txt', 'broken', 'docs', 'images', 'slow']);
    assert.equal(now.find((r) => r.tab === 0)?.path, 'broken');
  });
  await check('…and the keyboard stays on the button that was pressed, not yanked into the list', async () =>
    assert.equal(await active(), 'Refresh the listing'));
  await tabTo(/^row:/, { max: 10 });
  await check('…so tabbing on into the listing lands on the repaired row', async () =>
    assert.equal(await active(), 'row:broken'));
}
await mount('kb-late');
{
  await enterTree();
  await press('ArrowDown', 5);
  await press('ArrowRight');                         // slow, still loading
  await page.evaluate(() => document.getElementById('outside').focus());
  await page.evaluate(() => window.__api.settleSlow());
  await settle(250);
  await check('a directory that answers while another pane has the focus keeps its hands off', async () => {
    assert.equal(await active(), 'another pane');
    assert.ok((await rows()).some((r) => r.path === 'slow/later.txt'), 'the folder did open');
  });
  await tabTo(/^row:/);
  await check('…and the listing is still enterable, at the row it left off on', async () =>
    assert.equal(await active(), 'row:slow'));
}
await mount('kb-session-a');
{
  await enterTree();
  await press('ArrowDown', 2);
  await page.evaluate(() => document.getElementById('outside').focus());
  await mount('kb-session-b');
  await check('switching sessions does not pull the focus into the new listing', async () =>
    assert.equal(await active(), 'another pane'));
  await check('…and the new listing is at its own root', async () =>
    assert.deepEqual((await rows()).map((r) => r.path).slice(0, 2), ['alpha.txt', 'beta.md']));
}

// ── 7b · inputs, nested controls and the pane's own shortcuts ───────────────
console.log('\nwhat is typed into a field stays in the field');
await mount('kb-inputs');
{
  await enterTree();
  await tabTo('Rename alpha.txt');
  await press('Enter');
  await page.keyboard.type('draft');
  // An IME's Enter accepts a candidate. It must not commit the rename, and it
  // must not reach the row underneath either.
  await page.evaluate(() => document.querySelector('.tw-rename')
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  await settle(120);
  await check('Enter while an IME is composing commits nothing', async () => {
    assert.deepEqual(await calls('rename'), []);
    assert.ok(await page.evaluate(() => !!document.querySelector('.tw-rename')), 'the field closed');
  });
  await press('Enter');
  await settle(200);
  await check('…and the next Enter, outside composition, commits once', async () =>
    assert.deepEqual(await calls('rename'), [{ op: 'rename', id: 'kb-inputs', p: 'alpha.txt', name: 'draft.txt' }]));

  // The create field: its own Enter and Escape, and nothing else's.
  await tabTo('New file in workspace');
  await press('Enter');
  await page.keyboard.type('made.txt');
  await press('ArrowDown');
  await check('arrows in the create field do not walk the listing', async () =>
    assert.ok(await page.evaluate(() => document.activeElement.classList.contains('files-new-input'))));
  await press('Escape');
  await settle(120);
  await check('Escape closes the create field only — nothing is created, nothing is deleted', async () => {
    assert.deepEqual(await calls('touch'), []);
    assert.deepEqual(await calls('delete'), []);
    assert.equal(await page.evaluate(() => !!document.querySelector('.files-new-input')), false);
    assert.equal(await page.evaluate(() => window.__closed), false);
  });

  // A focused action button owns its keys: the row must not act on them too.
  await toRow('beta.md');
  await tabTo('Download beta.md');
  await press('ArrowDown');
  await check('an arrow key on a focused action does not move the row focus', async () =>
    assert.equal(await active(), 'Download beta.md'));
  await press('Enter');
  await settle(150);
  await check('…and Enter on it downloads without ALSO opening the preview', async () => {
    assert.deepEqual(await page.evaluate(() => window.__downloads.splice(0)),
      [{ href: 'blob:download/beta.md', name: 'beta.md' }]);
    assert.deepEqual(await calls('preview'), []);
    assert.equal(await page.evaluate(() => !!document.querySelector('.files-view')), false);
  });

  await toRow('beta.md');
  await page.keyboard.press('Control+s');
  await settle(120);
  await check('the save shortcut in the listing writes nothing and breaks nothing', async () => {
    assert.deepEqual(await calls('write'), []);
    assert.equal(await active(), 'row:beta.md');
  });
}

// ── 7c · leaving a preview with an unsaved edit ─────────────────────────────
console.log('\nthe unsaved-changes guard still guards, and still gives the row back');
await mount('kb-unsaved');
{
  await enterTree();
  await press('Enter');                                    // alpha.txt
  await page.waitForFunction(() => !!document.querySelector('.fv-cm .cm-content'));
  await page.click('.fv-cm .cm-content');
  await page.keyboard.type('edited');
  await page.waitForFunction(() => !!document.querySelector('.fv-dirty'));
  await press('Escape');
  await check('Escape with an unsaved buffer asks instead of leaving', async () => {
    assert.equal(await page.evaluate(() => !!document.querySelector('[role="dialog"]')), true);
    assert.equal(await page.evaluate(() => !!document.querySelector('.files-view')), true);
  });
  await press('Escape');
  await check('…and Escape again goes back to editing rather than discarding', async () => {
    assert.equal(await page.evaluate(() => !!document.querySelector('[role="dialog"]')), false);
    assert.equal(await page.evaluate(() => !!document.querySelector('.files-view')), true);
    assert.deepEqual(await calls('write'), []);
  });
  await press('Escape');
  await page.waitForFunction(() => !!document.querySelector('[role="dialog"]'));
  await page.click('.fv-modal-acts .mini-btn.danger');     // Discard
  await page.waitForFunction(() => !document.querySelector('.files-view'));
  await settle(150);
  await check('discarding closes the file, writes nothing and returns to its row', async () => {
    assert.deepEqual(await calls('write'), []);
    assert.equal(await active(), 'row:alpha.txt');
  });
}

// ── 7d · the listing's other controls ───────────────────────────────────────
console.log('\nthe controls around the listing are reachable too');
await mount('kb-controls');
{
  await page.evaluate(() => {
    window.__picker = 0;
    const real = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function click() { if (this.type === 'file') { window.__picker++; return; } return real.call(this); };
  });
  const stops = [];
  for (let i = 0; i < 10; i++) { await page.keyboard.press('Tab'); await settle(35); stops.push(await active()); }
  await check('breadcrumb, create, refresh, upload and the sort headings are all tab stops', () => {
    for (const want of ['workspace', 'New folder in workspace', 'New file in workspace', 'Refresh the listing', 'Upload files'])
      assert.ok(stops.includes(want), `${want} is not reachable: ${stops.join(' → ')}`);
    assert.ok(stops.some((s) => /Name/.test(s)) && stops.some((s) => /Size/.test(s)), stops.join(' → '));
  });
  await tabTo('Upload files', { shift: true, max: 12 });
  await press('Enter');
  await check('and Enter on Upload opens the file picker', async () =>
    assert.equal(await page.evaluate(() => window.__picker), 1));
}

// ── 8 · the pointer, the layout and the themes ──────────────────────────────
console.log('\nnothing the mouse could do stopped working');
await mount('kb-pointer');
{
  await page.click('.tree-row.file');                 // a file: preview
  await page.waitForFunction(() => !!document.querySelector('.files-view'));
  await check('clicking a file still previews it', async () =>
    assert.equal((await calls('preview'))[0].p, 'alpha.txt'));
  await page.click('.mini-btn[title="Back to files (Esc)"]');
  await settle(150);
  await page.click('[data-path="docs"]');
  await settle(400);                                   // the click/double-click timer
  await check('a single click on a folder still expands it in place', async () =>
    assert.equal((await rows()).find((r) => r.path === 'docs')?.open, 'true'));
  await page.dblclick('[data-path="docs"]');
  await settle(300);
  await check('a double click still opens it as the listing root', async () =>
    assert.equal(await page.evaluate(() => document.querySelector('.fi-where').textContent), 'workspace/docs'));
}
await mount('kb-drag');
{
  await check('drag and drop still moves a file into a folder', async () => {
    await page.evaluate(() => {
      window.__dt = new DataTransfer();
      document.querySelector('[data-path="alpha.txt"]')
        .dispatchEvent(new DragEvent('dragstart', { dataTransfer: window.__dt, bubbles: true }));
    });
    await settle(80);
    await page.evaluate(() => {
      const to = document.querySelector('[data-path="docs"]');
      to.dispatchEvent(new DragEvent('dragover', { dataTransfer: window.__dt, bubbles: true, cancelable: true }));
      to.dispatchEvent(new DragEvent('drop', { dataTransfer: window.__dt, bubbles: true, cancelable: true }));
    });
    await settle(250);
    assert.deepEqual(await calls('move'), [{ op: 'move', id: 'kb-drag', p: 'alpha.txt', to: 'docs' }]);
  });
}
await mount('kb-layout');
{
  await enterTree();
  await press('ArrowDown', 3);
  for (const [w, label] of [[900, 'a wide pane'], [320, 'a narrow pane']]) {
    await page.setViewportSize({ width: w, height: 620 });
    await settle(120);
    await check(`${label} shows the focused row's actions without overflowing`, async () => {
      const m = await page.evaluate(() => {
        const row = document.querySelector('[role="treeitem"][tabindex="0"]');
        const body = document.querySelector('.files-body');
        const act = row.querySelector('.tw-act:last-child');
        return {
          overflow: body.scrollWidth - body.clientWidth,
          actOpacity: getComputedStyle(act).opacity,
          actRight: Math.round(act.getBoundingClientRect().right),
          bodyRight: Math.round(body.getBoundingClientRect().right),
        };
      });
      assert.ok(m.overflow <= 1, `listing scrolls sideways by ${m.overflow}px`);
      assert.equal(m.actOpacity, '1');
      assert.ok(m.actRight <= m.bodyRight + 1, `actions spill past the pane by ${m.actRight - m.bodyRight}px`);
    });
  }
  await page.setViewportSize({ width: 900, height: 620 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await settle(80);
    await check(`the focus ring is drawn in the ${theme} theme`, async () => {
      const ring = await page.evaluate(() => {
        const row = document.querySelector('[role="treeitem"][tabindex="0"]');
        row.focus();
        const cs = getComputedStyle(row);
        return { width: cs.outlineWidth, style: cs.outlineStyle, colour: cs.outlineColor };
      });
      assert.equal(ring.style, 'solid');
      assert.ok(parseFloat(ring.width) >= 2, `ring is ${ring.width}`);
      assert.notEqual(ring.colour, 'rgba(0, 0, 0, 0)');
    });
  }
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  // Zoom: the pane's own font-size knob, which the rows are sized from.
  await page.evaluate(() => { document.querySelector('.files-stack').style.fontSize = '20px'; });
  await settle(80);
  await check('and at a larger reading size the rows still fit their pane', async () => {
    const m = await page.evaluate(() => {
      const body = document.querySelector('.files-body');
      return body.scrollWidth - body.clientWidth;
    });
    assert.ok(m <= 1, `listing scrolls sideways by ${m}px at 20px rows`);
  });
}

if (process.env.FILES_KEYBOARD_SHOTS) {
  const dir = process.env.FILES_KEYBOARD_SHOTS;
  fs.mkdirSync(dir, { recursive: true });
  await mount('kb-shot');
  await enterTree();
  await press('ArrowDown', 3);
  await press('ArrowRight');
  await settle(200);
  await page.screenshot({ path: path.join(dir, 'focused-row.png') });
  await tabTo('Rename folder docs');
  await page.screenshot({ path: path.join(dir, 'focused-action.png') });
  await press('Escape');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await settle(120);
  await page.screenshot({ path: path.join(dir, 'focused-action-dark.png') });
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  console.log(`  (screenshots in ${dir})`);
}

await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
