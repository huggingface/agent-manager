// The Usage trace table's two display-only promises: sessions without any
// recorded tokens stay out of the table, and every displayed column sorts on
// its raw value without mutating/refetching the response. The helper receives
// exhaustive value-level coverage; Chromium exercises the actual controls,
// accessibility state, empty/loading distinction, and narrow layout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-traces-'));

const helperOut = path.join(tmp, 'usageTraces.mjs');
await build({
  entryPoints: [path.join(WEB, 'src/lib/usageTraces.ts')],
  outfile: helperOut, format: 'esm', bundle: false, logLevel: 'error',
});
const {
  DEFAULT_TRACE_SORT,
  firstTraceSortDirection,
  hasRecordedTokens,
  visibleTraceSessions,
} = await import(pathToFileURL(helperOut).href);

const trace = (id, name = id, values = {}) => ({
  id, name, cli: 'codex', path: `/sessions/${id}`,
  turns: 0, prompts: 0, toolCalls: 0, tools: {}, web: 0,
  tokensIn: 1, tokensOut: 0, cacheRead: 0,
  firstTs: 1, lastTs: 1, files: 1,
  ...values,
});
const ids = (sessions) => sessions.map(({ id }) => id);
const sort = (sessions, key, direction) => ids(visibleTraceSessions(sessions, { key, direction }));

const zero = trace('zero', 'busy but empty', {
  prompts: 7, toolCalls: 4, tools: { Read: 4 }, tokensIn: 0, tokensOut: 0, cacheRead: 0,
});
const inputOnly = trace('input', 'input only', { tokensIn: 20, tokensOut: 0, cacheRead: 0 });
const outputOnly = trace('output', 'output only', { tokensIn: 0, tokensOut: 9, cacheRead: 0 });
const cacheOnly = trace('cache', 'cache only', { tokensIn: 0, tokensOut: 0, cacheRead: 1_040 });

assert.equal(hasRecordedTokens(zero), false, 'prompts and tools do not turn a zero-token row into usage');
assert.equal(hasRecordedTokens(inputOnly), true);
assert.equal(hasRecordedTokens(outputOnly), true);
assert.equal(hasRecordedTokens(cacheOnly), true);
assert.deepEqual(
  sort([zero, inputOnly, outputOnly, cacheOnly], 'agent', 'asc'),
  ['cache', 'input', 'output'],
  'input-only, output-only, and cache-read-only rows remain visible',
);
assert.deepEqual(visibleTraceSessions([], DEFAULT_TRACE_SORT), [], 'an empty response stays empty');
assert.deepEqual(visibleTraceSessions([zero], DEFAULT_TRACE_SORT), [], 'an all-zero response has no session rows');
assert.deepEqual(
  ids(visibleTraceSessions([{ ...zero, tokensOut: 9 }], DEFAULT_TRACE_SORT)),
  ['zero'],
  'a previously filtered session appears when a later response records tokens',
);

assert.deepEqual(DEFAULT_TRACE_SORT, { key: 'lastTs', direction: 'desc' }, 'default is newest activity first');
assert.equal(firstTraceSortDirection('agent'), 'asc');
for (const key of ['turns', 'prompts', 'tools', 'web', 'tokensIn', 'tokensOut', 'lastTs']) {
  assert.equal(firstTraceSortDirection(key), 'desc', `${key} starts descending`);
}

const named = [
  trace('run-10', 'run 10'),
  trace('same-b', 'SAME'),
  trace('run-2', 'Run 2'),
  trace('same-a', 'same'),
];
assert.deepEqual(sort(named, 'agent', 'asc'), ['run-2', 'run-10', 'same-a', 'same-b'],
  'agent names use case-insensitive natural ordering, then ID');
assert.deepEqual(sort(named, 'agent', 'desc'), ['same-b', 'same-a', 'run-10', 'run-2'],
  'agent ordering toggles in full');

const values = [9, 20, 999, 1_000, 1_040];
for (const key of ['turns', 'prompts', 'tools', 'web', 'tokensIn', 'tokensOut', 'lastTs']) {
  const sessions = values.map((value) => trace(`v-${value}`, `value ${value}`, {
    ...(key === 'tools' ? { toolCalls: value } : { [key]: value }),
  }));
  assert.deepEqual(sort(sessions, key, 'asc'), values.map((n) => `v-${n}`), `${key} sorts raw numbers ascending`);
  assert.deepEqual(sort(sessions, key, 'desc'), values.toReversed().map((n) => `v-${n}`), `${key} sorts raw numbers descending`);
}

const tied = [
  trace('z', 'Beta', { prompts: 7 }),
  trace('b', 'alpha', { prompts: 7 }),
  trace('a', 'ALPHA', { prompts: 7 }),
];
assert.deepEqual(sort(tied, 'prompts', 'desc'), ['a', 'b', 'z'], 'equal values resolve by name then ID');
assert.deepEqual(sort(tied.toReversed(), 'prompts', 'desc'), ['a', 'b', 'z'], 'tie order is independent of input order');

const timestamps = [
  trace('new', 'new', { lastTs: 1_040 }),
  trace('unknown-b', 'unknown b', { lastTs: 0 }),
  trace('old', 'old', { lastTs: 9 }),
  trace('unknown-a', 'unknown a', { lastTs: Number.NaN }),
];
assert.deepEqual(sort(timestamps, 'lastTs', 'asc'), ['old', 'new', 'unknown-a', 'unknown-b'],
  'unknown timestamps follow known timestamps when ascending');
assert.deepEqual(sort(timestamps, 'lastTs', 'desc'), ['new', 'old', 'unknown-a', 'unknown-b'],
  'unknown timestamps follow known timestamps when descending');

const original = [trace('second'), trace('first')];
const snapshot = structuredClone(original);
const derived = visibleTraceSessions(original, { key: 'agent', direction: 'asc' });
assert.deepEqual(original, snapshot, 'sorting and filtering do not mutate the API array or its rows');
assert.notEqual(derived, original, 'sorting returns a derived array');

const bundle = path.join(tmp, 'app.js');
const stub = path.join(tmp, 'api-stub.ts');
fs.writeFileSync(stub, `
export * from ${JSON.stringify(path.join(WEB, 'src/api.ts'))};
const stat = (values = {}) => ({ turns: 0, prompts: 0, toolCalls: 0, tools: {}, web: 0,
  tokensIn: 0, tokensOut: 0, cacheRead: 0, firstTs: 0, lastTs: 0, files: 1, ...values });
const session = (id, name, values = {}) => ({ id, name, cli: 'codex', path: '/logs/' + id, ...stat(values) });
const now = Date.now();
const mixed = [
  session('zero', 'busy but empty', { prompts: 99, toolCalls: 88, tools: { Read: 88 }, lastTs: now }),
  session('v1040', 'zeta 1040', { turns: 1_040, prompts: 9, toolCalls: 20, tools: { Read: 12, Bash: 8 }, web: 999, tokensIn: 1_040, tokensOut: 20, cacheRead: 40, lastTs: now - 100 }),
  session('v1000', 'zeta 1000', { turns: 1_000, prompts: 20, toolCalls: 999, tools: { Read: 999 }, web: 1_040, tokensIn: 1_000, tokensOut: 9, lastTs: now - 200 }),
  session('v999', 'zeta 999', { turns: 999, prompts: 999, toolCalls: 1_000, tools: { Bash: 1_000 }, web: 20, tokensIn: 999, tokensOut: 1_040, lastTs: now - 300 }),
  session('v20', 'Agent 2', { turns: 20, prompts: 1_000, toolCalls: 1_040, tools: { WebFetch: 1_040 }, web: 9, tokensIn: 20, tokensOut: 999, lastTs: now - 400 }),
  session('v9', 'agent 10', { turns: 9, prompts: 1_040, toolCalls: 9, tools: { Read: 9 }, web: 1_000, tokensIn: 9, tokensOut: 1_000, lastTs: now - 500 }),
  session('output', 'output only', { tokensOut: 4, lastTs: now - 600 }),
  session('cache', 'cache only', { cacheRead: 5, lastTs: now - 700 }),
  session('unknown', 'unknown activity', { tokensIn: 6, lastTs: 0 }),
];
const totals = stat({ turns: 9_999, prompts: 8_888, toolCalls: 7_777, tools: { Read: 7_777 },
  web: 6_666, tokensIn: 4_321, tokensOut: 8_765, cacheRead: 111, lastTs: now, files: 42 });
window.__apiCalls = [];
export const getUsage = (provider) => {
  window.__apiCalls.push(['usage', provider]);
  return Promise.resolve({ providers: { [provider]: { tokensToday: 1_234, tokensWeek: 5_678 } } });
};
export const getTraces = () => {
  window.__apiCalls.push(['traces']);
  if (window.__traceMode === 'failed') return Promise.reject(new Error('fixture failure'));
  const sessions = window.__traceMode === 'zero'
    ? [session('zero', 'busy but empty', { prompts: 9, toolCalls: 20, lastTs: now })]
    : mixed;
  return Promise.resolve({ sessions: structuredClone(sessions), totals: structuredClone(totals), generatedAt: '2026-09-09T00:00:00Z' });
};
`);

await build({
  stdin: {
    resolveDir: WEB, loader: 'tsx', contents: `
      import React, { useEffect, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import UsagePanel from './src/components/UsagePanel.tsx';
      function Harness() {
        const [, setRender] = useState(0);
        useEffect(() => { window.__rerenderUsage = () => setRender((n) => n + 1); }, []);
        return <UsagePanel />;
      }
      createRoot(document.getElementById('root')).render(<Harness />);
    `,
  },
  outfile: bundle, bundle: true, format: 'iife', platform: 'browser', logLevel: 'error',
  plugins: [{ name: 'stub-api', setup(b) { b.onResolve({ filter: /(^|\/)\.\.?\/api$/ }, () => ({ path: stub })); } }],
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');
const browser = await chromium.launch(chromiumLaunchOptions());
const openPanel = async (mode, width = 1_100) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.route('**/logos/**', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: fs.readFileSync(path.join(WEB, 'public/logos/codex.png')),
  }));
  await page.setContent(`<style>:root { --text:#202124; --muted:#687076; --accent:#df5b35; --panel:#fff; --panel-2:#f6f6f4; --border:#deded9; --border-strong:#b8b8b0; --font:Arial,sans-serif; --font-mono:ui-monospace,monospace; --r-xl:12px; } body { margin:0; padding:20px; color:var(--text); font-family:var(--font); } * { box-sizing:border-box; } ${css}</style><div id="root"></div>`);
  await page.evaluate((traceMode) => { window.__traceMode = traceMode; }, mode);
  await page.addScriptTag({ path: bundle });
  return page;
};

try {
  const page = await openPanel('mixed');
  await page.waitForFunction(() => document.querySelectorAll('.usage-card b').length >= 12);
  await page.waitForSelector('.tr-total');

  const sessionNames = () => page.locator('.traces-table tbody tr:not(.tr-total):not(.tr-empty) .tr-agent > span:last-child').allTextContents();
  assert.deepEqual(await sessionNames(), [
    'zeta 1040', 'zeta 1000', 'zeta 999', 'Agent 2', 'agent 10', 'output only', 'cache only', 'unknown activity',
  ], 'the actual panel defaults to last-active descending, keeps unknown last, and hides the active zero-token row');

  const headers = page.locator('.traces-table thead button');
  assert.equal(await headers.count(), 8, 'all eight column headings are controls');
  const lastActive = page.getByRole('button', { name: /Sort by last active/ });
  assert.equal(await lastActive.locator('xpath=..').getAttribute('aria-sort'), 'descending');
  assert.equal((await lastActive.locator('.tr-sort-arrow').textContent()).trim(), '↓', 'active direction is visible');

  const providerBefore = await page.locator('.usage-card').allTextContents();
  const totalBefore = await page.locator('.tr-total').textContent();
  assert.match(totalBefore, /total \(42 files\).*9999.*8888.*7777.*6666.*4\.3K.*8\.8K/s,
    'the unchanged server total is formatted and remains last');
  assert.equal(await page.locator('.traces-table tbody tr').last().getAttribute('class'), 'tr-total');

  const agent = page.getByRole('button', { name: /^Sort by agent/ });
  await agent.click();
  assert.deepEqual(await sessionNames(), [
    'Agent 2', 'agent 10', 'cache only', 'output only', 'unknown activity', 'zeta 999', 'zeta 1000', 'zeta 1040',
  ], 'a real click selects natural, case-insensitive agent ascending');
  assert.equal(await agent.locator('xpath=..').getAttribute('aria-sort'), 'ascending');
  assert.equal(await agent.evaluate((el) => document.activeElement === el), true, 'click sorting retains header focus');

  await page.keyboard.press('Enter');
  assert.deepEqual((await sessionNames()).slice(0, 3), ['zeta 1040', 'zeta 1000', 'zeta 999'], 'Enter toggles the active heading');
  assert.equal(await agent.locator('xpath=..').getAttribute('aria-sort'), 'descending');
  assert.equal(await agent.evaluate((el) => document.activeElement === el), true, 'Enter sorting retains header focus');

  const turns = page.getByRole('button', { name: /^Sort by turns/ });
  await turns.focus();
  await page.keyboard.press('Space');
  assert.deepEqual((await sessionNames()).slice(0, 5), ['zeta 1040', 'zeta 1000', 'zeta 999', 'Agent 2', 'agent 10'],
    'Space activates a different numeric column in descending order');
  assert.equal(await turns.locator('xpath=..').getAttribute('aria-sort'), 'descending');
  assert.equal(await turns.evaluate((el) => document.activeElement === el), true, 'Space sorting retains header focus');

  const tokensIn = page.getByRole('button', { name: /^Sort by tok in/ });
  await tokensIn.click();
  assert.deepEqual((await sessionNames()).slice(0, 5), ['zeta 1040', 'zeta 1000', 'zeta 999', 'Agent 2', 'agent 10'],
    'token sorting uses raw 1040/1000/999/20/9 values, not rounded display strings');
  assert.equal(await tokensIn.locator('xpath=..').getAttribute('aria-sort'), 'descending');

  const apiCallsBeforeRender = await page.evaluate(() => structuredClone(window.__apiCalls));
  await page.evaluate(() => window.__rerenderUsage());
  await page.waitForTimeout(20);
  assert.equal(await tokensIn.locator('xpath=..').getAttribute('aria-sort'), 'descending', 'sort survives an ordinary render');
  assert.deepEqual((await sessionNames()).slice(0, 5), ['zeta 1040', 'zeta 1000', 'zeta 999', 'Agent 2', 'agent 10']);
  assert.deepEqual(await page.evaluate(() => window.__apiCalls), apiCallsBeforeRender,
    'sorting and ordinary renders issue no extra provider or trace requests');
  assert.deepEqual(await page.locator('.usage-card').allTextContents(), providerBefore, 'provider cards are unchanged by table sorting');
  assert.equal(await page.locator('.tr-total').textContent(), totalBefore, 'the server-provided total is unchanged by table sorting');

  const firstUsageRow = page.locator('.traces-table tbody tr:not(.tr-total)').first();
  assert.equal(await firstUsageRow.locator('.tr-agent').getAttribute('title'), '/logs/v1040', 'path tooltip remains');
  assert.match(await firstUsageRow.locator('td').nth(3).getAttribute('title'), /Read 12.*Bash 8/, 'tool tooltip remains');
  assert.match(await firstUsageRow.locator('td').nth(5).getAttribute('title'), /served from cache/, 'cache tooltip remains');
  assert.equal(await firstUsageRow.locator('.tr-agent img').count(), 1, 'agent logo remains');

  await page.setViewportSize({ width: 320, height: 900 });
  const narrow = await page.evaluate(() => {
    const table = document.querySelector('.traces-table');
    const wrap = document.querySelector('.table-scroll');
    const header = table.querySelector('th');
    const cell = table.querySelector('tbody td');
    const before = { header: header.getBoundingClientRect().left, cell: cell.getBoundingClientRect().left };
    wrap.scrollLeft = wrap.scrollWidth;
    const after = { header: header.getBoundingClientRect().left, cell: cell.getBoundingClientRect().left };
    return {
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tableOverflow: wrap.scrollWidth - wrap.clientWidth,
      moved: before.header - after.header,
      alignmentDrift: Math.abs((before.header - before.cell) - (after.header - after.cell)),
    };
  });
  assert.equal(narrow.pageOverflow, 0, 'at narrow/zoom-equivalent width the page does not scroll sideways');
  assert.ok(narrow.tableOverflow > 0 && narrow.moved > 0, 'the table retains its own horizontal scroll');
  assert.ok(narrow.alignmentDrift < 0.5, 'header and body remain aligned while horizontally scrolled');
  await tokensIn.focus();
  await page.keyboard.press('Tab');
  const keyboardFocusedHeader = page.locator('.traces-table thead button:focus');
  assert.equal(await keyboardFocusedHeader.count(), 1, 'keyboard navigation reaches a sort heading');
  const focusStyle = await keyboardFocusedHeader.evaluate((el) => ({
    width: getComputedStyle(el).outlineWidth,
    style: getComputedStyle(el).outlineStyle,
  }));
  assert.notEqual(focusStyle.style, 'none', 'keyboard focus remains visibly outlined');
  assert.notEqual(focusStyle.width, '0px', 'keyboard focus outline has visible width');

  if (process.env.USAGE_TRACE_SHOTS) {
    fs.mkdirSync(process.env.USAGE_TRACE_SHOTS, { recursive: true });
    await page.setViewportSize({ width: 1_100, height: 900 });
    await page.evaluate(() => document.activeElement?.blur());
    await page.locator('.table-scroll').screenshot({ path: path.join(process.env.USAGE_TRACE_SHOTS, 'sorted.png') });
  }
  await page.close();

  const empty = await openPanel('zero');
  await empty.waitForSelector('.tr-empty');
  assert.equal(await empty.locator('.tr-empty').textContent(), 'No sessions with recorded tokens');
  assert.equal(await empty.locator('.traces-table tbody tr:not(.tr-total):not(.tr-empty)').count(), 0);
  assert.equal(await empty.locator('.traces-table tbody tr').last().getAttribute('class'), 'tr-total',
    'the original aggregate remains last even with no visible sessions');
  assert.match(await empty.locator('.tr-total').textContent(), /total \(42 files\)/);
  if (process.env.USAGE_TRACE_SHOTS) {
    fs.mkdirSync(process.env.USAGE_TRACE_SHOTS, { recursive: true });
    await empty.locator('.table-scroll').screenshot({ path: path.join(process.env.USAGE_TRACE_SHOTS, 'empty.png') });
  }
  await empty.close();

  const failed = await openPanel('failed');
  await failed.waitForSelector('.traces-table .skel');
  await failed.waitForTimeout(20);
  assert.equal(await failed.locator('.tr-empty').count(), 0, 'a failed request is not presented as success-empty');
  assert.equal(await failed.locator('.traces-table .skel').count(), 3, 'failed/unresolved traces retain the loading treatment');
  await failed.close();
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('usage traces: filtering, all-column sorting, accessibility, totals, cards, and narrow layout agree');
