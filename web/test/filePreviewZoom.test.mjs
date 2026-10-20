// The Files zoom is a reading size, not only a code-editor setting. Exercise the
// real FileView and the real stylesheet so an inline font-size that never reaches
// markdown's absolute heading rules cannot pass this test.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'file-preview-zoom-'));
const bundle = path.join(tmp, 'app.js');
const stub = path.join(tmp, 'api-stub.ts');
const markdown = `# A document heading

Body copy with \`inline code\` and enough words to make the reading size clear.

## A section

### A detail

\`\`\`ts
const answer = 42;
\`\`\`

| Part | State |
| --- | --- |
| body | readable |
`;

fs.writeFileSync(stub, `
  export class TraceUnavailable extends Error {}
  const md = ${JSON.stringify(markdown)};
  export const previewFile = (_id, p) => Promise.resolve(
    p.endsWith('.md')
      ? { kind: 'markdown', name: 'zoom.md', mime: 'text/markdown', size: md.length, mtime: 1, tag: 'md-1', text: md }
      : p.endsWith('.jsonl')
        ? { kind: 'trace', name: 'run.jsonl', mime: 'application/x-ndjson', size: 2, mtime: 1, tag: 'tr-1', text: '{}' }
        : p.endsWith('.png')
          ? { kind: 'image', name: 'picture.png', mime: 'image/png', size: 1, mtime: 1, tag: 'im-1' }
          : { kind: 'html', name: 'page.html', mime: 'text/html', size: 20, mtime: 1, tag: 'ht-1' }
  );
  export const rawUrl = (_id, p) => p.endsWith('.png')
    ? 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>'
    : 'data:text/html,<p>framed page</p>';
  export const downloadUrl = () => '#';
  export const writeFile = () => Promise.resolve({ size: 0, mtime: 1, tag: 'saved' });
  export const getFileTraceWindow = () => new Promise(() => {});
  export const getFileTraceSummary = () => new Promise(() => {});
`);

await build({
  stdin: {
    resolveDir: WEB,
    loader: 'tsx',
    contents: `
      import React, { useEffect, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { FileView } from './src/components/FilesPane.tsx';

      function Harness() {
        const [zoom, setZoom] = useState(80);
        const [file, setFile] = useState('/zoom.md');
        const [raw, setRaw] = useState(false);
        useEffect(() => { window.__fileZoom = { setZoom, setFile, setRaw }; }, []);
        return <main className="shot-shell">
          <div className="shot-head">
            <span>Files / zoom.md</span><span className="shot-zoom">Zoom {zoom}%</span>
          </div>
          <div className="slot focused"><div className="files-view">
            <FileView sessionId="files-1" path={file} zoom={zoom} raw={raw} scripts={false} onInfo={() => {}} />
          </div></div>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<Harness />);
    `,
  },
  outfile: bundle,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  logLevel: 'error',
  plugins: [{ name: 'stub-api', setup(b) {
    b.onResolve({ filter: /(^|\/)\.\.?\/api$/ }, () => ({ path: stub }));
  } }],
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage({ viewport: { width: 940, height: 680 }, deviceScaleFactor: 1 });

const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 0.03, `${label}: ${actual}px, expected ${expected}px`);
const sizes = () => page.evaluate(() => Object.fromEntries(Object.entries({
  body: '.fv-md p', h1: '.fv-md h1', h2: '.fv-md h2', h3: '.fv-md h3',
  inlineCode: '.fv-md p code', blockCode: '.fv-md pre code', table: '.fv-md td',
}).map(([key, selector]) => [key, parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)])));

try {
  await page.setContent(`<style>
    ${css}
    html, body, #root { width: 100%; height: 100%; margin: 0; }
    body { padding: 20px; box-sizing: border-box; }
    .shot-shell { width: 900px; height: 640px; display: flex; flex-direction: column; gap: 8px; }
    .shot-head { display: flex; justify-content: space-between; color: var(--muted); font: 12px var(--font-mono); }
    .shot-zoom { color: var(--accent); }
    .shot-shell > .slot { flex: 1; }
  </style><div id="root"></div>`);
  await page.addScriptTag({ path: bundle });
  await page.waitForFunction(() => !!window.__fileZoom && !!document.querySelector('.fv-md td'));

  const at80 = await sizes();
  near(at80.body, 11.2, '80% body');
  near(at80.h1, 17.6, '80% h1');
  near(at80.h2, 14.4, '80% h2');
  near(at80.h3, 12, '80% h3');
  near(at80.inlineCode, 9.856, '80% inline code');
  near(at80.blockCode, 9.856, '80% code block');
  near(at80.table, 11.2, '80% table');

  if (process.env.FILE_ZOOM_SHOTS) {
    fs.mkdirSync(process.env.FILE_ZOOM_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.FILE_ZOOM_SHOTS, 'markdown-zoom-80.png') });
  }

  await page.evaluate(() => window.__fileZoom.setZoom(150));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.fv-md p')).fontSize === '21px');
  const at150 = await sizes();
  near(at150.body, 21, '150% body');
  near(at150.h1, 33, '150% h1');
  near(at150.h2, 27, '150% h2');
  near(at150.h3, 22.5, '150% h3');
  near(at150.inlineCode, 18.48, '150% inline code');
  near(at150.blockCode, 18.48, '150% code block');
  near(at150.table, 21, '150% table');

  if (process.env.FILE_ZOOM_SHOTS) {
    await page.screenshot({ path: path.join(process.env.FILE_ZOOM_SHOTS, 'markdown-zoom-150.png') });
  }

  // Trace text already owns the same shared zoom inside TraceView. Pin both
  // levels here so it cannot silently fall back to the unzoomed outer body.
  await page.evaluate(() => { window.__fileZoom.setFile('/run.jsonl'); window.__fileZoom.setZoom(80); });
  await page.waitForSelector('.trace-body');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.trace-body')).fontSize === '10.4px');
  await page.evaluate(() => window.__fileZoom.setZoom(150));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.trace-body')).fontSize === '19.5px');

  // Pictures and framed pages are not text surfaces. The shared text-size
  // control must not turn into pixel scaling on these preview kinds.
  await page.evaluate(() => { window.__fileZoom.setFile('/picture.png'); window.__fileZoom.setZoom(150); });
  await page.waitForSelector('.fv-image');
  assert.equal(await page.locator('.fv-body').evaluate((e) => e.style.fontSize), '');
  await page.evaluate(() => window.__fileZoom.setFile('/page.html'));
  await page.waitForSelector('.fv-frame');
  assert.equal(await page.locator('.fv-body').evaluate((e) => e.style.fontSize), '');
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('file-preview-zoom: markdown and trace scale; pixels and framed pages do not');
