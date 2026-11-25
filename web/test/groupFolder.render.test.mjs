// Group folder persistence and contextual NewSession pre-fill in the Sidebar.
//
// Run with: node test/groupFolder.render.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'group-folder-render-'));

try {
  // 1. Verify api.createGroup forwards optional path cleanly.
  const apiOut = path.join(tmp, 'api.mjs');
  await build({
    entryPoints: [path.join(WEB, 'src/api.ts')],
    outfile: apiOut,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const sentBodies = [];
  globalThis.fetch = async (_url, init) => {
    sentBodies.push(JSON.parse(String(init?.body || '{}')));
    return new Response(JSON.stringify({ id: 'g-1', name: 'ok', sessionIds: [] }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  const api = await import(pathToFileURL(apiOut).href);
  await api.createGroup('Plain');
  await api.createGroup('Team', 'my-team');
  assert.deepEqual(sentBodies, [
    { name: 'Plain' },
    { name: 'Team', path: 'my-team' },
  ]);

  // 2. Render Sidebar and verify group '+' pre-fills g.path -> member path -> defaultPath.
  const bundle = path.join(tmp, 'app.js');
  const stub = path.join(tmp, 'api-stub.ts');
  fs.writeFileSync(stub, `
    export const listFolders = () => Promise.resolve({ path: '', folders: [] });
    export const nextName = (cli) => Promise.resolve({ cli, name: cli + '-1' });
    export const uploadAttachment = () => new Promise(() => {});
    export const deleteAttachment = () => Promise.resolve({ ok: true });
    export const getMetaOne = () => new Promise(() => {});
  `);

  const TREE = {
    order: ['g:explicit', 'g:derived', 'g:fallback'],
    groups: [
      { id: 'explicit', name: 'Explicit Team', path: 'my-team', sessionIds: [], createdAt: '2026-11-25T00:00:00Z' },
      { id: 'derived', name: 'Derived Team', sessionIds: ['f1', 'm1'], createdAt: '2026-11-25T00:00:00Z' },
      { id: 'fallback', name: 'Fallback Team', sessionIds: [], createdAt: '2026-11-25T00:00:00Z' },
    ],
    sessions: [
      { id: 'f1', name: 'files', cli: 'files', path: 'ignored-passive', createdAt: '2026-11-25T00:00:00Z', everStarted: false, running: false, state: 'stopped' },
      { id: 'm1', name: 'claude-1', cli: 'claude', path: 'member-dir', createdAt: '2026-11-25T00:00:00Z', everStarted: false, running: false, state: 'stopped' },
    ],
    hidden: [],
  };

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
              { id: 'claude', label: 'Claude Code', color: '#d97757', available: true },
              { id: 'shell', label: 'Shell', color: '#8aa0ad', available: true },
            ]}
            tree={${JSON.stringify(TREE)}}
            activeRef={null}
            focusedId={null}
            defaultPath="global-fallback"
            ages={{}}
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
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.setContent(`<!doctype html><style>${css}</style><div id="root"></div>`);
    await page.addScriptTag({ path: bundle });

    const clickAddOnGroup = async (groupName) => {
      await page.locator(`button.g-add[title="New agent in ${groupName}"]`).click({ force: true });
      return (await page.locator('.controls .fp-path').innerText()).trim();
    };

    assert.equal(await clickAddOnGroup('Explicit Team'), 'my-team');
    assert.equal(await clickAddOnGroup('Derived Team'), 'member-dir');
    assert.equal(await clickAddOnGroup('Fallback Team'), 'global-fallback');
    console.log('groupFolder.render: ok');
  } finally {
    await browser.close();
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
