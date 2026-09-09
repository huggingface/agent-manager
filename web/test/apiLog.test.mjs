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
const PROMPT = '## Review\n\nRead the diff in `web/` and report:\n\n- anything that would **break**\n- anything undocumented\n';
const prompt = (i, from, to, chars, ok = true) => ({
  id: `p${i}`, at: at(i), method: 'POST', path: `/api/agents/${to}/prompt`,
  origin: { id: from, type: 'agent', name: from },
  target: { id: to, name: to, cli: 'claude' },
  // as the log stores it now: the text, and the checksum that spots a repeat
  request: { present: true, chars, sha256: `sha-${chars}`, text: PROMPT },
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
  request: { present: true, chars: 88, sha256: 'seed', text: 'Write a poem about FUSE.' },
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
  { id: 'w-poet', at: at(2), method: 'GET', path: '/api/agents/poet-1/wait',
    origin: { id: 'manager', type: 'agent', name: 'manager' },
    target: { id: 'poet-1', name: 'poet', cli: 'claude' },
    status: 200, ok: true, durationMs: 258000,
    result: { id: 'poet-1', state: 'waiting', matched: true, waited: 258 } },
];

// The case the first span implementation dropped: five minutes of blocking with
// no other call in between, and nothing after it either. Snapping the resolution
// to the nearest neighbouring call gave this no span at all — which is the
// normal shape of waiting, not an edge case.
const quietWait = {
  id: 'wq', at: at(600), method: 'GET', path: '/api/agents/quiet-1/wait',
  origin: { id: 'watcher', type: 'agent', name: 'watcher' },
  target: { id: 'quiet-1', name: 'quiet', cli: 'claude' },
  status: 200, ok: true, durationMs: 300000,
  result: { id: 'quiet-1', state: 'waiting', matched: true, waited: 300 },
};
operations.push({ ...prompt(599, 'watcher', 'quiet-1', 64), target: { id: 'quiet-1', name: 'quiet', cli: 'claude' } });
operations.push(quietWait);
// The log keeps whole bodies now, so the viewer has to cope with one this big.
// Nothing is cut on disk; the card decides how much of it to paint.
const HUGE = 'q'.repeat(400_000);
operations.push({
  id: 'big', at: at(601), method: 'PUT', path: '/api/files/files-9/write',
  origin: { id: 'manager', type: 'agent', name: 'manager' },
  target: { id: 'files-9', name: 'files-9' },
  request: { present: true, chars: HUGE.length, sha256: 'sha-huge', text: HUGE },
  status: 200, ok: true, durationMs: 88, result: { ok: true, size: HUGE.length },
});

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


// A real press on the Nth mark. Selection is committed by the SVG's pointerup
// (see ApiLog.tsx: brushing captures the pointer, so a mark's own click never
// fires), which means a synthetic click cannot stand in for a user here.
const pressMark = async (page, pick = 0) => {
  const spot = await page.evaluate((n) => {
    const marks = [...document.querySelectorAll('.al-arrowg, .al-dotg')];
    const g = typeof n === 'number' ? marks[n] : marks.find((m) => new RegExp(n).test(m.querySelector('title')?.textContent || ''));
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, pick);
  if (!spot) return false;
  await page.mouse.move(spot.x, spot.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(120);
  return true;
};
const browser = await chromium.launch(chromiumLaunchOptions());
// A duplicate React key silently duplicates DOM nodes, which is how a fixture id
// collision looked like a zoom bug for twenty minutes. Fail on it instead.
const warnings = [];
const open = async (width) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') warnings.push(m.text().slice(0, 120)); });
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.addScriptTag({ path: bundle });
  await page.waitForFunction(() => !!document.querySelector('.al-tbl tbody tr'));
  return page;
};

try {
  const page0 = await open(1200);
  const filters = await page0.evaluate(() => {
    const box = document.querySelector('.al-check input');
    return {
      isCheckbox: box?.type === 'checkbox',
      checked: !!box?.checked,
      inHeader: !!document.querySelector('.al-head .al-check'),
      label: document.querySelector('.al-check')?.textContent.trim(),
      whos: [...document.querySelectorAll('.al-who')].map((e) => e.textContent.trim()),
      header: document.querySelector('.al-count')?.textContent.replace(/\s+/g, ' ').trim(),
      finds: document.querySelectorAll('.al-find').length,
    };
  });
  const mineCount = operations.filter((o) => o.origin?.type === 'operator').length;
  console.log('the only control there is');
  check('a plain checkbox, unchecked, on the same line as the buttons',
    () => {
      assert.ok(filters.isCheckbox, 'not a checkbox');
      assert.equal(filters.checked, false);
      assert.ok(filters.inHeader, 'not on the header line');
      assert.match(filters.label, /^show user calls/, `label: ${filters.label}`);
    });
  check('and no path search either', () => assert.equal(filters.finds, 0));
  check('the user\'s own calls are out until it is ticked, and it says how many',
    () => {
      assert.ok(!filters.whos.includes('lvwerra'), `whos: ${filters.whos.join(', ')}`);
      assert.match(filters.label, new RegExp(`\\(${mineCount}\\)`), `label: ${filters.label}`);
    });
  check('the failure count survives as a fact rather than a filter',
    () => assert.match(filters.header, /1 failed/));
  await page0.click('.al-check input');
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
      first: cells.find((c) => c[2].includes('/api/agents/builder/wait')) || cells[0],
      repeats: [...document.querySelectorAll('.al-rep')].map((e) => e.textContent.trim()),
      whos: [...document.querySelectorAll('.al-who')].map((e) => e.textContent.trim()),
      newest: document.querySelector('.al-tbl tbody tr')?.getAttribute('title')?.split(' ')[0],
      big: (() => {
        const row = [...document.querySelectorAll('.al-tbl tbody tr')]
          .find((r) => r.textContent.includes('/api/files/files-9/write'));
        return row ? { payload: row.children[5].textContent.trim(), height: row.getBoundingClientRect().height } : null;
      })(),
    };
  });
  console.log('what a row says');
  check('a resolved wait reads as one, with the time it blocked for',
    () => assert.deepEqual(list.first.slice(2), ['GET /api/agents/builder/wait', '200', '4m 18s', 'resolved · waiting']));
  check('and the newest row really is the newest', () => assert.equal(list.newest, operations[0].at));
  check('identical prompts are marked as repeats — the checksum still earns its place',
    () => assert.deepEqual(list.repeats, ['×2', '×2']));
  check('an unattributed call still reads as a row, with an em dash for who',
    () => assert.ok(list.whos.includes('—'), list.whos.join(', ')));
  // "just store all the full api calls" — so the VIEWER is what has to stay
  // usable when one of them is 400 KB. The row says how big, on one line.
  check('a 400 KB body is a size in the list, not an attempt to show it',
    () => {
      assert.ok(list.big, 'the big entry is missing from the list');
      assert.match(list.big.payload, /^file · \d+(\.\d+)? KB$/, `payload: ${list.big.payload}`);
      assert.ok(list.big.height < 30, `row is ${list.big.height}px tall`);
    });

  await page.click('.al-view button:nth-child(2)');
  await page.waitForSelector('.al-map svg');
  const map = await page.evaluate(() => {
    const birth = document.querySelectorAll('circle.al-birth').length;
    const held = [...document.querySelectorAll('.al-held')].map((l) => Number(l.getAttribute('x2')) - Number(l.getAttribute('x1')));
    const heldEnds = [...document.querySelectorAll('.al-held')].map((l) => Number(l.getAttribute('x2')));
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
    return { lanes, arrows, birth, held, heldEnds, unborn, dotLanes: dotLanes.map((y) => lanes[laneAt(y)]) };
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
  const timedWaits = operations.filter((o) => o.method === 'GET' && o.durationMs > 0 && o.origin);
  check(`every one of the ${timedWaits.length} waits that blocked draws a span`,
    () => {
      assert.equal(map.held.length, timedWaits.length, `spans: ${map.held.join(', ')}`);
      assert.ok(map.held.every((w) => w > 1), `widths: ${map.held.join(', ')}`);
    });
  check('including the five-minute one that blocked with nothing else going on',
    () => {
      // That wait is the newest thing in the fixture and resolved last, so its
      // span has to run to the right edge of the plot — 760 wide, 20 of margin.
      assert.ok(map.heldEnds.some((x2) => x2 >= 760 - 20 - 1), `span ends: ${map.heldEnds.join(', ')}`);
    });
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

  // A card you cannot reach is a card you cannot read: the JSON is capped and
  // scrollable, so the pointer has to be able to travel from the mark into it.
  const reach = await page.evaluate(async () => {
    const card = document.querySelector('.al-card');
    const before = card.querySelector('.al-card-path').textContent;
    // leave the mark the way a pointer does, then arrive on the card
    document.querySelector('.al-arrowg').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: card }));
    document.querySelector('.al-arrowg').dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    card.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    await new Promise((r) => setTimeout(r, 400));
    const still = document.querySelector('.al-card-path')?.textContent;
    const pre = document.querySelector('.al-json');
    let scrolled = null;
    if (pre) { pre.scrollTop = 40; scrolled = pre.scrollTop; }
    return { before, still, idle: !!document.querySelector('.al-card-idle'), scrolled,
      overflows: pre ? pre.scrollHeight > pre.clientHeight : null };
  });
  check('the entry survives the pointer moving onto the card',
    () => { assert.equal(reach.still, reach.before); assert.ok(!reach.idle); });
  check('and the JSON is shown whole rather than in a scrolling window',
    () => assert.equal(reach.overflows, false, 'the card clips its own content'));

  // …and a click keeps it, so the pointer can go anywhere without losing it.
  await pressMark(page, 0);
  const pinned = await page.evaluate(async () => {
    const path = document.querySelector('.al-card-path')?.textContent;
    const g = document.querySelector('.al-arrowg, .al-dotg');
    g.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    return {
      path,
      still: document.querySelector('.al-card-path')?.textContent,
      marked: !!document.querySelector('.al-card.pinned'),
      hasClose: !!document.querySelector('.al-card-x'),
    };
  });
  check('clicking a call pins the entry, and it says so',
    () => { assert.equal(pinned.still, pinned.path); assert.ok(pinned.marked && pinned.hasClose); });

  // "it is hard/impossible to select an element that then stays selected so i
  // can easily scroll down and read the trace without being deselected."
  console.log('\nkeeping an entry while you read it');
  const gutter = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.settings-main')).scrollbarGutter);
  check('the settings scroller reserves its scrollbar gutter, so appearing cannot move the plot',
    () => assert.match(gutter, /stable/, `scrollbar-gutter: ${gutter}`));

  await pressMark(page, 0);
  const sticks = await page.evaluate(async () => {
    const marks = [...document.querySelectorAll('.al-arrowg, .al-dotg')];
    const first = marks[0];
    const picked = document.querySelector('.al-card-path')?.textContent;
    const ringed = document.querySelectorAll('.al-held-ring').length;
    // the pointer wanders off the mark, and the page scrolls
    first.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    document.querySelector('.settings-main').scrollTop = 120;
    await new Promise((r) => setTimeout(r, 400));
    const afterScroll = document.querySelector('.al-card-path')?.textContent;
    // hovering ANOTHER mark must not steal a pinned selection
    const other = marks.find((m) => m !== first);
    other.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    other.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    await new Promise((r) => setTimeout(r, 120));
    const afterHover = document.querySelector('.al-card-path')?.textContent;
    return { picked, ringed, afterScroll, afterHover };
  });
  check('it survives the pointer leaving and the page scrolling',
    () => { assert.equal(sticks.afterScroll, sticks.picked); assert.ok(sticks.picked); });
  check('hovering another call does not steal it',
    () => assert.equal(sticks.afterHover, sticks.picked));
  check('and the mark it belongs to is ringed', () => assert.ok(sticks.ringed >= 1, `${sticks.ringed} rings`));

  const escaped = await page.evaluate(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    return { pinned: !!document.querySelector('.al-card.pinned'), rings: document.querySelectorAll('.al-held-ring').length,
      card: document.querySelector('.al-card')?.className };
  });
  await pressMark(page, 0);
  const closed = await page.evaluate(async () => {
    document.querySelector('.al-card-x')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    return { pinned: !!document.querySelector('.al-card.pinned'), rings: document.querySelectorAll('.al-held-ring').length };
  });
  const letGo = await page.evaluate(async () => {
    return {};
  });
  // Whether the card then shows a preview depends on where the pointer happens
  // to be — what must be gone is the PIN.
  check('Escape lets go of it',
    () => { assert.ok(!escaped.pinned, `card: ${escaped.card}`); assert.equal(escaped.rings, 0); });
  check('so does the ✕', () => { assert.ok(!closed.pinned); assert.equal(closed.rings, 0); });

  // The bug behind "impossible to select": a brush that ended on empty space
  // left the swallow-the-next-click flag set, and the next click on a mark was
  // eaten instead of selecting it.
  const afterBrush = await page.evaluate(() => {
    const b = document.querySelector('.al-map svg').getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height };
  });
  const emptyY = afterBrush.top + afterBrush.height - 12;   // below the lanes
  await page.mouse.move(afterBrush.left + afterBrush.width * 0.2, emptyY);
  await page.mouse.down();
  await page.mouse.move(afterBrush.left + afterBrush.width * 0.45, emptyY, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  if (await page.$('.al-reset')) await page.click('.al-reset');
  await page.waitForTimeout(120);
  await pressMark(page, 0);
  const clickAfterDrag = await page.evaluate(() => ({
    pinned: !!document.querySelector('.al-card.pinned'),
    card: document.querySelector('.al-card')?.className,
    path: document.querySelector('.al-card-path')?.textContent,
  }));
  check('a click still selects after an unrelated drag',
    () => assert.ok(clickAfterDrag.pinned, `card: ${clickAfterDrag.card} / ${clickAfterDrag.path}`));

  // "why arent the prompts not stored? or just not shown? we should change that"
  await pressMark(page, '/prompt$');
  const words = await page.evaluate(() => {
    const md = document.querySelector('.markdown.al-md');
    return {
      path: document.querySelector('.al-card-path')?.textContent,
      rendered: md ? { h: md.querySelectorAll('h2').length, li: md.querySelectorAll('li').length,
        code: md.querySelectorAll('code').length, strong: md.querySelectorAll('strong').length,
        text: md.textContent } : null,
      rawShown: !!document.querySelector('.al-prompt-body'),
      toggle: [...document.querySelectorAll('.al-md-toggle button')].map((b) => b.textContent.trim()),
      on: document.querySelector('.al-md-toggle .on')?.textContent.trim(),
      json: document.querySelector('.al-json')?.textContent,
      selectable: md ? getComputedStyle(md).userSelect !== 'none' : null,
    };
  });
  console.log('\nthe prompt itself');
  check('is rendered as markdown by default — headings, list, code, emphasis',
    () => {
      assert.match(words.path || '', /\/prompt$/, `card shows ${words.path}`);
      assert.ok(words.rendered, 'no rendered block');
      assert.deepEqual(
        { h: words.rendered.h > 0, li: words.rendered.li, code: words.rendered.code > 0, strong: words.rendered.strong > 0 },
        { h: true, li: 2, code: true, strong: true },
        JSON.stringify(words.rendered),
      );
      assert.ok(!words.rendered.text.includes('##'), 'the markup is showing through');
    });
  check('with the file viewer\'s own control and wording beside it',
    () => { assert.deepEqual(words.toggle, ['Rendered', 'Source']); assert.equal(words.on, 'Rendered'); });
  check('and no raw block until you ask for one', () => assert.ok(!words.rawShown));
  check('as its own block rather than escaped into the JSON',
    () => assert.ok(!words.json.includes('\\n'), 'the JSON carries an escaped prompt'));
  check('with the checksum still in the entry, which is what spots a repeat',
    () => assert.match(words.json, /sha256/));
  check('and it can be selected', () => assert.ok(words.selectable));

  const source = await page.evaluate(async () => {
    [...document.querySelectorAll('.al-md-toggle button')].find((b) => b.textContent.trim() === 'Source')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    return { raw: document.querySelector('.al-prompt-body')?.textContent, md: !!document.querySelector('.markdown.al-md') };
  });
  check('Source shows the text exactly as sent, and nothing rendered',
    () => { assert.equal(source.raw, PROMPT); assert.ok(!source.md); });

  await pressMark(page, 'files-9');
  const painted = await page.evaluate(() => ({
    drawn: (document.querySelector('.al-prompt-body') || document.querySelector('.markdown.al-md'))?.textContent.length,
    note: document.querySelector('.al-clipped')?.textContent,
    path: document.querySelector('.al-card-path')?.textContent,
  }));
  check('a 400 KB body is not painted whole, and the card says how much it is holding back',
    () => {
      assert.match(painted.path || '', /files-9/, `card shows ${painted.path}`);
      assert.ok(painted.drawn <= 20_000, `painted ${painted.drawn} characters`);
      assert.match(painted.note || '', /400,000 characters/, `note: ${painted.note}`);
    });

  // "i want an option to show things in real time, now it seems all actions are
  // equi-distant" — and then: "maybe we need a way to zoom in and zoom out"
  const scaled = await page.evaluate(async () => {
    // .al-arrowg only: the legend's swatches are .al-arrow too
    const xs = () => [...document.querySelectorAll('.al-arrowg .al-arrow')].map((l) => Math.round(Number(l.getAttribute('x1'))));
    const gaps = (a) => a.slice(1).map((v, i) => v - a[i]).filter((g) => g > 0);
    const even = gaps([...new Set(xs())].sort((a, b) => a - b));
    const svgWidth = () => document.querySelector('.al-map svg').style.width;
    document.querySelectorAll('.al-scale button')[1].click();
    await new Promise((r) => setTimeout(r, 120));
    const clock = gaps([...new Set(xs())].sort((a, b) => a - b));
    return { even, clock, width: svgWidth() };
  });
  console.log('\ntwo ways to lay out the same calls');
  // Not every event draws an arrow, so consecutive arrows sit one OR SEVERAL
  // steps apart. What separates the modes is the smallest gap: evenly spaced,
  // it is the grid step and nothing can be closer; by the clock, calls a second
  // apart land on top of each other — which is the whole reason zoom exists.
  const evenStep = Math.min(...scaled.even);
  const clockStep = Math.min(...scaled.clock);
  check('evenly spaced by default — every gap a whole number of steps',
    () => {
      assert.ok(evenStep > 20, `step ${evenStep}px`);
      assert.ok(scaled.even.every((g) => Math.abs(g / evenStep - Math.round(g / evenStep)) < 0.08),
        `gaps: ${scaled.even.join(', ')}`);
    });
  check('and by the clock on demand, where a burst collapses and a quiet spell opens up',
    () => {
      assert.ok(clockStep < evenStep / 4, `clock step ${clockStep}px vs even ${evenStep}px`);
      assert.ok(Math.max(...scaled.clock) > evenStep * 2, `widest clock gap ${Math.max(...scaled.clock)}px`);
    });
  check('and the drawing still fits its frame in both — zoom is a window, not a stretch',
    () => assert.equal(scaled.width, ''));

  // "i meant more zooming into specific regions of the x-axis … drag
  // horizontally a window to zoom in". Driven with a real mouse, not synthetic
  // events, because pointer capture and the click that follows a drag are
  // exactly what has to behave.
  const { allMarks, fullAxisLeft } = await page.evaluate(() => ({
    allMarks: document.querySelectorAll('.al-arrowg, circle.al-dot').length,
    fullAxisLeft: document.querySelectorAll('.al-axis')[0]?.textContent,
  }));
  // release whatever the card tests pinned, so "the drag did not select" is
  // about the drag rather than about leftover state
  if (await page.$('.al-card-x')) await page.click('.al-card-x');
  const plot = await page.evaluate(() => {
    const box = document.querySelector('.al-map svg').getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  });
  const atFrac = (f) => plot.left + plot.width * f;
  const midY = plot.top + plot.height * 0.35;
  await page.mouse.move(atFrac(0.35), midY);
  await page.mouse.down();
  await page.mouse.move(atFrac(0.5), midY, { steps: 6 });
  const midDrag = await page.evaluate(() => ({
    brush: !!document.querySelector('.al-brush'),
    label: document.querySelector('.al-brush-lbl')?.textContent,
  }));
  await page.mouse.move(atFrac(0.75), midY, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const zoomed = await page.evaluate(() => ({
    brush: !!document.querySelector('.al-brush'),
    window: document.querySelector('.al-window')?.textContent?.trim(),
    reset: !!document.querySelector('.al-reset'),
    marks: document.querySelectorAll('.al-arrowg, circle.al-dot').length,
    axisLeft: document.querySelectorAll('.al-axis')[0]?.textContent,
    pinned: !!document.querySelector('.al-card.pinned'),
  }));
  console.log('\ndrag across the plot to zoom');
  check('the selection is drawn while dragging, with the range on it',
    () => { assert.ok(midDrag.brush); assert.match(midDrag.label || '', /\d\d:\d\d:\d\d → \d\d:\d\d:\d\d/, `label: ${midDrag.label}`); });
  check('releasing keeps that window, and says which one it is',
    () => {
      assert.ok(!zoomed.brush, 'the selection rectangle stayed up');
      assert.match(zoomed.window || '', /\d\d:\d\d:\d\d → \d\d:\d\d:\d\d · \d+ of \d+ calls/, `window: ${zoomed.window}`);
    });
  check('there are fewer calls in view than before', () => assert.ok(zoomed.marks < allMarks, `${zoomed.marks} of ${allMarks}`));
  check('the axis names the slice, not the whole run', () => assert.notEqual(zoomed.axisLeft, fullAxisLeft));
  check('and a drag that started on a mark did not also select it', () => assert.ok(!zoomed.pinned));
  check('there is a way back out', () => assert.ok(zoomed.reset));

  await page.click('.al-reset');
  await page.waitForTimeout(120);
  const out = await page.evaluate(() => ({
    marks: document.querySelectorAll('.al-arrowg, circle.al-dot').length,
    window: !!document.querySelector('.al-window'),
    axisLeft: document.querySelectorAll('.al-axis')[0]?.textContent,
  }));
  check('reset puts everything back', () => {
    assert.equal(out.marks, allMarks, `${out.marks} marks after reset vs ${allMarks} before`);
    assert.ok(!out.window);
    assert.equal(out.axisLeft, fullAxisLeft);
  });

  // and again, cleared by double-click
  await page.mouse.move(atFrac(0.3), midY);
  await page.mouse.down();
  await page.mouse.move(atFrac(0.6), midY, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const beforeDouble = await page.evaluate(() => !!document.querySelector('.al-window'));
  await page.mouse.dblclick(atFrac(0.5), midY);
  await page.waitForTimeout(120);
  const afterDouble = await page.evaluate(() => !!document.querySelector('.al-window'));
  check('double-click clears it too', () => { assert.ok(beforeDouble); assert.ok(!afterDouble); });
  // A horizontal drag on a phone is how you scroll — the frame scrolls sideways
  // and the page scrolls down — so brushing is mouse and pen only rather than
  // competing for the gesture.
  const touched = await page.evaluate(async () => {
    const svg = document.querySelector('.al-map svg');
    const box = svg.getBoundingClientRect();
    const at = (f) => box.left + box.width * f;
    const opts = (x) => ({ pointerType: 'touch', pointerId: 7, clientX: x, clientY: box.top + 20, bubbles: true, isPrimary: true });
    svg.dispatchEvent(new PointerEvent('pointerdown', opts(at(0.3))));
    svg.dispatchEvent(new PointerEvent('pointermove', opts(at(0.6))));
    const during = !!document.querySelector('.al-brush');
    svg.dispatchEvent(new PointerEvent('pointerup', opts(at(0.6))));
    await new Promise((r) => setTimeout(r, 100));
    return { during, zoomed: !!document.querySelector('.al-window'), touchAction: getComputedStyle(svg).touchAction };
  });
  check('a touch drag does not brush, and the page keeps its own scrolling',
    () => {
      assert.ok(!touched.during, 'a touch started a selection');
      assert.ok(!touched.zoomed, 'a touch zoomed the axis');
      assert.notEqual(touched.touchAction, 'none');
    });

  // A duplicate key silently duplicates DOM nodes — a fixture id collision once
  // read exactly like a zoom bug. Nothing in the map should be warning.
  check('and the map renders without React complaining',
    () => assert.deepEqual(warnings, [], warnings.join(' // ')));
  await page.close();
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : '\napi-log: ok');
process.exit(failed ? 1 : 0);
