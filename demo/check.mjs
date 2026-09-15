// Verifies the built demo in a real browser and FAILS on a regression.
//
// Every fact here was already being computed; it used to print them and exit 0,
// which meant a regressed build looked exactly like a good one. The invariants
// below are the demo's whole point: an initial fill that means something, the
// complete fixture reachable, injected context absent even with the work folds
// opened, and a reset that is genuinely cold.
//
// Run with:  node check.mjs          (after `node build.mjs`)
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs'; import net from 'node:net'; import path from 'node:path';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../scripts/test-chromium.mjs';

/** The fixture is generated with this many topic exchanges; nothing else counts. */
const EXPECTED_EXCHANGES = 90;
/** A first fill that shows one exchange is not "a useful amount of recent history". */
const MIN_INITIAL_EXCHANGES = 8;

const dist = path.resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.jsonl': 'text/plain', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.md': 'text/markdown' };
const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const server = http.createServer((req, res) => {
  const file = path.join(dist, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!file.startsWith(dist) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok   ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

let browser;
try {
  browser = await chromium.launch(chromiumLaunchOptions());
  const errors = [];
  const open = async (width, height) => {
    const p = await browser.newPage({ viewport: { width, height } });
    p.on('pageerror', (e) => errors.push(e.message.slice(0, 110)));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 110)}`); });
    await p.goto(`http://127.0.0.1:${port}/`);
    await p.waitForSelector('.cxv-body', { timeout: 20_000 });
    return p;
  };
  /** Resolves when the top row reaches a resting state. A timeout is a failure,
   *  never something to shrug off: a reader stuck mid-fill is the bug. */
  const settled = (p, where) => p.waitForFunction(() => {
    const t = document.querySelector('.cxv-top')?.textContent || '';
    return t.includes('Full history loaded') || t.includes('Load earlier turns');
  }, null, { timeout: 90_000 })
    .then(() => p.waitForTimeout(800))
    .catch(() => { throw new Error(`the reader never settled (${where})`); });
  const count = async (p) => Number((await p.locator('.cxv-status').textContent() || '')
    .match(/(\d+) turns loaded/)?.[1] || 0);
  /** Press Load earlier until the source is exhausted. Running out of attempts
   *  is a failure, not a quiet success. */
  const loadAll = async (p) => {
    for (let i = 0; i < 40; i++) {
      const row = p.locator('.cxv-top');
      if (((await row.textContent()) || '').includes('Full history loaded')) return;
      if (await row.isDisabled()) { await p.waitForTimeout(350); continue; }
      await row.click();
      await p.waitForTimeout(900);
    }
    throw new Error('Load earlier never reached the end of the conversation in 40 attempts');
  };
  /** Every exchange, with its work folds OPENED — collapsed content hides what
   *  the reader is actually holding, which is how the leak survived once. */
  const sweep = (p) => p.evaluate(async () => {
    const el = document.querySelector('.cxv-body');
    const keys = new Set(); const promptless = new Set(); let text = '';
    for (let y = 0; y <= el.scrollHeight + 400; y += Math.max(200, el.clientHeight - 120)) {
      el.scrollTop = y;
      await new Promise((r) => setTimeout(r, 90));
      for (const row of document.querySelectorAll('[data-x]')) {
        keys.add(row.dataset.x);
        if (!row.querySelector('.cx-prompt')) promptless.add(row.dataset.x);
        for (const fold of row.querySelectorAll('.cx-fold, .cs-head')) {
          try { fold.click(); } catch { /* not a button */ }
        }
      }
      await new Promise((r) => setTimeout(r, 120));
      text += (document.querySelector('.cxv-col')?.innerText || '');
    }
    return { keys: keys.size, promptless: [...promptless], text };
  });
  const INJECTED = ['BEGIN DEMO CONTEXT', '<environment_context>', 'skills_instructions', 'system-reminder'];

  for (const [label, width, height] of [['desktop', 1280, 860], ['phone', 390, 844]]) {
    console.log(`\n### ${label} (${width}x${height})`);
    const p = await open(width, height);
    const spinner = await p.waitForSelector('.cxv-top-spin', { timeout: 15_000 }).then(() => true).catch(() => false);
    await settled(p, `${label}: first fill`);
    const initial = await count(p);
    check(`the first fill shows the spinner and lands on ${initial} exchanges`, () => {
      assert.equal(spinner, true, 'no spinner was shown while the reader filled');
      assert.ok(initial >= MIN_INITIAL_EXCHANGES,
        `a cold reader should hold at least ${MIN_INITIAL_EXCHANGES} exchanges, got ${initial}`);
      assert.ok(initial < EXPECTED_EXCHANGES,
        `the demo needs history left to page (got all ${initial} at once)`);
    });

    await loadAll(p);
    const seen = await sweep(p);
    const top = await p.evaluate(() => {
      const t = document.querySelector('.cxv-top');
      return { text: t?.textContent?.trim(), disabled: t?.disabled, arrow: !!document.querySelector('.cxv-top-arrow') };
    });
    check(`the whole fixture is reachable: ${EXPECTED_EXCHANGES} exchanges`, () => {
      assert.equal(seen.keys, EXPECTED_EXCHANGES, `saw ${seen.keys}`);
    });
    check('no exchange was opened by something with no prompt', () => {
      assert.deepEqual(seen.promptless, [], `promptless exchanges: ${seen.promptless.join(', ')}`);
    });
    check('no injected context anywhere, with every work fold opened', () => {
      const found = INJECTED.filter((needle) => seen.text.includes(needle));
      assert.deepEqual(found, [], `injected text visible: ${found.join(', ')}`);
    });
    check('prompts that mention skills and AGENTS.md are kept', () => {
      assert.ok(seen.text.includes('read the environment skill'), 'the environment-skill prompt is missing');
      assert.ok(seen.text.includes('update AGENTS.md instructions'), 'the AGENTS.md prompt is missing');
    });
    check('tool work is rendered', () => {
      assert.match(seen.text, /\d+ tools?\b/, 'no exchange reported tool work');
    });
    check('the exhausted top row is a terminal state, not a control', () => {
      assert.equal(top.text, 'Full history loaded', `top row says ${JSON.stringify(top.text)}`);
      assert.equal(top.disabled, true, 'it is still clickable');
      assert.equal(top.arrow, false, 'it still shows the arrow');
    });

    if (label === 'desktop') {
      // Reset after a full load: a cold run must fill again from a small window.
      await p.getByRole('button', { name: /reset/ }).click();
      const spunAgain = await p.waitForSelector('.cxv-top-spin', { timeout: 15_000 }).then(() => true).catch(() => false);
      await settled(p, 'reset after a full load');
      const after = await count(p);
      check('reset after a full load returns to the cold-start count, with a spinner', () => {
        assert.equal(spunAgain, true, 'no spinner after reset');
        assert.equal(after, initial, `expected ${initial} exchanges, got ${after}`);
      });

      // Reset pressed DURING a fill must also start over cleanly.
      await p.getByRole('button', { name: /reset/ }).click();
      await p.waitForTimeout(250);
      await p.getByRole('button', { name: /reset/ }).click();
      const spunThird = await p.waitForSelector('.cxv-top-spin', { timeout: 15_000 }).then(() => true).catch(() => false);
      await settled(p, 'reset during a fill');
      const third = await count(p);
      check('reset pressed during a fill does the same', () => {
        assert.equal(spunThird, true, 'no spinner after the mid-fill reset');
        assert.equal(third, initial, `expected ${initial} exchanges, got ${third}`);
      });
    }
    await p.screenshot({ path: `/tmp/demo-${label}.png` });
    await p.close();
  }

  check('the page reported no errors', () => {
    assert.deepEqual([...new Set(errors)], [], `page/console errors: ${[...new Set(errors)].slice(0, 3).join(' | ')}`);
  });
} finally {
  // Always let the process exit, including on an assertion or a timeout.
  await browser?.close().catch(() => {});
  server.close();
}
console.log(failed ? `\n${failed} failed` : '\ndemo check: history, filtering and reset all hold');
process.exit(failed ? 1 : 0);
