// The Cron Settings contract in a real browser: labelled controls, correct
// request construction, distinct actions, plain-text state, and phone overflow.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-settings-'));
const bundle = path.join(tmp, 'app.js');
const stub = path.join(tmp, 'api-stub.ts');
fs.writeFileSync(stub, `
export * from ${JSON.stringify(path.join(WEB, 'src/api.ts'))};
let jobs = [{
  id: 'cron_one', name: 'morning check', agent: { name: 'triage', cli: 'codex' }, prompt: 'Check.',
  schedule: { cron: '0 9 * * *', tz: 'Europe/Zurich' }, runOnRestart: true,
  state: 'running', createdAt: '2026-08-19T00:00:00Z', updatedAt: '2026-08-19T00:00:00Z',
  next: '2026-08-20T07:00:00Z', last: { at: '2026-08-19T07:00:00Z', status: 'ok', durationMs: 258 },
}];
window.__cronCalls = [];
export const getCrons = () => Promise.resolve({ crons: structuredClone(jobs) });
export const getTree = () => Promise.resolve({ order: [], groups: [], hidden: [], sessions: [] });
export const createCron = (draft) => { window.__cronCalls.push(['create', structuredClone(draft)]); jobs.push({ ...draft, id: 'cron_new', state: 'running', next: '2026-08-21T07:00:00Z', createdAt: '', updatedAt: '' }); return Promise.resolve(jobs.at(-1)); };
export const updateCron = (id, patch) => { window.__cronCalls.push(['update', id, structuredClone(patch)]); jobs = jobs.map((job) => job.id === id ? { ...job, ...patch, next: patch.state === 'stopped' ? null : job.next } : job); return Promise.resolve(jobs.find((job) => job.id === id)); };
export const runCron = (id) => { window.__cronCalls.push(['run', id]); return Promise.resolve({ ok: true, agentCreated: false }); };
export const deleteCron = (id) => { window.__cronCalls.push(['delete', id]); jobs = jobs.filter((job) => job.id !== id); return Promise.resolve({ ok: true }); };
export const getConfig = () => Promise.resolve(null);
export const getSecrets = () => Promise.resolve({ detected: [], notes: {} });
export const backupStatus = () => Promise.resolve(null);
export const checkUpdate = () => Promise.resolve({ ok: true });
`);

await build({
  stdin: {
    resolveDir: WEB, loader: 'tsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import SettingsView from './src/components/SettingsView.tsx';
      const clis = [
        { id: 'shell', label: 'Shell', color: '#888', available: true },
        { id: 'files', label: 'Files', color: '#888', available: true },
        { id: 'trace', label: 'Trace', color: '#888', available: true },
        { id: 'remote', label: 'Remote agent', color: '#888', available: true },
        { id: 'claude', label: 'Claude Code', color: '#d97757', available: true },
        { id: 'codex', label: 'Codex', color: '#5eb6a6', available: false },
      ];
      createRoot(document.getElementById('root')).render(
        <SettingsView page="cron" onPage={() => {}} onClose={() => {}} theme="light"
          onToggleTheme={() => {}} clis={clis} info={{ dataDir: '/data' }} />,
      );
    `,
  },
  outfile: bundle, bundle: true, format: 'iife', platform: 'browser', logLevel: 'error',
  plugins: [{ name: 'stub-api', setup(b) { b.onResolve({ filter: /(^|\/)\.\.?\/api$/ }, () => ({ path: stub })); } }],
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.addScriptTag({ path: bundle });
  await page.waitForSelector('.cron-table tbody tr');

  assert.equal(await page.getByRole('button', { name: 'Codex' }).isDisabled(), true,
    'unavailable CLI remains visible but cannot be selected');
  assert.equal(await page.locator('.cron-clis button').count(), 2,
    'the picker is the CLI catalog minus shell/files/trace/remote');
  for (const label of ['Job name', 'Agent name', 'Prompt']) {
    assert.ok(await page.getByLabel(label, { exact: true }).count(), `${label} has an accessible label`);
  }

  const stateStyle = await page.locator('.cron-state').evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, radius: style.borderRadius, color: style.color };
  });
  assert.equal(stateStyle.background, 'rgba(0, 0, 0, 0)', 'state is text, not a badge fill');
  assert.equal(stateStyle.radius, '0px', 'state is text, not a rounded pill');

  const overflow = await page.evaluate(() => {
    const main = document.querySelector('.settings-main');
    const table = document.querySelector('.cron-table-wrap');
    return {
      page: main.scrollWidth - main.clientWidth,
      table: table.scrollWidth - table.clientWidth,
      stacked: document.querySelector('#cron-job-name').getBoundingClientRect().top
        >= document.querySelector('label[for="cron-job-name"]').getBoundingClientRect().bottom,
    };
  });
  assert.equal(overflow.page, 0, 'wide job table does not make the phone page scroll sideways');
  assert.ok(overflow.table > 0, 'the table owns its horizontal overflow');
  assert.equal(overflow.stacked, true, 'phone form control sits below its label');

  const firstRow = page.locator('.cron-table tbody tr').filter({ hasText: 'morning check' });
  const compactRow = await firstRow.evaluate((row) => {
    const cells = [...row.querySelectorAll('td')];
    const buttons = [...row.querySelectorAll('button')];
    return {
      height: row.getBoundingClientRect().height,
      noWrap: cells.every((cell) => getComputedStyle(cell).whiteSpace === 'nowrap'),
      typeText: cells[2].textContent.trim(),
      interval: cells[3].textContent.trim(),
      last: cells[6].textContent.trim(),
      buttonsFit: buttons.every((button) => button.scrollWidth <= button.clientWidth),
      buttonBorders: buttons.map((button) => getComputedStyle(button).borderTopStyle),
    };
  });
  assert.ok(compactRow.height < 40, `job row stays on one line at phone width (${compactRow.height}px)`);
  assert.equal(compactRow.noWrap, true, 'every retained column is pinned to one line');
  assert.equal(compactRow.typeText, '', 'type column is icon-only');
  assert.equal(compactRow.interval, 'every day 09:00', 'interval omits timezone and restart detail');
  assert.match(compactRow.last, /^ok 258ms · 19 Aug 09:00$/, 'last run uses the dense date');
  assert.equal(compactRow.buttonsFit, true, 'action labels are not clipped');
  assert.deepEqual(compactRow.buttonBorders, ['solid', 'solid', 'solid'], 'actions use button controls, not text links');

  await page.getByLabel('Job name', { exact: true }).fill('weekday digest');
  await page.getByLabel('Agent name', { exact: true }).fill('digest-agent');
  await page.getByLabel('Prompt', { exact: true }).fill('Summarize yesterday.');
  await page.getByRole('button', { name: 'Weekdays' }).click();
  await page.locator('input[type="time"]').fill('14:25');
  await page.getByLabel('timezone').fill('America/New_York');
  await page.getByRole('button', { name: 'No', exact: true }).click();
  await page.getByRole('button', { name: 'Create job' }).click();
  await page.waitForFunction(() => window.__cronCalls.some((call) => call[0] === 'create'));
  const created = await page.evaluate(() => window.__cronCalls.find((call) => call[0] === 'create')[1]);
  assert.deepEqual(created, {
    name: 'weekday digest', agent: { name: 'digest-agent', cli: 'claude' }, prompt: 'Summarize yesterday.',
    schedule: { cron: '25 14 * * 1-5', tz: 'America/New_York' }, runOnRestart: false,
  });

  const row = page.locator('.cron-table tbody tr').filter({ hasText: 'morning check' });
  await row.click();
  await page.getByRole('button', { name: 'Update job' }).waitFor();
  assert.equal(await page.getByLabel('Job name', { exact: true }).inputValue(), 'morning check');
  assert.equal(await page.getByLabel('Agent name', { exact: true }).inputValue(), 'triage');
  assert.equal(await page.getByLabel('Prompt', { exact: true }).inputValue(), 'Check.');
  assert.equal(await page.locator('input[type="time"]').inputValue(), '09:00');
  assert.equal(await page.getByLabel('timezone').inputValue(), 'Europe/Zurich');
  assert.equal(await page.getByRole('button', { name: 'Every day' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('button', { name: 'Yes', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('button', { name: 'Codex' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('button', { name: 'Update job' }).isDisabled(), false,
    'an unavailable saved CLI is preserved without blocking edits to the other fields');

  await page.getByLabel('Prompt', { exact: true }).fill('Check and summarize.');
  await page.getByRole('button', { name: 'Weekly' }).click();
  await page.locator('input[type="time"]').fill('10:15');
  await page.locator('.cron-schedule-fields select').selectOption('4');
  await page.getByLabel('timezone').fill('Asia/Tokyo');
  await page.getByRole('button', { name: 'No', exact: true }).click();
  await page.getByRole('button', { name: 'Update job' }).click();
  await page.waitForFunction(() => window.__cronCalls.some((call) => call[0] === 'update' && call[2].prompt));
  const edited = await page.evaluate(() => window.__cronCalls.find((call) => call[0] === 'update' && call[2].prompt));
  assert.deepEqual(edited, ['update', 'cron_one', {
    name: 'morning check', agent: { name: 'triage', cli: 'codex' }, prompt: 'Check and summarize.',
    schedule: { cron: '15 10 * * 4', tz: 'Asia/Tokyo' }, runOnRestart: false,
  }], 'row selection round-trips every persisted field through PUT');
  assert.equal(await page.getByRole('button', { name: 'Create job' }).isVisible(), true, 'successful update returns the form to create mode');

  await row.getByRole('button', { name: 'Run now' }).click();
  assert.equal(await page.getByRole('button', { name: 'Create job' }).isVisible(), true, 'an action click does not also select the row');
  await row.getByRole('button', { name: 'Stop' }).click();
  await page.waitForFunction(() => window.__cronCalls.some((call) => call[0] === 'update' && call[2].state));
  const actions = await page.evaluate(() => window.__cronCalls.map((call) => call[0]));
  assert.ok(actions.includes('run') && actions.includes('update'), 'Run now and Stop are separate wired actions');
  await row.getByRole('button', { name: 'Delete' }).click();
  await page.waitForFunction(() => window.__cronCalls.some((call) => call[0] === 'delete'));
  assert.ok((await page.evaluate(() => window.__cronCalls)).some((call) => call[0] === 'delete' && call[1] === 'cron_one'));

  await page.close();
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('cron settings: form, catalog, actions, state treatment, and phone overflow agree');
