import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../scripts/test-chromium.mjs';
const URL = 'https://lvwerra-am-reader-demo.static.hf.space/index.html';
const browser = await chromium.launch(chromiumLaunchOptions());
for (const [label, width, height] of [['desktop', 1280, 860], ['phone', 390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width, height },
    extraHTTPHeaders: { authorization: `Bearer ${process.env.HF_TOKEN}` } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message.slice(0, 100)));
  p.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url().slice(-40)}`); });
  await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await p.waitForSelector('.cxv-body', { timeout: 40_000 });
  const spinner = await p.waitForSelector('.cxv-top-spin', { timeout: 20_000 }).then(() => true).catch(() => false);
  await p.waitForFunction(() => {
    const t = document.querySelector('.cxv-top')?.textContent || '';
    return t.includes('Full history loaded') || t.includes('Load earlier turns');
  }, null, { timeout: 90_000 }).catch(() => {});
  await p.waitForTimeout(1500);
  const seen = await p.evaluate(async () => {
    const el = document.querySelector('.cxv-body');
    const keys = new Set(); let text = '';
    for (let y = 0; y <= el.scrollHeight; y += Math.max(200, el.clientHeight - 100)) {
      el.scrollTop = y; await new Promise((r) => setTimeout(r, 80));
      for (const n of document.querySelectorAll('[data-x]')) keys.add(n.dataset.x);
      text += (document.querySelector('.cxv-col')?.innerText || '');
    }
    const top = document.querySelector('.cxv-top');
    return { exchanges: keys.size, top: top?.textContent?.trim(), disabled: top?.disabled,
      arrow: !!document.querySelector('.cxv-top-arrow'), color: getComputedStyle(top).color,
      leaked: text.includes('BEGIN DEMO CONTEXT') || text.includes('skills loaded:'),
      realKept: text.includes('read the environment skill'),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  });
  console.log(`\n### deployed · ${label} (${width}x${height})`);
  console.log('  spinner while filling :', spinner);
  console.log('  exchanges             :', seen.exchanges);
  console.log('  top row               :', JSON.stringify(seen.top), '| disabled', seen.disabled, '| arrow', seen.arrow, '|', seen.color);
  console.log('  injected leaked       :', seen.leaked, '· real skill prompt kept:', seen.realKept);
  console.log('  horizontal overflow   :', seen.overflowX);
  console.log('  errors                :', errors.length ? errors.slice(0, 3) : 'none');
  await p.screenshot({ path: `/tmp/live-${label}.png` });
  await ctx.close();
}
await browser.close();
