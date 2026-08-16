// The settings page on a phone, in a real browser.
//
// Two things here are invariants rather than taste, and both were reported by
// the operator ("all over the place on mobile", "the backup now button should
// be below the time options"):
//
//   1. ONE horizontal gutter. The header, the section tabs and the page body
//      start on the same rail. This is easy to break by accident because two
//      elements can each contribute padding — `.main` gives every pane 12px and
//      `.settings-page` adds its own — and the result is not a broken layout,
//      just a body sitting 12px inside its own chrome, which is exactly the
//      "not nicely aligned" that was reported.
//   2. In a narrow pane a setting's control sits UNDER its label, and at desktop
//      width it is back beside it. The stacking comes from a container query on
//      the pane, so a change to the pane's width or padding can silently move
//      the breakpoint.
//
// Plus the backup section's reading order: intervals → cost note → Back up now.
//
// The real SettingsView against a stubbed api module, so the fixture can hold
// the states worth measuring (backup enabled with a token, a full skip list).
// Run with:  node test/settingsMobile.test.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-mobile-'));
const bundle = path.join(tmp, 'app.js');

// `export *` first, then the overrides: the named exports below win, and
// everything else (whatever SkillsEditor/UsagePanel import) still resolves.
const stub = path.join(tmp, 'api-stub.ts');
fs.writeFileSync(stub, `
export * from ${JSON.stringify(path.join(WEB, 'src/api.ts'))};
const cfg = {
  artifacts: { enabled: true, space: 'me/artifacts', visibility: 'public' },
  jobs: { askAboveUsd: 5 },
  archive: { after: 'month' },
  revive: { enabled: true, days: 3 },
  backup: { every: '1h', dataset: 'me/backup', exclude: ['node_modules', '.venv', '__pycache__', 'dist'] },
};
const bk = {
  every: '1h', source: '/data', staging: '/tmp/s', dataset: 'me/backup',
  defaults: { dataset: 'me/backup', staging: '/tmp/s' },
  hasToken: true, canRunNow: true, running: false, unavailable: null,
  last: { at: 1, jobId: 'j', stage: 'done' }, jobName: 'backup', jobsUrl: 'https://example.invalid',
  exclude: cfg.backup.exclude, excludeDefaults: cfg.backup.exclude, excludeIsDefault: true,
  health: null, failures: 0, lastFailure: null, lastSuccessAt: 1, nextDue: 2,
  datasetPrivate: true, error: null,
};
export const getConfig = () => Promise.resolve(structuredClone(cfg));
export const saveConfig = () => Promise.resolve({ ok: true });
export const backupStatus = () => Promise.resolve(structuredClone(bk));
export const runBackup = () => Promise.resolve({ job: 'j2' });
export const getSecrets = () => Promise.resolve({ detected: ['HF_TOKEN'], notes: { HF_TOKEN: 'Hub access.' } });
export const saveSecrets = () => Promise.resolve({ ok: true });
export const checkUpdate = () => Promise.resolve({ ok: true, canUpdate: false, behind: false, current: 'abc1234' });
export const runUpdate = () => Promise.resolve({ ok: true });
export const relaunchSpace = () => Promise.resolve({ ok: true });
export const getPushKey = () => Promise.resolve({ publicKey: '' });
export const subscribePush = () => Promise.resolve({ ok: true });
export const unsubscribePush = () => Promise.resolve({ ok: true });
export const sendTestNotification = () => Promise.resolve({ sent: 0 });
`);

await build({
  stdin: {
    resolveDir: WEB,
    loader: 'tsx',
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import SettingsView from './src/components/SettingsView.tsx';

      const clis = [
        { id: 'claude', label: 'Claude Code', color: '#d97757', available: true, ready: true, version: '2.1.232' },
        { id: 'gemini', label: 'Gemini CLI', color: '#4796e3', available: true, ready: false, version: '0.55.1', setup: 'Sign in once.' },
      ];
      const info = { dataDir: '/data', home: '/data/home', spaceId: 'me/space', ghostty: true, canRelaunch: true };
      createRoot(document.getElementById('root')).render(
        <SettingsView page="general" onPage={() => {}} onClose={() => {}}
          theme="light" onToggleTheme={() => {}} clis={clis} info={info}
          onShowWelcome={() => {}} demoMode={false} onToggleDemo={() => {}} />,
      );
    `,
  },
  outfile: bundle,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  logLevel: 'error',
  plugins: [{
    name: 'stub-api',
    setup(b) { b.onResolve({ filter: /(^|\/)\.\.?\/api$/ }, () => ({ path: stub })); },
  }],
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const browser = await chromium.launch(chromiumLaunchOptions());
const open = async (width) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.addScriptTag({ path: bundle });
  await page.waitForFunction(() => !!document.querySelector('.tagf'));   // backup section painted
  return page;
};

try {
  for (const width of [320, 390]) {
    const page = await open(width);
    const m = await page.evaluate(() => {
      const left = (sel) => {
        const el = document.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().left) : null;
      };
      const main = document.querySelector('.settings-main');
      const row = [...document.querySelectorAll('.setting-row')].find((r) => r.querySelector('.cfg-ctl'));
      const label = row.querySelector('.s-label').getBoundingClientRect();
      const ctl = row.querySelector('.cfg-ctl').getBoundingClientRect();
      const order = [...document.querySelectorAll('.settings-page *')];
      const at = (el) => order.indexOf(el);
      return {
        back: left('.brand .icon-btn'),
        tab: left('.settings-navitem'),
        heading: left('.settings-page h2'),
        label: Math.round(label.left),
        control: Math.round(ctl.left),
        scroll: main.scrollWidth,
        client: main.clientWidth,
        stacked: ctl.top >= label.bottom,
        intervals: at([...document.querySelectorAll('.cfg-seg')].find((s) => s.textContent.includes('24h'))),
        cost: at(document.querySelector('.s-warn')),
        backup: at(document.querySelector('.bk-now')),
        skips: at(document.querySelector('.tagf')),
      };
    });

    console.log(`a phone at ${width}px`);
    check(`one gutter: back arrow, tabs, heading, label and control all start at x=${m.back}`,
      () => assert.deepEqual(
        { tab: m.tab, heading: m.heading, label: m.label, control: m.control },
        { tab: m.back, heading: m.back, label: m.back, control: m.back },
      ));
    check('nothing hangs past the scroller', () => assert.equal(m.scroll, m.client));
    check('a control sits under its label, not beside it', () => assert.ok(m.stacked));
    check('backup reads: intervals, then the cost note, then "Back up now", then the skip list',
      () => assert.ok(m.intervals < m.cost && m.cost < m.backup && m.backup < m.skips,
        `got ${JSON.stringify({ i: m.intervals, c: m.cost, b: m.backup, s: m.skips })}`));
    await page.close();
    console.log('');
  }

  // The stacking is a container query on the pane: at desktop width the two
  // columns must come back, or every row would be twice as tall for nothing.
  const page = await open(1200);
  const d = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.setting-row')].find((r) => r.querySelector('.cfg-ctl'));
    const label = row.querySelector('.s-label').getBoundingClientRect();
    const ctl = row.querySelector('.cfg-ctl').getBoundingClientRect();
    const main = document.querySelector('.settings-main');
    return { beside: ctl.top < label.bottom, right: Math.round(ctl.right), rowRight: Math.round(row.getBoundingClientRect().right), scroll: main.scrollWidth, client: main.clientWidth };
  });
  console.log('a desktop at 1200px');
  check('the control is beside its label again', () => assert.ok(d.beside));
  check('and still ends on the row\'s right rail', () => assert.ok(Math.abs(d.right - d.rowRight) <= 3, `${d.right} vs ${d.rowRight}`));
  check('nothing hangs past the scroller', () => assert.equal(d.scroll, d.client));
  await page.close();
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : '\nsettings-mobile: ok');
process.exit(failed ? 1 : 0);
