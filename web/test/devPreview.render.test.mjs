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
let status = { repo: 'huggingface/agent-manager', supervised: true, restartPending: false, next: null, running: main, selected: { prs: [] }, job: null, crashed: null, log: [] };
window.__setStatus = (s) => { status = { ...status, ...s }; };
export const getDevPreviewStatus = () => Promise.resolve(structuredClone(status));
export const getDevPreviewPrs = () => Promise.resolve({ ok: true, repo: 'huggingface/agent-manager', main: { sha: '${M}' }, prs: [
  { number: 182, title: 'Security: keep edge sign-in parameters out of the URL', author: 'ana', permission: 'admin', headRepo: 'huggingface/agent-manager', fork: false, allowed: true, sha: '${A}' },
  { number: 190, title: 'Cron tweaks', author: 'bo', permission: 'write', headRepo: 'huggingface/agent-manager', fork: false, allowed: true, sha: '${B}', draft: true },
  { number: 191, title: 'Totally harmless', author: 'outsider', permission: 'read', headRepo: 'outsider/agent-manager', fork: true, allowed: false,
    refusal: 'its author outsider has read permission on huggingface/agent-manager, not write, maintain or admin', sha: '${'d'.repeat(40)}' },
  { number: 192, title: 'From my fork', author: 'cy', permission: 'maintain', headRepo: 'cy/agent-manager', fork: true, allowed: true, sha: '${'e'.repeat(40)}' },
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
      import DevPreviewBar from './src/components/DevPreviewBar.tsx';
      import DevPreviewPanel from './src/components/DevPreviewPanel.tsx';
      import SettingsShell from './src/components/SettingsShell.tsx';
      const main = { kind: 'main', label: 'main', id: 'image', prs: [] };
      const stack = { kind: 'prs', label: '#190 bbbbbbb + #182 aaaaaaa', id: 'rel-2', base: '${M}', prs: [{ number: 190, sha: '${B}' }, { number: 182, sha: '${A}' }] };
      const sum = (running, job = null) => ({ repo: 'huggingface/agent-manager', supervised: true, restartPending: false, next: null, running, selected: { prs: [] }, job, crashed: null });
      window.__render = (which) => {
        const root = document.getElementById('root');
        root.innerHTML = '';
        const r = createRoot(root);
        const bar = (summary) => <div className="sidebar" style={{ width: 260 }}><DevPreviewBar summary={summary} onOpenSettings={() => { window.__opened = (window.__opened || 0) + 1; }} /></div>;
        if (which === 'none') r.render(<div id="x">{bar(undefined)}</div>);
        if (which === 'main') r.render(bar(sum(main)));
        if (which === 'stack') r.render(bar(sum(stack, { kind: 'switch', state: 'running', step: 'build web' })));
        if (which === 'pending') r.render(bar({ ...sum(main), restartPending: true, next: { ...stack, label: '#190 bbbbbbb + #182 aaaaaaa' } }));
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

  const bar = '[data-testid="dev-preview-bar"]';
  await check('the sidebar row renders nothing without the server\'s devPreview object', async () => {
    await render('none');
    assert.equal(await page.locator(bar).count(), 0);
  });
  await check('it is one small row: "Preview:", a dropdown on main, the settings button', async () => {
    await render('main');
    await page.waitForFunction(() => document.querySelectorAll('#devpv-pick option').length > 1);
    const box = await page.locator(bar).boundingBox();
    assert.ok(box.height <= 48, `row is ${box.height}px tall`); // 30px controls + padding + divider
    assert.match(await page.locator(bar).innerText(), /^Preview:/);
    assert.equal(await page.getByTestId('dev-preview-pick').inputValue(), 'main');
    const options = await page.locator('#devpv-pick option').allInnerTexts();
    // a long title is cut to its first letters; a refused PR is not offered at all
    assert.deepEqual(options, ['main', '#182 Security: keep edge s…', '#190 Cron tweaks', '#192 From my fork']);
    const [pick, btn] = await Promise.all([page.getByTestId('dev-preview-pick').boundingBox(), page.getByTitle(/Preview settings/).boundingBox()]);
    assert.equal(pick.height, btn.height, `dropdown ${pick.height}px vs settings button ${btn.height}px`);
    assert.equal(pick.y, btn.y, 'dropdown and button are aligned');
    assert.equal(await page.locator(bar).evaluate((el) => getComputedStyle(el).borderBottomStyle), 'solid', 'the divider sits below the row');
    await page.getByTitle(/Preview settings/).click();
    assert.equal(await page.evaluate(() => window.__opened), 1);
  });
  await check('picking a PR asks first, then switches to exactly that PR', async () => {
    await render('main');
    await page.waitForFunction(() => document.querySelectorAll('#devpv-pick option').length > 1);
    await page.evaluate(() => { window.__calls.length = 0; });
    page.once('dialog', (d) => d.dismiss());
    await page.getByTestId('dev-preview-pick').selectOption('pr:190');
    assert.deepEqual(await page.evaluate(() => window.__calls), [], 'declined: nothing sent');
    await render('main');
    await page.waitForFunction(() => document.querySelectorAll('#devpv-pick option').length > 1);
    let said = '';
    page.once('dialog', (d) => { said = d.message(); d.accept(); });
    await page.getByTestId('dev-preview-pick').selectOption('pr:190');
    await page.waitForFunction(() => window.__calls.length > 0);
    assert.deepEqual(await page.evaluate(() => window.__calls), [['switch', [{ number: 190, sha: B }]]]);
    assert.match(said, /#190 by bo \(write permission\), branch on huggingface\/agent-manager/);
    assert.match(said, /This code will run with this Space's secrets, bucket and agents/);
    await page.waitForSelector('[data-testid="dev-preview-note"]');
    assert.match(await page.getByTestId('dev-preview-note').innerText(), /conflicts/);
  });
  await check('a stack shows as what runs, and a switch in flight is a one-line note', async () => {
    await render('stack');
    await page.waitForFunction(() => document.querySelectorAll('#devpv-pick option').length > 2);
    assert.equal(await page.getByTestId('dev-preview-pick').inputValue(), 'running');
    assert.equal(await page.locator('#devpv-pick option:checked').innerText(), '#190 bbbbbbb + #182 aaaaaaa');
    assert.equal(await page.getByTestId('dev-preview-pick').isDisabled(), true);
    assert.match(await page.getByTestId('dev-preview-note').innerText(), /switching: build web/);
  });
  await check('between the swap and the restart it names what comes next', async () => {
    await render('pending');
    assert.equal(await page.getByTestId('dev-preview-pick').inputValue(), 'main');
    assert.match(await page.getByTestId('dev-preview-note').innerText(), /restarting into #190 bbbbbbb \+ #182 aaaaaaa/);
  });
  await check('Settings has no Preview tab unless the Space is a preview Space', async () => {
    await render('shell-off');
    assert.equal(await page.getByRole('button', { name: 'Preview', exact: true }).count(), 0);
    await render('shell-on');
    assert.equal(await page.getByRole('button', { name: 'Preview', exact: true }).count(), 1);
  });
  await check('after the restart the last switch log is still offered', async () => {
    await page.evaluate(() => window.__setStatus({ job: null, log: ['[13:53:50] done in 11.6s'] }));
    await render('shell-on');
    await page.waitForSelector('[data-testid="dev-preview-lastlog"]');
    await page.locator('[data-testid="dev-preview-lastlog"] button').click();
    assert.match(await page.locator('[data-testid="dev-preview-lastlog"]').innerText(), /done in 11\.6s/);
    await page.evaluate(() => window.__setStatus({ log: [] }));
    await render('shell-on');
  });
  await check('the panel switches to PRs in the order ticked and shows the conflict', async () => {
    await page.evaluate(() => { window.__calls.length = 0; window.__setStatus({ job: null }); });
    await render('shell-on');
    await page.waitForSelector('.devpv-prs li');
    assert.match(await page.locator('[data-testid="dev-preview-running"]').innerText(), /main/);
    assert.equal(await page.getByRole('button', { name: 'Roll back to main' }).isDisabled(), true, 'already on main');
    await page.locator('.devpv-prs li', { hasText: '#190' }).locator('input').check();
    await page.locator('.devpv-prs li', { hasText: '#182' }).locator('input').check();
    assert.deepEqual(await page.locator('.devpv-stack li b').allInnerTexts(), ['#190', '#182']);
    await page.locator('.devpv-stack li', { hasText: '#182' }).getByTitle('Earlier').click();
    assert.deepEqual(await page.locator('.devpv-stack li b').allInnerTexts(), ['#182', '#190']);
    await page.locator('.devpv-stack li', { hasText: '#182' }).getByTitle('Later').click();
    const fork = page.getByTestId('dev-preview-pr-191');
    assert.equal(await fork.locator('input').isDisabled(), true, 'a refused PR cannot be ticked');
    assert.match(await fork.innerText(), /outsider \(read\) · fork: outsider\/agent-manager/);
    assert.doesNotMatch(await fork.innerText(), /the author's own/);
    assert.match(await fork.innerText(), /not allowed: its author outsider has read permission/);
    assert.match(await page.getByTestId('dev-preview-pr-182').innerText(), /ana \(admin\) · huggingface\/agent-manager/);
    // a writer's own fork: allowed, and visibly a fork
    const own = page.getByTestId('dev-preview-pr-192');
    assert.equal(await own.locator('input').isDisabled(), false);
    assert.match(await own.innerText(), /cy \(maintain\) · fork: cy\/agent-manager \(the author's own\)/);
    let said = '';
    page.once('dialog', (d) => { said = d.message(); d.accept(); });
    await page.getByTestId('dev-preview-switch').click();
    await page.waitForSelector('[data-testid="dev-preview-job"]');
    assert.match(said, /Run these PRs on this Space\?/);
    assert.match(said, /#190 by bo \(write permission\).*\n#182 by ana \(admin permission\)/s);
    assert.match(said, /secrets, bucket and agents/);
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
