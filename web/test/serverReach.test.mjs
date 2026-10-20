// The shared "is the server there?" poll (src/lib/serverReach.ts), on a fake
// clock: one poll however many callers report the outage, backed off and
// capped, silent in a hidden tab, woken by a return, its end announced to
// every listener spread over SPREAD_MS, and a restart that shipped a new web
// build reported as an update rather than silently left running old code.
// Run:  node test/serverReach.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'server-reach-')), 'serverReach.mjs');
await build({ entryPoints: [path.join(HERE, '../src/lib/serverReach.ts')], outfile: out, format: 'esm', bundle: true, platform: 'node', logLevel: 'error' });
const { createServerReach, pollDelay, SPREAD_MS } = await import(pathToFileURL(out).href);

function harness({ loaded = '/assets/index-OLD.js', hidden = false } = {}) {
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  const server = { up: true, boot: 'boot-1', entry: '/assets/index-OLD.js', probes: 0, pages: 0 };
  const events = {};
  const target = () => ({ addEventListener: (ev, fn) => { (events[ev] ||= []).push(fn); } });
  const doc = { ...target(), hidden };
  const reach = createServerReach({
    fetch: async (url) => {
      if (url === '/api/visibility') {
        server.probes++;
        if (!server.up) throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ boot: server.boot }), { status: 200 });
      }
      server.pages++;
      return new Response(`<script type="module" src="${server.entry}"></script>`, { status: 200 });
    },
    setTimeout: (run, ms) => { const id = nextId++; timers.set(id, { at: now + ms, run }); return id; },
    clearTimeout: (id) => timers.delete(id),
    random: () => 0.5,
    window: target(),
    document: doc,
    loadedBuild: () => loaded,
  });
  const flush = () => new Promise((r) => setImmediate(r));
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      await flush(); await flush();
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].run();
    }
    now = end; await flush(); await flush();
  };
  const fire = async (ev, target = 'window') => {
    for (const fn of (target === 'doc' ? events.visibilitychange : events[ev]) || []) fn();
    await flush(); await flush();
  };
  return { reach, server, advance, fire, doc, timers };
}

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`); }
};

await test('backoff grows from 2s and is capped at 20s', () => {
  assert.equal(pollDelay(1), 2000);
  assert.equal(pollDelay(2), 3000);
  assert.equal(pollDelay(30), 20_000);
});

await test('twelve callers reporting one outage share one poll', async () => {
  const h = harness();
  assert.equal(await h.reach.answers(), true);
  h.server.up = false;
  for (let i = 0; i < 12; i++) h.reach.reportOutage();
  const before = h.server.probes;
  await h.advance(60_000);
  const polls = h.server.probes - before;
  // 2 + 3 + 4.5 + 6.75 + 10.1 + 15.2 + 20 … ≈ 7 polls in a minute, not 84.
  assert.ok(polls >= 5 && polls <= 9, `${polls} probes in 60s`);
  assert.equal(h.reach.down, true);
});

await test('concurrent answers() calls share one request', async () => {
  const h = harness();
  const all = await Promise.all(Array.from({ length: 12 }, () => h.reach.answers()));
  assert.ok(all.every(Boolean));
  assert.equal(h.server.probes, 1);
});

await test('the end of an outage reaches every listener once, spread out', async () => {
  const h = harness();
  const got = [];
  for (let i = 0; i < 3; i++) h.reach.onBack((b) => got.push(b));
  h.server.up = false; h.reach.reportOutage();
  await h.advance(10_000);
  assert.equal(got.length, 0);
  h.server.up = true;
  await h.advance(20_000 + SPREAD_MS);
  assert.equal(got.length, 3);
  assert.equal(h.reach.down, false);
  await h.advance(60_000);
  assert.equal(got.length, 3, 'announced again after recovery');
});

await test('a hidden tab does not poll; becoming visible asks at once', async () => {
  const h = harness({ hidden: true });
  const got = [];
  h.reach.onBack(() => got.push(1));
  h.server.up = false; h.reach.reportOutage();
  await h.advance(5 * 60_000);
  assert.equal(h.server.probes, 0, 'polled while hidden');
  h.server.up = true; h.doc.hidden = false;
  await h.fire('visibilitychange', 'doc');
  await h.advance(SPREAD_MS);
  assert.equal(got.length, 1);
});

await test('online and focus wake a backed-off poll immediately', async () => {
  const h = harness();
  h.server.up = false; h.reach.reportOutage();
  await h.advance(60_000);           // backed off to the cap
  h.server.up = true;
  const got = [];
  h.reach.onBack(() => got.push(1));
  await h.fire('online');
  await h.advance(SPREAD_MS);
  assert.equal(got.length, 1, 'waited for the next backed-off poll');
});

await test('a restart that shipped a new web build is reported as an update', async () => {
  const h = harness();
  let updates = 0;
  h.reach.onUpdateReady(() => updates++);
  await h.reach.answers();                       // learns boot-1
  h.server.up = false; h.reach.reportOutage();
  h.server.boot = 'boot-2'; h.server.entry = '/assets/index-NEW.js';
  h.server.up = true;
  let back = null;
  h.reach.onBack((b) => { back = b; });
  await h.advance(5000);
  assert.deepEqual(back, { rebooted: true });
  assert.equal(updates, 1);
  assert.equal(h.reach.updateReady, true);
});

await test('a restart with the same build, or no restart, is only a reconnect', async () => {
  const h = harness();
  h.reach.onUpdateReady(() => assert.fail('offered a reload'));
  h.reach.noteBoot('boot-1');
  h.server.up = false; h.reach.reportOutage();
  h.server.boot = 'boot-2'; h.server.up = true;
  let back = null;
  h.reach.onBack((b) => { back = b; });
  await h.advance(5000);
  assert.deepEqual(back, { rebooted: true });
  assert.equal(h.reach.updateReady, false);
  assert.equal(h.server.pages, 1, 'checked the served build once');
  h.server.up = false; h.reach.reportOutage(); h.server.up = true;
  await h.advance(5000);
  assert.deepEqual(back, { rebooted: false });
  assert.equal(h.server.pages, 1, 'checked the build without a restart');
});

if (failed) { console.log(`server reach: ${failed} failed`); process.exit(1); }
console.log('server reach: all passed');
