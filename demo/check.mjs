import http from 'node:http';
import fs from 'node:fs'; import net from 'node:net'; import path from 'node:path';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../scripts/test-chromium.mjs';

const dist = path.resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.jsonl': 'text/plain', '.woff2': 'font/woff2' };
const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const server = http.createServer((req, res) => {
  const file = path.join(dist, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!file.startsWith(dist) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));

const browser = await chromium.launch(chromiumLaunchOptions());
const errors = [];
const page = async (width, height) => {
  const p = await browser.newPage({ viewport: { width, height } });
  p.on('pageerror', (e) => errors.push(e.message.slice(0, 110)));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 110)}`); });
  await p.goto(`http://127.0.0.1:${port}/`);
  await p.waitForSelector('.cxv-body', { timeout: 20_000 });
  return p;
};
const settled = (p) => p.waitForFunction(() => {
  const t = document.querySelector('.cxv-top')?.textContent || '';
  return t.includes('Full history loaded') || t.includes('Load earlier turns');
}, null, { timeout: 90_000 }).then(() => p.waitForTimeout(800)).catch(() => {});
const loadAll = async (p) => {
  for (let i = 0; i < 25; i++) {
    const row = p.locator('.cxv-top');
    const text = (await row.textContent()) || '';
    if (text.includes('Full history loaded')) return;
    if (await row.isDisabled()) { await p.waitForTimeout(350); continue; }
    await row.click(); await p.waitForTimeout(900);
  }
};
/** Every exchange, with its work folds OPENED — the reviewer's point was that
 *  collapsed content hides what the reader is really holding. */
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

const dist_ = null;
for (const [label, width, height] of [['desktop', 1280, 860], ['phone', 390, 844]]) {
  const p = await page(width, height);
  const spinner = await p.waitForSelector('.cxv-top-spin', { timeout: 15_000 }).then(() => true).catch(() => false);
  await settled(p);
  const initial = Number((await p.locator('.cxv-status').textContent() || '').match(/(\d+) turns loaded/)?.[1] || 0);
  await loadAll(p);
  const seen = await sweep(p);
  const top = await p.evaluate(() => {
    const t = document.querySelector('.cxv-top');
    return { text: t?.textContent?.trim(), disabled: t?.disabled, arrow: !!document.querySelector('.cxv-top-arrow') };
  });
  console.log(`\n### ${label} (${width}x${height})`);
  console.log('  spinner on first fill      :', spinner, '· initial exchanges:', initial);
  console.log('  exchanges after full load  :', seen.keys, '· promptless:', seen.promptless.length, seen.promptless.slice(0, 3));
  console.log('  top row                    :', JSON.stringify(top.text), 'disabled', top.disabled, 'arrow', top.arrow);
  console.log('  injected text anywhere     :',
    seen.text.includes('BEGIN DEMO CONTEXT') || seen.text.includes('<environment_context>')
    || seen.text.includes('skills_instructions') || seen.text.includes('system-reminder'));
  console.log('  real skill prompt kept     :', seen.text.includes('read the environment skill'),
    '· AGENTS prompt kept:', seen.text.includes('update AGENTS.md instructions'));
  console.log('  tool work visible          :', /\d+ tools?\b/.test(seen.text));

  if (label === 'desktop') {
    // Reset after a full load: a cold run must fill again from a small window.
    await p.getByRole('button', { name: /reset/ }).click();
    const spunAgain = await p.waitForSelector('.cxv-top-spin', { timeout: 15_000 }).then(() => true).catch(() => false);
    await settled(p);
    const after = Number((await p.locator('.cxv-status').textContent() || '').match(/(\d+) turns loaded/)?.[1] || 0);
    console.log('  reset after full load      : spinner', spunAgain, '· exchanges back to', after,
      after === initial ? '(same as a cold start)' : `(EXPECTED ${initial})`);

    // Reset DURING a fill: pressing mid-flight must also start over cleanly.
    await p.getByRole('button', { name: /reset/ }).click();
    await p.waitForTimeout(250);
    await p.getByRole('button', { name: /reset/ }).click();
    const spunThird = await p.waitForSelector('.cxv-top-spin', { timeout: 15_000 }).then(() => true).catch(() => false);
    await settled(p);
    const third = Number((await p.locator('.cxv-status').textContent() || '').match(/(\d+) turns loaded/)?.[1] || 0);
    console.log('  reset during a fill        : spinner', spunThird, '· exchanges', third,
      third === initial ? '(same as a cold start)' : `(EXPECTED ${initial})`);
  }
  await p.screenshot({ path: `/tmp/demo-${label}.png` });
  await p.close();
}
console.log('\npage errors:', errors.length ? [...new Set(errors)].slice(0, 4) : 'none');
await browser.close(); server.close();
