// Dev preview UI in a real browser: the header banner (absent without the
// server's devPreview object, truthful about what runs), the Settings tab
// (only on a preview Space), and the panel's ordered selection, conflict and
// full-rebuild reporting.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-preview-ui-'));
const bundle = path.join(tmp, 'app.js');
const stub = path.join(tmp, 'api-stub.ts');
const A = 'a'.repeat(40), B = 'b'.repeat(40), M = 'c'.repeat(40);
fs.writeFileSync(stub, `
export * from ${JSON.stringify(path.join(WEB, 'src/api.ts'))};
window.__calls = [];
const main = { kind: 'main', label: 'main', id: 'image', image: true, prs: [] };
let status = { repo: 'huggingface/agent-manager', supervised: true, running: main, selected: { prs: [] }, job: null, crashed: null, log: [] };
window.__setStatus = (s) => { status = { ...status, ...s }; };
export const getDevPreviewStatus = () => Promise.resolve(structuredClone(status));
export const getDevPreviewPrs = () => Promise.resolve({ ok: true, repo: 'huggingface/agent-manager', main: { sha: '${M}' }, prs: [
  { number: 182, title: 'Terminal fix', author: 'ana', sha: '${A}' },
  { number: 190, title: 'Cron tweaks', author: 'bo', sha: '${B}', draft: true },
] });
export const switchDevPreview = (prs) => {
  window.__calls.push(['switch', prs]);
  status = { ...status, job: { id: 'j', kind: 'switch', source: 'operator', state: 'failed', step: 'merge', steps: [{ name: 'fetch', ms: 1200 }, { name: 'merge', ms: 300 }],
    startedAt: 1, finishedAt: 1501, error: '#182 conflicts with main + #190 in server/src/index.js', prs, restarting: false,
    rebuild: null, conflict: { pr: 182, onto: 'main + #190', files: ['server/src/index.js'] } } };
  return Promise.resolve(status);
};
export const rollbackDevPreview = () => { window.__calls.push(['rollback']); return Promise.resolve(status); };
`);

await build({
  stdin: {
    resolveDir: WEB, loader: 'tsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import DevPreviewBanner from './src/components/DevPreviewBanner.tsx';
      import DevPreviewPanel from './src/components/DevPreviewPanel.tsx';
      import SettingsShell from './src/components/SettingsShell.tsx';
      const main = { kind: 'main', label: 'main', id: 'image', prs: [] };
      const stack = { kind: 'prs', label: '', id: 'rel-2', base: '${M}', prs: [{ number: 190, sha: '${B}' }, { number: 182, sha: '${A}' }] };
      const sum = (running, job = null) => ({ repo: 'huggingface/agent-manager', supervised: true, running, selected: { prs: [] }, job, crashed: null });
      window.__render = (which) => {
        const root = document.getElementById('root');
        root.innerHTML = '';
        const r = createRoot(root);
        if (which === 'none') r.render(<div id="x"><DevPreviewBanner summary={undefined} onOpen={() => {}} /></div>);
        if (which === 'main') r.render(<DevPreviewBanner summary={sum(main)} onOpen={() => {}} />);
        if (which === 'stack') r.render(<DevPreviewBanner summary={sum(stack, { kind: 'switch', state: 'running', step: 'build web' })} onOpen={() => {}} />);
        if (which === 'shell-off') r.render(<SettingsShell page="general" onPage={() => {}} onClose={() => {}}><div /></SettingsShell>);
        if (which === 'shell-on') r.render(<SettingsShell page="preview" devPreview onPage={() => {}} onClose={() => {}}><DevPreviewPanel /></SettingsShell>);
      };
    `,
  },
  outfile: bundle, bundle: true, format: 'iife', platform: 'browser', logLevel: 'error',
  plugins: [{ name: 'stub-api', setup(b) { b.onResolve({ filter: /(^|\/)\.\.?\/api$/ }, () => ({ path: stub })); } }],
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');
const browser = await chromium.launch(chromiumLaunchOptions());
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`ok - ${name}`); } catch (e) { failures++; console.log(`not ok - ${name}\n  ${String(e.stack || e).split('\n').join('\n  ')}`); }
};
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.addScriptTag({ path: bundle });
  const render = async (w) => { await page.evaluate((x) => window.__render(x), w); await page.waitForTimeout(50); };

  await check('banner renders nothing without the server\'s devPreview object', async () => {
    await render('none');
    assert.equal(await page.locator('[data-testid="dev-preview-banner"]').count(), 0);
  });
  await check('banner says main when the image build runs', async () => {
    await render('main');
    assert.match(await page.locator('[data-testid="dev-preview-banner"]').innerText(), /preview\s+main/i);
  });
  await check('banner lists the stack with short SHAs, base, and an in-flight switch', async () => {
    await render('stack');
    const text = await page.locator('[data-testid="dev-preview-banner"]').innerText();
    assert.match(text, /#190 bbbbbbb \+ #182 aaaaaaa on main ccccccc/);
    assert.match(text, /switching: build web/);
    // this tab loaded on "image": it must offer the reload
    assert.match(text, /reload to load this build's UI/);
  });
  await check('Settings has no Preview tab unless the Space is a preview Space', async () => {
    await render('shell-off');
    assert.equal(await page.getByRole('button', { name: 'Preview', exact: true }).count(), 0);
    await render('shell-on');
    assert.equal(await page.getByRole('button', { name: 'Preview', exact: true }).count(), 1);
  });
  await check('the panel switches to PRs in the order ticked and shows the conflict', async () => {
    await page.waitForSelector('.devpv-prs li');
    assert.match(await page.locator('[data-testid="dev-preview-running"]').innerText(), /main/);
    assert.equal(await page.getByRole('button', { name: 'Roll back to main' }).isDisabled(), true, 'already on main');
    await page.locator('.devpv-prs li', { hasText: '#190' }).locator('input').check();
    await page.locator('.devpv-prs li', { hasText: '#182' }).locator('input').check();
    assert.deepEqual(await page.locator('.devpv-stack li b').allInnerTexts(), ['#190', '#182']);
    await page.locator('.devpv-stack li', { hasText: '#182' }).getByTitle('Earlier').click();
    assert.deepEqual(await page.locator('.devpv-stack li b').allInnerTexts(), ['#182', '#190']);
    await page.locator('.devpv-stack li', { hasText: '#182' }).getByTitle('Later').click();
    await page.getByTestId('dev-preview-switch').click();
    await page.waitForSelector('[data-testid="dev-preview-job"]');
    const calls = await page.evaluate(() => window.__calls);
    assert.deepEqual(calls, [['switch', [{ number: 190, sha: B }, { number: 182, sha: A }]]]);
    const job = await page.locator('[data-testid="dev-preview-job"]').innerText();
    assert.match(job, /failed/);
    assert.match(job, /#182 conflicts with main \+ #190/);
    assert.match(job, /server\/src\/index\.js/);
  });
  await check('the panel lists files that need a full rebuild', async () => {
    await page.evaluate(() => window.__setStatus({ job: { id: 'k', kind: 'switch', source: 'operator', state: 'refused', step: 'check', steps: [],
      startedAt: 1, finishedAt: 2, error: 'needs a full rebuild: Dockerfile', prs: [], restarting: false, conflict: null,
      rebuild: [{ file: 'Dockerfile', why: 'changed by the selection' }] } }));
    await render('shell-on');
    await page.waitForSelector('[data-testid="dev-preview-job"]');
    const job = await page.locator('[data-testid="dev-preview-job"]').innerText();
    assert.match(job, /Needs a full rebuild/);
    assert.match(job, /Dockerfile — changed by the selection/);
  });
  await check('phone width: no sideways page scroll', async () => {
    await page.setViewportSize({ width: 390, height: 900 });
    const over = await page.evaluate(() => document.querySelector('.settings-main').scrollWidth - document.querySelector('.settings-main').clientWidth);
    assert.ok(over <= 0, `overflow ${over}px`);
  });
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failures) { console.log(`# ${failures} failed`); process.exit(1); }
console.log('# all passed');
