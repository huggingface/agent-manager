// App-level tree/meta freshness: race semantics under a controllable clock, then
// the real App handlers in Chromium. The browser cannot enter Chromium's real
// back/forward cache under automation, so it dispatches the PageTransitionEvent
// that a persisted restore delivers — through the production listener, not a
// test-only refresh path.
//
// Run with: node test/appRefresh.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-refresh-'));
const libraryBundle = path.join(tmp, 'app-refresh.mjs');

await build({
  entryPoints: [path.join(WEB, 'src/lib/appRefresh.ts')],
  outfile: libraryBundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'error',
});
const { createLatestRefresh, observeAppReturns } = await import(`${pathToFileURL(libraryBundle)}?${Date.now()}`);

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
class FakeClock {
  nowValue = 1_000;
  serial = 0;
  timers = new Map();
  now = () => this.nowValue;
  setTimeout = (run, delay) => {
    const id = ++this.serial;
    this.timers.set(id, { at: this.nowValue + delay, run });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  advance(ms) {
    const end = this.nowValue + ms;
    for (;;) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.nowValue = due[1].at;
      this.timers.delete(due[0]);
      due[1].run();
    }
    this.nowValue = end;
  }
}

// A replacement starts even when the prior transport ignores abort, and only
// the replacement keeps publication rights.
{
  const clock = new FakeClock();
  const reads = [];
  const published = [];
  const manager = createLatestRefresh((signal) => {
    const pending = deferred();
    reads.push({ signal, pending });
    return pending.promise;
  }, (value) => published.push(value), { clock, timeoutMs: 1_000 });

  const old = manager.refresh('poll');
  let oldSettled = false;
  void old.then(() => { oldSettled = true; });
  await turn();
  const fresh = manager.refresh('replace');
  await turn();
  assert.equal(reads.length, 2, 'foreground replacement does not wait for an old read');
  assert.equal(reads[0].signal.aborted, true, 'the superseded transport is aborted');
  assert.equal(oldSettled, false, 'the superseded caller waits for the replacing read');
  reads[1].pending.resolve('fresh');
  assert.equal(await fresh, 'fresh');
  assert.equal(await old, 'fresh', 'the superseded caller receives the published replacement');
  assert.deepEqual(published, ['fresh']);
  reads[0].pending.resolve('obsolete');
  assert.deepEqual(published, ['fresh'], 'a late obsolete response cannot publish');

  // A regular poll coalesces rather than churning an in-flight request. Once a
  // deadline fires, even an abort-ignoring mock loses its slot and the next poll
  // can proceed.
  const frozen = manager.refresh('poll');
  await turn();
  assert.equal(reads.length, 3);
  assert.equal(await manager.refresh('poll'), null);
  assert.equal(reads.length, 3, 'polls preserve the existing single-flight cadence');
  clock.advance(1_000);
  await turn();
  assert.equal(await frozen, null);
  assert.equal(reads[2].signal.aborted, true, 'the deadline aborts the transport');
  const recovered = manager.refresh('poll');
  await turn();
  assert.equal(reads.length, 4, 'the timed-out request did not retain the slot');
  reads[3].pending.resolve('after-timeout');
  assert.equal(await recovered, 'after-timeout');
  manager.dispose();
}

// Failure and unmount are local to one resource: last-good data stays put, the
// other resource publishes, and a disposed manager cannot publish later.
{
  let tree = 'tree-old';
  let meta = 'meta-old';
  const treeReads = [Promise.reject(new Error('tree offline')), Promise.resolve('tree-new')];
  const metaReads = [Promise.resolve('meta-new')];
  const treeManager = createLatestRefresh(() => treeReads.shift(), (next) => { tree = next; });
  const metaManager = createLatestRefresh(() => metaReads.shift(), (next) => { meta = next; });
  await Promise.all([treeManager.refresh(), metaManager.refresh()]);
  assert.equal(tree, 'tree-old', 'a failed read retains that resource\'s last good value');
  assert.equal(meta, 'meta-new', 'the other resource succeeds independently');
  await treeManager.refresh('poll');
  assert.equal(tree, 'tree-new', 'failure does not disable the next ordinary poll');

  const late = deferred();
  const disposed = [];
  const manager = createLatestRefresh(() => late.promise, (next) => disposed.push(next));
  const request = manager.refresh();
  await turn();
  manager.dispose();
  late.resolve('too-late');
  await request;
  assert.deepEqual(disposed, [], 'unmount retires outstanding publication rights');
  treeManager.dispose();
  metaManager.dispose();
}

// The lifecycle itself is clock-controlled: return events are prompt, startup
// noise is ignored, one browser event burst is one refresh, and hidden online
// events defer until visibility returns.
{
  const clock = new FakeClock();
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.hidden = false;
  let refreshes = 0;
  const stop = observeAppReturns(() => { refreshes++; }, {
    window: win, document: doc, clock, coalesceMs: 250,
  });
  const show = (persisted) => {
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: persisted });
    win.dispatchEvent(event);
  };

  win.dispatchEvent(new Event('focus'));
  show(false);
  assert.equal(refreshes, 0, 'initial focus/pageshow do not duplicate initial reads');
  clock.advance(300);
  win.dispatchEvent(new Event('blur'));
  win.dispatchEvent(new Event('focus'));
  assert.equal(refreshes, 1, 'returning focus refreshes immediately');
  show(true);
  win.dispatchEvent(new Event('online'));
  assert.equal(refreshes, 1, 'the related event burst is coalesced');

  clock.advance(300);
  show(true);
  assert.equal(refreshes, 2, 'a persisted pageshow refreshes without visibilitychange');
  clock.advance(300);
  win.dispatchEvent(new Event('online'));
  assert.equal(refreshes, 3, 'online while visible is a refresh hint');

  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  clock.advance(1_000);
  win.dispatchEvent(new Event('online'));
  assert.equal(refreshes, 3, 'online while hidden performs no background work');
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(refreshes, 4, 'the visible return catches up immediately');
  // Chromium variants do not all order focus and visibilitychange alike. If
  // focus observes the new visible state first, it consumes the hidden return;
  // the later visibility event is only a companion and must not duplicate it.
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('blur'));
  clock.advance(1_000);
  doc.hidden = false;
  win.dispatchEvent(new Event('focus'));
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(refreshes, 5, 'event order does not split one return into two refreshes');
  // A genuinely separate hidden/visible cycle is never swallowed merely because
  // it is fast; only the companion focus/pageshow/online events are.
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(refreshes, 6, 'repeated return cycles each refresh once');
  stop();
  clock.advance(1_000);
  win.dispatchEvent(new Event('online'));
  assert.equal(refreshes, 6, 'cleanup removes every listener');
}

// --- actual App wiring in Chromium ---

const paneStub = path.join(tmp, 'PaneStub.tsx');
fs.writeFileSync(paneStub, `
  import React, { useEffect, useRef, useState } from 'react';
  export default function Pane({ session }) {
    const [draft, setDraft] = useState('');
    const body = useRef(null);
    useEffect(() => {
      window.__paneMounts = (window.__paneMounts || 0) + 1;
      return () => { window.__paneUnmounts = (window.__paneUnmounts || 0) + 1; };
    }, []);
    return <div className="slot pane-probe">
      <div data-pane-name>{session.name}</div>
      <div data-pane-scroll ref={body} style={{height: '40px', overflow: 'auto'}}>
        <div style={{height: '300px'}}>pane history</div>
      </div>
      <textarea data-pane-draft value={draft} onChange={(e) => setDraft(e.target.value)} />
    </div>;
  }
`);
const appBundle = path.join(tmp, 'app.js');
await build({
  stdin: {
    resolveDir: WEB,
    loader: 'tsx',
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import App from './src/App.tsx';
      let root;
      window.__appMount = () => {
        root = createRoot(document.getElementById('root'));
        root.render(<App />);
      };
      window.__appUnmount = () => { root?.unmount(); root = undefined; };
      window.__appMount();
    `,
  },
  outfile: appBundle,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  nodePaths: [path.join(WEB, 'node_modules')],
  logLevel: 'error',
  plugins: [{
    name: 'pane-stubs',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/components\/(TerminalPane|FilesPane|TracePane|RemotePane)$/ }, () => ({ path: paneStub }));
    },
  }],
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');
const conversationCss = fs.readFileSync(path.join(WEB, 'src/conversation.css'), 'utf8');
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
  await page.route('http://app-refresh.test/', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<style>${css}\n${conversationCss}</style><div id="root"></div>`,
  }));
  await page.goto('http://app-refresh.test/');
  await page.evaluate(() => {
    localStorage.setItem('am-active-ref', 'overview');
    localStorage.setItem('am-ov-view', 'list');
    const state = {
      version: 1,
      groupName: 'Return tests',
      created: false,
      freeze: { tree: 0, meta: 0 },
      fail: { tree: 0, meta: 0 },
      frozen: { tree: [], meta: [] },
      calls: [],
    };
    const session = (i, version) => ({
      id: `s${i}`,
      name: i === 1 ? `agent-${version}` : `filler-${i}`,
      cli: 'claude',
      path: `agent-${i}`,
      createdAt: '2026-09-08T12:00:00.000Z',
      everStarted: true,
      running: i === 1 && version === 1,
      state: i === 1 ? (version === 1 ? 'working' : 'waiting') : 'idle',
    });
    const createdSession = {
      id: 's99', name: 'fresh-agent', cli: 'claude', path: 'fresh-agent',
      createdAt: '2026-09-09T12:00:00.000Z', everStarted: true, running: true, state: 'working',
    };
    const treeFor = (version) => {
      const sessions = Array.from({ length: 12 }, (_, i) => session(i + 1, version));
      const order = ['g:g1'];
      if (state.created) { sessions.push(createdSession); order.push('s:s99'); }
      return { order, groups: [{ id: 'g1', name: state.groupName, sessionIds: sessions.filter((s) => s.id !== 's99').map((s) => s.id) }], sessions, hidden: [] };
    };
    const metaFor = (version) => ({
      generatedAt: new Date().toISOString(),
      sessions: treeFor(version).sessions.map((s) => ({ ...s, digest: {
        lastPromptText: `prompt-${version}`, lastPromptRaw: `prompt-${version}`, lastPromptTs: 100,
        lastAssistantText: `answer-${version}`, lastAssistantMd: `answer-${version}`, lastAssistantTs: 200,
        sinceTurns: 1, sinceToolCalls: 0, sinceTools: {}, sinceFiles: [], sinceTokens: 0, turnsLog: [],
      } })),
    });
    const response = (body, ok = true) => new Response(JSON.stringify(body), {
      status: ok ? 200 : 503, headers: { 'content-type': 'application/json' },
    });
    const resource = (url) => url === '/api/tree' ? 'tree' : url === '/api/meta' ? 'meta' : null;
    window.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const kind = resource(url);
      const call = { url, method: init.method || 'GET', aborted: !!init.signal?.aborted };
      state.calls.push(call);
      init.signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
      if (kind) {
        const version = state.version;
        if (state.fail[kind] > 0) {
          state.fail[kind]--;
          return Promise.reject(new TypeError(`${kind} offline`));
        }
        const body = kind === 'tree' ? treeFor(version) : metaFor(version);
        if (state.freeze[kind] > 0) {
          state.freeze[kind]--;
          return new Promise((resolve) => state.frozen[kind].push({ resolve: () => resolve(response(body)), call, version }));
        }
        return Promise.resolve(response(body));
      }
      if (url === '/api/info') return Promise.resolve(response({ locked: false, welcomeSeen: true, demoMode: false, spaceId: 'test/space', backup: null }));
      if (url === '/api/clis') return Promise.resolve(response([{ id: 'claude', label: 'Claude Code', color: '#d97757', available: true, ready: true }]));
      if (url === '/api/config') return Promise.resolve(response({ archive: { after: 'never' }, artifacts: { enabled: false, space: '', visibility: 'private' }, jobs: { askAboveUsd: 1 }, revive: { enabled: true, days: 3 }, backup: { every: 'never', dataset: '', exclude: [] } }));
      if (url === '/api/groups/g1' && init.method === 'PUT') {
        state.groupName = JSON.parse(init.body).name;
        return Promise.resolve(response({ ok: true }));
      }
      if (url === '/api/sessions' && init.method === 'POST') {
        state.created = true;
        return Promise.resolve(response(createdSession));
      }
      if (url.startsWith('/api/next-name')) return Promise.resolve(response({ cli: 'claude', name: 'claude-13' }));
      if (url.startsWith('/api/folders')) return Promise.resolve(response({ path: '', folders: [] }));
      return Promise.resolve(response({ ok: true, sessions: [], messages: [] }));
    };
    const counts = () => ({
      tree: state.calls.filter((c) => c.url === '/api/tree').length,
      meta: state.calls.filter((c) => c.url === '/api/meta').length,
    });
    window.__refreshHarness = {
      state,
      counts,
      setVersion(version) { state.version = version; },
      freezeNext(kind) { state.freeze[kind]++; },
      failNext(kind) { state.fail[kind]++; },
      frozen(kind) { return state.frozen[kind].length; },
      resolveFrozen(kind) { state.frozen[kind].shift()?.resolve(); },
      resolveFrozenAt(kind, index) { state.frozen[kind].splice(index, 1)[0]?.resolve(); },
      setHidden(hidden) {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      },
      focusReturn() {
        window.dispatchEvent(new Event('blur'));
        window.dispatchEvent(new Event('focus'));
      },
      burst() {
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        window.dispatchEvent(new Event('online'));
        window.dispatchEvent(new Event('focus'));
      },
      initialPageShow() { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })); },
    };
  });
  await page.addScriptTag({ path: appBundle });
  await page.waitForFunction(() => document.querySelector('.ov-name')?.textContent === 'agent-1');
  await page.waitForFunction(() => document.querySelector('.ov-answer-wrap')?.textContent.includes('answer-1'));

  const initial = await page.evaluate(() => window.__refreshHarness.counts());
  await page.evaluate(() => window.__refreshHarness.initialPageShow());
  await page.waitForTimeout(30);
  assert.deepEqual(await page.evaluate(() => window.__refreshHarness.counts()), initial,
    'the ordinary initial pageshow does not duplicate initial tree/meta reads');
  await page.waitForTimeout(300);
  const beforePersistedShow = await page.evaluate(() => window.__refreshHarness.counts());
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForFunction((before) => {
    const now = window.__refreshHarness.counts();
    return now.tree === before.tree + 1 && now.meta === before.meta + 1;
  }, beforePersistedShow);

  // Hidden time crosses both Overview metadata (1.5s) and tree (2.5s) clocks,
  // but adds no reads. Returning publishes both immediately, and companion
  // lifecycle events do not multiply them.
  await page.fill('.ov-card textarea', 'draft survives return');
  // Composer focus deliberately calls scrollIntoView after the mobile keyboard
  // animation window. Let that app behavior settle before measuring refresh.
  await page.waitForTimeout(350);
  const beforeScroll = await page.evaluate(() => {
    const el = document.querySelector('.ov-wrap');
    el.scrollTop = 180;
    return el.scrollTop;
  });
  assert.ok(beforeScroll > 0, 'the fixture has real Overview scroll to preserve');
  await page.evaluate(() => {
    window.__refreshHarness.setHidden(true);
    window.__refreshHarness.setVersion(2);
  });
  const hiddenCounts = await page.evaluate(() => window.__refreshHarness.counts());
  await page.waitForTimeout(2_700);
  assert.deepEqual(await page.evaluate(() => window.__refreshHarness.counts()), hiddenCounts,
    'hidden time does not add polling work');
  await page.evaluate(() => {
    window.__refreshHarness.setHidden(false);
    window.__refreshHarness.burst();
  });
  await page.waitForFunction(() => document.querySelector('.ov-name')?.textContent === 'agent-2');
  await page.waitForFunction(() => document.querySelector('.ov-answer-wrap')?.textContent.includes('answer-2'));
  assert.deepEqual(await page.evaluate(() => window.__refreshHarness.counts()), {
    tree: hiddenCounts.tree + 1, meta: hiddenCounts.meta + 1,
  }, 'one return/reconnect burst performs one fresh read per resource');
  assert.equal(await page.inputValue('.ov-card textarea'), 'draft survives return');
  assert.equal(await page.evaluate(() => document.querySelector('.ov-wrap').scrollTop), beforeScroll,
    'the refresh does not remount the feed or reset its scroll');

  // Independent failure keeps last-good state. A later return recovers the
  // failed side; neither failure occupies a slot permanently.
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__refreshHarness.setVersion(3);
    window.__refreshHarness.failNext('meta');
    window.__refreshHarness.focusReturn();
  });
  await page.waitForFunction(() => document.querySelector('.row[data-ref="s:s1"] .name')?.textContent === 'agent-3');
  assert.match(await page.textContent('.ov-answer-wrap'), /answer-2/, 'failed metadata keeps its last good card');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__refreshHarness.setVersion(4);
    window.__refreshHarness.failNext('tree');
    window.__refreshHarness.focusReturn();
  });
  await page.waitForFunction(() => document.querySelector('.ov-answer-wrap')?.textContent.includes('answer-4'));
  assert.equal(await page.textContent('.row[data-ref="s:s1"] .name'), 'agent-3', 'failed tree keeps its last good sidebar');

  // Freeze ordinary polls with a mock that records abort but deliberately does
  // not reject. The visible return must still start both reads; late poll data
  // then has no right to replace it.
  await page.evaluate(() => {
    window.__refreshHarness.freezeNext('tree');
    window.__refreshHarness.freezeNext('meta');
  });
  await page.waitForFunction(() => window.__refreshHarness.frozen('tree') === 1
    && window.__refreshHarness.frozen('meta') === 1, null, { timeout: 5_000 });
  await page.evaluate(() => {
    window.__refreshHarness.setVersion(5);
    window.__refreshHarness.setHidden(true);
    window.__refreshHarness.setHidden(false);
  });
  await page.waitForFunction(() => document.querySelector('.ov-name')?.textContent === 'agent-5');
  await page.waitForFunction(() => document.querySelector('.ov-answer-wrap')?.textContent.includes('answer-5'));
  assert.deepEqual(await page.evaluate(() => ({
    tree: window.__refreshHarness.state.frozen.tree[0].call.aborted,
    meta: window.__refreshHarness.state.frozen.meta[0].call.aborted,
  })), { tree: true, meta: true }, 'return aborts both obsolete poll transports');
  await page.evaluate(() => {
    window.__refreshHarness.resolveFrozen('tree');
    window.__refreshHarness.resolveFrozen('meta');
  });
  await page.waitForTimeout(50);
  assert.equal(await page.textContent('.ov-name'), 'agent-5', 'late poll tree cannot overwrite the return result');
  assert.match(await page.textContent('.ov-answer-wrap'), /answer-5/, 'late poll metadata cannot overwrite the return result');

  // A post-mutation tree read uses the same replacement path. Start another
  // frozen ordinary tree poll, rename the group through the real Sidebar, and
  // verify its refresh neither waits for nor loses to the old poll.
  await page.evaluate(() => window.__refreshHarness.freezeNext('tree'));
  await page.waitForFunction(() => window.__refreshHarness.frozen('tree') === 1, null, { timeout: 4_000 });
  await page.hover('.group-head');
  await page.click('.group-head button[title="Rename"]');
  await page.fill('.group-head input.rename', 'Renamed after mutation');
  await page.press('.group-head input.rename', 'Enter');
  await page.waitForFunction(() => document.querySelector('.group-head .name')?.textContent === 'Renamed after mutation');
  assert.equal(await page.evaluate(() => window.__refreshHarness.state.frozen.tree[0].call.aborted), true,
    'post-mutation refresh replaces an obsolete poll');
  await page.evaluate(() => window.__refreshHarness.resolveFrozen('tree'));
  await page.waitForTimeout(50);
  assert.equal(await page.textContent('.group-head .name'), 'Renamed after mutation');

  // Session view uses the slow metadata cadence, but the same immediate return
  // path. The keyed pane stays mounted, keeping its local draft and scroll.
  await page.click('.ov-card .ov-id');
  await page.waitForSelector('[data-pane-name]');
  await page.fill('[data-pane-draft]', 'unsent pane draft');
  await page.evaluate(() => { document.querySelector('[data-pane-scroll]').scrollTop = 90; });
  const mounts = await page.evaluate(() => window.__paneMounts);
  await page.waitForTimeout(300);
  const sessionCounts = await page.evaluate(() => window.__refreshHarness.counts());
  await page.evaluate(() => {
    window.__refreshHarness.setVersion(6);
    window.__refreshHarness.setHidden(true);
    window.__refreshHarness.setHidden(false);
    window.__refreshHarness.burst();
  });
  await page.waitForFunction(() => document.querySelector('[data-pane-name]')?.textContent === 'agent-6');
  assert.deepEqual(await page.evaluate(() => window.__refreshHarness.counts()), {
    tree: sessionCounts.tree + 1, meta: sessionCounts.meta + 1,
  }, 'a hidden session view refreshes both resources once without waiting for its 8s metadata poll');
  assert.equal(await page.inputValue('[data-pane-draft]'), 'unsent pane draft');
  assert.equal(await page.evaluate(() => document.querySelector('[data-pane-scroll]').scrollTop), 90);
  assert.equal(await page.evaluate(() => window.__paneMounts), mounts, 'the open pane was not remounted');
  const recoveryCalls = await page.evaluate((from) => window.__refreshHarness.state.calls.slice(from),
    await page.evaluate(() => window.__refreshHarness.state.calls.length - 2));
  assert.ok(recoveryCalls.every((call) => call.method === 'GET' && ['/api/tree', '/api/meta'].includes(call.url)),
    'return performs only the two approved reads — no prompt, session, trace or PTY action');

  // Unlike visibility/bfcache, Chromium does expose a real offline transition
  // in headless mode. Use it for the reconnect smoke rather than synthesizing
  // the final `online` event.
  await page.waitForTimeout(300);
  const beforeReconnect = await page.evaluate(() => window.__refreshHarness.counts());
  await page.context().setOffline(true);
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  await page.context().setOffline(false);
  await page.waitForFunction((before) => {
    const now = window.__refreshHarness.counts();
    return now.tree === before.tree + 1 && now.meta === before.meta + 1;
  }, beforeReconnect);

  // A mutation caller awaits its replacement tree before navigating. A return
  // event during quickstart used to settle the superseded promise as null,
  // select s99 against the stale tree, and let reconciliation bounce back to
  // Overview before the replacement finally published s99.
  await page.click('.ov-row');
  await page.waitForSelector('.ov-card');
  await page.click('.add-btn');
  await page.waitForSelector('.quick-prompt');
  await page.fill('.quick-prompt', 'run the synthetic task');
  await page.evaluate(() => { window.__refreshHarness.state.freeze.tree = 2; });
  await page.press('.quick-prompt', 'Enter');
  await page.waitForFunction(() => window.__refreshHarness.frozen('tree') === 1, null, { timeout: 5_000 });
  await page.evaluate(() => {
    window.__refreshHarness.setHidden(true);
    window.__refreshHarness.setHidden(false);
  });
  await page.waitForFunction(() => window.__refreshHarness.frozen('tree') === 2, null, { timeout: 5_000 });
  assert.equal(await page.evaluate(() => window.__refreshHarness.state.frozen.tree[0].call.aborted), true,
    'the return supersedes quickstart\'s tree transport');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => localStorage.getItem('am-active-ref')), 'overview',
    'navigation waits while the replacement tree is still unresolved');
  await page.evaluate(() => {
    window.__refreshHarness.resolveFrozenAt('tree', 1);
    window.__refreshHarness.resolveFrozenAt('tree', 0);
  });
  await page.waitForSelector('[data-pane-name]');
  assert.equal(await page.textContent('[data-pane-name]'), 'fresh-agent');
  assert.equal(await page.evaluate(() => localStorage.getItem('am-active-ref')), 's:s99',
    'quickstart keeps its selected session when a return supersedes its refresh');
  assert.equal(await page.$('.ov-name'), null, 'selection did not fall back to Overview');

  // Unmount removes all timers/listeners/publication rights; remount creates one
  // fresh set rather than accumulating another loop.
  await page.evaluate(() => window.__appUnmount());
  const unmountedCounts = await page.evaluate(() => window.__refreshHarness.counts());
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__refreshHarness.focusReturn());
  await page.waitForTimeout(30);
  assert.deepEqual(await page.evaluate(() => window.__refreshHarness.counts()), unmountedCounts,
    'unmounted App has no return listeners or pollers');
  await page.evaluate(() => {
    localStorage.setItem('am-active-ref', 'overview');
    window.__appMount();
  });
  await page.waitForFunction(() => document.querySelector('.ov-name')?.textContent === 'agent-6');
  const remounted = await page.evaluate(() => window.__refreshHarness.counts());
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__refreshHarness.focusReturn());
  await page.waitForFunction((before) => {
    const now = window.__refreshHarness.counts();
    return now.tree === before.tree + 1 && now.meta === before.meta + 1;
  }, remounted);
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('app-refresh: ok');
