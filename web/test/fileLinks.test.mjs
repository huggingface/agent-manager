// Standalone/copied-link fallback without a session preview host. The in-pane
// flow is covered by sessionFilePreview.test.mjs; explicit tabs stay supported.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'file-link-browser-'));
const bundle = path.join(tmp, 'fixture.js');
const markdown = '[Readme](./readme.md) · [Website](https://example.test/guide) · [Line](./code.ts:42:3) · [Bare line](code.ts:42) · [File URI](file:///data/workspaces/team/readme.md) · [Spaces](docs/a%20%231%25.md)\n\n`docs/next.md`\n\n```sh\n./not-a-link.sh\n```\n\n[Bad](javascript:alert(1))';
await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React, { useEffect, useState } from 'react'; import { createRoot } from 'react-dom/client';
    import FileLinkContent, { FileLinkScope, linkFileContent } from './src/components/FileLinkContent';
    import FileLinkPage from './src/components/FileLinkPage';
    import { renderMarkdown } from './src/lib/markdown';
    import * as links from './src/lib/fileLinks';
    import { Terminal } from '@xterm/xterm';
    import { WebLinksAddon } from '@xterm/addon-web-links';
    import { installTerminalFileLinks, terminalLinkHandler, openTerminalLink } from './src/lib/terminalFileLinks';
    import '@xterm/xterm/css/xterm.css';
    window.testLinks = { ...links, renderMarkdown, linkFileContent };
    const request = links.requestFromHash(location.hash);
    function FileRoute() {
      const [hash,setHash]=useState(location.hash);
      useEffect(()=>{const changed=()=>setHash(location.hash); window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
      const next=React.useMemo(()=>links.requestFromHash(hash),[hash]);
      return <FileLinkPage key={hash} request={next}/>;
    }
    if (request) createRoot(document.getElementById('root')).render(<FileRoute/>);
    else {
      createRoot(document.getElementById('root')).render(<main>
        <FileLinkScope session="team"><FileLinkContent className="markdown" html={renderMarkdown(${JSON.stringify(markdown)})}/></FileLinkScope>
        <textarea aria-label="Draft" defaultValue="Keep this draft"/>
        <div style={{height:1200}}>Conversation below the links</div>
      </main>);
      const term = new Terminal({ cols:80,rows:8,fontSize:14,linkHandler:terminalLinkHandler('team') });
      term.loadAddon(new WebLinksAddon((event,uri)=>openTerminalLink(event,uri,'team')));
      term.open(document.getElementById('terminal')); installTerminalFileLinks(term,'team');
      term.write('docs/next.md:42\\r\\nhttps://example.test/terminal\\r\\n\\x1b]8;;file:///data/workspaces/team/readme.md\\x1b\\\\open readme\\x1b]8;;\\x1b\\\\');
      window.term=term;
      window.osc=(text)=>terminalLinkHandler('team').activate(new MouseEvent('click'),text);
    }
  ` }, bundle: true, outfile: bundle, format: 'iife', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
});
const files = {
  'team/readme.md': { kind: 'markdown', text: '# Readme preview\n\n[Next](docs/next.md)\n\n![Picture](docs/pixel.svg)' },
  'team/docs/next.md': { kind: 'markdown', text: '# Nested document\n\n[Parent](../readme.md)' },
  'team/docs/a #1%.md': { kind: 'markdown', text: '# Special characters' },
  'team/code.ts': { kind: 'text', text: Array.from({ length: 100 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') },
};
const calls = [];
const css = ['styles.css', 'conversation.css'].map((name) => fs.readFileSync(path.join(web, 'src', name), 'utf8')).join('\n');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); return res.end(fs.readFileSync(bundle)); }
  if (url.pathname === '/fixture.css') { res.setHeader('content-type', 'text/css'); return res.end(css + fs.readFileSync(bundle.replace('.js', '.css'))); }
  if (url.pathname.startsWith('/api/')) {
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    res.setHeader('content-type', 'application/json');
    let file = url.searchParams.get('file') || '';
    if (file.startsWith('/data/workspaces/')) file = file.slice('/data/workspaces/'.length);
    else if (!url.searchParams.has('root')) file = path.posix.join('team', file);
    file = path.posix.normalize(file);
    const entry = files[file];
    if (url.searchParams.get('session') === 'remote') { res.statusCode = 404; return res.end(JSON.stringify({ error: 'File unavailable here: remote conversation.' })); }
    if (url.pathname.endsWith('/raw') && file === 'team/docs/pixel.svg') {
      res.setHeader('content-type', 'image/svg+xml'); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>');
    }
    if (!entry) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'File not found.' })); }
    if (url.pathname.endsWith('/resolve')) return res.end(JSON.stringify({ root: 'workspace', path: file, absolute: '/data/workspaces/' + file }));
    if (url.pathname.endsWith('/preview')) return res.end(JSON.stringify({ ...entry, path: file, name: path.basename(file), size: entry.text.length, mtime: 1 }));
    return res.end(entry.text);
  }
  if (url.pathname.startsWith('/fonts/')) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><link rel="stylesheet" href="/fixture.css"><style>body:has(#terminal:not(:empty)){overflow:auto}#terminal{position:fixed;bottom:0;right:0;background:white;z-index:2}</style><div id="root"></div><div id="terminal"></div><script src="/fixture.js"></script>');
});
server.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(chromiumLaunchOptions());
const context = await browser.newContext({ viewport: { width: 1000, height: 760 } });
context.setDefaultTimeout(10_000);
await context.route('https://example.test/**', (route) => route.fulfill({ body: 'External destination' }));
const errors = [];
context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
const page = await context.newPage();
const popup = async (action) => {
  const pending = context.waitForEvent('page');
  await action();
  const tab = await pending; await tab.waitForLoadState('domcontentloaded');
  return tab;
};
try {
  await page.goto(origin);
  console.log('file-links: fixture loaded');
  await page.getByRole('link', { name: 'Readme', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => {
    const { parseFileReference: parse, fileRequest, fileLinkHash, requestFromHash } = window.testLinks;
    return [parse('src/main.ts:42:3'), parse('src/main.ts#L12-L15'), parse('docs/a%20%231%25.md'),
      parse('https://example.test'), parse('file://other-host/x.md'), parse('javascript:alert(1)'),
      fileRequest('../readme.md', { root: 'workspace', base: 'team/docs' }),
      requestFromHash(fileLinkHash({ file: 'team/a #1%.md', root: 'workspace', line: 7 }))];
  }), [{ file: 'src/main.ts', line: 42, column: 3 }, { file: 'src/main.ts', line: 12 }, { file: 'docs/a #1%.md' },
    null, null, null, { file: 'team/docs/../readme.md', root: 'workspace' },
    { file: 'team/a #1%.md', root: 'workspace', line: 7, column: undefined, session: undefined, unavailable: undefined }]);
  assert.equal(await page.locator('pre a').count(), 0, 'code blocks do not gain file links');
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  for (const anchor of await page.locator('a[href]').all()) {
    assert.equal(await anchor.getAttribute('target'), '_blank');
    assert.match(await anchor.getAttribute('rel'), /noopener/);
  }
  const original = page.url();
  let tab = await popup(() => page.getByRole('link', { name: 'Readme', exact: true }).click());
  await tab.getByRole('heading', { name: 'Readme preview' }).waitFor();
  assert.equal(await tab.evaluate(() => window.opener), null);
  assert.equal(page.url(), original); assert.equal(await page.getByRole('textbox', { name: 'Draft' }).inputValue(), 'Keep this draft');
  assert.equal(await tab.locator('.xterm').count(), 0, 'file tab does not mount a terminal');
  assert.match(tab.url(), /root=workspace/); assert.doesNotMatch(tab.url(), /session=/);
  await tab.waitForFunction(() => document.querySelector('.fv-md img')?.naturalWidth === 20);
  if (process.env.FILE_LINK_SHOTS) {
    fs.mkdirSync(process.env.FILE_LINK_SHOTS, { recursive: true });
    await tab.screenshot({ path: path.join(process.env.FILE_LINK_SHOTS, 'file-preview-desktop.png') });
  }
  let nested = await popup(() => tab.getByRole('link', { name: 'Next', exact: true }).click());
  await nested.getByRole('heading', { name: 'Nested document' }).waitFor();
  assert.match(nested.url(), /team%2Fdocs%2Fnext.md/); await nested.close();
  await tab.setViewportSize({ width: 390, height: 844 });
  assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile preview fits');
  if (process.env.FILE_LINK_SHOTS) await tab.screenshot({ path: path.join(process.env.FILE_LINK_SHOTS, 'file-preview-mobile.png') });
  await tab.close();
  console.log('file-links: Markdown preview and nested links passed');
  tab = await popup(() => page.getByRole('link', { name: 'Line', exact: true }).click());
  await tab.locator('.cm-activeLine').filter({ hasText: 'const line42' }).waitFor();
  assert.equal(await tab.locator('.cm-content').getAttribute('contenteditable'), 'false');
  const lineBox = await tab.locator('.cm-activeLine').boundingBox();
  assert.ok(lineBox.y > 0 && lineBox.y < 760, 'line reference is revealed'); await tab.close();
  tab = await popup(() => page.getByRole('link', { name: 'Bare line', exact: true }).click());
  await tab.locator('.cm-activeLine').filter({ hasText: 'const line42' }).waitFor(); await tab.close();
  for (const [label, heading] of [['File URI', 'Readme preview'], ['Spaces', 'Special characters'], ['docs/next.md', 'Nested document']]) {
    tab = await popup(() => page.getByRole('link', { name: label, exact: true }).click());
    await tab.getByRole('heading', { name: heading }).waitFor(); await tab.close();
  }
  tab = await popup(() => page.getByRole('link', { name: 'Website' }).click());
  assert.equal(tab.url(), 'https://example.test/guide'); await tab.close();
  console.log('file-links: reader links passed');

  // Real hit testing in xterm, including OSC 8 links that are not visible paths.
  await page.waitForFunction(() => window.term?.buffer.active.getLine(2)?.translateToString(true).includes('open readme'));
  const clickCell = async (x, y) => {
    const box = await page.locator('.xterm-screen').boundingBox();
    await page.mouse.move(box.x + (x + 0.5) * box.width / 80, box.y + (y + 0.5) * box.height / 8);
    await page.waitForTimeout(100);
    await page.mouse.down(); await page.mouse.up();
  };
  for (const [row, expected] of [[0, 'Nested document'], [1, 'external'], [2, 'Readme preview']]) {
    console.log('file-links: terminal row', row);
    tab = await popup(() => clickCell(3, row));
    if (expected === 'external') assert.equal(tab.url(), 'https://example.test/terminal');
    else if (row === 0) await tab.locator('.cm-content').waitFor(); // :42 requests source
    else await tab.getByRole('heading', { name: expected }).waitFor();
    assert.equal(page.url(), original); await tab.close();
  }
  await page.evaluate(() => window.osc('javascript:alert(1)'));
  assert.equal(context.pages().length, 1, 'unsafe OSC 8 URLs do not open');
  // The link starts after a wide glyph and wraps to another row. Click its
  // continuation to verify both the joined path and terminal cell mapping.
  const wrappedPath = 'docs/' + 'a'.repeat(90) + '.md';
  await page.evaluate((value) => new Promise((resolve) => {
    window.term.reset(); window.term.write('🔎 ' + value, resolve);
  }), wrappedPath);
  tab = await popup(() => clickCell(3, 1));
  await tab.getByRole('alert').filter({ hasText: 'File not found' }).waitFor();
  assert.equal(new URLSearchParams(new URL(tab.url()).hash.slice(1)).get('file'), wrappedPath);
  await tab.close();
  tab = await context.newPage();
  await tab.goto(origin + '/#file=missing.md&session=team');
  await tab.getByRole('alert').filter({ hasText: 'File not found' }).waitFor();
  await tab.goto(origin + '/#file=readme.md&session=remote');
  await tab.getByRole('alert').filter({ hasText: 'File unavailable here' }).waitFor(); await tab.close();
  assert.ok(calls.every((call) => call.method === 'GET' && call.path.startsWith('/api/file-links/')), 'no file writes or agent APIs');
  assert.deepEqual(errors, []);
  console.log('file-links: reader + terminal new tabs, canonical URLs, Markdown assets, line jumps, mobile layout, and errors passed');
} finally {
  await browser.close(); await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
