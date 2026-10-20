// Startup cost of a production build, measured in a real Chromium against the
// fixture fleet (web/test/helpers/fixture-server.mjs), before and after a change
// to how the app loads. Every number here is a measurement of THIS machine under
// the stated conditions — compare two runs of this script, never a run to a
// figure from somewhere else.
//
// For each profile × scenario, `--runs` cold visits (fresh browser profile,
// HTTP cache disabled, nothing preloaded) record:
//   js.bytes / js.count   script bytes and requests until the view was usable
//   script / compile      V8 ScriptDuration and V8CompileDuration (ms) at that point
//   nav                   ms from navigation start until the sidebar lists sessions
//   view                  ms until the selected view's first useful interaction:
//                         Overview cards, the Reader's first exchange + composer,
//                         the Files listing, the Trace's first turn, both group tiles
// then, from a warm Overview, the cost of opening each deferred panel the first
// time (its chunk on the wire) and again (from the module cache): Settings and
// each subpage, Files, Trace.
//
// Profiles: desktop (1280×800, no throttling) and mobile-like (390×844, 4× CPU
// slowdown, 1.6 Mbps down / 750 kbps up / 150 ms RTT — Chrome's "Slow 4G").
// The server does not compress; gzip sizes are computed from the files.
//
//   node scripts/startup-bench.mjs --dist <web/dist> --label before --runs 5 --out before.json
//
// am-test: manual — a benchmark, not a pass/fail suite.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { chromium } from '../web/node_modules/playwright/index.mjs';
import { chromiumLaunchOptions } from './test-chromium.mjs';
import { startFixtureServer } from '../web/test/helpers/fixture-server.mjs';
import { MARK } from '../web/test/helpers/markers.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const DIST = path.resolve(arg('dist'));
const LABEL = arg('label', path.basename(DIST));
const RUNS = Number(arg('runs', 5));
const OUT = arg('out', `startup-${LABEL}.json`);
const PORT = Number(arg('port', 7905));
const PROFILES = arg('profiles', 'desktop,mobile').split(',');

const MOBILE = { cpu: 4, latency: 150, down: 1.6e6 / 8, up: 750e3 / 8 };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const stat = (a) => ({ median: med(a), min: Math.min(...a), max: Math.max(...a), n: a.length });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await startFixtureServer({ port: PORT, publicDir: DIST, tag: 'am-bench-' });
const { ids } = server;
const browser = await chromium.launch(chromiumLaunchOptions());

// A view is usable at its first USEFUL content — see web/test/helpers/markers.mjs.
const SCENARIOS = [
  { id: 'overview', restore: 'overview', view: ['overview'] },
  { id: 'reader', restore: `s:${ids.cadence}`, view: ['reader', 'composer'] },
  { id: 'reader-empty', restore: `s:${ids.fresh}`, view: ['composer'] },
  { id: 'files', restore: `s:${ids.files}`, view: ['files'] },
  { id: 'trace', restore: `s:${ids.trace}`, view: ['trace'] },
  // A phone shows one pane of a group at a time, so only the focused one can land.
  { id: 'group', restore: `g:${ids.group}`, focused: ids.groupFiles, view: ['files', 'trace'], mobileView: ['files'] },
];

// `stage`: on a phone, start on the selected view (true) or on the sidebar list
// (false) — the Settings button lives in the sidebar.
async function visit(profile, scenario, { stage = true, want: wantOnly = null } = {}) {
  const mobile = profile === 'mobile';
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Performance.enable');
  if (mobile) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: MOBILE.cpu });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: MOBILE.latency, downloadThroughput: MOBILE.down, uploadThroughput: MOBILE.up });
  }
  const js = new Map(); // requestId -> {url, bytes}
  cdp.on('Network.requestWillBeSent', (e) => { if (e.type === 'Script') js.set(e.requestId, { url: e.request.url, bytes: 0, t: null }); });
  cdp.on('Network.loadingFinished', (e) => { const r = js.get(e.requestId); if (r) { r.bytes = e.encodedDataLength; r.t = e.timestamp; } });
  await page.addInitScript(({ restore, focused, mobile, marks }) => {
    localStorage.setItem('am-active-ref', restore);
    if (focused) localStorage.setItem('am-focused-id', focused);
    localStorage.setItem('am-pane-mode', 'reader');
    if (mobile) localStorage.setItem('am-mobile-stage', '1');
    // First appearance of each marker, stamped by a MutationObserver rather than
    // by polling from outside, so the numbers are the DOM's, not the harness's.
    const seen = (window.__marks = {});
    const look = () => { for (const [k, sel] of Object.entries(marks)) if (!(k in seen) && document.querySelector(sel)) seen[k] = performance.now(); };
    // `document` itself: init scripts run before <html> exists.
    new MutationObserver(look).observe(document, { childList: true, subtree: true, attributes: true });
    look();
  }, { restore: scenario.restore, focused: scenario.focused || null, mobile: mobile && stage, marks: MARK });

  await page.goto(server.origin + '/');
  const views = mobile && scenario.mobileView ? scenario.mobileView : scenario.view;
  const want = wantOnly || ['nav', ...views];
  await page.waitForFunction((want) => want.every((k) => k in window.__marks), want, { timeout: 60_000 });
  const marks = await page.evaluate(() => window.__marks);
  const perf = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const startup = {
    nav: marks.nav,
    view: wantOnly ? NaN : Math.max(...views.map((k) => marks[k])),
    js: { count: js.size, bytes: [...js.values()].reduce((n, r) => n + r.bytes, 0), files: [...js.values()].map((r) => path.basename(new URL(r.url).pathname)) },
    script: perf.ScriptDuration * 1000, compile: perf.V8CompileDuration * 1000, task: perf.TaskDuration * 1000,
  };
  return { ctx, page, cdp, js, startup };
}

// From a warm Overview: open each deferred panel cold (chunk on the wire) and
// again warm (module cached), timing click → first useful content.
// On a phone only the Settings pages are opened this way: Files and Trace are
// reached through the stage, whose cold cost the scenarios above already hold.
async function panelOpens(page, mobile) {
  const timeIt = async (act, marker) => {
    const t0 = Date.now();
    await act();
    try {
      await page.locator(marker).first().waitFor({ timeout: 30_000 });
    } catch (e) {
      // Say what the page showed instead — a bare timeout hides the cause.
      const seen = await page.evaluate(() => [...document.querySelectorAll('.app')].map((el) => el.className).join(' | ') + ' ; main: ' + [...document.querySelectorAll('.main > *, .settings-main > *')].map((el) => el.className).join(' | ')).catch(() => '?');
      throw new Error(`${e.message.split('\n')[0]} — page showed: ${seen}`);
    }
    return Date.now() - t0;
  };
  const back = () => page.locator('.brand .icon-btn[title="Back"]').click();
  const tab = (l) => page.locator('.settings-navitem', { hasText: l }).click();
  const rowOf = (name) => page.locator('.sidebar .row.session:not(.nested)').filter({ has: page.locator('.name', { hasText: new RegExp(`^${name}$`) }) });
  const settingsBtn = page.locator('.icon-btn[title="Settings"]').first();
  const out = {};
  for (const pass of ['cold', 'warm']) {
    const r = (out[pass] = {});
    r.settings = await timeIt(() => settingsBtn.click(), MARK.settings);
    for (const [k, label] of [['usage', 'Usage'], ['apilog', 'API log'], ['skills', 'Skills'], ['cron', 'Cron']]) r[k] = await timeIt(() => tab(label), MARK[k]);
    // Settings reopens on the page it was left on; leave it on General so the
    // warm pass measures the same open as the cold one.
    await timeIt(() => tab('General'), MARK.settings);
    await back();
    await page.locator('.app:not(.settings)').waitFor();
    if (mobile) continue;
    r.files = await timeIt(() => rowOf('files').click(), MARK.files);
    r.trace = await timeIt(() => rowOf('trace').click(), MARK.trace);
    await page.locator('.sidebar .row.ov-row').first().click();
    await page.locator(MARK.overview).first().waitFor({ timeout: 10_000 }).catch(() => {});
  }
  return out;
}

const gz = (f) => zlib.gzipSync(fs.readFileSync(f), { level: 6 }).length;
// Resumable: a partial file from an interrupted run of the same build is
// continued, cell by cell, rather than started over.
const prior = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
const results = prior && prior.dist === DIST && prior.runs === RUNS
  ? { ...prior, resumedAt: new Date().toISOString() }
  : { label: LABEL, dist: DIST, at: new Date().toISOString(), runs: RUNS, node: process.version, chromium: browser.version(), mobile: MOBILE, cpus: os.cpus().length, load: [], profiles: {} };
// The box is shared: a run taken under load is not a measurement. Record the
// 1-minute load average at the start and after every profile.
const noteLoad = (when) => { results.load.push({ when, at: new Date().toISOString(), load1: +os.loadavg()[0].toFixed(2) }); console.log(`load ${when}: ${os.loadavg().map((x) => x.toFixed(1)).join(' ')}`); };
noteLoad('start');
const save = () => fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
try {
  for (const profile of PROFILES) {
    const P = (results.profiles[profile] ||= { scenarios: {}, panels: null });
    for (const sc of SCENARIOS) {
      if (P.scenarios[sc.id]) continue;
      const samples = [];
      for (let i = 0; i < RUNS; i++) {
        const v = await visit(profile, sc);
        samples.push(v.startup);
        await v.ctx.close();
        process.stdout.write(`\r${LABEL} ${profile} ${sc.id} ${i + 1}/${RUNS}   `);
      }
      const files = samples[0].js.files;
      P.scenarios[sc.id] = {
        nav: stat(samples.map((s) => s.nav)), view: stat(samples.map((s) => s.view)),
        script: stat(samples.map((s) => s.script)), compile: stat(samples.map((s) => s.compile)), task: stat(samples.map((s) => s.task)),
        js: { count: samples[0].js.count, bytes: samples[0].js.bytes, gzip: files.reduce((n, f) => n + gz(path.join(DIST, 'assets', f)), 0), files },
      };
      save();
    }
    if (P.panels) continue;
    console.log();
    const opens = [];
    for (let i = 0; i < RUNS; i++) {
      const v = await visit(profile, SCENARIOS[0], { stage: false, want: ['nav'] });
      opens.push(await panelOpens(v.page, profile === 'mobile'));
      await v.ctx.close();
      process.stdout.write(`\r${LABEL} ${profile} panel opens ${i + 1}/${RUNS}   `);
    }
    console.log();
    P.panels = {};
    for (const pass of ['cold', 'warm']) {
      P.panels[pass] = {};
      for (const k of Object.keys(opens[0][pass])) P.panels[pass][k] = stat(opens.map((o) => o[pass][k]));
    }
    noteLoad(`after ${profile}`);
    save();
  }
  results.chunks = Object.fromEntries(fs.readdirSync(path.join(DIST, 'assets')).filter((f) => f.endsWith('.js')).map((f) => [f, { bytes: fs.statSync(path.join(DIST, 'assets', f)).size, gzip: gz(path.join(DIST, 'assets', f)) }]));
} finally {
  await browser.close();
  await server.stop();
}
save();

const kb = (n) => `${(n / 1024).toFixed(0)}k`;
const ms = (s) => `${s.median.toFixed(0)}ms`;
for (const [profile, P] of Object.entries(results.profiles)) {
  console.log(`\n${LABEL} · ${profile} · medians of ${RUNS}`);
  console.log('scenario      js req  js bytes  gzip   script   compile  nav      view');
  for (const [id, s] of Object.entries(P.scenarios)) console.log(`${id.padEnd(13)} ${String(s.js.count).padStart(6)}  ${kb(s.js.bytes).padStart(8)}  ${kb(s.js.gzip).padStart(5)}  ${ms(s.script).padStart(7)}  ${ms(s.compile).padStart(7)}  ${ms(s.nav).padStart(7)}  ${ms(s.view).padStart(7)}`);
  console.log('panel open    cold     warm');
  for (const k of Object.keys(P.panels.cold)) console.log(`${k.padEnd(13)} ${ms(P.panels.cold[k]).padStart(7)}  ${ms(P.panels.warm[k]).padStart(7)}`);
}
console.log(`\nwritten ${OUT}`);
