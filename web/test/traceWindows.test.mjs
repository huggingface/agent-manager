// Critical-path scheduling for the windowed reader, in a real React/browser
// lifecycle: hidden readers stay silent, the first request is deliberately
// small, and the whole-file summary clock starts only after the tail paints.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-windows-web-'));
const bundle = path.join(tmp, 'harness.js');

await build({
  stdin: {
    resolveDir: path.join(HERE, '..'),
    loader: 'tsx',
    contents: `
      import React, { useEffect } from 'react';
      import { createRoot } from 'react-dom/client';
      import { useTraceWindows } from './src/lib/traceWindows.ts';

      const calls = [];
      const tails = [];
      const source = {
        window(req, bytes, min) {
          calls.push({ kind: 'window', req, bytes, min, at: performance.now() });
          return new Promise((resolve) => tails.push(resolve));
        },
        async summary() {
          calls.push({ kind: 'summary', at: performance.now() });
          return { total: 2, userTurns: [0] };
        },
      };

      function Probe({ paused }) {
        const { head } = useTraceWindows(source, 'session-a', { paused, live: false });
        useEffect(() => { window.__traceHead = head; }, [head]);
        return <div id="head">{head ? String(head.loaded) : ''}</div>;
      }

      const root = createRoot(document.getElementById('root'));
      let paused = true;
      const render = () => root.render(<Probe paused={paused} />);
      window.__traceHarness = {
        calls,
        setPaused(next) { paused = next; render(); },
        resolveTail() {
          tails.shift()?.({
            harness: 'claude', harnessLabel: 'Claude Code', sessionId: 's',
            title: '', model: null, cwd: null, firstTs: 0, lastTs: Date.now(),
            usage: null, source: null, sharedBy: null, note: null, truncated: false,
            total: null, userTurns: null,
            turns: [
              { role: 'user', ts: 1, blocks: [{ type: 'text', text: 'ask' }] },
              { role: 'assistant', ts: 2, blocks: [{ type: 'text', text: 'answer' }] },
            ],
            window: { mode: 'bytes', start: 10, end: 20, atStart: false, atEnd: true },
          });
        },
      };
      render();
    `,
  },
  outfile: bundle,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  logLevel: 'error',
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// CI normally uses Playwright's matching download. The development Space keeps
// a shared Chromium revision instead, so allow that executable to be supplied
// without baking an environment-specific path into the test.
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
try {
  const page = await browser.newPage();
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ path: bundle });
  await page.waitForFunction(() => !!window.__traceHarness);

  await sleep(100);
  assert.deepEqual(await page.evaluate(() => window.__traceHarness.calls), [],
    'a paused reader performs no initial or summary request');

  await page.evaluate(() => window.__traceHarness.setPaused(false));
  await page.waitForFunction(() => window.__traceHarness.calls.length === 1);
  const first = await page.evaluate(() => window.__traceHarness.calls[0]);
  assert.deepEqual(first.req, { at: 'tail' });
  assert.equal(first.bytes, 128 * 1024, 'the first byte window is strict and small');
  assert.equal(first.min, 2, 'the first window stops after one displayable exchange');

  // The old mount-based timer would have fired by now even though no tail page
  // exists. The summary must not compete with the request that removes loading.
  await sleep(500);
  assert.equal(await page.evaluate(() => window.__traceHarness.calls.filter((c) => c.kind === 'summary').length), 0,
    'the summary clock has not started while the tail is pending');

  const resolvedAt = Date.now();
  await page.evaluate(() => window.__traceHarness.resolveTail());
  await page.waitForFunction(() => document.getElementById('head').textContent === '2');
  await sleep(250);
  assert.equal(await page.evaluate(() => window.__traceHarness.calls.filter((c) => c.kind === 'summary').length), 0,
    'the summary remains deferred after the first page paints');
  await page.waitForFunction(() => window.__traceHarness.calls.some((c) => c.kind === 'summary'), { timeout: 1500 });
  assert.ok(Date.now() - resolvedAt >= 350, 'the delay is measured from the painted tail, not mount');

  const beforePause = await page.evaluate(() => window.__traceHarness.calls.length);
  await page.evaluate(() => window.__traceHarness.setPaused(true));
  await sleep(500);
  assert.equal(await page.evaluate(() => window.__traceHarness.calls.length), beforePause,
    'pausing an already-mounted reader starts no further work');
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('trace-windows: ok');
