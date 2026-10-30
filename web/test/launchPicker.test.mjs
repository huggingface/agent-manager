// The model / effort selects of the quick create panel (LaunchPicker.tsx), in
// the real app over the fixture server. /api/clis, /api/launch-options and
// session creation are answered in the browser, so no agent is ever launched.
//
//   - a catalog still being built on first open fills in by itself, the
//     refresh control is there while a list is empty, and reopening the panel
//     asks again
//   - removing the last attachment and then changing the choice creates a new
//     session with the new choice, not the one prepared for the attachment
//   - a refresh that drops the chosen model, or only the chosen effort, clears
//     it: what is submitted is what is shown
// Run with:  node test/launchPicker.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
import { startFixtureServer, buildWeb } from './helpers/fixture-server.mjs';

let failed = 0;
let last = null;
const check = async (what, fn) => {
  try { await fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    if (process.env.DBG && last) {
      console.log(last.s.log.join('\n'));
      console.log(await last.page.locator('.quick-cli.on').evaluateAll((e) => e.map((x) => x.title)).catch(() => 'x'));
      console.log(await last.page.evaluate(() => document.body.innerText.slice(0, 1500)).catch(() => 'x'));
    }
    console.log(`  FAIL ${what}\n       ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n       ')}`);
  }
};

const FULL = { refreshing: false, clis: [
  { id: 'claude', model: true, models: [{ id: 'opus' }, { id: 'sonnet' }], efforts: ['low', 'high'], perModelEfforts: false },
  { id: 'codex', model: true, perModelEfforts: true, efforts: null, models: [
    { id: 'gpt-5.5', efforts: ['low', 'high', 'xhigh'] }, { id: 'gpt-6-astra', efforts: ['ultra'] }] },
] };
const COLD = { refreshing: true, clis: FULL.clis.map((c) => ({ ...c, model: false, models: [] })) };
const withCodex = (models) => ({ ...FULL, clis: FULL.clis.map((c) => (c.id === 'codex' ? { ...c, models } : c)) });

const dist = buildWeb(spawnSync, 'am-launch-picker-dist-');
const server = await startFixtureServer({ publicDir: dist, tag: 'am-launch-picker-' });
const browser = await chromium.launch(chromiumLaunchOptions());
const CLIS = (await (await fetch(`${server.origin}/api/clis`)).json()).map((c) => ({ ...c, available: true, ready: true,
  launch: c.id === 'claude' || c.id === 'codex' ? { model: true, effort: true } : { model: false, effort: false } }));

async function open(initial) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const s = { options: initial, gets: 0, creates: [], inputs: [], n: 0, log: [] };
  last = { page, s };
  page.on('request', (r) => { if (r.url().includes('/api/')) s.log.push(r.url().replace(server.origin, '')); });
  page.on('console', (m) => { if (m.type() === 'error') s.log.push(`console: ${m.text().slice(0, 300)}`); });
  // Served from memory: a pass-through to the server can lose a busy run its
  // only /api/clis, and the panel then has no CLI to pick.
  await page.route('**/api/clis', (route) => route.fulfill({ json: CLIS }));
  await page.route('**/api/launch-options', (route) => { s.gets++; return route.fulfill({ json: s.options }); });
  await page.route('**/api/launch-options/refresh', (route) => route.fulfill({ json: s.options }));
  await page.route('**/api/sessions', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    const id = `picked-${++s.n}`;
    s.creates.push({ id, ...body });
    return route.fulfill({ status: 201, json: { id, name: id, path: '.', cli: body.cli || 'claude', state: 'stopped', ...body } });
  });
  await page.route('**/api/sessions/picked-*/attachments', (route) => route.fulfill({ json: { id: 'file-1', name: 'a.txt', mime: 'text/plain', size: 5, path: 'a.txt' } }));
  await page.route('**/api/sessions/picked-*/attachments/*', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/sessions/picked-*/input*', (route) => {
    s.inputs.push(route.request().url());
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(server.origin);
  return { ctx, page, s };
}
const panel = (page) => page.locator('[title="New agent or group"]').click();
const model = (page) => page.getByLabel('Model', { exact: true });
// The picker is a lazy chunk; selectOption waits for it like any element.
const effort = (page) => page.getByLabel('Reasoning effort', { exact: true });
const refresh = (page) => page.getByLabel('Refresh model lists', { exact: true });
const codex = (page) => page.locator('.quick-cli[title^="Codex"]').click();

try {
  await check('a cold catalog fills in by itself; refresh stays reachable; reopening asks again', async () => {
    const { ctx, page, s } = await open(COLD);
    await panel(page);
    await refresh(page).waitFor();
    assert.equal(await model(page).isDisabled(), true);
    assert.match(await model(page).locator('option').first().textContent(), /listing/);
    await codex(page);
    await refresh(page).waitFor();
    s.options = FULL;
    // No click: the picker keeps asking while the server says it is building.
    await page.locator('option[value="gpt-5.5"]').waitFor({ state: 'attached', timeout: 10_000 });
    assert.equal(await model(page).isDisabled(), false);
    const before = s.gets;
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await panel(page);
    await model(page).waitFor();
    await page.waitForTimeout(300);
    assert.ok(s.gets > before, 'reopening the panel revalidates');
    await ctx.close();
  });

  await check('changing the choice after an attachment prepared a session starts a new one', async () => {
    const { ctx, page, s } = await open(FULL);
    await panel(page);
    await model(page).selectOption('opus');
    await effort(page).selectOption('high');
    await page.locator('textarea.quick-prompt').evaluate((el) => {
      const data = new DataTransfer();
      data.items.add(new File(['hello'], 'a.txt', { type: 'text/plain' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.getByRole('button', { name: 'Remove a.txt', exact: true }).waitFor();
    for (let i = 0; i < 50 && !s.creates.length; i++) await page.waitForTimeout(100);
    assert.equal(s.creates.length, 1, 'the attachment prepared a session');
    assert.equal(s.creates[0].model, 'opus');
    await page.getByRole('button', { name: 'Remove a.txt', exact: true }).click();
    assert.equal(await model(page).isDisabled(), false);
    await model(page).selectOption('sonnet');
    await effort(page).selectOption('low');
    await page.locator('textarea.quick-prompt').fill('hello');
    await page.getByRole('button', { name: 'Create & send', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('textarea.quick-prompt'));
    const last = s.creates.at(-1);
    assert.equal(s.creates.length, 2, 'a new session, not the prepared one');
    assert.deepEqual([last.model, last.effort, last.prompt], ['sonnet', 'low', 'hello'], 'created with the prompt');
    assert.deepEqual(s.inputs, [], 'nothing typed into the session prepared for opus');
    await ctx.close();
  });

  await check('a refresh that drops the chosen model clears model and effort', async () => {
    const { ctx, page, s } = await open(FULL);
    await panel(page);
    await codex(page);
    await model(page).selectOption('gpt-6-astra');
    await effort(page).selectOption('ultra');
    s.options = withCodex([FULL.clis[1].models[0]]);
    await refresh(page).click();
    await page.waitForFunction(() => !document.querySelector('option[value="gpt-6-astra"]'));
    assert.equal(await model(page).inputValue(), '');
    assert.equal(await effort(page).inputValue(), '');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('textarea.quick-prompt'));
    const last = s.creates.at(-1);
    assert.equal(last.model, undefined);
    assert.equal(last.effort, undefined);
    await ctx.close();
  });

  await check('a refresh that drops only the chosen effort clears the effort and keeps the model', async () => {
    const { ctx, page, s } = await open(FULL);
    await panel(page);
    await codex(page);
    await model(page).selectOption('gpt-5.5');
    await effort(page).selectOption('xhigh');
    s.options = withCodex([{ id: 'gpt-5.5', efforts: ['low', 'high'] }, FULL.clis[1].models[1]]);
    await refresh(page).click();
    await page.waitForFunction(() => !document.querySelector('option[value="xhigh"]'));
    assert.equal(await model(page).inputValue(), 'gpt-5.5');
    assert.equal(await effort(page).inputValue(), '');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('textarea.quick-prompt'));
    const last = s.creates.at(-1);
    assert.equal(last.model, 'gpt-5.5');
    assert.equal(last.effort, undefined);
    await ctx.close();
  });
} finally {
  await browser.close();
  await server.stop();
}
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
