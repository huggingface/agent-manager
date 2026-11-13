// The warning for agent state that is not reaching durable storage
// (CheckpointBanner, fed by /api/info's `checkpoint`): what it says for a
// harness that is not saved at all, for one with a few stuck files, and for a
// checkpoint loop that stopped; and that App loads it from a chunk of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-banner-'));
const out = path.join(tmp, 'banner.mjs');
await build({
  stdin: {
    resolveDir: WEB,
    loader: 'tsx',
    contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import HealthBanners from './src/components/HealthBanners.tsx';
      export const render = (checkpoint, backup = null) =>
        renderToStaticMarkup(<HealthBanners checkpoint={checkpoint} backup={backup} onOpenSettings={() => {}} />);
    `,
  },
  bundle: true, format: 'esm', platform: 'node', outfile: out, jsx: 'automatic', logLevel: 'silent',
  // React's CommonJS build calls require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const { render } = await import(pathToFileURL(out).href);
const adapter = (o) => ({
  adapter: 'claude', failures: 40, since: 1794578400000, lastSuccessAt: 1794578000000, rc: 12, pending: 0, untested: 40, copied: 0,
  reason: 'rsync: [sender] send_files failed to open "/x/bad.jsonl": Permission denied (13)', paths: 'projects/a/bad.jsonl', ...o,
});
const log = '/data/state/agent-state.log';

test('nothing wrong renders nothing', () => {
  assert.equal(render(null), '');
  assert.equal(render(undefined), '');
});

test('a harness that is not being saved is named, with the reason', () => {
  const html = render({ adapters: [adapter({})], stalled: null, log });
  assert.match(html, /<b>Claude Code sessions are not being saved\.<\/b>/);
  assert.match(html, /Last complete save /);
  assert.match(html, /A restart now would lose the work since then\./);
  assert.match(html, /Permission denied \(13\)/);
  assert.match(html, /title="[^"]*Not copied: projects\/a\/bad\.jsonl\s+Log: \/data\/state\/agent-state\.log"/);
  assert.match(html, /role="status"/);
});

test('no success since boot says so instead of a date', () => {
  const html = render({ adapters: [adapter({ lastSuccessAt: null })], stalled: null, log });
  assert.match(html, /No complete save since this Space started/);
});

test('a few stuck files while the rest is saved reads as that', () => {
  // Also on a pass that had nothing else to copy (copied 0).
  for (const copied of [31, 0]) {
    const html = render({ adapters: [adapter({ adapter: 'codex', pending: 2, untested: 0, copied })], stalled: null, log });
    assert.match(html, /<b>Codex: 2 files are not being backed up\.<\/b>/);
    assert.doesNotMatch(html, /sessions are not being saved|A restart now would lose/);
  }
  const one = render({ adapters: [adapter({ pending: 1, untested: 0 })], stalled: null, log });
  assert.match(one, /<b>Claude Code: 1 file is not being backed up\.<\/b>/);
});

test('stuck files with others still waiting behind them is not "a few files"', () => {
  const html = render({ adapters: [adapter({ pending: 2, untested: 300 })], stalled: null, log });
  assert.match(html, /<b>Claude Code sessions are not being saved\.<\/b>/);
});

test('one line per adapter, and one for a loop that stopped', () => {
  const html = render({ adapters: [adapter({}), adapter({ adapter: 'fx' })], stalled: { lastPassAt: 1794578400000 }, log });
  assert.equal(html.match(/class="bkfail ckfail"/g).length, 3);
  assert.match(html, /No checkpoint has finished since /);
});

test('the bucket-backup banner still renders beside it', () => {
  const html = render(null, { failing: true, stale: false, failures: 2, at: 1, jobId: 'j', stage: 'ERROR', message: null, reason: 'boom', lastSuccessAt: null, jobsUrl: 'https://x' });
  assert.match(html, /Bucket backup is failing\./);
});

test('App loads the banners on demand, not in the entry', () => {
  const app = fs.readFileSync(path.join(WEB, 'src/App.tsx'), 'utf8');
  assert.match(app, /lazy\(\(\) => import\('\.\/components\/HealthBanners'\)/);
  assert.doesNotMatch(app, /^import .*(BackupBanner|CheckpointBanner|HealthBanners)/m);
  assert.match(app, /\(info\?\.backup \|\| info\?\.checkpoint\) && <Suspense>/);
});
