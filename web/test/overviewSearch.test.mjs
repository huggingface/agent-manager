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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovsearch-'));
const out = path.join(tmp, 'overviewSearch.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/overviewSearch.ts')],
  outfile: out, format: 'esm', bundle: false, logLevel: 'error',
});
const { matchesOverviewSearch, overviewSearchText } = await import(pathToFileURL(out).href);

const session = {
  id: 'one', name: 'Research Agent', cli: 'codex', state: 'waiting', createdAt: '',
  digest: {
    lastPromptText: 'Investigate auth', lastPromptRaw: 'Investigate the OAuth callback', lastPromptTs: 1,
    lastAssistantText: 'Fixed it', lastAssistantMd: 'Fixed the **redirect**.', lastAssistantTs: 2,
    sinceTurns: 2, sinceToolCalls: 2, sinceTools: { Read: 1, apply_patch: 1 },
    sinceFiles: ['/src/login.ts'], sinceTokens: 10,
    turnsLog: [{ answer: 'Found a stale cookie', answerMd: 'Found a `stale cookie`.', ts: 1 }],
  },
};

assert.equal(matchesOverviewSearch(session, 'Web App', ''), true);
assert.equal(matchesOverviewSearch(session, 'Web App', 'research'), true, 'agent name');
assert.equal(matchesOverviewSearch(session, 'Web App', 'web app'), true, 'group name and AND terms');
assert.equal(matchesOverviewSearch(session, 'Web App', 'OAUTH redirect'), true, 'prompt + answer, case-insensitive');
assert.equal(matchesOverviewSearch(session, 'Web App', 'apply_patch login.ts'), true, 'tool + file');
assert.equal(matchesOverviewSearch(session, 'Web App', 'stale cookie'), true, 'recent intermediate answer');
assert.equal(matchesOverviewSearch(session, 'Web App', 'oauth missing'), false, 'every term is required');
assert.match(overviewSearchText(session, 'Web App'), /oauth callback/);

// Browser integration: the real search box drives the real Overview, and the
// phone CSS keeps both focus and the clear action touch-safe.
const bundle = path.join(tmp, 'browser.js');
const stub = path.join(tmp, 'api-stub.ts');
fs.writeFileSync(stub, `
  export const getTracePage = () => Promise.reject(new Error('not used'));
  export const sendInput = () => Promise.resolve({ ok: true });
`);
const sessions = [
  { ...session, id: 'one', name: 'Research Agent' },
  { ...session, id: 'two', name: 'Docs Agent', digest: { ...session.digest,
      lastPromptText: 'Rewrite deployment docs', lastPromptRaw: 'Rewrite deployment docs',
      lastAssistantText: 'README published', lastAssistantMd: 'README published',
      sinceTools: {}, sinceFiles: [], turnsLog: [] } },
  { ...session, id: 'three', name: 'Loose Agent', digest: { ...session.digest,
      lastPromptText: 'Run browser checks', lastPromptRaw: 'Run browser checks',
      lastAssistantText: 'Still working', lastAssistantMd: 'Still working',
      sinceTools: { Playwright: 1 }, sinceFiles: [], turnsLog: [] } },
];
await build({
  stdin: {
    resolveDir: WEB, loader: 'tsx',
    contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import Overview from './src/components/Overview.tsx';
      import OverviewSearchBox from './src/components/OverviewSearchBox.tsx';
      const sessions = ${JSON.stringify(sessions)};
      const tree = { order: ['g:web', 's:three'], groups: [{ id: 'web', name: 'Web App', sessionIds: ['one', 'two'] }], sessions, hidden: [] };
      const meta = Object.fromEntries(sessions.map((s) => [s.id, s]));
      function Harness() {
        const [query, setQuery] = useState('');
        return <><div className="zoombar ov-bar"><OverviewSearchBox value={query} onChange={setQuery} /></div>
          <div style={{ height: 500 }}><Overview clis={[{ id: 'codex', color: '#5eb6a6' }]} tree={tree}
            chip="all" sort="manual" query={query} view="tiles" archived={new Set()}
            showArchived={false} showHidden={false} meta={meta} metaReady={true} isMobile={true} onOpen={() => {}} /></div></>;
      }
      createRoot(document.getElementById('root')).render(<Harness />);
    `,
  },
  outfile: bundle, bundle: true, format: 'iife', platform: 'browser', logLevel: 'error',
  plugins: [{ name: 'stub-api', setup(b) {
    b.onResolve({ filter: /(^|\/)\.\.?\/api$/ }, () => ({ path: stub }));
  } }],
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');
assert.match(css, /@media \(pointer: coarse\) \{[\s\S]*?\.ov-search > input \{ font-size: 16px; \}/,
  'the phone anti-zoom rule includes the Overview search');
// Headless Chromium otherwise reports no primary pointer even with hasTouch;
// enable touch events so the coarse-pointer rule is tested through the cascade.
const browser = await chromium.launch(chromiumLaunchOptions({ args: ['--touch-events=enabled'] }));
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${css}</style><div id="root"></div>`);
  await page.addScriptTag({ path: bundle });
  const search = page.getByLabel('Filter agents by recent trace activity');
  await search.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.ovt-tile').length === 3);

  assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true, 'browser is exercising touch CSS');
  assert.equal(await search.evaluate((el) => getComputedStyle(el).fontSize), '16px', 'phone input prevents iOS focus zoom');
  await search.fill('oauth redirect');
  assert.equal(await page.locator('.ovt-tile').count(), 1, 'prompt + answer terms filter cards');
  assert.equal(await page.locator('.ovt-name').textContent(), 'Research Agent');
  await search.fill('web app');
  assert.equal(await page.locator('.ovt-tile').count(), 2, 'group name keeps its members');
  const clear = page.getByLabel('Clear search');
  const clearBox = await clear.boundingBox();
  assert.ok(clearBox && Math.round(clearBox.width) >= 24 && Math.round(clearBox.height) >= 24,
    `clear has a 24px touch target (measured ${clearBox?.width}×${clearBox?.height})`);
  await clear.click();
  assert.equal(await page.locator('.ovt-tile').count(), 3, 'clear restores the fleet');
  await search.fill('nothing matches this');
  assert.match(await page.locator('.usage-msg').textContent(), /no recent activity matches/, 'query-specific empty state');
  await search.press('Escape');
  assert.equal(await search.inputValue(), '', 'Escape clears the search');
  await context.close();
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('overview search: helper, integration, and mobile checks passed');
