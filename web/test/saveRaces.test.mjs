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
import { SettingsConflict } from ${JSON.stringify(path.join(WEB, 'src/api.ts'))};
const net = { writes: [], configs: [], secrets: [] };
window.__net = net;
const park = (list, payload) => new Promise((resolve, reject) => {
  list.push({ ...payload, at: Date.now(), resolve, reject, settled: false });
});
export const previewFile = (_id, p) => Promise.resolve({
  kind: 'text', name: p.replace(/^.*\\//, ''), mime: 'text/plain',
  size: 5, mtime: 1, tag: 'tag-0', text: 'start',
});
export const listFiles = () => Promise.resolve({
  path: '', root: '/workspace',
  entries: [{ name: 'notes.txt', dir: false, size: 5, mtime: 1, kind: 'text' }],
});
export const rawUrl = () => 'data:text/plain,';
export const downloadUrl = () => '#';
export const writeFile = (_id, p, text, base) => park(net.writes, { path: p, text, base });
export const getFileTraceWindow = () => new Promise(() => {});
export const getFileTraceSummary = () => new Promise(() => {});

const baseConfig = {
  artifacts: { enabled: true, space: 'me/artifacts', visibility: 'private' },
  jobs: { askAboveUsd: 5 },
  archive: { after: 'month' },
  revive: { enabled: true, days: 3 },
  backup: { every: 'never', dataset: '', exclude: [] },
  defaultArtifactsSpace: 'me/agent-artifacts',
};
const clean = () => ({ pending: false, error: null, at: null });
// What the "server" holds. Committing is separate from answering, because a lost
// answer is exactly the case where the two come apart.
const state = { config: structuredClone(baseConfig), notes: { HF_TOKEN: '' }, configRev: 'rev-0', notesRev: 'nrev-0', derived: clean() };
let revN = 0;
window.__state = state;
window.__commit = (kind, i) => {
  const req = net[kind][i];
  if (kind === 'configs') { state.config = structuredClone(req.body); state.configRev = ('rev-lost-' + (++revN)); }
  else { state.notes = structuredClone(req.body); state.notesRev = ('nrev-lost-' + (++revN)); }
};
export const getConfig = () => Promise.resolve({
  ...structuredClone(state.config), rev: state.configRev, readError: state.configReadError || null, derived: state.derived,
});
export const saveConfig = (c, base) => park(net.configs, { body: structuredClone(c), base }).then((r) => {
  if (r && r.conflict) throw new SettingsConflict('these settings were changed somewhere else', 'stale', r.rev, r.value);
  state.config = structuredClone(c);
  state.configRev = (r && r.rev) || ('rev-' + (++revN));
  if (r && r.derived) state.derived = r.derived;
  return { ok: true, ...structuredClone(state.config), rev: state.configRev, derived: state.derived };
});
export const getSecrets = () => Promise.resolve({
  detected: ['HF_TOKEN'], notes: structuredClone(state.notes), rev: state.notesRev, readError: null, derived: state.derived,
});
export const saveSecrets = (notes, base) => park(net.secrets, { body: structuredClone(notes), base }).then((r) => {
  if (r && r.conflict) throw new SettingsConflict('these descriptions were changed somewhere else', 'stale', r.rev, r.value);
  state.notes = structuredClone(notes);
  state.notesRev = (r && r.rev) || ('nrev-' + (++revN));
  if (r && r.derived) state.derived = r.derived;
  return { ok: true, notes: structuredClone(state.notes), rev: state.notesRev, derived: state.derived };
});
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
      import FilesPane, { FileView } from './src/components/FilesPane.tsx';
      import SettingsView from './src/components/SettingsView.tsx';
      import SettingsSaveAlert from './src/components/SettingsSaveAlert.tsx';
      import { configSaver, secretsSaver } from './src/lib/settingsSaves.ts';
      import { recall, remember } from './src/components/filesMemory.ts';
      window.__savers = { config: configSaver, secrets: secretsSaver };

      function Harness() {
        const [showSettings, setShowSettings] = useState(true);
        const [showFile, setShowFile] = useState(true);
        const [showPane, setShowPane] = useState(false);
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
            // The pane is the chrome around the editor — where the buttons a
            // failure needs actually live. It opens on its own session so the
            // two never share a remembered draft.
            openPane: () => { remember('files-2', { viewing: '/notes.txt' }); setShowPane(true); },
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
          {/* The app chrome's own report of a settings save that failed, which is
              the only place left to say it once the panel is closed. */}
          <SettingsSaveAlert hidden={showSettings} onOpen={() => setShowSettings(true)} />
          {showPane && (
            <div style={{ height: 420 }}>
              <FilesPane
                session={{ id: 'files-2', name: 'pane', cli: 'claude', path: 'pane', createdAt: '', everStarted: true, running: false, state: 'idle' }}
                onClose={() => setShowPane(false)}
              />
            </div>
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
// The flag beside one section's heading. The two settings resources save
// independently, so "is anything saying saved?" has to name which one.
const flagOf = (section) => page.evaluate((name) => {
  const head = [...document.querySelectorAll('h3')].find((h) => h.textContent?.includes(name));
  return head?.querySelector('.save-flag')?.textContent || '';
}, section);

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
  const midSecret = await flagOf('Secrets');
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
  const saidSaved = await flagOf('Agent output');
  check('and that setting does not claim to be saved', () => assert.ok(!/saved ✓/.test(saidSaved), saidSaved));
  const neighbour = await flagOf('Secrets');
  check('while the descriptions beside it are unaffected — two resources, saved apart',
    () => assert.ok(!/not saved/.test(neighbour), neighbour));
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


  // ---- a response that outlives the view it was sent from ----
  console.log('\na file save that lands after the view is gone');
  const w0 = (await net('writes')).length;
  await page.locator('.fv-cm .cm-content').fill('version H');
  await page.evaluate(() => { window.__edit.save(); });
  const sentH = await waitFor((n) => window.__net.writes.length === n + 1, w0, 600);
  check('the save goes out', () => assert.ok(sentH, 'nothing was written'));
  await page.locator('.fv-cm .cm-content').fill('version I');
  await waitFor(() => window.__h.draft('files-1')?.text === 'version I', null, 600);
  // Leaving takes the viewer with it. The buffer does not go with it: it lives
  // in the remembered draft, which is the thing the late answer must not touch.
  await page.evaluate(() => { window.__h.setShowFile(false); window.__edit = null; });
  await page.waitForTimeout(80);
  await settle('writes', w0, { size: 9, mtime: 8, tag: 'tag-H' });
  await page.waitForTimeout(120);
  const kept = await page.evaluate(() => window.__h.draft('files-1'));
  check('the newer buffer survives a save that lands after the view closed',
    () => assert.equal(kept?.text, 'version I'));
  check('and it is rebased onto the version that save committed',
    () => assert.equal(kept?.base, 'tag-H'));

  await page.evaluate(() => window.__h.setShowFile(true));
  await waitFor(() => window.__edit && window.__edit.can, null, 15000);
  const back = await page.evaluate(() => ({
    status: window.__edit.status,
    editor: document.querySelector('.fv-cm .cm-content').textContent,
  }));
  check('reopening the file shows the unsaved text, not what was saved under it',
    () => assert.match(back.editor, /version I/));
  check('…and still says it is unsaved', () => assert.equal(back.status, 'dirty'));
  await page.evaluate(() => { window.__edit.save(); });
  const sentI = await waitFor((n) => window.__net.writes.length === n + 2, w0, 600);
  check('and saving it writes that text', () => assert.ok(sentI, 'nothing was written'));
  const iWrite = (await net('writes')).at(-1);
  check('against the base the older save returned', () => assert.equal(iWrite?.base, 'tag-H'));
  await settle('writes', w0 + 1, { size: 9, mtime: 9, tag: 'tag-I' });
  await page.waitForTimeout(80);

  console.log('\na file save that lands while another file is open');
  const w1 = (await net('writes')).length;
  await page.locator('.fv-cm .cm-content').fill('version J');
  await page.evaluate(() => { window.__edit.save(); });
  await waitFor((n) => window.__net.writes.length === n + 1, w1, 600);
  await page.evaluate(() => window.__h.setFilePath('/other.txt'));
  await waitFor(() => window.__edit && window.__edit.status === 'clean', null, 2000);
  await page.locator('.fv-cm .cm-content').fill('a different file');
  await waitFor(() => window.__h.draft('files-1')?.path === '/other.txt', null, 600);
  await settle('writes', w1, { size: 9, mtime: 10, tag: 'tag-J' });
  await page.waitForTimeout(120);
  const across = await page.evaluate(() => ({
    draft: window.__h.draft('files-1'),
    status: window.__edit.status,
    editor: document.querySelector('.fv-cm .cm-content').textContent,
  }));
  check('a save finishing for one file does not clear another file\'s draft',
    () => { assert.equal(across.draft?.path, '/other.txt'); assert.equal(across.draft?.text, 'a different file'); });
  check('nor mark the open file saved', () => assert.notEqual(across.status, 'saved'));
  check('nor touch its text', () => assert.match(across.editor, /a different file/));
  // The damage a response for another file does is quieter than a cleared
  // draft: it can leave this file's base pointing at the other file's version,
  // which the next save then carries.
  await page.evaluate(() => { window.__edit.save(); });
  const savedOther = await waitFor((n) => window.__net.writes.length === n + 2, w1, 800);
  check('the open file saves', () => assert.ok(savedOther, 'nothing was written'));
  const otherWrite = (await net('writes')).at(-1);
  check('and it carries its own file and its own base, not the other file\'s',
    () => { assert.equal(otherWrite?.path, '/other.txt'); assert.equal(otherWrite?.base, 'tag-0'); });
  await settle('writes', w1 + 1, { size: 9, mtime: 11, tag: 'tag-O' });
  await page.waitForTimeout(80);

  // ---- the chrome around a failure ----
  console.log('\na file write that fails has a way to send it again');
  await page.evaluate(() => window.__h.openPane());
  await page.waitForSelector('.files-info .fv-cm, .fv-cm .cm-content', { timeout: 15000 });
  await page.waitForTimeout(150);
  const paneEditor = page.locator('.fv-cm .cm-content').last();
  const w2 = (await net('writes')).length;
  await paneEditor.fill('pane edit');
  await page.locator('.files-info').getByRole('button', { name: 'Save', exact: true }).click();
  const sentPane = await waitFor((n) => window.__net.writes.length === n + 1, w2, 800);
  check('the pane saves the buffer', () => assert.ok(sentPane, 'nothing was written'));
  await settle('writes', w2, 'disk is full', 'reject');
  await page.waitForTimeout(120);
  const strip = await page.evaluate(() => {
    const info = document.querySelector('.files-info');
    return {
      text: info?.textContent || '',
      buttons: [...(info?.querySelectorAll('button') || [])].map((b) => b.textContent),
    };
  });
  check('the failure is named in the strip', () => assert.match(strip.text, /disk is full/));
  check('and a failure that is not a conflict still offers Retry',
    () => assert.ok(strip.buttons.includes('Retry'), strip.buttons.join(',')));
  await page.locator('.files-info').getByRole('button', { name: 'Retry', exact: true }).click();
  const sentAgain = await waitFor((n) => window.__net.writes.length === n + 2, w2, 800);
  check('which sends it again', () => assert.ok(sentAgain, 'Retry sent nothing'));
  const paneWrite = (await net('writes')).at(-1);
  check('with the same text', () => assert.equal(paneWrite?.text, 'pane edit'));
  check('and still with its precondition — Retry is not an overwrite',
    () => assert.notEqual(paneWrite?.base, null));
  await settle('writes', w2 + 1, { size: 9, mtime: 11, tag: 'tag-P' });
  await page.waitForTimeout(120);
  const settledStrip = await page.evaluate(() => document.querySelector('.files-info')?.textContent || '');
  check('and then it reads as saved', () => assert.match(settledStrip, /saved/));
  await page.evaluate(() => window.__h.setShowPane && window.__h.setShowPane(false));


  // ---- an edit that is not finished being typed ----
  console.log('\na number that is not a number yet');
  const c0 = (await net('configs')).length;
  await page.locator('.cfg-num').fill('17');
  const sentUsd = await waitFor((n) => window.__net.configs.length === n + 1, c0, 600);
  check('a complete number is saved as it is typed', () => assert.ok(sentUsd, 'nothing was sent'));
  const usd17 = (await net('configs')).at(-1);
  check('with the value in it', () => assert.equal(usd17?.body?.jobs?.askAboveUsd, 17));
  await settle('configs', c0, { rev: 'rev-usd' });
  await page.waitForTimeout(80);
  // The empty moment on the way from 17 to something else is not a request to
  // ask about every job.
  await page.locator('.cfg-num').fill('');
  await page.waitForTimeout(250);
  const midNumber = await page.evaluate(() => ({
    count: window.__net.configs.length,
    shown: document.querySelector('.cfg-num').value,
    marked: !!document.querySelector('.cfg-num.cfg-bad'),
    stored: window.__state.config.jobs.askAboveUsd,
  }));
  check('an emptied field sends nothing', () => assert.equal(midNumber.count, c0 + 1));
  check('so the setting keeps the last number that was one', () => assert.equal(midNumber.stored, 17));
  check('the box keeps what was typed rather than snapping to 0', () => assert.equal(midNumber.shown, ''));
  check('and it is marked as not a number yet', () => assert.ok(midNumber.marked));
  await page.locator('.cfg-num').fill('42');
  const sentUsd2 = await waitFor((n) => window.__net.configs.length === n + 2, c0, 600);
  check('finishing the edit saves the finished number', () => assert.ok(sentUsd2, 'nothing was sent'));
  const usd42 = (await net('configs')).at(-1);
  check('and it is the number that was typed', () => assert.equal(usd42?.body?.jobs?.askAboveUsd, 42));
  await settle('configs', c0 + 1, { rev: 'rev-usd2' });
  await page.waitForTimeout(80);

  // ---- somebody else got there first ----
  console.log('\nsettings changed somewhere else');
  const c1 = (await net('configs')).length;
  await page.locator('.cfg-num').fill('7');
  await waitFor((n) => window.__net.configs.length === n + 1, c1, 600);
  await settle('configs', c1, {
    conflict: true, rev: 'rev-elsewhere',
    value: { artifacts: { enabled: true, space: 'them/theirs', visibility: 'private' }, jobs: { askAboveUsd: 3 }, archive: { after: 'month' }, revive: { enabled: true, days: 3 }, backup: { every: 'never', dataset: '', exclude: [] } },
  });
  await page.waitForTimeout(150);
  const conflictFlag = await flagOf('Agent output');
  check('a conflict says which kind of failure it is',
    () => assert.match(conflictFlag, /changed elsewhere/));
  check('and offers both ways out rather than choosing one',
    () => assert.ok(/Keep mine/.test(conflictFlag) && /Use theirs/.test(conflictFlag), conflictFlag));
  const stillMine = await page.evaluate(() => document.querySelector('.cfg-num').value);
  check('my value is still on screen while the choice is open', () => assert.equal(stillMine, '7'));
  await page.getByRole('button', { name: 'Keep mine', exact: true }).click();
  const resent = await waitFor((n) => window.__net.configs.length === n + 2, c1, 800);
  check('keeping mine sends it again', () => assert.ok(resent, 'nothing was sent'));
  const kept7 = (await net('configs')).at(-1);
  check('against the revision the server reported, not a blind overwrite',
    () => assert.equal(kept7?.base, 'rev-elsewhere'));
  check('and it is still my value', () => assert.equal(kept7?.body?.jobs?.askAboveUsd, 7));
  await settle('configs', c1 + 1, { rev: 'rev-kept' });
  await page.waitForTimeout(120);

  // and the other way: take what they have
  const c2 = (await net('configs')).length;
  await page.locator('.cfg-num').fill('8');
  await waitFor((n) => window.__net.configs.length === n + 1, c2, 600);
  await settle('configs', c2, {
    conflict: true, rev: 'rev-theirs',
    value: { artifacts: { enabled: true, space: 'them/theirs', visibility: 'private' }, jobs: { askAboveUsd: 3 }, archive: { after: 'month' }, revive: { enabled: true, days: 3 }, backup: { every: 'never', dataset: '', exclude: [] } },
  });
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: 'Use theirs', exact: true }).click();
  await page.waitForTimeout(200);
  const taken = await page.evaluate(() => ({
    shown: document.querySelector('.cfg-num').value,
    count: window.__net.configs.length,
    flag: [...document.querySelectorAll('h3')].find((h) => h.textContent.includes('Agent output'))?.querySelector('.save-flag')?.textContent || '',
  }));
  check('taking theirs shows what is stored', () => assert.equal(taken.shown, '3'));
  check('and does not turn round and save it back', () => assert.equal(taken.count, c2 + 1));
  check('with the conflict cleared', () => assert.ok(!/changed elsewhere/.test(taken.flag), taken.flag));

  // ---- an answer that never comes ----
  console.log('\nan answer that never comes');
  // The mechanism is exercised at a test speed below, but the resource has to
  // carry a real one: without it, nothing below ever happens in the product.
  const settingsTimeout = await page.evaluate(() => window.__savers.config.timeout());
  check('a settings save has a finite window for an answer',
    () => assert.ok(Number.isFinite(settingsTimeout) && settingsTimeout > 0 && settingsTimeout <= 60_000,
      `timeout is ${settingsTimeout}`));
  await page.evaluate(() => window.__savers.config.configure({ timeoutMs: 250 }));
  const c3 = (await net('configs')).length;
  await page.locator('.cfg-num').fill('11');
  await waitFor((n) => window.__net.configs.length === n + 1, c3, 600);
  // The server committed it. The answer is simply lost — the case where "just
  // retry" would either write it twice or walk over whatever replaced it.
  await page.evaluate((i) => window.__commit('configs', i), c3);
  await page.waitForTimeout(500);
  const lost = await page.evaluate(() => ({
    state: window.__savers.config.state(),
    flag: [...document.querySelectorAll('h3')].find((h) => h.textContent.includes('Agent output'))?.querySelector('.save-flag')?.textContent || '',
  }));
  check('a request that never answers gives the slot back instead of saying "saving…" forever',
    () => assert.equal(lost.state.status, 'error'));
  check('and it is not reported as saved', () => assert.match(lost.flag, /not confirmed/));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForTimeout(300);
  const checked = await page.evaluate(() => ({ count: window.__net.configs.length, state: window.__savers.config.state() }));
  check('a retry asks what the server holds before sending anything again',
    () => assert.equal(checked.count, c3 + 1));
  check('and a write that had landed after all is recognised, not repeated',
    () => assert.equal(checked.state.status, 'saved'));

  const c4 = (await net('configs')).length;
  await page.locator('.cfg-num').fill('13');
  await waitFor((n) => window.__net.configs.length === n + 1, c4, 600);
  await page.waitForTimeout(500);   // this one is lost with nothing committed
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  const resentLost = await waitFor((n) => window.__net.configs.length === n + 2, c4, 1500);
  check('a lost answer with nothing committed is sent again', () => assert.ok(resentLost, 'nothing was sent'));
  const again13 = (await net('configs')).at(-1);
  check('with the value that was owed', () => assert.equal(again13?.body?.jobs?.askAboveUsd, 13));
  check('and a precondition, not a forced write', () => assert.ok(again13?.base, 'no base'));
  await settle('configs', c4 + 1, { rev: 'rev-13' });
  await page.evaluate(() => window.__savers.config.configure({ timeoutMs: 15000 }));
  await page.waitForTimeout(120);

  // ---- a change made, and then walked away from ----
  console.log('\na settings change whose panel is closed before it fails');
  const c5 = (await net('configs')).length;
  await page.locator('.cfg-num').fill('23');
  await waitFor((n) => window.__net.configs.length === n + 1, c5, 600);
  await page.evaluate(() => window.__h.setShowSettings(false));
  await page.waitForTimeout(100);
  await settle('configs', c5, 'disk is full', 'reject');
  await page.waitForTimeout(150);
  const alert = await page.evaluate(() => {
    const el = document.querySelector('.save-alert');
    return { text: el?.textContent || '', buttons: [...(el?.querySelectorAll('button') || [])].map((b) => b.textContent) };
  });
  check('a failure that arrives after the panel is closed is reported in the app',
    () => assert.match(alert.text, /was not saved/));
  check('with a way back to the setting and a way to send it again',
    () => assert.ok(alert.buttons.includes('Open settings') && alert.buttons.includes('Retry'), alert.buttons.join(',')));
  await page.locator('.save-alert').getByRole('button', { name: 'Retry', exact: true }).click();
  const alertRetry = await waitFor((n) => window.__net.configs.length === n + 2, c5, 800);
  check('and the change is still there to send', () => assert.ok(alertRetry, 'nothing was sent'));
  const owed23 = (await net('configs')).at(-1);
  check('carrying the value that was made before the panel closed',
    () => assert.equal(owed23?.body?.jobs?.askAboveUsd, 23));
  await settle('configs', c5 + 1, 'still full', 'reject');
  await page.waitForTimeout(150);

  await page.evaluate(() => window.__h.setShowSettings(true));
  await page.waitForFunction(() => document.querySelector('textarea.secret-desc'), null, { timeout: 15000 });
  const reopened2 = await page.evaluate(() => document.querySelector('.cfg-num').value);
  check('reopening shows the value still owed to the server, not the older one it would fetch',
    () => assert.equal(reopened2, '23'));
  const gone = await page.evaluate(() => !!document.querySelector('.save-alert'));
  check('and the app-level report stands down while the panel is open', () => assert.ok(!gone));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  const finalTry = await waitFor((n) => window.__net.configs.length === n + 3, c5, 800);
  check('retrying from the panel sends it once more', () => assert.ok(finalTry, 'nothing was sent'));
  await settle('configs', c5 + 2, { rev: 'rev-23' });
  await page.waitForTimeout(150);
  const done = await flagOf('Agent output');
  check('and it lands', () => assert.match(done, /saved/));

} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : '\nsave-races: ok');
process.exit(failed ? 1 : 0);
