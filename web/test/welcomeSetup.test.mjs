// First-run setup: the step that turns a fresh Space into a working agent.
//
// What matters here is that the window tells the truth about THIS Space. The
// state it shows comes from the live catalog (`ready`, the same signal behind
// the dot in Settings -> Agents) and the live secret list, so the checks below
// drive it with fixture catalogs and assert what a new operator would read.
//
// The sign-in commands are asserted by name on purpose. `codex login` serves a
// localhost:1455 redirect that a browser cannot reach from a Space — the CLI
// itself says to use `--device-auth` on a remote machine — so offering the
// plain form would be instructions for a flow that cannot complete.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'welcome-setup-'));
const bundle = path.join(tmp, 'fixture.js');

const cli = (id, label, color, ready, secrets, signIn) =>
  ({ id, label, color, available: true, ready, secrets, signIn });
const NOTE = 'Choose "Sign in with Device Code" — the ChatGPT option needs a browser redirect a Space cannot receive.';
const CATALOG = (ready = []) => [
  cli('claude', 'Claude Code', '#d97757', ready.includes('claude'), ['ANTHROPIC_API_KEY'], { note: null }),
  cli('codex', 'Codex', '#5eb6a6', ready.includes('codex'), ['OPENAI_API_KEY'], { note: NOTE }),
  cli('gemini', 'Gemini CLI', '#4796e3', ready.includes('gemini'), ['GEMINI_API_KEY'], null),
];

await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import Welcome from './src/components/Welcome';
    import { configuredCount, setupCandidates, keepOffering } from './src/components/WelcomeSetup';
    window.configuredCount = configuredCount;
    window.setupCandidates = setupCandidates;
    window.keepOffering = keepOffering;
    window.started = [];
    window.render = (s) => {
      document.getElementById('root').innerHTML = '';
      createRoot(document.getElementById('root')).render(React.createElement(Welcome, {
        onClose: () => { window.closed = true; },
        clis: s.clis, spaceId: s.spaceId === null ? null : (s.spaceId ?? 'you/am'),
        presentSecrets: s.secrets || [], bucketUnverified: !!s.unverified,
        onStartSession: (c) => window.started.push(c),
      }));
    };
  ` },
  outfile: bundle, bundle: true, format: 'iife', platform: 'browser', logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"' },
});

let failed = 0;
const check = async (what, fn) => {
  // Awaited: an async assertion passed to a sync runner throws into a dropped
  // promise and reports ok, which is a test that cannot fail.
  try { await fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const mount = async (state) => {
    await page.setContent(`<style>${fs.readFileSync(path.join(web, 'src/styles.css'), 'utf8')}</style><div id="root"></div>`);
    await page.addScriptTag({ path: bundle });
    await page.evaluate((s) => window.render(s), state);
    await page.waitForSelector('.welcome-card');
    await page.waitForTimeout(120);
  };
  const text = () => page.locator('.welcome-card').innerText();

  console.log('\na fresh Space, nothing configured');
  await mount({ clis: CATALOG([]) });
  const fresh = await text();
  await check('opens on setup, not on the tour', () => assert.match(fresh, /Connect your first agent/));
  await check('says nothing is signed in', () => assert.match(fresh, /Nothing is signed in yet/));
  await check('every agent reads as needing setup', () => {
    assert.equal((fresh.match(/needs setup/g) || []).length, 3);
  });
  // Launching each agent in a PTY with no credentials showed that opening a
  // session IS the sign-in for claude and codex, so the card must not ask for
  // a command. It cannot: a Claude pane runs Claude, and anything typed there
  // goes to the model as a prompt.
  await check('asks only that a session be opened, with no command to type', () => {
    assert.match(fresh, /Open a session/);
    assert.ok(!/auth login|--device-auth|\$ /.test(fresh), `a command leaked into the card: ${fresh.slice(0, 200)}`);
  });
  await check('steers Codex past the option that cannot work from a Space', () =>
    assert.match(fresh, /Sign in with Device Code/));
  // Named only where it is the route: an agent whose session signs itself in
  // does not need a key paragraph, and listing one would be extra to do.
  await check('names the secret only for the agents that need one', () => {
    assert.match(fresh, /Needs a key: GEMINI_API_KEY/);
    assert.ok(!/Needs a key: ANTHROPIC_API_KEY/.test(fresh), 'asked Claude for a key it does not need');
  });
  await check('warns that adding a secret restarts the Space', () =>
    assert.match(fresh, /restarts the Space/));
  await check('an agent with no confirmed sign-in is offered the key instead', () => {
    assert.match(fresh, /Needs a key: GEMINI_API_KEY/);
    assert.ok(!/Open a Gemini CLI session/.test(fresh), 'offered a session it cannot sign in from');
  });
  await check('the shared explanation is said once, not once per agent', () =>
    assert.equal((fresh.match(/has no browser of its own/g) || []).length, 1));

  const href = await page.locator('a.setup-go').first().getAttribute('href');
  await check(' deep-links to this Space\'s settings', () =>
    assert.equal(href, 'https://huggingface.co/spaces/you/am/settings'));

  await page.locator('.setup-row').filter({ hasText: 'Claude Code' }).locator('button.setup-go').click();
  await check('opening a session asks for that agent', async () =>
    assert.deepEqual(await page.evaluate(() => window.started), ['claude']));

  console.log('\npartly configured');
  await mount({ clis: CATALOG(['claude']), secrets: ['OPENAI_API_KEY'] });
  await page.locator('.welcome-foot .btn-ghost').click();   // one agent works, so it opened on the tour
  await page.waitForTimeout(80);
  const part = await text();
  await check('counts what already works', () => assert.match(part, /1 of 3/));
  await check('each agent carries its own mark, with its readiness on it', async () => {
    const marks = await page.$$eval('.setup-logo .state-logo', (els) => els.map((e) => e.className));
    assert.equal(marks.length, 3, `expected one mark per agent, got ${marks.length}`);
    // Same vocabulary as the sidebar: a live frame for an agent that can run.
    assert.deepEqual(marks.map((c) => c.split(' ').pop()), ['idle', 'stopped', 'stopped']);
  });
  await check('a ready agent offers a session instead of setup', () =>
    assert.match(part, /signed in/));

  await mount({ clis: CATALOG(['codex']), secrets: ['OPENAI_API_KEY'] });
  await page.locator('.welcome-foot .btn-ghost').click();   // one agent works, so it opened on the tour
  await check('and says WHICH secret is doing the work', async () =>
    assert.match(await text(), /via the OPENAI_API_KEY secret/));

  console.log('\nprivacy not verified');
  await mount({ clis: CATALOG([]), unverified: true });
  await check('warns before inviting any credential', async () =>
    assert.match(await text(), /Check this Space is private before signing in/));
  await mount({ clis: CATALOG([]) });
  await check('and says nothing when the bucket is verified', async () =>
    assert.ok(!/Check this Space is private/.test(await text())));

  console.log('\nwhich step opens, and the way between them');
  await mount({ clis: CATALOG(['claude']) });
  await check('an already-working Space opens on the tour', async () =>
    assert.match(await text(), /Welcome to Agent Manager/));
  await page.locator('.welcome-foot .btn-ghost').click();
  await check('and setup is one click back from it', async () =>
    assert.match(await text(), /Connect your first agent/));
  await page.locator('.welcome-foot .btn-ghost').click();
  await check('the tour is one click forward from setup', async () =>
    assert.match(await text(), /Welcome to Agent Manager/));

  console.log('\noutside a Space (no SPACE_ID): a local or self-hosted install');
  // Both of these shipped broken. With no CLIs the card rendered an empty list
  // under "pick an agent", and because nothing was configured the dismissal was
  // never recorded, so it reopened on every load offering nothing. With CLIs
  // installed every action was gated on spaceId, so a local operator saw seven
  // rows and no buttons at all.
  const LOCAL = (available, ready = false) => CATALOG(ready ? ['claude'] : [])
    .map((c) => ({ ...c, available }));

  await mount({ clis: LOCAL(false), spaceId: null });
  const bare = await text();
  await check('with no CLIs installed it says how to install them', () => {
    assert.match(bare, /No agent CLIs are installed yet/);
    assert.match(bare, /install-local-clis\.sh/);
  });
  await check('and does not ask them to pick from an empty list', () =>
    assert.ok(!/Pick an agent/.test(bare), 'offered a choice with nothing to choose'));

  await mount({ clis: LOCAL(true), spaceId: null });
  const localReady = await text();
  const localActions = await page.$$eval('.setup-go', (e) => e.length);
  await check('with CLIs installed every row still has an action', () =>
    assert.equal(localActions, 3, `expected one action per agent, got ${localActions}`));
  await check('the sign-in route is not gated on being a Space', () =>
    assert.match(localActions > 0 ? localReady : '', /Open a Claude Code session/));
  await check('and the key route is the environment, not a Space secret', () => {
    assert.match(localReady, /Set it in the environment Agent Manager runs in/);
    assert.ok(!/Space secret|restarts the Space/.test(localReady), 'offered Space secrets locally');
  });
  await check('nothing claims a Space when there is not one', () =>
    assert.ok(!/a Space has no browser/.test(localReady), 'told a local operator about Spaces'));

  // The Space path must be untouched by all of that.
  await mount({ clis: CATALOG([]), spaceId: 'you/am' });
  const spaced = await text();
  await check('a Space still gets the secret deep-link and its restart warning', () => {
    assert.match(spaced, /Add it as a Space secret/);
    assert.match(spaced, /restarts the Space/);
  });
  const spaceHref = await page.locator('a.setup-go').first().getAttribute('href');
  await check('and the link still points at that Space', () =>
    assert.equal(spaceHref, 'https://huggingface.co/spaces/you/am/settings'));

  console.log('\nthe rule that decides whether it reappears');
  const counts = await page.evaluate(() => ({
    none: window.configuredCount([
      { id: 'claude', available: true, ready: false, secrets: ['A'], signIn: 'x' },
      { id: 'shell', available: true, ready: true },
    ]),
    one: window.configuredCount([
      { id: 'claude', available: true, ready: true, secrets: ['A'], signIn: 'x' },
    ]),
    missingBinary: window.setupCandidates([
      { id: 'codex', available: false, ready: false, secrets: ['B'], signIn: 'y' },
    ]).length,
  }));
  // App.tsx reopens the window on each load while this is 0, so a reader who
  // dismisses setup before configuring anything is not stranded.
  await check('a shell does not count as a configured agent', () => assert.equal(counts.none, 0));
  await check('one working agent does', () => assert.equal(counts.one, 1));
  await check('an agent missing from the image is not offered', () => assert.equal(counts.missingBinary, 0));

  // The trap: with nothing installed there is nothing to come back for, so
  // closing it has to stick. Dismissal is only withheld while the card can
  // still do something about the state it is complaining about.
  const offering = await page.evaluate(() => ({
    nothingInstalled: window.keepOffering([{ id: 'claude', available: false, ready: false, secrets: ['A'], signIn: { note: null } }]),
    installedUnconfigured: window.keepOffering([{ id: 'claude', available: true, ready: false, secrets: ['A'], signIn: { note: null } }]),
    oneWorking: window.keepOffering([
      { id: 'claude', available: true, ready: true, secrets: ['A'], signIn: { note: null } },
      { id: 'codex', available: true, ready: false, secrets: ['B'], signIn: { note: null } },
    ]),
  }));
  await check('closing it sticks when nothing is installed to configure', () =>
    assert.equal(offering.nothingInstalled, false));
  await check('but it returns while an installed agent is unconfigured', () =>
    assert.equal(offering.installedUnconfigured, true));
  await check('and stops returning once one agent works', () =>
    assert.equal(offering.oneWorking, false));

  console.log('\nicons and commands, by size');
  // Every glyph in icons.tsx is <svg viewBox> with NO width/height, so its size
  // is entirely CSS's job. A glyph dropped into a flex row with no rule fills
  // it — the API-key key rendered at 406px — and one in a plain span collapses
  // to 0. Both shipped. This asserts the whole class rather than the one that
  // was noticed.
  for (const [w, name] of [[1000, 'desktop'], [390, 'phone']]) {
    await page.setViewportSize({ width: w, height: 900 });
    await mount({ clis: CATALOG([]), unverified: true });
    const icons = await page.$$eval('.welcome-card svg', (els) => els.map((e) => ({
      where: String(e.parentElement?.className || '?'),
      w: Math.round(e.getBoundingClientRect().width),
      h: Math.round(e.getBoundingClientRect().height),
    })));
    await check(`${name}: every icon has a sane size`, () => {
      assert.ok(icons.length >= 3, `only ${icons.length} icons found`);
      const bad = icons.filter((i) => i.w < 8 || i.w > 28 || i.h < 8 || i.h > 28);
      assert.deepEqual(bad, [], `off-size icons: ${JSON.stringify(bad)}`);
    });
    // The command is the one thing a reader retypes, so it must not be clipped:
    // at phone width `codex login --device-auth` was cut to "--device-aut".
    // Every row is text-left / action-right. Claude's had a button alone on
    // the left once its command was removed, because the note was optional —
    // so this asserts the shape rather than that one row, and the actions
    // share an edge rather than each finding its own.
    const shape = await page.$$eval('.setup-act', (rows) => rows.map((r) => {
      const btn = r.querySelector('.setup-go'); const note = r.querySelector('.setup-note');
      return { note: !!note && !!note.textContent.trim(), right: btn ? Math.round(btn.getBoundingClientRect().right) : null };
    }));
    await check(`${name}: every row has a note beside its action`, () =>
      assert.deepEqual(shape.filter((r) => !r.note), [], 'a row had an action with nothing to say'));
    await check(`${name}: every action sits in the same slot`, () => {
      const edges = [...new Set(shape.map((r) => r.right).filter((x) => x !== null))];
      assert.equal(edges.length, 1, `actions ended at ${JSON.stringify(edges)}`);
    });

    // Nothing in a row may run under the button beside it — the secret names
    // for an agent that accepts three of them did exactly that.
    const overlap = await page.$$eval('.setup-act', (els) => els.flatMap((row) => {
      const note = row.querySelector('.setup-note'); const btn = row.querySelector('.setup-go');
      if (!note || !btn) return [];
      const a = note.getBoundingClientRect(); const b = btn.getBoundingClientRect();
      const hit = a.right > b.left + 1 && a.left < b.right - 1 && a.bottom > b.top + 1 && a.top < b.bottom - 1;
      return hit ? [note.textContent.slice(0, 40)] : [];
    }));
    await check(`${name}: nothing collides with its button`, () =>
      assert.deepEqual(overlap, [], `overlapping: ${JSON.stringify(overlap)}`));
  }
  await page.setViewportSize({ width: 1000, height: 900 });

  await check('no page errors', () => assert.deepEqual(errors, [], errors[0]));
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\nwelcome-setup: ok');
process.exit(failed ? 1 : 0);
