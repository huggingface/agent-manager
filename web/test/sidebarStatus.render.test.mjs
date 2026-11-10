// The sidebar's status column (#242), rendered: the real <Sidebar> over a real
// tree in Chromium, as pinnedWiring.render.test.mjs does.
//
// rowStatus.test.mjs proves which state a row is in. This proves the row SHOWS
// it: one mark per row, all on one left edge (nested rows included), only the
// spinner moving and holding still under reduced motion, the hover and
// screen-reader text, the name left alone, and colours that differ in both
// themes. And "done": an idle row with an unread reply shows it, loses it once
// the reply is read, and a working row with one keeps spinning.
//
// Run with:  node test/sidebarStatus.render.test.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-status-'));
const bundle = path.join(tmp, 'app.js');
const stub = path.join(tmp, 'api-stub.ts');

fs.writeFileSync(stub, `
  export const listFolders = () => Promise.resolve({ folders: [] });
  export const uploadAttachment = () => new Promise(() => {});
  export const deleteAttachment = () => Promise.resolve({ ok: true });
  export const getMetaOne = () => new Promise(() => {});
`);

const session = (id, name, cli, state, extra = {}) => ({
  id, name, cli, path: null, createdAt: new Date().toISOString(),
  everStarted: true, running: state !== 'stopped', state, ...extra,
});
const ask = (kind) => ({ kind, cli: 'claude', confidence: 'high', detectedAt: new Date().toISOString() });

// One row per mark, plus the cases that must NOT get one of their own: a
// remote agent (its own wording), a panel (no mark at all), and a shared Codex
// row whose presentation the server already folded into state/inputRequired.
const SESSIONS = [
  session('work', 'trl-review', 'claude', 'working'),
  session('ask', 'harness', 'claude', 'waiting', { inputRequired: ask('permission') }),
  session('done', 'agent-manager', 'claude', 'waiting'),
  session('idle', 'fix-bindings', 'codex', 'waiting'),
  session('sh', 'shell', 'shell', 'idle'),
  session('shbusy', 'build-shell', 'shell', 'working'),
  session('old', 'old-docs', 'codex', 'stopped'),
  session('far', 'laptop', 'remote', 'idle', { remote: { name: 'laptop' } }),
  session('farbusy', 'cluster', 'remote', 'working', { remote: { name: 'cluster' } }),
  session('faroff', 'gone', 'remote', 'stopped', { remote: { name: 'gone' } }),
  session('files', 'files', 'files', 'idle'),
  session('cx', 'shared-codex', 'codex', 'waiting', { codexShared: true, inputRequired: ask('question') }),
  // grouped: nested rows must keep the column straight
  session('g1', 'writer', 'claude', 'working'),
  session('g2', 'reviewer', 'codex', 'waiting', { inputRequired: ask('confirmation') }),
];
const TREE = {
  order: [...SESSIONS.filter((s) => !s.id.startsWith('g')).map((s) => `s:${s.id}`), 'g:crew'],
  groups: [{ id: 'crew', name: 'crew', sessionIds: ['g1', 'g2'], createdAt: new Date().toISOString() }],
  sessions: SESSIONS,
  hidden: [],
};
// Replies not yet read. `done` is the one that shows it; the others prove that
// working, a shell, a stopped row and a panel are not overridden by it.
const UNREAD = ['done', 'work', 'sh', 'shbusy', 'old', 'files', 'g1'];
const CLIS = [
  { id: 'claude', label: 'Claude Code', color: '#d97757', available: true },
  { id: 'codex', label: 'Codex', color: '#5eb6a6', available: true },
  { id: 'shell', label: 'Shell', color: '#8aa0ad', available: true },
  { id: 'remote', label: 'Remote agent', color: '#5ec2e0', available: true },
  { id: 'files', label: 'Files', color: '#d99a2b', available: true },
];

await build({
  stdin: {
    resolveDir: WEB,
    loader: 'tsx',
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import Sidebar from './src/components/Sidebar.tsx';
      const noop = () => {};
      const promise = () => Promise.resolve();
      const root = createRoot(document.getElementById('root'));
      window.mount = (tree, unread) => root.render(
        <Sidebar
          clis={${JSON.stringify(CLIS)}}
          tree={tree}
          {...(unread ? { unread: new Set(unread) } : {})}
          activeRef={null} focusedId={null} defaultPath="" ages={{}}
          onActivate={noop} onOpenSession={noop} onOpenSettings={noop}
          onNewSession={noop} onNewGroup={noop}
          onRenameGroup={noop} onRenameSession={noop} onDeleteGroup={noop}
          onArchiveSession={noop} onUnarchiveSession={noop}
          onSetRemotePaused={noop} onDeleteSession={noop}
          onTraceHandover={() => Promise.resolve({ path: '' })}
          handoverFor={null} onHandoverHandled={noop}
          onMove={noop} onDragState={noop}
          theme="dark" onToggleTheme={noop}
          onQuickStart={promise} onPrepareQuickStart={promise} onAbandonQuickStart={promise}
          archived={new Set()} retired={new Set()}
          showArchived={false} onToggleArchived={noop}
          overviewHidden={new Set()} onToggleOverviewHidden={noop}
          onPinSession={noop} onPinGroup={noop}
        />,
      );
    `,
  },
  outfile: bundle, bundle: true, format: 'iife', platform: 'browser', logLevel: 'error',
  plugins: [{ name: 'stub-api', setup(b) {
    b.onResolve({ filter: /(^|\/)\.\.?\/api$/ }, () => ({ path: stub }));
  } }],
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`); }
};

const rowsOf = (page) => page.$$eval('.row.session[data-ref]', (rows) => rows.map((row) => {
  const marks = row.querySelectorAll('.row-status');
  const mark = marks[0];
  const name = row.querySelector('.name');
  const b = mark ? getComputedStyle(mark, '::before') : null;
  return {
    ref: row.dataset.ref,
    nested: row.classList.contains('nested'),
    stoppedRow: row.classList.contains('row-stopped'),
    marks: marks.length,
    kind: mark ? [...mark.classList].find((c) => c.startsWith('rs-')) : null,
    first: row.firstElementChild === mark,
    left: mark ? mark.getBoundingClientRect().left : null,
    role: mark?.getAttribute('role') ?? null,
    aria: mark?.getAttribute('aria-label') ?? null,
    title: mark?.getAttribute('title') ?? null,
    hidden: mark?.getAttribute('aria-hidden') ?? null,
    content: b?.content ?? null,
    color: b ? (b.backgroundColor !== 'rgba(0, 0, 0, 0)' ? b.backgroundColor : b.borderTopColor) : null,
    glyphColor: b?.color ?? null,
    animations: mark ? mark.getAnimations({ subtree: true }).length : 0,
    name: name?.textContent ?? null,
    nameColor: name ? getComputedStyle(name).color : null,
    nameOpacity: name ? getComputedStyle(name).opacity : null,
    stateLogos: row.querySelectorAll('.state-logo').length,
    logos: row.querySelectorAll('.cli-logo').length,
  };
}));

const browser = await chromium.launch(chromiumLaunchOptions());
const colours = {};
try {
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
    await page.setContent(`<style>${css}
      html, body { margin: 0; background: var(--bg); }
    </style><div id="root" data-theme="${theme}"></div>`);
    await page.addScriptTag({ path: bundle });
    await page.evaluate(([tree, unread]) => window.mount(tree, unread), [TREE, UNREAD]);
    await page.waitForSelector('[data-ref="s:work"] .row-status');

    const rows = await rowsOf(page);
    const by = Object.fromEntries(rows.map((r) => [r.ref.slice(2), r]));
    const t = `${theme}:`;

    check(`${t} one .row-status per session row, first in the row`, () => {
      assert.equal(rows.length, SESSIONS.length);
      for (const r of rows) {
        assert.equal(r.marks, 1, `${r.ref} has ${r.marks} marks`);
        assert.ok(r.first, `${r.ref}: the mark is not the row's first child`);
      }
    });

    check(`${t} every mark sits on the same left edge, nested rows included`, () => {
      assert.ok(rows.some((r) => r.nested), 'the fixture has no nested row');
      const lefts = new Set(rows.map((r) => Math.round(r.left * 100) / 100));
      assert.equal(lefts.size, 1, `marks start at ${[...lefts].join(', ')}`);
    });

    check(`${t} each state gets its mark`, () => {
      const expect = {
        work: 'rs-working', ask: 'rs-blocked', done: 'rs-done', idle: 'rs-idle',
        sh: 'rs-shell', shbusy: 'rs-working', old: 'rs-stopped',
        far: 'rs-idle', farbusy: 'rs-working', faroff: 'rs-stopped',
        files: 'rs-none', cx: 'rs-blocked', g1: 'rs-working', g2: 'rs-blocked',
      };
      for (const [id, kind] of Object.entries(expect)) assert.equal(by[id].kind, kind, id);
    });

    check(`${t} the sidebar draws plain logos, no state frames`, () => {
      for (const r of rows) {
        assert.equal(r.stateLogos, 0, `${r.ref} still has a StateLogo`);
        assert.equal(r.logos, 1, `${r.ref} lost its logo`);
      }
    });

    check(`${t} stopped and panels draw nothing; the stopped row is dimmed`, () => {
      for (const id of ['old', 'faroff', 'files']) assert.equal(by[id].content, 'none', `${id} draws a mark`);
      assert.ok(by.old.stoppedRow && by.faroff.stoppedRow);
      assert.equal(Number(by.old.nameOpacity), 0.45);
      assert.equal(Number(by.idle.nameOpacity), 1);
      assert.ok(!by.files.stoppedRow, 'a panel is not stopped');
    });

    check(`${t} only the spinner animates`, () => {
      for (const r of rows) {
        assert.equal(r.animations, r.kind === 'rs-working' ? 1 : 0, `${r.ref} (${r.kind}) runs ${r.animations} animations`);
      }
      assert.match(by.work.content, /[⠋⠙⠹⠸⠼⠴⠦⠧]/);
    });

    check(`${t} hover and screen-reader text`, () => {
      const expect = {
        work: 'working', ask: 'needs input: permission', done: 'done: new reply not yet read',
        idle: 'idle', sh: 'shell, quiet',
        old: 'stopped', far: 'listening', farbusy: 'working', faroff: 'not connected',
        cx: 'needs input: question', g2: 'needs input: confirmation',
      };
      for (const [id, label] of Object.entries(expect)) {
        assert.equal(by[id].aria, label, `${id} aria-label`);
        assert.equal(by[id].title, label, `${id} title`);
        assert.equal(by[id].role, 'img', `${id} role`);
      }
      assert.equal(by.files.role, null);
      assert.equal(by.files.hidden, 'true', 'a panel mark is hidden from screen readers');
    });

    check(`${t} names are unchanged`, () => {
      for (const s of SESSIONS) assert.equal(by[s.id].name, s.name);
    });

    check(`${t} needs-input and done names are bright, the others stay muted`, () => {
      assert.notEqual(by.ask.nameColor, by.idle.nameColor);
      assert.equal(by.done.nameColor, by.ask.nameColor);
      assert.equal(by.idle.nameColor, by.work.nameColor);
    });

    const legend = await page.$$eval('.sidebar .legend', (ls) => ls.map((l) => ({
      kinds: [...l.querySelectorAll('.row-status')].map((m) => [...m.classList].find((c) => c.startsWith('rs-'))),
      frames: l.querySelectorAll('.state-logo').length,
      animations: l.getAnimations({ subtree: true }).length,
      text: l.textContent.replace(/\s+/g, ' ').trim(),
    })));
    check(`${t} the legend shows the new marks, and holds still`, () => {
      assert.equal(legend.length, 1);
      assert.deepEqual(legend[0].kinds, ['rs-working', 'rs-blocked', 'rs-done', 'rs-idle', 'rs-shell', 'rs-stopped']);
      assert.equal(legend[0].frames, 0);
      assert.equal(legend[0].animations, 0, 'the legend spinner moves');
      assert.equal(legend[0].text, 'working needs input done idle shell stopped');
    });
    colours[theme] = {
      working: by.work.glyphColor, blocked: by.ask.color, idle: by.idle.color, shell: by.sh.color,
      done: by.done.color,
    };

    check(`${t} the five marks have five colours`, () => {
      const c = colours[theme];
      assert.equal(new Set(Object.values(c)).size, 5, JSON.stringify(c));
    });

    // Reading the reply (markSeen -> readLocal -> App's unread set) drops it
    // from the set; the row must follow without anything else changing.
    const read = UNREAD.filter((id) => id !== 'done');
    await page.evaluate(([tree, unread]) => window.mount(tree, unread), [TREE, read]);
    await page.waitForFunction(() => document.querySelector('[data-ref="s:done"] .row-status.rs-idle'));
    const after = Object.fromEntries((await rowsOf(page)).map((r) => [r.ref.slice(2), r]));
    check(`${t} once read, the done row flips to idle and dims its name`, () => {
      assert.equal(after.done.kind, 'rs-idle');
      assert.equal(after.done.aria, 'idle');
      assert.equal(after.done.nameColor, after.idle.nameColor);
      for (const r of Object.values(after)) if (r.ref !== 's:done') assert.equal(r.kind, by[r.ref.slice(2)].kind, r.ref);
    });
    // The reply arrives again (a new turn finished): done comes back.
    await page.evaluate(([tree, unread]) => window.mount(tree, unread), [TREE, UNREAD]);
    await page.waitForFunction(() => document.querySelector('[data-ref="s:done"] .row-status.rs-done'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(30);
    const still = await rowsOf(page);
    check(`${t} under reduced motion the spinner holds a still frame`, () => {
      for (const r of still) assert.equal(r.animations, 0, `${r.ref} still animates`);
      const w = still.find((r) => r.ref === 's:work');
      assert.equal(w.content, '"⠋"');
    });
    await page.close();
  }

  // Without the prop (an embedder that has no read marks) nothing is done; and
  // a remote agent with an unread reply shows done like any other agent.
  {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
    await page.setContent(`<style>${css}</style><div id="root" data-theme="dark"></div>`);
    await page.addScriptTag({ path: bundle });
    await page.evaluate((tree) => window.mount(tree), TREE);
    await page.waitForSelector('[data-ref="s:work"] .row-status');
    const bare = await rowsOf(page);
    check('no unread prop: no row shows done', () => {
      assert.equal(bare.filter((r) => r.kind === 'rs-done').length, 0);
      assert.equal(bare.find((r) => r.ref === 's:done').kind, 'rs-idle');
    });
    await page.evaluate((tree) => window.mount(tree, ['far', 'farbusy', 'faroff']), TREE);
    await page.waitForFunction(() => document.querySelector('[data-ref="s:far"] .row-status.rs-done'));
    const remote = Object.fromEntries((await rowsOf(page)).map((r) => [r.ref.slice(2), r]));
    check('remote: unread listening is done, working still spins, not connected stays stopped', () => {
      assert.equal(remote.far.kind, 'rs-done');
      assert.equal(remote.farbusy.kind, 'rs-working');
      assert.equal(remote.faroff.kind, 'rs-stopped');
    });
    await page.close();
  }

  // The phone layout (≤720px) changes row and group padding, so the column has
  // to survive that too.
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 1100 } });
    await page.setContent(`<style>${css}
      html, body { margin: 0; background: var(--bg); } .sidebar { width: 100%; }
    </style><div id="root" data-theme="dark"></div>`);
    await page.addScriptTag({ path: bundle });
    await page.evaluate((tree) => window.mount(tree), TREE);
    await page.waitForSelector('[data-ref="s:work"] .row-status');
    const rows = await rowsOf(page);
    check('phone layout: every mark sits on the same left edge, nested rows included', () => {
      const lefts = new Set(rows.map((r) => Math.round(r.left * 100) / 100));
      assert.equal(lefts.size, 1, `marks start at ${[...lefts].join(', ')}`);
    });
    await page.close();
  }

  check('light and dark colours are distinct for every mark', () => {
    for (const k of Object.keys(colours.dark)) assert.notEqual(colours.dark[k], colours.light[k], k);
  });
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
