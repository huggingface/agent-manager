import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, serviceWorkers: 'block' })).newPage();
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 120)));
await p.goto('http://127.0.0.1:7788/', { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
await p.getByText('cadence', { exact: true }).first().click();
await p.waitForTimeout(800);
await p.locator('.modebar button:text-is("reader")').click();
await p.waitForTimeout(1800);

// paste a PNG into the reader's reply line, the way a screenshot arrives
await p.locator('.cxv-live textarea').click();
await p.evaluate(() => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVQoU2NkYGD4z0AEYBxViKEQAxE8xVGFGAoBI8oCAWlpUmYAAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
  const file = new File([png], 'screenshot.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  document.querySelector('.cxv-live textarea')
    .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await p.waitForTimeout(1200);
const dom = await p.evaluate(() => {
  const c = document.querySelector('.cxv-composer');
  return { hasComposer: !!c, html: c ? c.innerHTML.slice(0, 300) : null };
});
console.log('composer present:', dom.hasComposer, '|', dom.html?.replace(/\s+/g, ' ').slice(0, 200));
const chips = await p.locator('.cxv-composer .att-item, .cxv-composer [class*="att"]').count();
const sendVisible = await p.locator('.cxv-live .ov-send').count();
console.log(`attachment chips in the reader: ${chips}; send key visible with an empty box: ${sendVisible}`);
console.log(chips > 0 ? 'PASS  a pasted screenshot attaches in reader mode' : 'FAIL  nothing attached');
await p.screenshot({ path: '/tmp/app-shots/28-reader-paste.png' });
await b.close();
