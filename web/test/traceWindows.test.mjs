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
      import { useReaderBatch } from './src/lib/readerBatch.ts';

      const calls = [];
      const tails = [];
      const page = (turns, end = 20) => ({
        harness: 'claude', harnessLabel: 'Claude Code', sessionId: 's',
        title: '', model: null, cwd: null, firstTs: 0, lastTs: Date.now(),
        usage: null, source: null, sharedBy: null, note: null, truncated: false,
        total: null, userTurns: null, turns,
        window: { mode: 'bytes', start: 10, end, atStart: false, atEnd: true },
      });
      const source = {
        window(req, bytes, min, signal) {
          const call = { kind: 'window', req, bytes, min, at: performance.now(), aborted: false };
          calls.push(call);
          signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
          if (req.at === 'after') return Promise.resolve(page([], req.cursor + 1));
          return new Promise((resolve) => tails.push({ resolve, call }));
        },
        summary(signal) {
          const call = { kind: 'summary', at: performance.now(), aborted: false };
          calls.push(call);
          signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
          return new Promise(() => {});
        },
      };

      function Probe({ paused }) {
        const { head, loadNewer } = useTraceWindows(source, 'session-a', { paused, live: false });
        useEffect(() => { window.__traceHead = head; }, [head]);
        useEffect(() => { window.__loadNewer = loadNewer; }, [loadNewer]);
        return <div id="head">{head ? String(head.loaded) : ''}</div>;
      }

      function BatchProbe({ surfaceKey }) {
        const batch = useReaderBatch(surfaceKey);
        const [readyFor, setReadyFor] = React.useState('');
        useEffect(() => { window.__readerBatch = batch; window.__markReaderReady = () => setReadyFor(batch); });
        return <div id="follower">{readyFor === batch ? 'ready' : 'gated'}</div>;
      }

      const root = createRoot(document.getElementById('root'));
      let paused = true;
      let surfaceKey = '';
      const render = () => root.render(<><Probe paused={paused} /><BatchProbe surfaceKey={surfaceKey} /></>);
      window.__traceHarness = {
        calls,
        setPaused(next) { paused = next; render(); },
        setSurface(next) { surfaceKey = next; render(); },
        resolveTail() {
          const pending = [...tails].reverse().find((x) => !x.call.aborted);
          pending?.resolve(page([
            { role: 'user', ts: 1, blocks: [{ type: 'text', text: 'ask' }] },
            { role: 'assistant', ts: 2, blocks: [{ type: 'text', text: 'answer' }] },
          ]));
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

  // This is the same activation hook App uses to gate follower panes. Merely
  // focusing within one surface keeps it ready; hiding and returning to the
  // same ids creates a fresh batch and gates followers again.
  await page.evaluate(() => window.__traceHarness.setSurface('a,b'));
  await page.waitForFunction(() => document.getElementById('follower').textContent === 'gated');
  const firstBatch = await page.evaluate(() => window.__readerBatch);
  await page.evaluate(() => window.__markReaderReady());
  await page.waitForFunction(() => document.getElementById('follower').textContent === 'ready');
  await page.evaluate(() => window.__traceHarness.setSurface('a,b'));
  assert.equal(await page.evaluate(() => document.getElementById('follower').textContent), 'ready',
    'rerendering or refocusing within one appearance preserves readiness');
  await page.evaluate(() => window.__traceHarness.setSurface(''));
  await page.evaluate(() => window.__traceHarness.setSurface('a,b'));
  await page.waitForFunction(() => document.getElementById('follower').textContent === 'gated');
  assert.notEqual(await page.evaluate(() => window.__readerBatch), firstBatch,
    'returning to the same ids is a new focused-first activation');

  await page.evaluate(() => window.__traceHarness.setPaused(false));
  await page.waitForFunction(() => window.__traceHarness.calls.filter((c) => c.kind === 'window').length === 1);
  const first = await page.evaluate(() => window.__traceHarness.calls[0]);
  assert.deepEqual(first.req, { at: 'tail' });
  assert.equal(first.bytes, 128 * 1024, 'the first byte window is strict and small');
  assert.equal(first.min, 2, 'the first window stops after one displayable exchange');

  // Leaving while a tail is outstanding aborts it. A later activation starts
  // a fresh request; the obsolete one cannot consume the response body or
  // update the old reader.
  await page.evaluate(() => window.__traceHarness.setPaused(true));
  await page.waitForFunction(() => window.__traceHarness.calls[0].aborted);
  await page.evaluate(() => window.__traceHarness.setPaused(false));
  await page.waitForFunction(() => window.__traceHarness.calls.filter((c) => c.kind === 'window').length === 2);

  // The old mount-based timer would have fired by now even though no tail page
  // exists. The summary must not compete with the request that removes loading.
  await sleep(500);
  assert.equal(await page.evaluate(() => window.__traceHarness.calls.filter((c) => c.kind === 'summary').length), 0,
    'the summary clock has not started while the tail is pending');

  const resolvedAt = Date.now();
  await page.evaluate(() => window.__traceHarness.resolveTail());
  await page.waitForFunction(() => document.getElementById('head').textContent === '2');
  await page.waitForFunction(() => window.__traceHarness.calls.some((c) => c.kind === 'summary'), { timeout: 1500 });
  assert.ok(Date.now() - resolvedAt >= 350, 'the delay is measured from the painted tail, not mount');

  // A live metadata update while the whole-file read is unresolved must not
  // discard it and schedule another summary.
  await page.evaluate(() => window.__loadNewer());
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__traceHarness.calls.filter((c) => c.kind === 'summary').length), 1,
    'the whole-file summary is single-flight across metadata churn');

  await page.evaluate(() => window.__traceHarness.setPaused(true));
  await page.waitForFunction(() => window.__traceHarness.calls.find((c) => c.kind === 'summary').aborted);
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('trace-windows: ok');
