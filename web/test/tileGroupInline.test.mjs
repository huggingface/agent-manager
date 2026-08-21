// The Overview tile puts an agent's group on the name's row. A tile is ~225px,
// so the two cannot always share it — and the rule is measured, not guessed.
//
// This pins the INVARIANT rather than a threshold, because a threshold is what
// failed review: a 19-character budget let `AM cowrite-add-agent` through at
// 225px (both strings clipped) and dropped `rl-llm-agents release` at 276px
// (where it fits). So for every fixture, at every width the grid can produce:
//
//   1. nothing on the row is ever truncated while the group is shown, and
//   2. the group is shown whenever it WOULD fit — checked by putting it back
//      into the row the component decided to drop it from and measuring that.
//
// Run with:  node test/tileGroupInline.test.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-group-'));
const bundle = path.join(tmp, 'app.js');
const stub = path.join(tmp, 'api-stub.ts');

// Every pair the review measured, plus the comfortable ones. The lopsided pair
// is the case a character count cannot see: same sum, wildly different widths.
const FIXTURES = [
  { group: 'AM', name: 'manager' },
  { group: 'AM', name: 'cowrite-add-agent' },          // sum 19 — clipped both halves at 225
  { group: 'abcdefghijklmnopqr', name: 'x' },          // sum 19 — lopsided
  { group: 'rl-llm-agents', name: 'release' },         // sum 20 — fits at 238 and 276
  { group: 'rl-llm-agents', name: 'deploy' },
  { group: 'rl-llm-agents', name: 'maybe-claude-better' },
  { group: 'claudes', name: 'am-overview-improv' },
];
// 225px is the grid minimum (`minmax(225px, 1fr)`); the others are widths the
// grid actually produces at common window sizes.
const WIDTHS = [225, 238, 276, 340];

fs.writeFileSync(stub, `
  export const getMetaOne = () => new Promise(() => {});
  export const previewFile = () => new Promise(() => {});
`);

await build({
  stdin: {
    resolveDir: WEB,
    loader: 'tsx',
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { Tile } from './src/components/Overview.tsx';

      const FIXTURES = ${JSON.stringify(FIXTURES)};
      const session = (name) => ({
        id: name, name, cli: 'claude', state: 'waiting', running: false, path: name,
        createdAt: new Date(Date.now() - 59 * 60_000).toISOString(),
        digest: { lastPromptTs: Date.now() - 59 * 60_000, lastAssistantTs: Date.now() - 58 * 60_000,
          lastPrompt: 'a prompt', lastAnswer: 'an answer', turnsLog: [], files: [] },
      });

      function Grid({ width }) {
        return <div className="ovt-grid" style={{ gridTemplateColumns: \`repeat(auto-fill, \${width}px)\` }}>
          {FIXTURES.map((f) => (
            <div key={f.group + f.name} data-fixture={f.group + '|' + f.name}>
              <Tile s={session(f.name)} group={f.group} onOpen={() => {}} />
            </div>
          ))}
        </div>;
      }
      window.__renderAt = (width) => {
        const host = document.getElementById('root');
        host.innerHTML = '<div id="grid"></div>';
        createRoot(document.getElementById('grid')).render(<Grid width={width} />);
      };
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
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
  if (!ok) failures += 1;
};

try {
  await page.setContent(`<style>${css}
    html, body { margin: 0; background: var(--bg); }
    #root { padding: 12px; }
  </style><div id="root"></div>`);
  await page.addScriptTag({ path: bundle });
  await page.waitForFunction(() => !!window.__renderAt);
  // Web fonts change every width; the component re-measures on fonts.ready and
  // so must this test, or it measures fallback metrics.
  await page.evaluate(() => document.fonts.ready);

  // A measured decision must SETTLE. Watch the head rows for the group being
  // added or removed: a hook that re-arms its own trigger flips it forever.
  // (Scoped to childList on purpose — the StateLogo animates an SVG attribute
  // thousands of times a second, which is not what this is about.)
  await page.evaluate((w) => window.__renderAt(w), 225);
  await page.waitForFunction(() => document.querySelectorAll('.ovt-tile').length > 0);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  const flips = await page.evaluate(() => new Promise((resolve) => {
    let n = 0;
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of [...r.addedNodes, ...r.removedNodes]) {
          if (node.nodeType === 1 && node.classList?.contains('ovt-gtag')) n += 1;
        }
      }
    });
    for (const head of document.querySelectorAll('.ovt-head')) obs.observe(head, { childList: true });
    setTimeout(() => { obs.disconnect(); resolve(n); }, 1500);
  }));
  check(flips === 0, `the group stops flipping once decided (${flips} add/remove in 1.5s after settling)`);

  for (const width of WIDTHS) {
    await page.evaluate((w) => window.__renderAt(w), width);
    await page.waitForFunction(() => document.querySelectorAll('.ovt-tile').length > 0);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const rows = await page.evaluate(() => [...document.querySelectorAll('[data-fixture]')].map((host) => {
      const key = host.dataset.fixture;
      const [group, name] = key.split('|');
      const head = host.querySelector('.ovt-head');
      const nameEl = head.querySelector('.ovt-name');
      const tag = head.querySelector('.ovt-gtag');
      const clipped = (el) => !!el && el.scrollWidth > el.clientWidth + 0.5;
      const shown = !!tag;
      const nameClipped = clipped(nameEl);
      const groupClipped = clipped(tag);
      // Would it have fitted? Put it back where the component dropped it and
      // ask the browser the same question about the real row.
      let wouldFit = shown && !nameClipped && !groupClipped;
      if (!shown) {
        const probe = document.createElement('span');
        probe.className = 'ovt-gtag mono';
        probe.textContent = group;
        head.insertBefore(probe, nameEl);
        void head.offsetWidth;
        wouldFit = !clipped(probe) && !clipped(nameEl);
        probe.remove();
      }
      return { key, group, name, shown, nameClipped, groupClipped, wouldFit,
        tileW: Math.round(host.querySelector('.ovt-tile').getBoundingClientRect().width) };
    }));

    console.log(`\n${width}px grid → tiles ${rows[0].tileW}px`);
    for (const r of rows) {
      // 1. while the group is shown, nothing on that row may truncate
      check(!(r.shown && (r.groupClipped || r.nameClipped)),
        `${r.key} — ${r.shown ? 'group shown' : 'group dropped'}, nothing clipped`
        + (r.shown && (r.groupClipped || r.nameClipped) ? ` (group ${r.groupClipped}, name ${r.nameClipped})` : ''));
      // 2. and it is shown exactly when it fits — no fact dropped that had room
      check(r.shown === r.wouldFit,
        `${r.key} — shown(${r.shown}) matches fits(${r.wouldFit})`);
    }
  }

  if (process.env.TILE_SHOTS) {
    fs.mkdirSync(process.env.TILE_SHOTS, { recursive: true });
    for (const width of [225, 276]) {
      await page.evaluate((w) => window.__renderAt(w), width);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme });
        const box = await page.locator('#root').boundingBox();
        await page.screenshot({ path: path.join(process.env.TILE_SHOTS, `tiles-${width}-${theme}.png`),
          clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 460) } });
      }
      await page.emulateMedia({ colorScheme: 'light' });
    }
  }
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\ntile-group-inline: the group is shown exactly when the row has space for it');
process.exit(failures ? 1 : 0);
