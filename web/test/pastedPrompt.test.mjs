// A prompt typed while the agent is mid-turn, through the real pipeline (#101).
//
// Claude Code does not write such a prompt as a `user` message. It queues it as
// `queue-operation` records, and when it absorbs the message into the running
// turn it writes `remove` with `reason: "absorbed_mid_turn"`. The queued copy is
// then the ONLY copy of that text in the transcript — there is no later `user`
// record, and the `attachment` record that carries it is not rendered — so the
// reader has to show it or the operator's message is lost on reload.
//
// Claude Code also wraps pasted text in `<pasted_content id="…">…`. That is the
// operator's own text, so it is unwrapped rather than filtered, and leaving it
// in broke two things at once:
//
//   - the closing tag carries an `id` attribute, which is not valid HTML, so
//     markdown prints it literally while swallowing the opening tag;
//   - the reader's optimistic echo retires itself by checking whether the text
//     that came back starts with the text it sent, which a wrapper defeats —
//     so the sent prompt stayed on screen beside the copy from the transcript.
//     That is the duplicate the operator reported: wrapped copy first, clean
//     copy second.
//
// Records go through the REAL server normalizer and the REAL reader, because
// the duplicate only exists when both halves are present. Run with:
//   node test/queuedPrompt.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';
import { readTraceByPath } from '../../server/src/traces.js';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'queued-prompt-'));
const bundle = path.join(tmp, 'fixture.js');

// ---- the records Claude Code actually writes, copied from a live transcript ----
const S = '99caf302-4002-47ac-9147-3246345838b5';
// Near now, not a fixed hour: the reader retires its optimistic echo only
// against a turn from the last minute, so stale fixture timestamps would keep
// the echo on screen for reasons the operator never hits.
const T0 = Date.now() - 20_000;
const at = (n) => new Date(T0 + n * 1000).toISOString();
const rec = {
  user: (text, n) => ({ type: 'user', sessionId: S, uuid: `u${n}`, timestamp: at(n),
    message: { role: 'user', content: [{ type: 'text', text }] } }),
  asst: (text, n) => ({ type: 'assistant', sessionId: S, uuid: `a${n}`, timestamp: at(n),
    message: { id: `msg_${n}`, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] } }),
  enqueue: (content, n) => ({ type: 'queue-operation', operation: 'enqueue', sessionId: S, timestamp: at(n), content }),
  dequeue: (n) => ({ type: 'queue-operation', operation: 'dequeue', sessionId: S, timestamp: at(n) }),
  // `reason` and the delivery ids appear on newer CLIs only; both shapes are in
  // one real transcript, so both are exercised.
  remove: (content, n, reason) => ({ type: 'queue-operation', operation: 'remove', sessionId: S,
    timestamp: at(n), content, ...(reason ? { reason, deliveryId: '18445368-4b59-4203-a9fd-6f317ef78cd4',
      commandUuid: 'a26f88b4-d507-4d0c-82a6-f2bc4bbc96ed' } : {}) }),
  // How the absorbed message is handed to the model: a system-reminder inside
  // the running turn, which is why it never becomes a `user` record.
  absorbed: (prompt, n) => ({ type: 'attachment', sessionId: S, uuid: `at${n}`, timestamp: at(n),
    attachment: { type: 'queued_command', prompt, delivery_id: '18445368-4b59-4203-a9fd-6f317ef78cd4',
      source_uuid: 'a26f88b4-d507-4d0c-82a6-f2bc4bbc96ed', commandMode: 'prompt',
      origin: { kind: 'human' }, humanTurn: true },
    renderedRole: 'system',
    rendered: [{ content: `<system-reminder>\nThe user sent a new message while you were working:\n${prompt}\n</system-reminder>` }] }),
};

/** The real normalizer, in the reader's own mode. */
const normalize = async (records) => {
  const file = path.join(tmp, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // A v2 WINDOW request is what puts the normalizer in the reader's mode —
  // `reader` is derived from `window.version`, so passing it directly (as this
  // did) quietly exercised the older path the reader does not use.
  try { return (await readTraceByPath(file, { window: { version: 2, at: 'tail', bytes: 8 * 1024 * 1024 } })).turns; }
  finally { fs.rmSync(file, { force: true }); }
};
/** The same, with the span and turn floor the reader actually asks for. */
const normalizeTail = async (records, bytes, min) => {
  const file = path.join(tmp, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  try { return (await readTraceByPath(file, { window: { version: 2, at: 'tail', bytes, min } })).turns; }
  finally { fs.rmSync(file, { force: true }); }
};

await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import ConversationView from './src/components/conversation/ConversationView';
    window.WebSocket = class { static OPEN=1; readyState=1; send(){} close(){} };
    window.sent = []; window.__case = 0;
    let turns = [], cfg = {}, root;
    const page = () => ({harness:'claude',harnessLabel:'Fixture',sessionId:cfg.id,title:'',model:null,cwd:null,
      firstTs:0,lastTs:0,usage:null,source:null,sharedBy:null,note:null,truncated:false,
      total:turns.length,userTurns:null,activity:'waiting',generation:'g1',revision:'r'+turns.length,
      turns:[...turns],
      window:{mode:'bytes',start:0,end:1000,atStart:true,atEnd:true,generation:'g1',revision:'r'+turns.length}});
    window.fixtureApi = {
      window(){ return Promise.resolve(page()); },
      summary(){ return Promise.resolve({...page(), userTurns:[]}); },
      roster(){ return []; },
    };
    function App(){ return <div style={{position:'absolute',inset:0,display:'flex'}}>
      <div className="pane-reader">
        <ConversationView session={{id:cfg.id,cli:'claude',name:'Fixture',state:'working',running:true,
          everStarted:true,path:null,createdAt:new Date().toISOString()}} isMobile={false} />
      </div></div>; }
    window.fixture = {
      // A distinct session id per case: reader stores are cached by session.
      mount(initial){
        cfg = {id:'s'+(++window.__case)}; turns = initial;
        const host = document.getElementById('fixture-root');
        if (root) { root.unmount(); host.innerHTML = ''; }
        root = createRoot(host); root.render(<App/>);
      },
      serve(next){ turns = next; },
      // What the operator gets after refreshing: the same transcript, a reader
      // with no optimistic echo in it. A new id because stores cache by session.
      reload(){ cfg = {id:'s'+(++window.__case)};
        const host = document.getElementById('fixture-root');
        root.unmount(); host.innerHTML = '';
        root = createRoot(host); root.render(<App/>); },
    };
  `, sourcefile: 'fixture.tsx' },
  bundle: true, format: 'iife', outfile: bundle, jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  plugins: [{ name: 'fixture-api', setup(builder) {
    builder.onResolve({ filter: /^\.\.?(?:\/\.\.)*\/api$/ }, () => ({ path: 'fixture-api', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ resolveDir: web, loader: 'ts', contents: `
      export * from ${JSON.stringify(path.join(web, 'src/api.ts'))};
      export const getTraceWindow=(id,...args)=>window.fixtureApi.window(id,...args);
      export const getTraceSummary=()=>window.fixtureApi.summary();
      export const getSubAgentWindow=(id,agentId,...args)=>window.fixtureApi.window(agentId,...args);
      export const getSubAgentSummary=()=>window.fixtureApi.summary();
      export const getSubAgents=()=>Promise.resolve({agents:window.fixtureApi.roster()});
      export const getDispatches=()=>Promise.resolve({dispatches:[]});
      export const sendInput=(id,text)=>{ window.sent.push(text); return Promise.resolve({}); };
    ` }));
  } }],
});

// The operator's own message, exactly as the manager's transcript carries it:
// the attachment list is what puts a markdown block before the closing tag.
const TYPED = 'i sometimes see duplicate messages like this with the pasted tag on the first. do you know why this is happening?';
const SENT = `${TYPED}\n\nAttached files:\n- "/data/state/attachments/manager-1049f7/att_3ed86e.png"`;
const pasted = (t, id = 'df85') => `<pasted_content id="${id}">\n${t}\n</pasted_content id="${id}">`;

let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok   ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const p = await context.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.route('**/*', (route) => route.request().url() === 'http://fixture.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="fixture-root" style="display:flex;position:absolute;inset:10px"></div>' })
    : route.abort());
  await p.goto('http://fixture.test/');
  await p.addStyleTag({ content: fs.readFileSync(path.join(web, 'src/styles.css'), 'utf8')
    + fs.readFileSync(path.join(web, 'src/conversation.css'), 'utf8') });
  await p.addScriptTag({ path: bundle });

  /** Prompt bands carrying the operator's message. */
  const copies = () => p.evaluate((n) => [...document.querySelectorAll('.cx-prompt')]
    .filter((el) => el.textContent.includes(n)).length, TYPED);
  const bodyText = () => p.evaluate(() => document.querySelector('.cxv-body')?.textContent || '');

  /** The operator types into a working agent, and the transcript then carries
   *  whatever `records` say happened to that prompt. */
  const typeWhileWorking = async (records, typed = SENT) => {
    const opening = [rec.user('first prompt', 0), rec.asst('working on it', 1)];
    await p.evaluate((t) => window.fixture.mount(t), await normalize(opening));
    await p.waitForSelector('.cxv-body');
    await p.waitForTimeout(400);
    await p.evaluate((t) => window.fixture.serve(t), await normalize([...opening, ...records]));
    await p.locator('.ov-live textarea').fill(typed);
    await p.locator('button[aria-label="Send"]').click();
    await p.waitForTimeout(1500);
  };

  const CASES = [
    // The operator's actual case, and the common one: a multi-line message with
    // an attachment list, sent to an idle agent. Claude Code wraps any
    // multi-line paste, so there is a wrapper but no queue record anywhere.
    ['sent normally, arriving as a plain user record', [
      rec.user(pasted(SENT), 2), rec.asst('on it', 3)]],
    // The other way a prefix gets in front of the prompt: AM submits onto a
    // line the operator half-typed in the terminal and never sent, so the
    // harness records the concatenation. No wrapper — this one is single-line.
    // The merged text is a separate bug (the agent receives it too); what is
    // pinned here is that the reader still shows the message once.
    ['sent onto a line already half-typed in the terminal', [
      rec.user(`how are we going on the ${SENT}`, 2), rec.asst('on it', 3)]],
    ['absorbed into the running turn, pasted', [
      rec.enqueue(pasted(SENT), 2), rec.remove(pasted(SENT), 3, 'absorbed_mid_turn'),
      rec.absorbed(pasted(SENT), 4), rec.asst('answering it', 5)]],
    ['removed with no reason, the older shape', [
      rec.enqueue(pasted(SENT), 2), rec.remove(pasted(SENT), 3, null), rec.asst('later', 5)]],
    ['dequeued, so it arrives as a real user message', [
      rec.enqueue(pasted(SENT), 2), rec.dequeue(3), rec.user(pasted(SENT), 4), rec.asst('later', 5)]],
    ['absorbed, typed rather than pasted (no wrapper at all)', [
      rec.enqueue(SENT, 2), rec.remove(SENT, 3, 'absorbed_mid_turn'),
      rec.absorbed(SENT, 4), rec.asst('answering it', 5)]],
  ];

  for (const [name, records] of CASES) {
    console.log(`\n### ${name}`);
    await typeWhileWorking(records);
    const n = await copies();
    const text = await bodyText();
    console.log(`  prompt bands carrying the message: ${n}`);
    check('the operator sees their message exactly once', () => {
      assert.equal(n, 1, `it is on screen ${n} times`);
    });
    // The duplicate must not be traded for a lost prompt: hiding the queued
    // copy would make an absorbed message vanish, since nothing else carries it.
    check('and the message is actually there', () => {
      assert.ok(text.includes(TYPED), 'the operator\'s message is not in the reader at all');
    });
    check('with no wrapper left in the page', () => {
      assert.ok(!text.includes('pasted_content'), `wrapper visible: ${text.slice(text.indexOf('pasted_content') - 60, text.indexOf('pasted_content') + 30)}`);
    });

    // And it has to survive a refresh: the echo is client-only, so a reload is
    // what proves the transcript itself carries exactly one copy of the prompt.
    await p.evaluate(() => window.fixture.reload());
    await p.waitForSelector('.cxv-body');
    await p.waitForTimeout(900);
    const reloaded = await copies();
    const reloadedText = await bodyText();
    console.log(`  after a reload: ${reloaded}`);
    check('still one copy after a reload', () => {
      assert.equal(reloaded, 1, `it is on screen ${reloaded} times`);
      assert.ok(!reloadedText.includes('pasted_content'), 'the wrapper is back after a reload');
    });
  }

  // The same words sent twice, once dequeued into a request and once absorbed.
  // A dequeue says the ordinary message carries that prompt, so a later record
  // of the same text must not be read as the same send — the second removal
  // was being spent against the first dequeue and dropped, leaving its enqueue
  // stranded at the end still marked queued.
  console.log('\n### the same message sent twice, dequeued then absorbed');
  {
    const SAME = 'run the deploy again please';
    const turns = await normalize([
      rec.user('first prompt', 0),
      rec.enqueue(SAME, 1), rec.dequeue(2), rec.user(SAME, 3),   // delivered as an ordinary message
      rec.asst('working on it', 4),
      rec.enqueue(SAME, 5), rec.remove(SAME, 6, 'absorbed_mid_turn'),   // sent again, mid-turn
      rec.asst('done twice', 7),
    ]);
    await p.evaluate((t) => window.fixture.mount(t), turns);
    await p.waitForSelector('.cxv-body');
    await p.waitForTimeout(900);
    const bands = await p.evaluate((n) => [...document.querySelectorAll('.cx-prompt')]
      .filter((el) => el.textContent.includes(n)).map((el) => !!el.querySelector('.cx-queued')), SAME);
    console.log(`  bands=${bands.length} badged=${JSON.stringify(bands)}`);
    check('both sends are on screen', () => {
      assert.equal(bands.length, 2, 'one of the two sends is missing or doubled');
    });
    check('and neither is left marked as waiting', () => {
      assert.deepEqual(bands, [false, false], 'a delivered prompt is still badged queued');
    });
    const seen = await p.evaluate(() => document.querySelector('.cxv-body')?.innerText || '');
    check('the reply to the second one is after it', () => {
      assert.ok(seen.lastIndexOf(SAME) < seen.indexOf('done twice'), 'the last send has no reply after it');
    });
  }

  // A window that does not reach back as far as the enqueue. The reader asks
  // for a span of bytes with a minimum number of turns, so one large record
  // between the enqueue and its removal is enough to push the enqueue out —
  // and then the prompt was simply absent while its reply stayed behind in the
  // previous exchange, which is why the live view and a reload disagreed.
  console.log('\n### a window that begins after the enqueue');
  {
    const MID = 'the message whose enqueue fell off the window';
    const REPLY = 'the reply to the message';
    const bulky = 'x'.repeat(150 * 1024);
    const records = [rec.user('first prompt', 0), rec.enqueue(MID, 1), rec.asst(bulky, 2),
      rec.remove(MID, 3, 'absorbed_mid_turn'), rec.absorbed(MID, 4)];
    for (let i = 0; i < 11; i++) records.push(rec.asst(`step ${i}`, 5 + i));
    records.push(rec.asst(REPLY, 20));
    const turns = await normalizeTail(records, 128 * 1024, 12);
    const ops = turns.filter((t) => t.event?.type === 'queue').map((t) => t.event.operation);
    console.log(`  window turns=${turns.length} queue events=${JSON.stringify(ops)}`);
    assert.ok(!ops.includes('enqueue'), 'the window still reaches the enqueue — widen the bulky record');
    await p.evaluate((t) => window.fixture.mount(t), turns);
    await p.waitForSelector('.cxv-body');
    await p.waitForTimeout(900);
    const seen = await p.evaluate(() => document.querySelector('.cxv-body')?.innerText || '');
    const bands = await p.evaluate((n) => [...document.querySelectorAll('.cx-prompt')]
      .filter((el) => el.textContent.includes(n)).length, MID);
    check('the prompt is there even though its enqueue is not', () => {
      assert.equal(bands, 1, `the message is on screen ${bands} times`);
    });
    check('and its reply comes after it', () => {
      const a = seen.indexOf(MID), b = seen.indexOf(REPLY);
      assert.ok(a >= 0 && b > a, `order was ${JSON.stringify([a, b])}`);
    });
  }

  // A message delivered INTO the running turn, with the timestamps the harness
  // actually writes: the answer to the previous prompt is stamped before the
  // mid-turn message was typed, and the delivery record is stamped before its
  // own enqueue. Nothing may be reordered or re-parented because of that.
  console.log('\n### a message absorbed into the running turn');
  {
    const FIRST = 'answer to the first prompt';
    const MID = 'can we set up just one dev space instead of three?';
    const REPLY = 'answer to the mid-turn message';
    await p.evaluate((t) => window.fixture.mount(t), await normalize([
      rec.user('first prompt', 0),
      // File order, exactly as the harness writes it: the enqueue is appended
      // mid-turn, and the answer to the PREVIOUS prompt is written after it
      // while being stamped five seconds EARLIER. Put the answer first and
      // there is nothing to split, which is how this case can look fixed when
      // it is not.
      rec.enqueue(MID, 10),
      rec.asst(FIRST, 5),
      rec.remove(MID, 13, 'absorbed_mid_turn'),
      rec.absorbed(MID, 9),              // stamped before its own enqueue
      rec.asst(REPLY, 46),
    ]));
    await p.waitForSelector('.cxv-body');
    await p.waitForTimeout(900);
    const seen = await p.evaluate(() => document.querySelector('.cxv-body')?.innerText || '');
    const bands = await p.evaluate((n) => [...document.querySelectorAll('.cx-prompt')]
      .filter((el) => el.textContent.includes(n)).length, MID);
    const badged = await p.evaluate((n) => [...document.querySelectorAll('.cx-prompt')]
      .some((el) => el.textContent.includes(n) && el.querySelector('.cx-queued')), MID);
    const order = [FIRST, MID, REPLY].map((t) => seen.indexOf(t));
    console.log(`  bands=${bands} badged=${badged} order=${JSON.stringify(order)}`);
    check('the message is on screen once', () => assert.equal(bands, 1));
    check('it is not labelled as still waiting in the queue', () => {
      assert.equal(badged, false, 'a message the agent answered is badged "queued"');
    });
    check('output that predates it is not shown after it', () => {
      assert.ok(order.every((i) => i >= 0), `something is missing from the reader: ${JSON.stringify(order)}`);
      assert.ok(order[0] < order[1], 'the previous answer was moved below the mid-turn message');
      assert.ok(order[1] < order[2], 'the reply to the mid-turn message is not after it');
    });
    // The previous prompt keeps its own answer rather than donating it.
    const firstExchange = await p.evaluate((t) => {
      const section = document.querySelector('.cx');
      return !!section && section.innerText.includes(t);
    }, FIRST);
    check('the previous prompt keeps its answer', () => {
      assert.equal(firstExchange, true, 'the earlier answer was re-parented into the mid-turn exchange');
    });
  }

  // The echo has to be retired by the exchange that CARRIES the message, not by
  // any recent one. A short follow-up is easily a substring of the prompt
  // before it, and the one-minute window reaches back over that prompt — so an
  // unanchored containment test retires the echo on sight and the operator's
  // message is missing until the transcript catches up.
  console.log('\n### a short follow-up that the previous prompt contains');
  {
    const PREV = 'should we ship the login guide today?';
    const FOLLOWUP = 'the login guide';
    const opening = [rec.user(PREV, 0), rec.asst('not yet', 1)];
    await p.evaluate((t) => window.fixture.mount(t), await normalize(opening));
    await p.waitForSelector('.cxv-body');
    await p.waitForTimeout(400);
    // Deliberately no new records: this is the window between sending and the
    // transcript catching up, which is the whole point of the echo.
    await p.locator('.ov-live textarea').fill(FOLLOWUP);
    await p.locator('button[aria-label="Send"]').click();
    await p.waitForTimeout(1400);
    const bands = await p.evaluate((n) => [...document.querySelectorAll('.cx-prompt')]
      .map((el) => el.textContent.replace(/\s+/g, ' ').trim()), FOLLOWUP);
    const echoed = bands.filter((t) => t === FOLLOWUP).length;
    console.log(`  prompt bands: ${JSON.stringify(bands)}`);
    check('the message stays on screen until the transcript catches up', () => {
      assert.equal(echoed, 1, 'the echo was retired by the PREVIOUS exchange, so the message vanished');
    });
  }

  check('no page errors', () => assert.deepEqual(errors, [], errors.slice(0, 2).join(' | ')));
  await context.close();
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failed) { console.log(`\npasted-prompt: ${failed} failed`); process.exit(1); }
console.log('\npasted-prompt: one copy of every pasted prompt, wrapper unwrapped');
