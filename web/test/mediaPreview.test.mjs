// Video and audio previews in a real Chromium: the viewer every surface shares
// (Files pane and shared file links) plays a small fixture from a server that
// answers Range requests the way production does, loads its metadata, fits
// the pane, and turns a file the browser can't decode into a download card.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
import { createRequire } from 'node:module';
import { kindOfName, mimeOf } from '../../server/src/preview.js';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The module behind the server's res.sendFile, so Range is answered exactly as
// production answers it.
const send = createRequire(path.join(web, '..', 'server', 'package.json'))('send');
const fixtures = path.join(web, 'test', 'fixtures');
// An LFS pointer instead of the bytes means `git lfs pull` never ran; say that
// rather than failing later with a confusing decode error.
for (const name of ['clip.webm', 'tone.ogg']) {
  const head = fs.readFileSync(path.join(fixtures, name)).subarray(0, 40).toString('latin1');
  assert.ok(!head.startsWith('version https://git-lfs'), `${name} is an LFS pointer: run \`git lfs pull\``);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-preview-'));
const files = {
  'clip.webm': path.join(fixtures, 'clip.webm'),
  'tone.ogg': path.join(fixtures, 'tone.ogg'),
  'broken.mp4': path.join(tmp, 'broken.mp4'),
};
fs.writeFileSync(files['broken.mp4'], Buffer.alloc(4096, 7)); // named like a video, isn't one

const bundle = path.join(tmp, 'fixture.js');
await build({ stdin: { resolveDir: web, loader: 'tsx', contents: `
  import React from 'react'; import { createRoot } from 'react-dom/client';
  import { FileView } from './src/components/FilesPane';
  const params = new URLSearchParams(location.search), file = params.get('file');
  const link = (action) => '/api/file-links/' + action + '?root=workspace&file=' + encodeURIComponent(file);
  // ?link: the shared-link face of the same viewer (read-only, its own URLs).
  const source = params.has('link') ? {
    root: 'workspace', rawUrl: link('raw'), downloadUrl: link('download'),
    preview: () => fetch(link('preview')).then((r) => r.json()),
  } : undefined;
  window.facts = [];
  createRoot(document.getElementById('root')).render(
    <div className="fv-body" style={{ width: 480, height: 300, display: 'flex' }}>
      <FileView sessionId="s1" path={file} zoom={100} raw={false} scripts={false} source={source}
        onInfo={(info) => window.facts.push(info.extra.join(' | '))} />
    </div>);
` }, bundle: true, outfile: bundle, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
const css = fs.readFileSync(path.join(web, 'src', 'styles.css'), 'utf8');

const ranges = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); return res.end(fs.readFileSync(bundle)); }
  if (url.pathname === '/fixture.css') { res.setHeader('content-type', 'text/css'); return res.end(css); }
  if (url.pathname.startsWith('/api/')) {
    const name = url.searchParams.get('path') ?? url.searchParams.get('file');
    const file = files[name];
    if (!file) { res.statusCode = 404; return res.end('{}'); }
    const kind = kindOfName(name), size = fs.statSync(file).size;
    if (url.pathname.endsWith('/preview')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ path: name, name, size, mtime: 1, kind, mime: mimeOf(name, kind) }));
    }
    if (url.pathname.endsWith('/raw')) {
      res.setHeader('content-type', mimeOf(name, kind));
      res.setHeader('x-content-type-options', 'nosniff');
      if (req.headers.range) ranges.push(`${url.pathname} ${name} ${req.headers.range}`);
      return send(req, file).pipe(res);
    }
  }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>');
});
server.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.setDefaultTimeout(15_000);
const errors = []; page.on('pageerror', (error) => errors.push(error.message));
try {
  for (const query of ['', '&link']) {
    const label = query ? 'shared link' : 'files pane';
    await page.goto(`${origin}/?file=clip.webm${query}`);
    const video = page.locator('.fv-media video');
    await video.waitFor();
    assert.equal(await video.getAttribute('preload'), 'metadata', label);
    assert.equal(await video.getAttribute('autoplay'), null, `${label}: never autoplays`);
    assert.ok(await video.evaluate((el) => el.controls), label);
    await page.waitForFunction(() => document.querySelector('.fv-media video')?.readyState >= 1);
    const state = await video.evaluate((el) => ({ duration: el.duration, paused: el.paused, w: el.videoWidth, h: el.videoHeight }));
    assert.ok(state.duration > 0 && Number.isFinite(state.duration), `${label}: duration ${state.duration}`);
    assert.ok(state.paused, label);
    assert.deepEqual([state.w, state.h], [160, 90], label);
    await page.waitForFunction(() => window.facts.some((f) => f.includes('160×90 · 0:02')));
    // Fits the 480×300 pane: inside it whole, never overflowing.
    const box = await video.boundingBox(), pane = await page.locator('.fv-media').boundingBox();
    assert.ok(box.width <= pane.width && box.height <= pane.height, `${label}: ${JSON.stringify({ box, pane })}`);
    // The browser fetched it by Range — the route is what makes seeking work.
    assert.ok(ranges.some((r) => r.startsWith(query ? '/api/file-links/raw clip.webm' : '/api/files/s1/raw clip.webm')), `${label}: ${ranges}`);
    await video.evaluate((el) => { el.currentTime = 1.5; });
    await page.waitForFunction(() => { const v = document.querySelector('.fv-media video'); return !v.seeking && v.currentTime > 1; });
  }
  if (process.env.MEDIA_SHOTS) { fs.mkdirSync(process.env.MEDIA_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.MEDIA_SHOTS, 'video.png') }); }

  await page.goto(`${origin}/?file=tone.ogg`);
  await page.waitForFunction(() => document.querySelector('.fv-media audio')?.readyState >= 1);
  const audio = await page.locator('.fv-media audio').evaluate((el) => ({ duration: el.duration, preload: el.preload, paused: el.paused }));
  assert.ok(audio.duration > 0.5 && audio.duration < 2, `audio duration ${audio.duration}`);
  assert.equal(audio.preload, 'metadata'); assert.ok(audio.paused);

  await page.goto(`${origin}/?file=broken.mp4`);
  await page.getByText("This browser can't play this format.").waitFor();
  assert.equal(await page.locator('.fv-media').count(), 0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  assert.match((await download).url(), /\/api\/files\/s1\/download\?path=broken\.mp4$/);

  assert.deepEqual(errors, []);
  console.log('media-preview: video + audio metadata, fit, Range seek, shared link, decode fallback passed');
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); }
