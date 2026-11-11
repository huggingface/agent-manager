// The sidebar's "done" mark, end to end through the real App (#242).
//
// Done comes from the read marks App already keeps for the Overview and the
// reader: the /api/meta poll merged with the optimistic acknowledgements
// (readLocal). So acknowledging a reply on the Overview has to clear the
// sidebar's dot at once, with no reload and no new poll, and a reply the
// server still calls unread has to keep it.
//
// Same approach as appRefresh.test.mjs (the real App over a mocked fetch, the
// panes stubbed), in its own suite so its fixture cannot disturb that one's
// request counting.
//
// Run with: node test/sidebarDone.test.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-done-'));

const paneStub = path.join(tmp, 'PaneStub.tsx');
fs.writeFileSync(paneStub, `
  import React from 'react';
  export default function Pane({ session }) { return <div className="slot">{session.name}</div>; }
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
      createRoot(document.getElementById('root')).render(<App />);
    `,
  },
  outfile: appBundle, bundle: true, format: 'iife', platform: 'browser',
  nodePaths: [path.join(WEB, 'node_modules')], logLevel: 'error',
  plugins: [{
    name: 'pane-stubs',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/components\/(TerminalPane|FilesPane|TracePane|RemotePane)$/ }, () => ({ path: paneStub }));
    },
  }],
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');
const conversationCss = fs.readFileSync(path.join(WEB, 'src/conversation.css'), 'utf8');

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`); }
};

const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.route('http://sidebar-done.test/', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<style>${css}\n${conversationCss}</style><div id="root"></div>`,
  }));
  await page.goto('http://sidebar-done.test/');
  await page.evaluate(() => {
    localStorage.setItem('am-active-ref', 'overview');
    localStorage.setItem('am-ov-view', 'list');
    localStorage.setItem('am-ov-sort', 'answer');
    const v = (seq) => ({ src: 'gen1', seq, hash: `h${seq}` });
    const session = (id, name, state) => ({
      id, name, cli: 'claude', path: id, createdAt: '2026-11-10T12:00:00.000Z',
      everStarted: true, running: true, state,
    });
    // `fresh` has a reply nobody has read; `seen` has one that was read;
    // `busy` is mid-turn with unread (streaming) output.
    const state = {
      sessions: [session('fresh', 'fresh-reply', 'waiting'), session('seen', 'already-read', 'waiting'), session('busy', 'mid-turn', 'working')],
      output: { fresh: v(3), seen: v(2), busy: v(5) },
      read: { fresh: v(2), seen: v(2), busy: v(4) },
      acks: [],
    };
    const tree = () => ({ order: state.sessions.map((s) => `s:${s.id}`), groups: [], sessions: state.sessions, hidden: [] });
    const meta = () => ({
      generatedAt: new Date().toISOString(),
      sessions: state.sessions.map((s) => ({
        ...s, output: state.output[s.id], read: state.read[s.id],
        digest: {
          lastPromptText: 'do it', lastPromptRaw: 'do it', lastPromptTs: 100,
          lastAssistantText: `reply from ${s.name}`, lastAssistantMd: `reply from ${s.name}`, lastAssistantTs: 200,
          sinceTurns: 1, sinceToolCalls: 0, sinceTools: {}, sinceFiles: [], sinceTokens: 0, turnsLog: [],
        },
      })),
    });
    const response = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    window.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === '/api/tree') return Promise.resolve(response(tree()));
      if (url === '/api/meta') return Promise.resolve(response(meta()));
      if (url === '/api/read' && init.method === 'POST') {
        // Recorded, but the server's copy is deliberately NOT updated: the dot
        // must clear from the optimistic local mark alone.
        const { marks } = JSON.parse(init.body);
        state.acks.push(...marks);
        return Promise.resolve(response({ results: Object.fromEntries(marks.map((m) => [m.id, 'ok'])) }));
      }
      if (url === '/api/info') return Promise.resolve(response({ locked: false, welcomeSeen: true, demoMode: false, spaceId: 'test/space', backup: null }));
      if (url === '/api/clis') return Promise.resolve(response([{ id: 'claude', label: 'Claude Code', color: '#d97757', available: true, ready: true }]));
      if (url === '/api/config') return Promise.resolve(response({ archive: { after: 'never' }, artifacts: { enabled: false, space: '', visibility: 'private' }, jobs: { askAboveUsd: 1 }, revive: { enabled: true, days: 3, continue: true }, backup: { every: 'never', dataset: '', exclude: [] } }));
      if (url.startsWith('/api/folders')) return Promise.resolve(response({ path: '', folders: [] }));
      return Promise.resolve(response({ ok: true, sessions: [], messages: [] }));
    };
    window.__done = { state, v };
  });
  await page.addScriptTag({ path: appBundle });

  const kind = (id) => page.$eval(`.sidebar [data-ref="s:${id}"] .row-status`,
    (el) => [...el.classList].find((c) => c.startsWith('rs-')));
  await page.waitForSelector('.sidebar [data-ref="s:fresh"] .row-status.rs-done', { timeout: 10_000 });

  await check('an unread reply shows done; a read one idle; a working one keeps spinning', async () => {
    assert.equal(await kind('fresh'), 'rs-done');
    assert.equal(await kind('seen'), 'rs-idle');
    assert.equal(await kind('busy'), 'rs-working');
  });

  // The Overview's Unread section: the bulk acknowledgement is one of the two
  // read paths (the other is reading the reply in full), and both go through
  // App's markSeen.
  await page.waitForSelector('.ov-markread');
  await page.click('.ov-markread');
  await page.waitForSelector('.sidebar [data-ref="s:fresh"] .row-status.rs-idle', { timeout: 5_000 });

  await check('acknowledging it on the Overview clears the dot without a reload', async () => {
    assert.equal(await kind('fresh'), 'rs-idle');
    const { acks, read } = await page.evaluate(() => window.__done.state);
    assert.deepEqual(acks.map((m) => m.id), ['fresh'], 'only the unread, finished reply was acknowledged');
    // The mocked server never records the mark, so every poll still says
    // unread: only the optimistic local mark can have cleared the dot.
    assert.equal(read.fresh.seq, 2);
  });
  await page.waitForTimeout(1_800); // past the Overview's 1.5s poll
  await check('and a poll that has not caught up does not bring it back', async () => {
    assert.equal(await kind('fresh'), 'rs-idle');
  });
  await check('the working agent is untouched by it', async () => {
    assert.equal(await kind('busy'), 'rs-working');
  });

  // A newer reply lands: the next poll brings it, and the dot comes back.
  await page.evaluate(() => { const { state, v } = window.__done; state.output.fresh = v(4); });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForSelector('.sidebar [data-ref="s:fresh"] .row-status.rs-done', { timeout: 10_000 });
  await check('a newer reply shows done again', async () => {
    assert.equal(await kind('fresh'), 'rs-done');
  });

  // Selecting the agent is not reading it. (The panes are stubbed here, so no
  // reader shows the reply; reading it in the reader is the other read path,
  // and does clear it through the same markSeen.)
  await page.click('.sidebar [data-ref="s:fresh"]');
  await page.waitForTimeout(300);
  await check('opening the agent in a terminal pane does not clear done', async () => {
    assert.equal(await kind('fresh'), 'rs-done');
  });
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
