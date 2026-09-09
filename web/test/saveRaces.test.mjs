// Saving, when the answers come back out of order.
//
// Two policies share one contract here. Settings save IMMEDIATELY — no debounce,
// no blur, no close — and files stay explicit-save. What both must never do is
// let an older response speak for a newer edit: acknowledge it, clear its draft,
// or report "saved" over text that is still only in the buffer. That is lost
// work, and it is the reason this file exists.
//
// Deferred responses rather than timers: every race below is settled by
// resolving a specific request, so the order is the test's to choose.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'save-races-'));
const bundle = path.join(tmp, 'app.js');
const stub = path.join(tmp, 'api-stub.ts');

// Every write parks in `window.__net` until the test lets it finish.
fs.writeFileSync(stub, `
// Everything not named here keeps its real implementation, so a settings effect
// calling something this test never thought about fails like a fetch, not like
// a missing function.
export * from ${JSON.stringify(path.join(WEB, 'src/api.ts'))};
const net = { writes: [], configs: [], secrets: [] };
window.__net = net;
const park = (list, payload) => new Promise((resolve, reject) => {
  list.push({ ...payload, at: Date.now(), resolve, reject, settled: false });
});
export const previewFile = (_id, p) => Promise.resolve({
  kind: 'text', name: p.replace(/^.*\\//, ''), mime: 'text/plain',
  size: 5, mtime: 1, tag: 'tag-0', text: 'start',
});
export const rawUrl = () => 'data:text/plain,';
export const downloadUrl = () => '#';
export const writeFile = (_id, p, text, base) => park(net.writes, { path: p, text, base });
export const getFileTraceWindow = () => new Promise(() => {});
export const getFileTraceSummary = () => new Promise(() => {});

const baseConfig = {
  artifacts: { enabled: true, space: 'me/artifacts', visibility: 'private' },
  jobs: { askAboveUsd: 0 },
  archive: { after: 'month' },
  revive: { enabled: true, days: 3 },
  backup: { every: 'never', dataset: '', exclude: [] },
  defaultArtifactsSpace: 'me/agent-artifacts',
};
const state = { config: structuredClone(baseConfig), notes: { HF_TOKEN: '' } };
export const getConfig = () => Promise.resolve(structuredClone(state.config));
export const saveConfig = (c) => park(net.configs, { body: structuredClone(c) })
  .then((r) => { state.config = structuredClone(c); return r; });
export const getSecrets = () => Promise.resolve({ detected: ['HF_TOKEN'], notes: structuredClone(state.notes) });
export const saveSecrets = (notes) => park(net.secrets, { body: structuredClone(notes) })
  .then((r) => { state.notes = structuredClone(notes); return r; });
export const getTree = () => Promise.resolve({ order: [], groups: [], hidden: [], sessions: [] });
export const getCrons = () => Promise.resolve({ crons: [] });
export const backupStatus = () => new Promise(() => {});
export const checkUpdate = () => new Promise(() => {});
export const getSkills = () => Promise.resolve([]);
export const getUsage = () => new Promise(() => {});
`);

await build({
  stdin: {
    resolveDir: WEB,
    loader: 'tsx',
    contents: `
      import React, { useCallback, useEffect, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { FileView } from './src/components/FilesPane.tsx';
      import SettingsView from './src/components/SettingsView.tsx';
      import { recall } from './src/components/filesMemory.ts';

      function Harness() {
        const [showSettings, setShowSettings] = useState(true);
        const [showFile, setShowFile] = useState(true);
        const [filePath, setFilePath] = useState('/notes.txt');
        // The real pane holds what the viewer reports in state, which is what
        // makes a viewer that rebuilds its report every render a render loop.
        const [, setInfo] = useState(null);
        // Stable, the way the pane passes its own setter — an inline arrow here
        // would make this harness loop on its own and prove nothing.
        const onInfo = useCallback((info) => {
          window.__edit = info.edit;
          window.__infoCalls = (window.__infoCalls || 0) + 1;
          setInfo(info);
        }, []);
        useEffect(() => {
          window.__h = {
            setShowSettings, setShowFile, setFilePath,
            draft: (id) => recall(id).draft,
          };
        }, []);
        return <div>
          {showFile && (
            <div className="files-view">
              <FileView sessionId="files-1" path={filePath} zoom={100} raw={false} scripts={false}
                onInfo={onInfo} />
            </div>
          )}
          {showSettings && (
            <SettingsView page="general" onPage={() => {}} onClose={() => setShowSettings(false)}
              theme="light" onToggleTheme={() => {}} clis={[]} info={{ dataDir: '/data' }} />
          )}
        </div>;
      }
      createRoot(document.getElementById('root')).render(<Harness />);
    `,
  },
  outfile: bundle,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  logLevel: 'error',
  plugins: [{ name: 'stub-api', setup(b) {
    b.onResolve({ filter: /(^|\/)\.\.?\/api$/ }, () => ({ path: stub }));
  } }],
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${String(e.message).split('\n')[0]}`);
  }
};

console.log('[phase] bundled');
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
page.on('crash', () => console.log('[phase] RENDERER CRASH'));
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200)); });
console.log('[phase] browser up');
const net = (kind) => page.evaluate((k) => window.__net[k].map((r) => ({
  path: r.path, text: r.text, base: r.base, body: r.body, settled: r.settled, at: r.at,
})), kind);
// Tolerant on purpose: when a bug swallows a request the test should report the
// missing request as a failure, not die settling something that was never sent.
// A wait that reports rather than aborts: on a buggy build the thing being
// waited for never happens, and the run should say which promise was broken.
const waitFor = async (fn, arg = null, ms = 600) => {
  try { await page.waitForFunction(fn, arg, { timeout: ms }); return true; } catch { return false; }
};
const settle = (kind, index, value, how = 'resolve') => page.evaluate(([k, i, v, mode]) => {
  const req = window.__net[k][i];
  if (!req) return null;
  req.settled = true;
  if (mode === 'resolve') req.resolve(v); else req.reject(new Error(String(v)));
  return new Promise((r) => setTimeout(r, 60));
}, [kind, index, value, how]);

try {
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.addScriptTag({ path: bundle });
  console.log('[phase] content set');
  await page.waitForFunction(() => window.__edit && window.__edit.can, null, { timeout: 15000 });
  console.log('[phase] file view ready');
  await page.waitForFunction(() => document.querySelector('textarea.secret-desc'), null, { timeout: 15000 });
  console.log('[phase] settings ready');

  // ---- files: an older save must not speak for a newer buffer ----
  console.log('\na file save that lands after newer typing');
  await page.locator('.fv-cm .cm-content').fill('version A');
  await page.evaluate(() => { window.__edit.save(); });
  await page.waitForFunction(() => window.__net.writes.length === 1);
  await page.locator('.fv-cm .cm-content').fill('version B');
  await page.waitForFunction(() => document.querySelector('.fv-cm .cm-content').textContent.includes('version B'));
  await settle('writes', 0, { size: 9, mtime: 2, tag: 'tag-A' });

  const afterA = await page.evaluate(() => ({
    editor: document.querySelector('.fv-cm .cm-content').textContent,
    status: window.__edit.status,
    draft: window.__h.draft('files-1'),
    writes: window.__net.writes.length,
  }));
  check('the newer text is still in the editor', () => assert.match(afterA.editor, /version B/));
  check('and still in the remembered draft — an older success cannot clear it',
    () => assert.equal(afterA.draft?.text, 'version B'));
  check('the file is not reported saved while newer text is unwritten',
    () => assert.notEqual(afterA.status, 'saved'));

  await page.evaluate(() => { window.__edit.save(); });
  await page.waitForFunction(() => window.__net.writes.length === 2);
  const second = (await net('writes'))[1];
  check('the next save writes the newer text', () => assert.equal(second.text, 'version B'));
  check('…against the base the older save returned, not the one it was typed on',
    () => assert.equal(second.base, 'tag-A'));
  await settle('writes', 1, { size: 9, mtime: 3, tag: 'tag-B' });
  const afterB = await page.evaluate(() => ({ status: window.__edit.status, draft: window.__h.draft('files-1') }));
  check('once the current text is committed it is saved, and the draft is released',
    () => { assert.equal(afterB.status, 'saved'); assert.equal(afterB.draft, null); });

  // ---- files: Save during a write, and save-and-close ----
  console.log('\nsaving again while a write is still in flight');
  await page.locator('.fv-cm .cm-content').fill('version C');
  await page.evaluate(() => { window.__edit.save(); });
  await page.waitForFunction(() => window.__net.writes.length === 3);
  await page.locator('.fv-cm .cm-content').fill('version D');
  const closing = await page.evaluateHandle(() => ({ p: window.__edit.saveNow() }));
  await settle('writes', 2, { size: 9, mtime: 4, tag: 'tag-C' });
  await page.waitForTimeout(80);
  const midClose = await page.evaluate(() => window.__net.writes.length);
  check('an explicit save during a write is not dropped — the newer revision follows it',
    () => assert.equal(midClose, 4));
  const requestedD = (await net('writes'))[3];
  check('and it is the latest requested text', () => assert.equal(requestedD?.text, 'version D'));
  let closeResolved = await page.evaluate((h) => Promise.race([h.p.then(() => 'resolved'), new Promise((r) => setTimeout(() => r('pending'), 120))]), closing);
  check('save and close does not report success while its buffer is uncommitted',
    () => assert.equal(closeResolved, 'pending'));
  await settle('writes', 3, { size: 9, mtime: 5, tag: 'tag-D' });
  closeResolved = await page.evaluate((h) => Promise.race([h.p.then((v) => `resolved:${v}`), new Promise((r) => setTimeout(() => r('pending'), 200))]), closing);
  check('…and does report success once it is', () => assert.equal(closeResolved, 'resolved:true'));

  // A viewer that reports itself to its pane on every render, into state the
  // pane keeps, never stops rendering. Nothing above has waited on a timer, so
  // whatever this counts is renders, not seconds.
  const infoCalls = await page.evaluate(() => window.__infoCalls);
  await page.waitForTimeout(200);
  const infoLater = await page.evaluate(() => window.__infoCalls);
  check('the viewer settles instead of reporting itself forever',
    () => assert.equal(infoLater, infoCalls, `${infoCalls} → ${infoLater} reports while idle`));

  // ---- settings: immediate ----
  console.log('\nsettings save immediately');
  const beforeCfg = (await net('configs')).length;
  check('mounting settings saves nothing', () => assert.equal(beforeCfg, 0));
  const t0 = Date.now();
  await page.getByRole('button', { name: 'public', exact: true }).click();
  const dispatched = await waitFor((n) => window.__net.configs.length > n, beforeCfg, 400);
  const dispatchMs = Date.now() - t0;
  check('a change dispatches at once, with no debounce to wait out',
    () => assert.ok(dispatched, `nothing was sent within ${dispatchMs}ms of the click`));

  // newer edits during the write coalesce and go out the moment it settles
  await page.getByRole('button', { name: 'off', exact: true }).first().click();
  await page.waitForTimeout(120);
  const during = (await net('configs')).length;
  check('one write at a time', () => assert.equal(during, 1));
  await settle('configs', 0, { ok: true });
  const followed = await waitFor(() => window.__net.configs.length === 2, null, 400);
  const coalesced = (await net('configs'))[1];
  check('the pending change follows the moment the write settles, with no second delay',
    () => assert.ok(followed, 'no second write after the first settled'));
  check('and it carries both edits',
    () => {
      assert.equal(coalesced?.body?.artifacts?.visibility, 'public');
      assert.equal(coalesced?.body?.artifacts?.enabled, false);
    });
  await settle('configs', 1, { ok: true });

  console.log('\na secret description saves immediately too');
  const t1 = Date.now();
  await page.locator('textarea.secret-desc').first().fill('placeholder one');
  const noteSent = await waitFor(() => window.__net.secrets.length === 1, null, 400);
  check('a description dispatches without waiting',
    () => assert.ok(noteSent, `nothing was sent within ${Date.now() - t1}ms`));
  await page.locator('textarea.secret-desc').first().fill('placeholder two');
  const midSecret = await page.evaluate(() => document.querySelector('.save-flag')?.textContent || '');
  check('and it does not read as saved while the newer text is still unwritten',
    () => assert.ok(!/saved/i.test(midSecret), `flag said ${JSON.stringify(midSecret)}`));
  await settle('secrets', 0, { ok: true });
  const noteFollowed = await waitFor(() => window.__net.secrets.length === 2, null, 400);
  const secondNote = (await net('secrets'))[1];
  check('the newer description follows the one that was in flight',
    () => assert.ok(noteFollowed, 'the newer description was never sent'));
  check('and it is the newer text',
    () => assert.equal(secondNote?.body?.HF_TOKEN, 'placeholder two'));
  await settle('secrets', 1, { ok: true });

  // ---- settings: closing the panel must not cancel the work ----
  console.log('\nclosing settings while a write is out');
  await page.getByRole('button', { name: '1 week', exact: true }).click();
  const thirdSent = await waitFor(() => window.__net.configs.length === 3, null, 400);
  check('the third change is sent too', () => assert.ok(thirdSent, 'no write for the third change'));
  await page.evaluate(() => window.__h.setShowSettings(false));
  await page.waitForTimeout(60);
  await settle('configs', 2, { ok: true });
  const lastCfg = (await net('configs')).at(-1);
  check('a write already sent finishes after the panel closes',
    () => assert.ok(lastCfg?.settled, 'the outstanding write never settled'));
  check('and it carried the change that was made', () => assert.equal(lastCfg?.body?.archive?.after, 'week'));


  console.log('\nreopening the panel');
  await page.evaluate(() => window.__h.setShowSettings(true));
  await page.waitForFunction(() => document.querySelector('textarea.secret-desc'), null, { timeout: 15000 });
  const reopened = await page.evaluate(() => ({
    archive: [...document.querySelectorAll('.cfg-seg button.on')].map((b) => b.textContent),
    note: document.querySelector('textarea.secret-desc')?.value,
  }));
  check('reopening shows what was saved, not the value it was opened on first time',
    () => assert.ok(reopened.archive.includes('1 week'), reopened.archive.join(',')));
  check('and the saved description with it', () => assert.equal(reopened.note, 'placeholder two'));

  // ---- a refused save stays on screen, and Retry sends the current value ----
  console.log('\na settings write that fails');
  const before = (await net('configs')).length;
  await page.getByRole('button', { name: '1 month', exact: true }).click();
  const failing = await waitFor((n) => window.__net.configs.length === n + 1, before, 400);
  check('the change is sent', () => assert.ok(failing, 'nothing was sent'));
  await settle('configs', before, 'disk is full', 'reject');
  const flag = await waitFor(() => /not saved/i.test(document.querySelector('.save-flag-err')?.textContent || ''), null, 600);
  check('the failure is on screen', () => assert.ok(flag, 'no failure shown'));
  const saidSaved = await page.evaluate(() =>
    [...document.querySelectorAll('.save-flag')].map((e) => e.textContent).join(' | '));
  check('and nothing claims to be saved', () => assert.ok(!/saved ✓/.test(saidSaved), saidSaved));
  await page.waitForTimeout(2000);
  const stillThere = await page.evaluate(() => document.querySelector('.save-flag-err')?.textContent || '');
  check('a failure does not fade the way the tick does',
    () => assert.match(stillThere, /not saved/i));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  const retried = await waitFor((n) => window.__net.configs.length === n + 2, before, 600);
  check('Retry sends it again', () => assert.ok(retried, 'Retry sent nothing'));
  const retryBody = (await net('configs')).at(-1);
  check('carrying the change that failed', () => assert.equal(retryBody?.body?.archive?.after, 'month'));
  await settle('configs', before + 1, { ok: true });
  const cleared = await waitFor(() => !document.querySelector('.save-flag-err'), null, 600);
  check('and the failure clears once it lands', () => assert.ok(cleared, 'failure still shown'));

  // ---- a refused file write keeps the buffer ----
  console.log('\na file write that is refused');
  await page.locator('.fv-cm .cm-content').fill('version E');
  await page.evaluate(() => { window.__edit.save(); });
  const sentE = await waitFor(() => window.__net.writes.length === 5, null, 600);
  check('the save goes out', () => assert.ok(sentE, 'nothing was written'));
  await settle('writes', 4, 'changed on disk since you opened it', 'reject');
  await page.waitForTimeout(80);
  const refused = await page.evaluate(() => ({
    status: window.__edit.status, conflict: window.__edit.conflict,
    error: window.__edit.error, draft: window.__h.draft('files-1'),
    editor: document.querySelector('.fv-cm .cm-content').textContent,
  }));
  check('the file is not reported saved', () => assert.equal(refused.status, 'error'));
  check('the conflict is named', () => assert.ok(refused.conflict, refused.error || 'no conflict'));
  check('and the text is still there — in the editor and in the kept draft',
    () => { assert.match(refused.editor, /version E/); assert.equal(refused.draft?.text, 'version E'); });
  await page.evaluate(() => { window.__edit.overwrite(); });
  const sentF = await waitFor(() => window.__net.writes.length === 6, null, 600);
  check('overwrite sends it again', () => assert.ok(sentF, 'overwrite sent nothing'));
  const forced = (await net('writes')).at(-1);
  check('without the precondition it was refused on', () => assert.equal(forced?.base, null));
  await settle('writes', 5, { size: 9, mtime: 6, tag: 'tag-E' });
  await page.waitForTimeout(80);
  const afterForce = await page.evaluate(() => ({ status: window.__edit.status, draft: window.__h.draft('files-1') }));
  check('and then it really is saved', () => assert.equal(afterForce.status, 'saved'));
  check('with nothing left unwritten', () => assert.equal(afterForce.draft, null));

  console.log('\ntwo save handlers on one keystroke');
  await page.locator('.fv-cm .cm-content').fill('version G');
  // ⌘S reaches the editor's keymap and the pane, in that order, in one tick.
  await page.evaluate(() => { window.__edit.save(); window.__edit.save(); });
  const sentG = await waitFor(() => window.__net.writes.length === 7, null, 600);
  check('the save goes out once', () => assert.ok(sentG, 'nothing was written'));
  await settle('writes', 6, { size: 9, mtime: 7, tag: 'tag-G' });
  await page.waitForTimeout(120);
  const round = await page.evaluate(() => ({ writes: window.__net.writes.length, status: window.__edit.status }));
  check('and the second handler does not make a second round trip say the same thing',
    () => assert.equal(round.writes, 7));
  check('the file is saved either way', () => assert.equal(round.status, 'saved', `status ${round.status}`));

} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : '\nsave-races: ok');
process.exit(failed ? 1 : 0);
