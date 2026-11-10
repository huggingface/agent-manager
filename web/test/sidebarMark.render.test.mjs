// The sidebar's logo frame (#242), rendered: the real Sidebar over one session
// per mark, in both themes. lib/rowMark.ts picks the mark (rowMark.test.mjs);
// this proves the row draws it — a heavier frame only when busy, blocked or
// unread, a bare logo when running and read, and a faded row when not running.
//
// Run with:  node test/sidebarMark.render.test.mjs
// Set SIDEBAR_MARK_SHOT=<dir> to also save a screenshot per theme.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-mark-'));
const bundle = path.join(tmp, 'app.js');
const stub = path.join(tmp, 'api-stub.ts');

fs.writeFileSync(stub, `
  export const listFolders = () => Promise.resolve({ folders: [] });
  export const uploadAttachment = () => new Promise(() => {});
  export const deleteAttachment = () => Promise.resolve({ ok: true });
  export const getMetaOne = () => new Promise(() => {});
`);

const session = (id, extra = {}) => ({
  id, name: id, cli: 'codex', path: null, createdAt: new Date().toISOString(),
  everStarted: true, running: true, state: 'idle', ...extra,
});
const ask = { kind: 'permission', cli: 'codex', confidence: 'high', detectedAt: new Date().toISOString() };
// Each session's name is the mark it should get.
// A mix of CLIs, so the screenshot shows each keeps its own logo inside the frame.
const SESSIONS = [
  session('working', { cli: 'claude', state: 'working' }),
  session('blocked', { state: 'waiting', inputRequired: ask }),
  session('unread', { cli: 'claude', state: 'waiting' }),
  session('read', { state: 'idle' }),
  session('off', { cli: 'claude', state: 'stopped', running: false }),
  // Busy masks unread; a dialog outranks the spinner.
  session('working-unread', { state: 'working' }),
  session('blocked-working', { cli: 'claude', state: 'working', inputRequired: ask }),
];
const UNREAD = ['unread', 'working-unread', 'blocked-working'];
const EXPECT = { 'working-unread': 'working', 'blocked-working': 'blocked' };
const TREE = { order: SESSIONS.map((s) => `s:${s.id}`), groups: [], sessions: SESSIONS, hidden: [] };

await build({
  stdin: {
    resolveDir: WEB,
    loader: 'tsx',
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import Sidebar from './src/components/Sidebar.tsx';
      const noop = () => {};
      const promise = () => Promise.resolve();
      createRoot(document.getElementById('root')).render(
        <Sidebar
          clis={[
            { id: 'claude', label: 'Claude', color: '#d97757', available: true },
            { id: 'codex', label: 'Codex', color: '#5eb6a6', available: true },
          ]}
          tree={${JSON.stringify(TREE)}}
          unread={new Set(${JSON.stringify(UNREAD)})}
          activeRef={null} focusedId={null} defaultPath="" ages={{}}
          onActivate={noop} onOpenSession={noop} onOpenSettings={noop}
          onNewSession={noop} onNewGroup={noop}
          onRenameGroup={noop} onRenameSession={noop} onDeleteGroup={noop}
          onArchiveSession={noop} onUnarchiveSession={noop}
          onSetRemotePaused={noop} onDeleteSession={noop}
          onTraceHandover={() => Promise.resolve({ path: '' })}
          handoverFor={null} onHandoverHandled={noop}
          onMove={noop} onDragState={noop}
          theme="dark" onToggleTheme={noop}
          onQuickStart={promise} onPrepareQuickStart={promise} onAbandonQuickStart={promise}
          archived={new Set()} retired={new Set()}
          showArchived={false} onToggleArchived={noop}
          overviewHidden={new Set()} onToggleOverviewHidden={noop}
          onPinSession={noop} onPinGroup={noop}
        />,
      );
    `,
  },
  outfile: bundle, bundle: true, format: 'iife', platform: 'browser', logLevel: 'error',
  plugins: [{ name: 'stub-api', setup(b) {
    b.onResolve({ filter: /(^|\/)\.\.?\/api$/ }, () => ({ path: stub }));
  } }],
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');
const browser = await chromium.launch(chromiumLaunchOptions());

try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 282, height: 420 }, deviceScaleFactor: 2 });
    // Served from a fake origin so the rows' /logos/<cli>.png resolve to the real files.
    await page.route('http://am.test/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/logos/')) {
        return route.fulfill({ path: path.join(WEB, 'public', url.pathname) });
      }
      return route.fulfill({ contentType: 'text/html',
        body: `<style>${css}</style><div id="root" data-theme="${theme}" style="height:100vh;display:flex"></div>` });
    });
    await page.goto('http://am.test/');
    await page.addScriptTag({ path: bundle });
    await page.waitForSelector('.row.session .state-logo');
    await page.waitForFunction(() => [...document.querySelectorAll('.row.session img')].every((i) => i.complete && i.naturalWidth > 0));

    const read = () => page.evaluate(() => {
      const token = (name) => {
        const probe = document.createElement('span');
        probe.style.color = `var(${name})`;
        document.getElementById('root').append(probe);
        const c = getComputedStyle(probe).color; probe.remove(); return c;
      };
      const rows = [...document.querySelectorAll('.tree .row.session')].map((row) => {
        const logo = row.querySelector('.state-logo');
        const frame = logo.querySelector('.state-logo-frame');
        const rect = frame.querySelector('rect:last-child');
        return {
          name: row.querySelector('.name').textContent,
          logo: row.querySelector('.cli-logo img')?.getAttribute('src'),
          mark: logo.classList[1], title: logo.title,
          frameShown: getComputedStyle(frame).display !== 'none',
          stroke: getComputedStyle(rect).strokeWidth, color: getComputedStyle(logo).color,
          animations: logo.getAnimations({ subtree: true }).length,
          opacity: getComputedStyle(row.querySelector('.name')).opacity,
          nameColor: getComputedStyle(row.querySelector('.name')).color,
        };
      });
      const legend = [...document.querySelectorAll('.sidebar .legend .state-logo')].map((el) => el.classList[1]);
      return { rows, legend, accent: token('--accent'), danger: token('--danger'), text: token('--text') };
    });
    const r = await read();
    const by = Object.fromEntries(r.rows.map((x) => [x.name, x]));

    for (const row of r.rows) assert.equal(row.mark, EXPECT[row.name] ?? row.name, `${theme}: ${row.name} gets its mark`);
    // The frame wraps the CLI's own logo; it never replaces it.
    for (const s of SESSIONS) assert.equal(by[s.id].logo, `/logos/${s.cli}.png`, `${theme}: ${s.id} keeps the ${s.cli} logo`);
    for (const name of ['working', 'blocked', 'unread']) {
      assert.ok(by[name].frameShown, `${theme}: ${name} draws a frame`);
      assert.equal(by[name].stroke, '2px', `${theme}: ${name} frame is 2px`);
    }
    assert.equal(by.read.frameShown, false, `${theme}: running and read is a bare logo`);
    assert.equal(by.off.frameShown, false, `${theme}: not running has no frame`);
    assert.equal(by.blocked.color, r.danger, `${theme}: needs input is red`);
    assert.equal(by.unread.color, r.accent, `${theme}: unread is the accent colour`);
    assert.equal(by.working.animations, 1, `${theme}: busy spins`);
    for (const name of ['blocked', 'unread', 'read', 'off']) assert.equal(by[name].animations, 0, `${theme}: ${name} is still`);
    assert.equal(by.off.opacity, '0.45', `${theme}: not running fades the row`);
    assert.equal(by.read.opacity, '1');
    assert.equal(by.blocked.nameColor, r.text, `${theme}: needs input brightens the name`);
    assert.equal(by.unread.nameColor, r.text, `${theme}: unread brightens the name`);
    assert.notEqual(by.read.nameColor, r.text, `${theme}: a read row keeps the muted name`);
    assert.equal(by.blocked.title, 'needs input: permission');
    assert.equal(by.unread.title, 'unread reply');
    assert.equal(by.off.title, 'idle: not running');
    assert.deepEqual(r.legend, ['working', 'blocked', 'unread', 'off'], `${theme}: legend shows the three frames and idle`);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(20);
    const still = await read();
    assert.equal(still.rows.find((x) => x.name === 'working').animations, 0, `${theme}: reduced motion stops the spinner`);

    if (process.env.SIDEBAR_MARK_SHOT) {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      fs.mkdirSync(process.env.SIDEBAR_MARK_SHOT, { recursive: true });
      await page.locator('.sidebar').screenshot({ path: path.join(process.env.SIDEBAR_MARK_SHOT, `sidebar-${theme}.png`) });
    }
    await page.close();
  }
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('sidebar-mark render: frames only when busy, blocked or unread; bare logo when read; faded row when not running');
