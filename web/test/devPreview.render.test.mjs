// Dev preview UI in a real browser: the header banner (absent without the
// server's devPreview object, truthful about what runs), the Settings tab
// (only on a preview Space), the panel's ordered selection, conflict and
// full-rebuild reporting, and "Pull latest" in the panel and the sidebar row.
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
// The open-PR list, mutable from the page (window.__prs) so a test can move a head, main, or close a PR.
const initialPrs = () => ({ ok: true, repo: 'huggingface/agent-manager', main: { sha: '${M}' }, prs: [
  { number: 182, title: 'Security: keep edge sign-in parameters out of the URL', author: 'ana', permission: 'admin', headRepo: 'huggingface/agent-manager', fork: false, allowed: true, sha: '${A}' },
  { number: 190, title: 'Cron tweaks', author: 'bo', permission: 'write', headRepo: 'huggingface/agent-manager', fork: false, allowed: true, sha: '${B}', draft: true },
  { number: 191, title: 'Totally harmless', author: 'outsider', permission: 'read', headRepo: 'outsider/agent-manager', fork: true, allowed: false,
    refusal: 'its author outsider has read permission on huggingface/agent-manager, not write, maintain or admin', sha: '${'d'.repeat(40)}' },
  { number: 192, title: 'From my fork', author: 'cy', permission: 'maintain', headRepo: 'cy/agent-manager', fork: true, allowed: false,
    refusal: 'its branch is on a fork (cy/agent-manager); only branches on huggingface/agent-manager itself can be previewed', sha: '${'e'.repeat(40)}' },
] });
window.__prs = initialPrs();
window.__resetPrs = () => { window.__prs = initialPrs(); };
window.__prsReads = 0;
export const getDevPreviewPrs = () => { window.__prsReads++; return Promise.resolve(structuredClone(window.__prs)); };
export const switchDevPreview = (prs) => {
  window.__calls.push(['switch', prs]);
  status = { ...status, job: { id: 'j', kind: 'switch', source: 'operator', state: 'failed', step: 'merge', steps: [{ name: 'fetch', ms: 1200 }, { name: 'merge', ms: 300 }],
    startedAt: 1, finishedAt: 1501, error: '#182 conflicts with main + #190 in server/src/index.js', prs, restarting: false,
    rebuild: null, conflict: { pr: 182, onto: 'main + #190', files: ['server/src/index.js'] } } };
  return Promise.resolve(status);
};
export const rollbackDevPreview = () => { window.__calls.push(['rollback']); return Promise.resolve(status); };
// What Settings → General asks for on load; nothing here is about the preview.
export const getConfig = () => Promise.resolve(null);
export const getSecrets = () => Promise.resolve({ detected: [], notes: {} });
export const backupStatus = () => Promise.resolve(null);
export const checkUpdate = () => Promise.resolve({ ok: true });
export const getCliUpdate = () => Promise.resolve(null);
export const getPushKey = () => Promise.resolve({ publicKey: '', devices: 0 });
`);

await build({
  stdin: {
    resolveDir: WEB, loader: 'tsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import DevPreviewBar from './src/components/DevPreviewBar.tsx';
      import DevPreviewPanel from './src/components/DevPreviewPanel.tsx';
      import SettingsShell from './src/components/SettingsShell.tsx';
      import SettingsView from './src/components/SettingsView.tsx';
      const main = { kind: 'main', label: 'main', id: 'image', prs: [] };
      const stack = { kind: 'prs', label: '#190 bbbbbbb + #182 aaaaaaa', id: 'rel-2', base: '${M}', prs: [{ number: 190, sha: '${B}' }, { number: 182, sha: '${A}' }] };
      const one = { kind: 'prs', label: '#182 aaaaaaa', id: 'rel-1', base: '${M}', prs: [{ number: 182, sha: '${A}' }] };
      const sum = (running, job = null) => ({ repo: 'huggingface/agent-manager', supervised: true, restartPending: false, next: null, running, selected: { prs: [] }, job, crashed: null });
      window.__render = (which) => {
        // One mounted tree at a time: an earlier row's timers must not keep polling.
        window.__root?.unmount();
        const root = document.getElementById('root');
        root.innerHTML = '';
        const r = window.__root = createRoot(root);
        const bar = (summary) => <div className="sidebar" style={{ width: 260 }}><DevPreviewBar summary={summary} onOpenSettings={() => { window.__opened = (window.__opened || 0) + 1; }} /></div>;
        if (which === 'none') r.render(<div id="x">{bar(undefined)}</div>);
        if (which === 'main') r.render(bar(sum(main)));
        if (which === 'stack') r.render(bar(sum(stack, { kind: 'switch', state: 'running', step: 'build web' })));
        if (which === 'one') r.render(bar(sum(one)));
        if (which === 'pending') r.render(bar({ ...sum(main), restartPending: true, next: { ...stack, label: '#190 bbbbbbb + #182 aaaaaaa' } }));
        const general = (info) => <SettingsShell page="general" onPage={() => {}} onClose={() => {}}>
          <SettingsView page="general" onClose={() => {}} theme="light" onToggleTheme={() => {}} clis={[]} info={info} />
        </SettingsShell>;
        if (which === 'general-off') r.render(general({ dataDir: '/data' }));
        if (which === 'general-on') r.render(general({ dataDir: '/data', devPreview: sum(main) }));
        if (which === 'shell-on') r.render(<SettingsShell page="general" onPage={() => {}} onClose={() => {}}><DevPreviewPanel /></SettingsShell>);
      };
    `,
  },
  outfile: bundle, bundle: true, format: 'iife', platform: 'browser', logLevel: 'error',
  // Both the shared api module and the lazy dev-preview calls resolve to the stub.
  plugins: [{ name: 'stub-api', setup(b) { b.onResolve({ filter: /(^|\/)\.\.?\/(api|lib\/devPreviewApi)$/ }, () => ({ path: stub })); } }],
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
    assert.deepEqual(options, ['main', '#182 Security: keep edge s…', '#190 Cron tweaks']);
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
  await check('Settings → General has the Dev preview section only on a preview Space, and no extra tab', async () => {
    await render('general-off');
    await page.getByRole('heading', { name: 'General' }).waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.getByTestId('dev-preview-section').count(), 0);
    await render('general-on');
    await page.getByTestId('dev-preview-section').waitFor();
    // the panel arrives on demand inside it
    await page.locator('[data-testid="dev-preview-section"] [data-testid="dev-preview-running"]').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Preview', exact: true }).count(), 0, 'no separate tab');
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

    assert.match(await fork.innerText(), /not allowed: its author outsider has read permission/);
    assert.match(await page.getByTestId('dev-preview-pr-182').innerText(), /ana \(admin\) · huggingface\/agent-manager/);
    // even a maintainer's own fork: listed, flagged, refused
    const own = page.getByTestId('dev-preview-pr-192');
    assert.equal(await own.locator('input').isDisabled(), true);
    assert.match(await own.innerText(), /cy \(maintain\) · fork: cy\/agent-manager/);
    assert.match(await own.innerText(), /not allowed: its branch is on a fork/);
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
  // ---- Pull latest, in the panel ----
  const A2 = '1'.repeat(40), M2 = '3'.repeat(40);
  const one = { kind: 'prs', label: '#182 aaaaaaa', id: 'rel-1', base: M, prs: [{ number: 182, sha: A }] };
  const stack = { kind: 'prs', label: '#190 bbbbbbb + #182 aaaaaaa', id: 'rel-2', base: M, prs: [{ number: 190, sha: B }, { number: 182, sha: A }] };
  const pullBtn = () => page.getByTestId('dev-preview-pull');
  const fresh = () => page.getByTestId('dev-preview-fresh').innerText();
  const showPanel = async (running) => {
    await page.evaluate((r) => { window.__calls.length = 0; window.__setStatus({ job: null, log: [], running: r }); }, running);
    await render('shell-on');
    await page.waitForSelector('.devpv-prs li');
  };
  await check('Pull latest is offered only for a PR build; on main there is no button', async () => {
    await page.evaluate(() => window.__resetPrs());
    await showPanel({ kind: 'main', label: 'main', id: 'image', image: true, prs: [] });
    assert.equal(await pullBtn().count(), 0);
    assert.equal(await page.getByTestId('dev-preview-fresh').count(), 0);
  });
  await check('nothing moved: Pull latest is disabled and says up to date', async () => {
    await page.evaluate(() => window.__resetPrs());
    await showPanel(one);
    assert.equal(await pullBtn().isDisabled(), true);
    assert.match(await fresh(), /^Up to date with #182 and main\.$/);
    assert.equal(await page.getByRole('button', { name: 'Roll back to main' }).isDisabled(), false);
  });
  await check('a moved PR enables Pull latest; it asks first, then posts the running PRs in order without SHAs', async () => {
    await page.evaluate((sha) => { window.__resetPrs(); window.__prs.prs.find((p) => p.number === 182).sha = sha; }, A2);
    await showPanel(stack);
    assert.equal(await pullBtn().isDisabled(), false);
    assert.match(await fresh(), /#182 has new commits \(now 1111111\)/);
    assert.doesNotMatch(await fresh(), /#190|main moved/);
    page.once('dialog', (d) => d.dismiss());
    await pullBtn().click();
    assert.deepEqual(await page.evaluate(() => window.__calls), [], 'declined: nothing sent');
    let said = '';
    page.once('dialog', (d) => { said = d.message(); d.accept(); });
    await pullBtn().click();
    await page.waitForFunction(() => window.__calls.length > 0);
    // the stack's order (#190 first), not the list's or the moved PR's; no sha key at all
    assert.deepEqual(await page.evaluate(() => window.__calls), [['switch', [{ number: 190 }, { number: 182 }]]]);
    assert.match(said, /Run these PRs on this Space\?/);
    assert.match(said, /#190 by bo \(write permission\).*\n#182 by ana \(admin permission\)/s);
    assert.match(said, /secrets, bucket and agents/);
  });
  await check('main moving alone is also something to pull', async () => {
    await page.evaluate((sha) => { window.__resetPrs(); window.__prs.main.sha = sha; }, M2);
    await showPanel(one);
    assert.equal(await pullBtn().isDisabled(), false);
    assert.match(await fresh(), /^main moved to 3333333$/);
  });
  await check('a running PR that is closed or merged: no pull, the hint is to roll back', async () => {
    await page.evaluate((sha) => { window.__resetPrs(); window.__prs.prs = window.__prs.prs.filter((p) => p.number !== 182); window.__prs.main.sha = sha; }, M2);
    await showPanel(one);
    assert.equal(await pullBtn().isDisabled(), true);
    assert.match(await fresh(), /#182 is merged or closed, so there is nothing to pull\. Roll back to main/);
    assert.equal(await page.getByRole('button', { name: 'Roll back to main' }).isDisabled(), false);
  });
  await check('a running PR the server now refuses: no pull, and why', async () => {
    await page.evaluate((sha) => { window.__resetPrs(); Object.assign(window.__prs.prs.find((p) => p.number === 182), { sha, allowed: false, permission: 'read', refusal: 'its author ana has read permission on huggingface/agent-manager, not write, maintain or admin' }); }, A2);
    await showPanel(one);
    assert.equal(await pullBtn().isDisabled(), true);
    assert.match(await fresh(), /#182 can no longer be previewed: its author ana has read permission/);
  });
  await check('phone width: no sideways page scroll', async () => {
    // with the Pull latest line showing, and a stack's longest running label
    await page.evaluate((sha) => { window.__resetPrs(); window.__prs.prs.find((p) => p.number === 182).sha = sha; window.__prs.prs.find((p) => p.number === 190).sha = sha; }, A2);
    await page.evaluate(() => window.__setStatus({ job: null, log: [] }));
    await showPanel(stack);
    await page.setViewportSize({ width: 390, height: 900 });
    const over = await page.evaluate(() => document.querySelector('.settings-main').scrollWidth - document.querySelector('.settings-main').clientWidth);
    assert.ok(over <= 0, `overflow ${over}px`);
  });

  // ---- Pull latest, in the sidebar row: a page of its own with a fake clock,
  // so the 60 s refresh runs on demand. A fresh bundle also makes the PR
  // build the one this tab "loaded", so no reload hint shares the note.
  const clocked = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await clocked.clock.install();
  await clocked.setContent(`<style>${css}</style><div id="root"></div>`);
  await clocked.addScriptTag({ path: bundle });
  await check('the sidebar row re-reads the PR list every minute and on focus, and offers "pull latest"', async () => {
    const reads = () => clocked.evaluate(() => window.__prsReads);
    await clocked.evaluate(() => window.__render('one'));
    await clocked.waitForFunction(() => document.querySelectorAll('#devpv-pick option').length > 1);
    // the one running PR is its own entry, and nothing is newer yet
    assert.equal(await clocked.getByTestId('dev-preview-pick').inputValue(), 'pr:182');
    assert.equal(await clocked.getByTestId('dev-preview-note').count(), 0);
    const before = await reads();
    await clocked.evaluate((sha) => { window.__prs.prs.find((p) => p.number === 182).sha = sha; }, A2);
    await clocked.clock.runFor(30_000);
    assert.equal(await reads(), before, 'not before the minute is up');
    await clocked.clock.runFor(30_000);
    await clocked.getByTestId('dev-preview-pull-link').waitFor();
    assert.equal(await reads(), before + 1);
    assert.equal(await clocked.getByTestId('dev-preview-note').innerText(), '#182 has new commits · pull latest');
    // still recognised as the running PR although its head moved; picking it again does nothing
    assert.equal(await clocked.getByTestId('dev-preview-pick').inputValue(), 'pr:182');
    // focus re-reads too: now main has moved as well
    await clocked.evaluate((sha) => { window.__prs.main.sha = sha; window.dispatchEvent(new Event('focus')); }, M2);
    await clocked.waitForFunction(() => /and main have new commits/.test(document.querySelector('[data-testid="dev-preview-note"]')?.textContent || ''));
    assert.equal(await reads(), before + 2);
  });
  await check('the sidebar row offers nothing when the running PR is closed, and keeps the list when a read fails', async () => {
    await clocked.evaluate(() => { window.__resetPrs(); window.__render('one'); });
    await clocked.waitForFunction(() => document.querySelectorAll('#devpv-pick option').length > 1);
    await clocked.evaluate(() => { window.__prs.prs = window.__prs.prs.filter((p) => p.number !== 182); window.__prs.main.sha = '3'.repeat(40); });
    await clocked.clock.runFor(60_000);
    await clocked.waitForFunction(() => document.getElementById('devpv-pick')?.value === 'running');
    assert.equal(await clocked.getByTestId('dev-preview-pull-link').count(), 0);
    // GitHub down: the dropdown keeps what it had rather than emptying
    const options = await clocked.locator('#devpv-pick option').allInnerTexts();
    const n = await clocked.evaluate(() => { window.__prs = { ok: false, error: 'rate limited' }; return window.__prsReads; });
    await clocked.clock.runFor(60_000);
    await clocked.waitForFunction((k) => window.__prsReads > k, n);
    assert.deepEqual(await clocked.locator('#devpv-pick option').allInnerTexts(), options);
  });
  await check('the sidebar row\'s "pull latest" sends the panel\'s request, behind the same confirmation', async () => {
    await clocked.evaluate((sha) => { window.__resetPrs(); window.__prs.prs.find((p) => p.number === 182).sha = sha; window.__render('one'); }, A2);
    await clocked.getByTestId('dev-preview-pull-link').waitFor();
    await clocked.evaluate(() => { window.__calls.length = 0; });
    clocked.once('dialog', (d) => d.dismiss());
    await clocked.getByTestId('dev-preview-pull-link').click();
    assert.deepEqual(await clocked.evaluate(() => window.__calls), [], 'declined: nothing sent');
    let said = '';
    clocked.once('dialog', (d) => { said = d.message(); d.accept(); });
    await clocked.getByTestId('dev-preview-pull-link').click();
    await clocked.waitForFunction(() => window.__calls.length > 0);
    assert.deepEqual(await clocked.evaluate(() => window.__calls), [['switch', [{ number: 182 }]]]);
    assert.match(said, /#182 by ana \(admin permission\), branch on huggingface\/agent-manager/);
  });
  await clocked.close();
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failures) { console.log(`# ${failures} failed`); process.exit(1); }
console.log('# all passed');
