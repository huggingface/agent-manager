// Settings → API log, in a real browser.
//
// Two rules here came from the operator and are the kind that decay silently,
// so they are pinned rather than trusted:
//
//   1. ONE CALL PER LINE. A wrapped row halves how many calls fit on a screen.
//      Every cell clips; the path is the only column allowed to take the slack,
//      and below a certain width the table scrolls sideways instead of crushing
//      it. Measured as row height, not as CSS.
//   2. NO PILLS OR BADGES in a row. Status is coloured TEXT in its column — no
//      border, no background, no chip.
//
// And one rule the map's legend claims, which is only true if the lanes are
// ordered caller-above-target: a prompt goes from caller to target, a resolved
// wait comes back the other way.
//
// Run with:  node test/apiLog.test.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-log-'));
const bundle = path.join(tmp, 'app.js');

const at = (s) => new Date(Date.UTC(2026, 7, 19, 21, 0, s)).toISOString();
const prompt = (i, from, to, chars, ok = true) => ({
  id: `p${i}`, at: at(i), method: 'POST', path: `/api/agents/${to}/prompt`,
  origin: { id: from, type: 'agent', name: from },
  target: { id: to, name: to, cli: 'claude' },
  request: { present: true, chars, sha256: `sha-${chars}` },
  status: ok ? 200 : 404, ok, durationMs: 303, result: { ok },
});
const wait = (i, watcher, watched, ms) => ({
  id: `w${i}`, at: at(i), method: 'GET', path: `/api/agents/${watched}/wait`,
  origin: { id: watcher, type: 'agent', name: watcher },
  target: { id: watched, name: watched, cli: 'claude' },
  status: 200, ok: true, durationMs: ms,
  result: { id: watched, state: 'waiting', matched: true, waited: Math.round(ms / 1000) },
});
// A wait the server accepted with no `?from=`: read-only, so it is never
// refused, and every watch loop running today calls it that way. Nobody is
// attributed, so there is no caller to draw an arrow from.
// Its target is an agent nothing else in the fixture touches, so the mark it
// leaves can only have come from this entry.
const anonymousWait = {
  id: 'w0', at: at(2), method: 'GET', path: '/api/agents/lonely/wait',
  origin: null, target: { id: 'lonely', name: 'lonely', cli: 'claude' },
  status: 200, ok: true, durationMs: 12000,
  result: { id: 'lonely', state: 'waiting', matched: true, waited: 12 },
};
// The operator's own calls: most of a real log, and hidden by default because
// this view is for what the AGENTS did to each other.
const mine = (i) => ({
  id: `m${i}`, at: at(20 + i), method: 'POST', path: '/api/sessions/shell-1/input',
  origin: { id: 'lvwerra', type: 'operator', name: 'lvwerra' },
  target: { id: 'shell-1', name: 'shell-1', cli: 'shell' },
  request: { text: { present: true, chars: 30, sha256: `mine-${i}` } },
  status: 200, ok: true, durationMs: 200, result: { ok: true },
});
// A create names nothing in its path: the session it made is in the result, and
// the lane it brings into being must not look as though it was always there.
const create = {
  id: 'c1', at: at(1), method: 'POST', path: '/api/agents',
  origin: { id: 'manager', type: 'agent', name: 'manager' },
  query: { cli: 'claude', name: 'poet' },
  request: { present: true, chars: 88, sha256: 'seed' },
  status: 201, ok: true, durationMs: 452,
  result: { id: 'poet-1', name: 'poet', cli: 'claude', path: 'poet' },
};
// Two identical prompts (same checksum) — what a repeating job looks like.
const operations = [
  mine(1), mine(2), mine(3),
  create,
  wait(9, 'manager', 'builder', 258000),
  prompt(8, 'manager', 'builder', 1204),
  prompt(7, 'manager', 'ghost-1', 12, false),
  wait(6, 'operator', 'manager', 61000),
  prompt(5, 'operator', 'manager', 4096),
  prompt(4, 'manager', 'builder', 1204),
  { id: 'f1', at: at(3), method: 'PUT', path: '/api/files/files-5/write',
    origin: { id: 'operator', type: 'operator', name: 'operator' },
    target: { id: 'files-5', name: 'files-5' },
    request: { present: true, chars: 8400, sha256: 'sha-file' },
    status: 200, ok: true, durationMs: 41, result: { ok: true } },
  anonymousWait,
  // manager waits on the agent it just created; 258s of being blocked
  { id: 'w9', at: at(2), method: 'GET', path: '/api/agents/poet-1/wait',
    origin: { id: 'manager', type: 'agent', name: 'manager' },
    target: { id: 'poet-1', name: 'poet', cli: 'claude' },
    status: 200, ok: true, durationMs: 258000,
    result: { id: 'poet-1', state: 'waiting', matched: true, waited: 258 } },
];

operations.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));  // the endpoint's own order

const stub = path.join(tmp, 'api-stub.ts');
fs.writeFileSync(stub, `
export * from ${JSON.stringify(path.join(WEB, 'src/api.ts'))};
export const getOperations = () => Promise.resolve(${JSON.stringify({ operations, generatedAt: at(9) })});
export const getTree = () => Promise.resolve({ sessions: [], groups: [], order: [], hidden: [] });
`);

await build({
  stdin: {
    resolveDir: WEB,
    loader: 'tsx',
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ApiLog from './src/components/ApiLog.tsx';
      createRoot(document.getElementById('root')).render(
        <div className="app settings"><div className="main settings-main">
          <div className="settings-page wide"><ApiLog /></div>
        </div></div>);
    `,
  },
  outfile: bundle,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  logLevel: 'error',
  plugins: [{ name: 'stub-api', setup(b) { b.onResolve({ filter: /(^|\/)\.\.?\/api$/ }, () => ({ path: stub })); } }],
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++;
    console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const browser = await chromium.launch(chromiumLaunchOptions());
const open = async (width) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.addScriptTag({ path: bundle });
  await page.waitForFunction(() => !!document.querySelector('.al-tbl tbody tr'));
  return page;
};

try {
  const page0 = await open(1200);
  const filters = await page0.evaluate(() => {
    const chips = [...document.querySelectorAll('.al-chip')];
    return {
      chips: chips.length,
      label: chips[0]?.textContent.trim(),
      whos: [...document.querySelectorAll('.al-who')].map((e) => e.textContent.trim()),
      header: document.querySelector('.al-count')?.textContent.replace(/\s+/g, ' ').trim(),
      finds: document.querySelectorAll('.al-find').length,
    };
  });
  const mineCount = operations.filter((o) => o.origin?.type === 'operator').length;
  console.log('the only filter there is');
  check('one control, not a row of them', () => assert.equal(filters.chips, 1));
  check('and no path search either', () => assert.equal(filters.finds, 0));
  check('the operator\'s own calls are hidden by default, and it says how many',
    () => {
      assert.ok(!filters.whos.includes('lvwerra'), `whos: ${filters.whos.join(', ')}`);
      assert.match(filters.label, new RegExp(`hidden \\(${mineCount}\\)`), `label: ${filters.label}`);
    });
  check('the failure count survives as a fact rather than a filter',
    () => assert.match(filters.header, /1 failed/));
  await page0.click('.al-chip');
  await page0.waitForFunction(() => [...document.querySelectorAll('.al-who')].some((e) => e.textContent.trim() === 'lvwerra'));
  check('and one click brings them back', () => true);
  await page0.close();
  console.log('');

  for (const width of [1200, 390]) {
    const page = await open(width);
    const m = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.al-tbl tbody tr')];
      const line = parseFloat(getComputedStyle(document.querySelector('.al-tbl')).fontSize) * 2.4;
      const st = document.querySelector('.al-st');
      const stStyle = getComputedStyle(st);
      const main = document.querySelector('.settings-main');
      return {
        rows: rows.length,
        tallest: Math.max(...rows.map((r) => r.getBoundingClientRect().height)),
        line,
        clipped: rows.every((r) => [...r.children].every((c) => getComputedStyle(c).whiteSpace === 'nowrap')),
        badge: {
          border: stStyle.borderTopWidth,
          background: stStyle.backgroundColor,
          radius: stStyle.borderTopLeftRadius,
          colour: stStyle.color,
        },
        paneOverflow: main.scrollWidth > main.clientWidth,
      };
    });
    console.log(`the list at ${width}px`);
    check(`every one of the ${m.rows} rows is a single line`, () => assert.ok(m.tallest < m.line, `tallest ${m.tallest}px`));
    check('and every cell clips rather than wraps', () => assert.ok(m.clipped));
    check('status is coloured text, not a badge', () => assert.deepEqual(
      { border: m.badge.border, background: m.badge.background, radius: m.badge.radius },
      { border: '0px', background: 'rgba(0, 0, 0, 0)', radius: '0px' },
    ));
    check('…and it does carry a colour', () => assert.ok(!/rgba?\(0, 0, 0/.test(m.badge.colour), m.badge.colour));
    check('the page itself never scrolls sideways', () => assert.ok(!m.paneOverflow));
    await page.close();
    console.log('');
  }

  const page = await open(1200);
  const list = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.al-tbl tbody tr')].map((r) => [...r.children].map((c) => c.textContent.trim()));
    return {
      first: cells[0],
      repeats: [...document.querySelectorAll('.al-rep')].map((e) => e.textContent.trim()),
      whos: [...document.querySelectorAll('.al-who')].map((e) => e.textContent.trim()),
    };
  });
  console.log('what a row says');
  check('a resolved wait reads as one, with the time it blocked for',
    () => assert.deepEqual(list.first.slice(2), ['GET /api/agents/builder/wait', '200', '4m 18s', 'resolved · waiting']));
  check('identical prompts are marked as repeats, since the text itself is never stored',
    () => assert.deepEqual(list.repeats, ['×2', '×2']));
  check('an unattributed call still reads as a row, with an em dash for who',
    () => assert.ok(list.whos.includes('—'), list.whos.join(', ')));

  await page.click('.al-view button:nth-child(2)');
  await page.waitForSelector('.al-map svg');
  const map = await page.evaluate(() => {
    const birth = document.querySelectorAll('circle.al-birth').length;
    const held = [...document.querySelectorAll('.al-held')].map((l) => Number(l.getAttribute('x2')) - Number(l.getAttribute('x1')));
    const unborn = [...document.querySelectorAll('.al-lane.unborn')].map((l) => Number(l.getAttribute('x2')));
    const labels = [...document.querySelectorAll('.al-lane-lbl')];
    const dotLanes = [...document.querySelectorAll('circle.al-dot')].map((c) => Number(c.getAttribute('cy')));
    const lanes = labels.map((t) => t.textContent);
    // Which lane an endpoint sits on: the arrow stops a few px short of the
    // hairline, so snap to the nearest lane label.
    const laneYs = labels.map((t) => Number(t.getAttribute('y')));
    const laneAt = (y) => laneYs.reduce((best, ly, i) => (Math.abs(ly - y) < Math.abs(laneYs[best] - y) ? i : best), 0);
    const arrows = [...document.querySelectorAll('.al-arrow')].map((l) => ({
      back: l.classList.contains('back'),
      bad: l.classList.contains('bad'),
      down: Number(l.getAttribute('y2')) > Number(l.getAttribute('y1')),
      src: lanes[laneAt(Number(l.getAttribute('y1')))],
      dst: lanes[laneAt(Number(l.getAttribute('y2')))],
      dashed: !!getComputedStyle(l).strokeDasharray && getComputedStyle(l).strokeDasharray !== 'none',
    }));
    return { lanes, arrows, birth, held, unborn, dotLanes: dotLanes.map((y) => lanes[laneAt(y)]) };
  });
  console.log('\nthe map');
  check('callers are laid out above the agents they call',
    () => assert.ok(map.lanes.indexOf('manager') < map.lanes.indexOf('builder'), map.lanes.join(' < ')));
  check('a prompt is an arrow from caller down to target',
    () => assert.ok(map.arrows.some((a) => !a.back && a.down)));
  check('a resolved wait is an arrow back the other way, dashed',
    () => assert.ok(map.arrows.some((a) => a.back && !a.down && a.dashed)));
  // The claim is about direction between the two agents, not about up and down
  // on the screen: if A calls B and B also calls A, one of the pairs has to run
  // the other way. What must hold is that the wait reverses its own prompt.
  check('the wait reverses the prompt it answers — manager → builder, builder → manager',
    () => {
      const out = map.arrows.find((a) => !a.back && a.src === 'manager' && a.dst === 'builder');
      const back = map.arrows.find((a) => a.back && a.src === 'builder' && a.dst === 'manager');
      assert.ok(out && back, JSON.stringify(map.arrows));
      assert.ok(out.down && !back.down, 'and with callers on top that reads as out and back');
    });
  check('a failed call is visible in the shape too',
    () => assert.ok(map.arrows.some((a) => a.bad)));

  // The em dash in the Who column is a display fallback, not an agent. Giving it
  // a lane invented a caller the log never knew and drew a return arrow into it.
  check('an unattributed wait does not invent a caller lane',
    () => assert.ok(!map.lanes.includes('—'), map.lanes.join(' < ')));
  check('nor an arrow to one',
    () => assert.ok(!map.arrows.some((a) => a.src === '—' || a.dst === '—'), JSON.stringify(map.arrows)));
  // The operator's report: "create events are not shown … it's also not clear
  // that the poet session didnt exist before that because the line already
  // existed."
  check('a create reaches the lane it brought into being',
    () => {
      assert.ok(map.arrows.some((a) => a.src === 'manager' && a.dst === 'poet'), JSON.stringify(map.arrows));
      assert.ok(map.birth >= 1, `${map.birth} birth marks`);
    });
  check('and that lane is drawn faint until it exists',
    () => assert.ok(map.unborn.some((x2) => x2 > 2), `unborn segments end at: ${map.unborn.join(', ')}`));
  // "in the wait, i think it should also be visible when the wait started"
  check('a wait is a span from where it started, not a point',
    () => assert.ok(map.held.some((w) => w > 4), `spans: ${map.held.join(', ')}`));
  check('it is a mark on the lane of whoever was waited on',
    () => {
      assert.ok(map.lanes.includes('lonely'), map.lanes.join(' < '));
      assert.ok(map.dotLanes.includes('lonely'), `dots on: ${map.dotLanes.join(', ')}`);
      assert.ok(!map.arrows.some((a) => a.src === 'lonely' || a.dst === 'lonely'), 'and no arrow to or from it');
    });
  // "a pretty view of the json when hovering so we could see the full call plus
  // the metadata (duration, status)"
  // mouse.move, not .hover(): the group's own box centre is empty space and
  // Playwright reports the <svg> intercepting the click there.
  const spot = await page.evaluate(() => {
    const g = document.querySelector('.al-arrowg');
    const r = g.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(spot.x, spot.y);
  await page.waitForFunction(() => !!document.querySelector('.al-json'), null, { timeout: 5000 });
  const card = await page.evaluate(() => ({
    method: document.querySelector('.al-card-head .al-meth')?.textContent.trim(),
    path: document.querySelector('.al-card-path')?.textContent.trim(),
    status: document.querySelector('.al-card-head .al-st')?.textContent.trim(),
    tookText: document.querySelector('.al-card-took')?.textContent.trim(),
    json: document.querySelector('.al-json')?.textContent,
    keys: [...document.querySelectorAll('.al-json .al-k')].map((e) => e.textContent),
    floating: getComputedStyle(document.querySelector('.al-card')).position,
  }));
  console.log('\nthe hover card');
  check('shows the call, its status and how long it took',
    () => {
      assert.match(card.method, /^(POST|GET|PUT|DELETE)$/, `method: ${card.method}`);
      assert.match(card.path, /^\/api\//, `path: ${card.path}`);
      assert.match(card.status, /^\d{3}$/, `status: ${card.status}`);
      assert.match(card.tookText, /^\d/, `took: ${card.tookText}`);
    });
  check('and the whole entry as JSON, with the metadata named',
    () => ['at', 'call', 'from', 'to', 'status', 'took'].forEach((k) => assert.ok(card.keys.includes(k), `${k} missing from ${card.keys.join(', ')}`)));
  check('still never the prompt text', () => assert.ok(!/"text":\s*"/.test(card.json)));
  check('and it sits below the plot rather than covering it',
    () => assert.equal(card.floating, 'static'));
  await page.close();
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : '\napi-log: ok');
process.exit(failed ? 1 : 0);
