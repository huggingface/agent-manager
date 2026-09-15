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
const look = async (width, height, label) => {
  const p = await browser.newPage({ viewport: { width, height } });
  p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text().slice(0, 120)}`); });
  p.on('requestfailed', (r) => errors.push(`${label} failed: ${r.url().slice(-60)}`));
  p.on('response', (r) => { if (r.status() >= 400) errors.push(`${label} ${r.status()}: ${r.url().slice(-60)}`); });
  await p.goto(`http://127.0.0.1:${port}/`);
  await p.waitForSelector('.cxv-body', { timeout: 20_000 });
  // The spinner must be visible while the automatic fill runs.
  const spinnerSeen = await p.waitForSelector('.cxv-top-spin', { timeout: 15_000 }).then(() => true).catch(() => false);
  const busyText = await p.locator('.cxv-top').textContent().catch(() => '');
  // Let the fill finish.
  await p.waitForFunction(() => {
    const t = document.querySelector('.cxv-top')?.textContent || '';
    return t.includes('Full history loaded') || t.includes('Load earlier turns');
  }, null, { timeout: 60_000 }).catch(() => {});
  await p.waitForTimeout(1500);
  // Scroll the whole reader so every exchange mounts at least once; the list is
  // virtualized, so counting mounted rows at one scroll position measures the
  // viewport, not the history.
  const seen = await p.evaluate(async () => {
    const el = document.querySelector('.cxv-body');
    const keys = new Set(); const steps = new Set(); const text = [];
    for (let y = 0; y <= el.scrollHeight; y += Math.max(200, el.clientHeight - 100)) {
      el.scrollTop = y;
      await new Promise((r) => setTimeout(r, 90));
      for (const n of document.querySelectorAll('[data-x]')) keys.add(n.dataset.x);
      // Work is summarised behind a disclosure ("2 steps · 1 tool"); that
      // summary is the visible evidence a tool ran, not an expanded step row.
      for (const n of document.querySelectorAll('[data-x]')) {
        const m = (n.innerText || '').match(/\d+ tools?\b/);
        if (m) steps.add(n.dataset.x);
      }
      text.push(document.querySelector('.cxv-col')?.innerText || '');
    }
    el.scrollTop = el.scrollHeight;
    return { keys: keys.size, steps: steps.size, text: text.join('\n') };
  });
  const state = await p.evaluate(() => {
    const top = document.querySelector('.cxv-top');
    const status = document.querySelector('.cxv-status')?.textContent || '';
    return {
      reported: status.trim().split('·')[0].trim(),
      topText: top?.textContent?.trim(),
      topDisabled: top?.disabled,
      topColor: top ? getComputedStyle(top).color : null,
      hasArrow: !!document.querySelector('.cxv-top-arrow'),
    };
  });
  state.exchangesSeen = seen.keys;
  state.leaked = seen.text.includes('BEGIN DEMO CONTEXT') || seen.text.includes('skills loaded:');
  state.realPromptKept = seen.text.includes('read the environment skill');
  state.agentsPromptKept = seen.text.includes('update AGENTS.md instructions for the new layout');
  state.toolRows = seen.steps;
  console.log(`\n### ${label} (${width}x${height})`);
  console.log('  spinner seen while filling :', spinnerSeen, busyText ? `(row said: ${JSON.stringify(busyText.trim().slice(0, 40))})` : '');
  console.log('  reader reports             :', JSON.stringify(state.reported));
  console.log('  distinct exchanges mounted :', state.exchangesSeen);
  console.log('  top row                    :', JSON.stringify(state.topText), 'disabled:', state.topDisabled, 'arrow:', state.hasArrow);
  console.log('  injected context leaked    :', state.leaked);
  console.log('  real skill prompt kept     :', state.realPromptKept, '· AGENTS.md prompt kept:', state.agentsPromptKept);
  console.log('  exchanges showing tool work:', state.toolRows);
  // The operator's manual test: keep pressing until the source is exhausted.
  if (label === 'desktop') {
    let presses = 0;
    while (presses < 12) {
      const row = p.locator('.cxv-top');
      if ((await row.textContent() || '').includes('Full history loaded')) break;
      if (await row.isDisabled()) { await p.waitForTimeout(400); continue; }
      await row.click(); presses++;
      await p.waitForTimeout(1200);
    }
    const end = await p.evaluate(() => ({
      text: document.querySelector('.cxv-top')?.textContent?.trim(),
      disabled: document.querySelector('.cxv-top')?.disabled,
      arrow: !!document.querySelector('.cxv-top-arrow'),
      color: getComputedStyle(document.querySelector('.cxv-top')).color,
    }));
    console.log(`  after ${presses} presses         :`, JSON.stringify(end));
  }
  await p.screenshot({ path: `/tmp/demo-${label}.png`, fullPage: false });
  await p.close();
  return state;
};
const desk = await look(1280, 860, 'desktop');
const phone = await look(390, 844, 'phone');
console.log('\npage errors:', errors.length ? errors.slice(0, 4) : 'none');
await browser.close(); server.close();
