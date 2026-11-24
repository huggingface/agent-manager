// The warning for a CLI whose state folder under HOME stopped being a link to
// local disk (StateLinkBanner, fed by /api/info's `stateLinks`): Antigravity's
// on the bucket, deferred while agy runs, and the general case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'link-banner-'));
const out = path.join(tmp, 'banner.mjs');
await build({
  stdin: {
    resolveDir: WEB,
    loader: 'tsx',
    contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import HealthBanners from './src/components/HealthBanners.tsx';
      export const render = (stateLinks) =>
        renderToStaticMarkup(<HealthBanners checkpoint={null} backup={null} stateLinks={stateLinks} onOpenSettings={() => {}} />);
    `,
  },
  bundle: true, format: 'esm', platform: 'node', outfile: out, jsx: 'automatic', logLevel: 'silent',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const { render } = await import(pathToFileURL(out).href);
const log = '/data/state/agent-state.log';
const agy = {
  cli: 'antigravity', link: '/data/home/.gemini/antigravity-cli',
  target: '/home/node/local/antigravity-home/antigravity-cli', kind: 'dir', onBucket: true,
};

test('nothing wrong renders nothing', () => {
  assert.equal(render(null), '');
  assert.equal(render(undefined), '');
});

test('Antigravity state on the bucket is named, and when it gets repaired', () => {
  const html = render({ broken: [agy], repair: null, log });
  assert.match(html, /<b>Antigravity state is on the bucket \(link replaced\)\.<\/b>/);
  assert.match(html, /repaired before the next Antigravity launch/);
  assert.match(html, /its databases can corrupt/);
  assert.match(html, /\/data\/home\/\.gemini\/antigravity-cli/);
  assert.match(html, /role="status"/);
});

test('both Antigravity links make one line', () => {
  const html = render({ broken: [agy, { ...agy, link: '/data/home/.gemini/config', target: '/x/config' }], repair: null, log });
  assert.equal(html.match(/role="status"/g).length, 1);
  assert.match(html, /antigravity-cli, \/data\/home\/\.gemini\/config/);
});

test('a repair deferred because agy runs says what to do', () => {
  const html = render({ broken: [agy], repair: { outcome: 'deferred', at: 1, reason: 'launch x', detail: 'agy is running: pid 7: agy' }, log });
  assert.match(html, /An agy session is running, so it was not moved/);
  assert.match(html, /Last repair deferred: agy is running: pid 7/);
});

test('another CLI whose link became a directory is warned about too', () => {
  const html = render({ broken: [{ cli: 'hermes', link: '/data/home/.hermes', target: '/l/hermes', kind: 'dir', onBucket: true }], repair: null, log });
  assert.match(html, /<b>Hermes state is on the bucket \(link replaced\)\.<\/b>/);
  assert.match(html, /Restart the Space to relink it/);
});
