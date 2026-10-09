// am-test: manual — needs Chromium and a temporary local HTTP listener.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
const js = await build({ stdin: {
  contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import Panel from './src/components/CodexSharedSessions';
    createRoot(document.getElementById('root')).render(<Panel/>);`,
  resolveDir: process.cwd(), loader: 'tsx',
}, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
const css = await fs.readFile('src/styles.css', 'utf8');
const server = http.createServer((req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js.outputFiles[0].text); }
  else res.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch(chromiumLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  let requests = 0, fail = false;
  let snapshot = { connection: 'not-configured', tasks: [], nextCursor: null };
  await page.route('**/api/codex/shared*', async (route) => {
    requests++;
    if (fail) return route.fulfill({ status: 503, json: { error: 'private server detail' } });
    if (requests === 3) assert.ok(route.request().url().includes('cursor=next%2Fpage'));
    await route.fulfill({ json: { observedAt: new Date().toISOString(), launchEnabled: false, ...snapshot } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: 'Check server' }).waitFor();
  assert.equal(requests, 0, 'never connects automatically');
  await page.getByRole('button', { name: 'Check server' }).click();
  await page.getByText('No shared server is configured for this preview.').waitFor();
  snapshot = { connection: 'connected', serverVersion: '0.162.0', nextCursor: 'next/page', tasks: [
    { id: 'a', name: '<img src=x onerror=alert(1)>', cwd: '/work/a', status: 'working', amSessions: [] },
    { id: 'b', name: 'Saved task', cwd: '/work/b', status: 'unloaded', amSessions: [{ id: 'am-b', name: 'Project B' }] },
  ] };
  await page.getByRole('button', { name: 'Check server' }).click();
  await page.getByText('Saved · not loaded', { exact: false }).waitFor();
  assert.equal(await page.locator('li img').count(), 0, 'thread titles are text, never HTML');
  assert.ok(await page.getByText('Default shared creation is not enabled:', { exact: false }).isVisible());
  assert.equal(await page.getByRole('button', { name: /release|interrupt|enable/i }).count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile layout fits');
  snapshot = { connection: 'connected', tasks: [], nextCursor: null };
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.getByText('No tasks on this page.').waitFor();
  assert.equal(await page.getByText('Saved task', { exact: true }).count(), 0);
  fail = true;
  await page.getByRole('button', { name: 'Check server' }).click();
  await page.getByText('Task state is unknown', { exact: false }).waitFor();
  assert.equal(await page.getByText('No tasks on this page.').count(), 0, 'failed refresh clears old snapshot');
  assert.equal(await page.getByText('private server detail').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: manual connection, pagination, unknown state, no mutations, escaped titles, mobile layout');
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }
