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
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

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
      const summaries = [];
      // What the agent has written since the reader last looked, and a switch
      // that leaves such a request outstanding forever: a connection frozen
      // along with the tab, which is what iOS Safari does to a backgrounded one.
      let pending = [];
      let freeze = false;
      const page = (turns, end = 20, lastTs = Date.now()) => ({
        harness: 'claude', harnessLabel: 'Claude Code', sessionId: 's',
        title: '', model: null, cwd: null, firstTs: 0, lastTs,
        usage: null, source: null, sharedBy: null, note: null, truncated: false,
        total: null, userTurns: null, turns,
        window: { mode: 'bytes', start: 10, end, atStart: false, atEnd: true },
      });
      const source = {
        window(req, bytes, min, signal) {
          const call = { kind: 'window', req, bytes, min, at: performance.now(), aborted: false };
          calls.push(call);
          signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
          if (req.at === 'after') {
            if (freeze) return new Promise(() => {});
            const got = pending;
            pending = [];
            // Written a while ago: a returning reader must not depend on the
            // trace looking recent, which is exactly when polling is off.
            return Promise.resolve(page(got, req.cursor + 1, Date.now() - 10 * 60_000));
          }
          return new Promise((resolve) => tails.push({ resolve, call }));
        },
        summary(signal) {
          const call = { kind: 'summary', at: performance.now(), aborted: false };
          calls.push(call);
          signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
          // Unresolved by default — the whole-file read is slow by nature, and
          // several checks depend on it still being outstanding.
          return new Promise((resolve) => summaries.push({ resolve, call }));
        },
      };

      function Probe({ paused }) {
        const { head, loadNewer } = useTraceWindows(source, 'session-a', { paused, live: false });
        useEffect(() => { window.__traceHead = head; }, [head]);
        useEffect(() => { window.__loadNewer = loadNewer; }, [loadNewer]);
        return <div id="head">{head ? String(head.loaded) : ''}</div>;
      }

      const root = createRoot(document.getElementById('root'));
      let paused = true;
      const render = () => root.render(<Probe paused={paused} />);
      window.__traceHarness = {
        calls,
        setPaused(next) { paused = next; render(); },
        /** Turns the agent writes while the operator is looking at another app. */
        writeWhileAway(count) {
          pending = Array.from({ length: count }, (_, i) => (
            { role: 'assistant', ts: 100 + i, blocks: [{ type: 'text', text: 'away-' + i }] }
          ));
        },
        setFrozen(next) { freeze = next; },
        /** Answer the newest live whole-file read, the way a server would. */
        resolveSummary(total) {
          const pending = [...summaries].reverse().find((x) => !x.call.aborted);
          pending?.resolve({
            total, userTurns: 3, usage: null, firstTs: 1, truncated: false,
            note: null, title: '', harnessLabel: 'Claude Code', sessionId: 's',
            model: null, cwd: null, source: null, sharedBy: null,
          });
        },
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
// CI uses Playwright's matching download; this workspace keeps a shared Chromium
// of a different revision. The helper resolves whichever is actually installed
// (and still honours PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) so neither environment
// needs a path baked into the test.
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage();
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ path: bundle });
  await page.waitForFunction(() => !!window.__traceHarness);

  await sleep(100);
  assert.deepEqual(await page.evaluate(() => window.__traceHarness.calls), [],
    'a paused reader performs no initial or summary request');

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

  // --- switching to another app and coming back ----------------------------
  // Chromium cannot be genuinely backgrounded in this container: headless
  // reports every page visible, and headed has no window manager to minimise or
  // occlude one (both were tried, along with CDP lifecycle states, a sibling
  // tab, and WebKit, which will not launch here). So the document's own
  // visibility is overridden and the real event dispatched through the DOM. The
  // hook reads `document.hidden` and nothing else, so this is the same code path
  // a true app switch takes; what it does not prove is that the browser fires
  // the event, which is the browser's guarantee rather than this app's.
  const setVisibility = (state) => page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
  const windowCalls = () => page.evaluate(() =>
    window.__traceHarness.calls.filter((c) => c.kind === 'window').length);

  await page.evaluate(() => window.__traceHarness.setPaused(false));
  await page.evaluate(() => window.__traceHarness.resolveTail());
  await page.waitForFunction(() => document.getElementById('head').textContent === '2');

  await setVisibility('hidden');
  const whileAway = await windowCalls();
  await sleep(1200);
  assert.equal(await windowCalls(), whileAway, 'a reader nobody is looking at asks for nothing');

  // The agent writes three turns while the operator is in another app, and the
  // trace comes back ten minutes stale. `live: false` on a trace that old is
  // exactly the case the scheduler leaves alone: no interval will ever cover
  // this reader, so the return itself has to do the reading.
  await page.evaluate(() => window.__traceHarness.writeWhileAway(3));
  const returnedAt = Date.now();
  await setVisibility('visible');
  await page.waitForFunction(() => document.getElementById('head').textContent === '5', null, { timeout: 2_000 });
  assert.ok(Date.now() - returnedAt < 2_000,
    'what was written while away is on screen on return, not an interval later');
  const caughtUp = await page.evaluate(() =>
    window.__traceHarness.calls.filter((c) => c.kind === 'window').pop());
  assert.equal(caughtUp.req.at, 'after', 'the reader asks for what it missed, not for the whole tail again');

  // A request in flight when the tab went away can be frozen with it: it never
  // resolves and never rejects. The one-request-at-a-time latch is released only
  // in that request's `finally`, so a returning reader that waits for it is
  // stuck for good — every later read returns early against a latch nothing will
  // release.
  await page.evaluate(() => window.__traceHarness.setFrozen(true));
  const frozenIndex = await page.evaluate(() => window.__traceHarness.calls.length);
  // Deliberately not awaited in the page: this is the request that never settles.
  await page.evaluate(() => { void window.__loadNewer(); });
  await page.waitForFunction((n) => window.__traceHarness.calls.length > n, frozenIndex);
  await setVisibility('hidden');
  await page.evaluate(() => {
    window.__traceHarness.setFrozen(false);
    window.__traceHarness.writeWhileAway(2);
  });
  await setVisibility('visible');
  await page.waitForFunction(() => document.getElementById('head').textContent === '7', null, { timeout: 2_000 });
  const frozen = await page.evaluate((n) => window.__traceHarness.calls[n], frozenIndex);
  assert.ok(frozen.aborted, 'the request frozen with the tab is abandoned, not waited on');

  // Restoring from the back/forward cache fires no visibilitychange — the page
  // was frozen whole, not hidden. Chromium under automation refuses to put a
  // page in that cache (verified: `persisted` is false even over http with the
  // feature forced on), so the event a restore delivers is dispatched directly.
  await page.evaluate(() => window.__traceHarness.writeWhileAway(1));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForFunction(() => document.getElementById('head').textContent === '8', null, { timeout: 2_000 });

  // The frozen request can be the whole-file summary rather than a window. That
  // read is single-flight through a ref, so if it is the one the app switch
  // killed, the header keeps its partial counts for the life of this source —
  // turns arriving on every return, but never a turn total or a session cost.
  await page.waitForFunction(() =>
    window.__traceHarness.calls.some((c) => c.kind === 'summary' && !c.aborted), null, { timeout: 3_000 });
  const summaryIndex = await page.evaluate(() =>
    window.__traceHarness.calls.findIndex((c) => c.kind === 'summary' && !c.aborted));
  assert.equal(await page.evaluate(() => window.__traceHead?.total ?? null), null,
    'the header has no whole-file counts while that read is outstanding');
  await setVisibility('hidden');
  await setVisibility('visible');
  await page.waitForFunction((n) => window.__traceHarness.calls[n].aborted, summaryIndex, { timeout: 2_000 });
  await page.waitForFunction((n) => window.__traceHarness.calls
    .some((call, index) => index > n && call.kind === 'summary'), summaryIndex, { timeout: 3_000 });
  // And the retry is a real one: answering it fills the header in.
  await page.evaluate(() => window.__traceHarness.resolveSummary(41));
  await page.waitForFunction(() => window.__traceHead?.total === 41, null, { timeout: 3_000 });
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('trace-windows: ok');
