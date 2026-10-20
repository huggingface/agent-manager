// Framing protection end to end, in real browsers against the real server and
// the real built app:
//   - a foreign page framing the app is blocked by the server's frame-ancestors,
//     and nothing in it receives the clicks and keys aimed at the app;
//   - with that header stripped, the app itself refuses to render and shows only
//     an "Open Agent Manager" button;
//   - top-level loads, the app framing itself, and the Hub's Space page still work;
//     Hub-hosted content that frames a Space sandboxed (no same-origin) does not;
//   - where location.ancestorOrigins is missing, unverifiable ancestry fails closed.
// The Hub and Spaces are emulated with request routing (no network): their pages
// are fixtures, and *.hf.space requests are served by a local Space-mode server.
// Chromium always runs. Firefox and WebKit run when Playwright can launch them
// here, and print SKIP otherwise.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'vite';
import { build as esbuild } from 'esbuild';
import { chromium, firefox, webkit } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
import { framingServers } from '../../server/test/fixtures/framing-server.mjs';
import { REQUEST_HEADERS } from '../../server/src/request-admission.js';

const web = fileURLToPath(new URL('..', import.meta.url));
const fixture = await framingServers();
const SPACE_HOST = 'owner-space.hf.space';
const SPACE = `https://${SPACE_HOST}`;
const HUB = 'https://huggingface.co';
const EVIL = 'https://evil.example';
// The page framing the plain-http local app is a real local server at another
// origin: an https page would be blocked as mixed content (WebKit), and a
// routed "public" one by Chromium's local-network rules, both before
// frame-ancestors is ever consulted.
let EVIL_HTTP;
// What the attacker frames: a deep path, foreign parameters (one shaped like the
// Hub's sign-in token, one allowlisted app parameter) and a hash. The fallback's
// link must carry none of it.
const FOREIGN_ADDRESS = '/deep/path?__sign=SECRET&other=SECRET2&redirect=https%3A%2F%2Fevil.example&vvdebug=1#file=a.md';
const marker = { ...REQUEST_HEADERS, 'x-am-origin': 'operator', 'content-type': 'application/json' };

let local, space, evilServer;
const failures = [];
// The shipped ancestry helper as a script, for case 9.
const FRAMING_IIFE = (await esbuild({ entryPoints: [path.join(web, 'src/lib/framing.ts')], bundle: true, write: false,
  format: 'iife', globalName: 'framing', logLevel: 'silent' })).outputFiles[0].text;
try {
  // The run's shared build when there is one (scripts/run-suites.mjs), copied
  // because this suite adds a page to it; otherwise its own.
  if (process.env.AM_TEST_DIST) fs.cpSync(process.env.AM_TEST_DIST, fixture.publicDir, { recursive: true });
  else await build({ root: web, logLevel: 'silent', build: { outDir: fixture.publicDir, emptyOutDir: true } });
  // A page of the app's own origin that frames the app (same-origin framing).
  fs.writeFileSync(path.join(fixture.publicDir, 'frame-self.html'),
    '<!doctype html><body style="margin:0"><iframe id="app" src="/" style="border:0;width:1200px;height:700px"></iframe></body>');
  local = await fixture.start('local');
  evilServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><body style="margin:0"><p>Click Start, then type your nickname</p><iframe id="app" src="${local.base}${FOREIGN_ADDRESS}" style="position:absolute;left:0;top:0;border:0;width:1200px;height:700px;opacity:0.01"></iframe></body>`);
  });
  await new Promise((r) => evilServer.listen(0, '127.0.0.1', r));
  EVIL_HTTP = `http://localhost:${evilServer.address().port}`;
  space = await fixture.start('space', { SPACE_ID: 'owner/space', SPACE_HOST });
  const shell = await (await fetch(`${local.base}/api/sessions`, { method: 'POST', headers: marker,
    body: JSON.stringify({ cli: 'shell', path: '.', name: 'framing-shell' }) })).json();
  assert.ok(shell.id, 'a shell session to aim at');
  await fetch(`${space.base}/api/sessions`, { method: 'POST', headers: marker, body: JSON.stringify({ cli: 'files', path: '.', name: 'space-probe' }) });
  // Past the first-run welcome, so the layout is the everyday one.
  for (const srv of [local, space]) await fetch(`${srv.base}/api/welcome/seen`, { method: 'POST', headers: marker, body: '{}' });

  // AM_FRAMING_ENGINES=firefox,webkit narrows a manual run.
  const only = process.env.AM_FRAMING_ENGINES?.split(',');
  const engines = [['chromium', chromium, chromiumLaunchOptions()], ['firefox', firefox, {}], ['webkit', webkit, {}]]
    .filter(([name]) => !only || only.includes(name));
  for (const [name, type, options] of engines) {
    let browser;
    try { browser = await type.launch(options); } catch (e) {
      if (name === 'chromium') throw e;
      console.log(`SKIP ${name}: cannot launch here (${String(e.message).split('\n')[0]})`);
      continue;
    }
    try { await runEngine(name, browser); } catch (e) { failures.push(name); console.error(`FAIL ${name}: ${e.stack || e}`); } finally { await browser.close(); }
  }
} finally {
  await local?.stop(); await space?.stop(); evilServer?.close();
  await fixture.cleanup();
}
if (failures.length) { console.error(`framing browser: failed in ${failures.join(', ')}`); process.exit(1); }
console.log('framing browser: all checks passed');

async function runEngine(engine, browser) {
  const pwned = (tag) => path.join(local.workspaces, `pwned-${engine}-${tag}`);
  // The keystrokes an attacker wants delivered: a command that leaves a file.
  const command = (tag) => `echo hit > ${pwned(tag)}`;

  // Routes: fake Hub/attacker pages; *.hf.space → the Space-mode server.
  async function context({ stripCsp = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 700 } });
    ctx.setDefaultTimeout(15000);
    const pages = {
      [`${EVIL}/frame-space`]: `<iframe id="app" src="${SPACE}/" style="border:0;width:1200px;height:700px"></iframe>`,
      [`${HUB}/spaces/owner/space`]: `<iframe id="app" src="${SPACE}/" sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts allow-storage-access-by-user-activation" style="border:0;width:1200px;height:700px"></iframe>`,
      [`${HUB}/blog/someone/post`]: `<iframe id="app" src="${SPACE}/" sandbox="allow-scripts" referrerpolicy="same-origin" style="border:0;width:1200px;height:700px"></iframe>`,
      [`${HUB}/spaces/evil/space`]: `<iframe id="app" src="https://evil-space.hf.space/" style="border:0;width:1200px;height:700px"></iframe>`,
      ['https://evil-space.hf.space/']: `<iframe id="app" src="${SPACE}/" style="border:0;width:1100px;height:650px"></iframe>`,
    };
    await ctx.route((url) => pages[url.href] !== undefined, (route) => route.fulfill({ status: 200, contentType: 'text/html',
      body: `<!doctype html><body style="margin:0"><p>Click Start, then type your nickname</p>${pages[route.request().url()]}</body>` }));
    const strip = (headers) => Object.fromEntries(Object.entries(headers).filter(([k]) => !stripCsp || k.toLowerCase() !== 'content-security-policy'));
    await ctx.route((url) => url.origin === SPACE, async (route) => {
      const u = new URL(route.request().url());
      const response = await route.fetch({ url: `${space.base}${u.pathname}${u.search}`, maxRedirects: 0 });
      await route.fulfill({ response, headers: strip(response.headers()) });
    });
    if (stripCsp) {
      await ctx.route((url) => url.origin === local.base, async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, headers: strip(response.headers()) });
      });
    }
    return ctx;
  }
  // Everything the page asked either app server for, and its sockets.
  function watch(page) {
    const seen = { requests: [], sockets: [] };
    page.on('request', (r) => {
      const url = new URL(r.url());
      if ([local.base, SPACE].includes(url.origin)) seen.requests.push(url.pathname);
    });
    page.on('websocket', (ws) => seen.sockets.push(ws.url()));
    return seen;
  }
  const appFrame = (page) => page.frames().find((f) => f !== page.mainFrame());
  // A blocked frame holds the browser's error page (chrome-error://, or no URL
  // at all in Firefox, where querying it never answers): no app document.
  const showsApp = async (frame, text) => {
    if (!frame || !/^https?:/.test(frame.url())) return false;
    const count = await Promise.race([frame.getByText(text, { exact: true }).count(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`frame ${frame.url()} did not answer`)), 5000))]);
    return count > 0;
  };
  const fallbackIn = (frame) => frame.getByRole('button', { name: 'Open Agent Manager' });
  // Blocked by frame-ancestors: the frame asked for the app document and got
  // nothing else of it (no script, style or API read ever ran).
  const assertBlocked = (seen, label) => {
    const [document, ...rest] = seen.requests;
    assert.ok(['/', new URL(FOREIGN_ADDRESS, local.base).pathname].includes(document), `${label}: the frame did ask for the app (and was refused): ${seen.requests}`);
    assert.deepEqual(rest.filter((p) => p !== document), [], `${label}: blocked frame loaded nothing of the app: ${seen.requests}`);
  };
  const pass = (what) => console.log(`PASS ${engine}: ${what}`);

  // 1. Top-level load works.
  {
    const ctx = await context(); const page = await ctx.newPage();
    await page.goto(`${local.base}/`);
    await page.getByText('framing-shell', { exact: true }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Open Agent Manager' }).count(), 0);
    await ctx.close(); pass('top-level load renders the app');
  }

  // 2. The app framing itself works, and (Chromium) a click-then-type in that
  //    frame does reach the shell: the control that makes the negative checks
  //    below meaningful. Its click positions are reused by the attacker pages.
  let target = null;
  {
    const ctx = await context(); const page = await ctx.newPage();
    await page.goto(`${local.base}/frame-self.html`);
    const frame = page.frameLocator('#app');
    await frame.getByText('framing-shell', { exact: true }).first().waitFor();
    const item = await frame.getByText('framing-shell', { exact: true }).first().boundingBox();
    target = { x: item.x + item.width / 2, y: item.y + item.height / 2 };
    if (process.env.SHOT) console.log('target', JSON.stringify(item), await frame.getByText('framing-shell', { exact: true }).count());
    if (engine === 'chromium') {
      await page.mouse.click(target.x, target.y);
      await frame.locator('.xterm, canvas, [class*=terminal]').first().waitFor().catch(() => {});
      await page.waitForTimeout(2500);
      await page.mouse.click(700, 350);
      await page.keyboard.type(command('control'), { delay: 10 });
      await page.keyboard.press('Enter');
      for (let i = 0; i < 50 && !fs.existsSync(pwned('control')); i++) await page.waitForTimeout(200);
      if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
      assert.ok(fs.existsSync(pwned('control')), 'control: input in a trusted same-origin frame reaches the shell');
      pass('same-origin frame renders and receives input (harness control)');
    } else pass('same-origin frame renders the app');
    await ctx.close();
  }

  // The attack: click where the shell entry is, click into the terminal, type.
  async function attack(page, tag) {
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(2000);
    await page.mouse.click(700, 350);
    await page.keyboard.type(command(tag), { delay: 10 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    assert.ok(!fs.existsSync(pwned(tag)), `${tag}: the command must not run`);
  }

  // 3. A foreign page framing the app: the browser blocks the frame outright.
  {
    const ctx = await context(); const page = await ctx.newPage(); const seen = watch(page);
    await page.goto(`${EVIL_HTTP}/frame-local`);
    await page.waitForTimeout(3000);
    assert.ok(!(await showsApp(appFrame(page), 'framing-shell')), 'blocked frame shows no app');
    await attack(page, 'foreign');
    assertBlocked(seen, 'foreign');
    assert.deepEqual(seen.sockets, [], 'blocked frame opened no terminal socket');
    await ctx.close(); pass('foreign frame blocked by frame-ancestors; input reaches nothing');
  }

  // 4. Same, with the header stripped on the way: the app's own check holds.
  {
    const ctx = await context({ stripCsp: true }); const page = await ctx.newPage(); const seen = watch(page);
    await page.goto(`${EVIL_HTTP}/frame-local`);
    const frame = appFrame(page);
    await fallbackIn(page.frameLocator('#app')).waitFor();
    assert.ok(!(await showsApp(frame, 'framing-shell')), 'fallback renders no interface');
    await attack(page, 'stripped');
    assert.deepEqual(seen.sockets, [], 'no terminal socket from the fallback');
    const apiReads = seen.requests.filter((p) => p.startsWith('/api/'));
    assert.deepEqual([...new Set(apiReads)], ['/api/info'], `fallback reads only /api/info: ${apiReads}`);
    // The button opens the app's root in its own tab: nothing of the framed address.
    if (engine === 'chromium') {
      const [popup] = await Promise.all([ctx.waitForEvent('page'), page.frameLocator('#app').getByRole('button', { name: 'Open Agent Manager' }).click({ force: true })]);
      await popup.waitForLoadState();
      assert.equal(popup.url(), `${local.base}/`, 'fallback opens the bare app root');
    }
    await ctx.close(); pass('header stripped: in-app fallback only, input reaches nothing');
  }

  // 5. The Hub's Space page embeds the Space: renders.
  {
    const ctx = await context(); const page = await ctx.newPage();
    await page.goto(`${HUB}/spaces/owner/space`);
    await page.frameLocator('#app').getByText('space-probe', { exact: true }).first().waitFor();
    assert.equal(await fallbackIn(page.frameLocator('#app')).count(), 0);
    await ctx.close(); pass('Hub Space page embed renders the app');
  }

  // 6. A foreign page framing the Space: blocked; and stripped: fallback.
  for (const stripCsp of [false, true]) {
    const ctx = await context({ stripCsp }); const page = await ctx.newPage(); const seen = watch(page);
    await page.goto(`${EVIL}/frame-space`);
    if (stripCsp) await fallbackIn(page.frameLocator('#app')).waitFor();
    else await page.waitForTimeout(3000);
    assert.ok(!(await showsApp(appFrame(page), 'space-probe')), `foreign frame of the Space shows no app (stripped=${stripCsp})`);
    if (!stripCsp) assertBlocked(seen, 'foreign frame of the Space');
    await ctx.close();
  }
  pass('foreign frame of a Space: blocked, and fallback when stripped');

  // 7. Another Space inside the Hub page framing this one: every ancestor counts.
  for (const stripCsp of [false, true]) {
    const ctx = await context({ stripCsp }); const page = await ctx.newPage(); const seen = watch(page);
    await page.goto(`${HUB}/spaces/evil/space`);
    await page.waitForTimeout(3000);
    const inner = page.frames().find((f) => f.url().startsWith(SPACE));
    assert.ok(!(await showsApp(inner, 'space-probe')), `nested in another Space shows no app (stripped=${stripCsp})`);
    if (!stripCsp) assertBlocked(seen, 'nested');
    if (stripCsp) assert.ok(inner && (await inner.getByRole('button', { name: 'Open Agent Manager' }).count()) > 0, 'nested: fallback shown');
    await ctx.close();
  }
  pass('Space nested inside another Space on the Hub: blocked');

  // 8. Hub-hosted user content framing the Space sandboxed (no same-origin):
  //    the frame is admitted by frame-ancestors but the app does not render.
  {
    const ctx = await context(); const page = await ctx.newPage();
    await page.goto(`${HUB}/blog/someone/post`);
    await page.waitForTimeout(4000);
    assert.ok(!(await showsApp(appFrame(page), 'space-probe')), 'sandboxed embed shows no app');
    await ctx.close(); pass('sandboxed Hub embed renders no interface');
  }

  // 9. Engines without location.ancestorOrigins. Pages can't remove it from a
  //    real Location, so the shipped helper runs inside the real frames with the
  //    frame's own parent/top windows (real cross-origin errors) and a location
  //    view that lacks the list. Unverifiable ancestry must fail closed.
  {
    const ctx = await context({ stripCsp: true }); const page = await ctx.newPage();
    const verdictWithoutList = (frame) => frame.evaluate((helper) => {
      const framing = new Function(`${helper}; return framing;`)();
      const win = { self: window, top: window.top, parent: window.parent, origin: self.origin,
        location: { origin: location.origin, hostname: location.hostname } };
      return framing.frameVerdict({ win }, [location.origin, framing.HUB_ORIGIN]);
    }, FRAMING_IIFE);
    await page.goto(`${local.base}/frame-self.html`);
    await page.frameLocator('#app').getByText('framing-shell', { exact: true }).first().waitFor();
    assert.equal(await verdictWithoutList(appFrame(page)), 'trusted', 'same-origin parent: verified directly');
    await page.goto(`${EVIL_HTTP}/frame-local`);
    await fallbackIn(page.frameLocator('#app')).waitFor();
    assert.equal(await verdictWithoutList(appFrame(page)), 'untrusted', 'foreign parent: fails closed');
    await page.goto(`${HUB}/spaces/owner/space`);
    await page.frameLocator('#app').getByText('space-probe', { exact: true }).first().waitFor();
    assert.equal(await verdictWithoutList(appFrame(page)), 'untrusted', 'Hub parent: unverifiable without the list, so the button');
    await ctx.close(); pass('without ancestorOrigins: same-origin trusted, foreign parent and Hub fail closed');
  }
}
