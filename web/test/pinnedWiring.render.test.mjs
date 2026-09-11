// The pin control's WIRING, not the helper behind it.
//
// lib/pinned.ts is unit-tested in pinned.test.mjs, but a green helper says
// nothing about whether the sidebar asks it. Review found exactly that gap:
// `canPin(...)` could be deleted from the row's render condition and every
// suite stayed green, while a grouped session grew a pin control that argues
// back — the impossible state the whole design is built to prevent.
//
// So this renders the real Sidebar over a real tree and looks at the DOM.
//
// Run with:  node test/pinnedWiring.render.test.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-wiring-'));
const bundle = path.join(tmp, 'app.js');
const stub = path.join(tmp, 'api-stub.ts');

// The sidebar reaches for these on mount; none of them is what we are testing.
fs.writeFileSync(stub, `
  export const listFolders = () => Promise.resolve({ folders: [] });
  export const uploadAttachment = () => new Promise(() => {});
  export const deleteAttachment = () => Promise.resolve({ ok: true });
  export const getMetaOne = () => new Promise(() => {});
`);

const session = (id, name, extra = {}) => ({
  id, name, cli: 'shell', path: null, createdAt: new Date().toISOString(),
  everStarted: false, running: false, state: 'idle', ...extra,
});

// `member` carries a stray pinnedAt on purpose. The server now clears one when
// a session joins a group (groups.js), but the sidebar must not depend on that
// having happened: a member is unpinnable and reads as unpinned whatever its
// record says.
const TREE = {
  order: ['s:loose', 'g:crew'],
  groups: [{ id: 'crew', name: 'crew', sessionIds: ['member'], createdAt: new Date().toISOString() }],
  sessions: [
    session('loose', 'loose-one'),
    session('member', 'in-a-group', { pinnedAt: new Date().toISOString() }),
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
          clis={[{ id: 'shell', label: 'Shell', available: true }]}
          tree={${JSON.stringify(TREE)}}
          activeRef={null}
          focusedId={null}
          defaultPath=""
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
  plugins: [{ name: 'stub-api', setup(b) {
    b.onResolve({ filter: /(^|\/)\.\.?\/api$/ }, () => ({ path: stub }));
  } }],
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.setContent(`<style>${css}
    html, body { margin: 0; background: var(--bg); }
  </style><div id="root"></div>`);
  await page.addScriptTag({ path: bundle });
  await page.waitForSelector('[data-ref="s:loose"]');

  const pinControls = async (ref) => page.$$eval(
    `[data-ref="${ref}"] button[aria-label="Pin"], [data-ref="${ref}"] button[aria-label="Unpin"]`,
    (els) => els.length,
  );

  const loosePins = await pinControls('s:loose');
  check('an ungrouped session still offers a pin', () => assert.equal(loosePins, 1));

  // The regression the review demonstrated. Reverting `canPin(...)` out of the
  // render condition puts a control here.
  const memberPins = await pinControls('s:member');
  check('a session inside a group offers none', () => assert.equal(memberPins, 0,
    'a grouped row must have no pin control at all — not a disabled one'));

  const groupPins = await page.$$eval(
    '[data-ref="g:crew"] button[aria-label="Pin group"], [data-ref="g:crew"] button[aria-label="Unpin group"]',
    (els) => els.length,
  );
  check('the group itself does — that is where the pin lives', () => assert.equal(groupPins, 1));

  // The read side of the same rule: the member's stray `pinnedAt` must not put
  // anything above the rule.
  const pinnedBlocks = await page.$$eval('.pinned-block', (els) => els.length);
  check("a member's stray pin does not open the pinned block", () => assert.equal(pinnedBlocks, 0));

  const memberRowIsNested = await page.$eval('[data-ref="s:member"]',
    (el) => !!el.closest('[data-ref="g:crew"]'));
  check('and the member is still drawn inside its group', () => assert.ok(memberRowIsNested));
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
