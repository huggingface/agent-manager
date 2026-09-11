import { nativeFetch as fetch } from './native-client.mjs';
// Unread, end to end: which reply the transcript produced, what an
// acknowledgement is allowed to cover, and what survives a restart.
//
// The output identity half runs against the real transcript parsers with
// fixture files, because the interesting failures are all about what the parser
// calls "a new reply" — a mirrored record, a streaming answer that grew, two
// answers with the same words. A hand-made digest object would test none of it.
//
// Run with:  node test/unread.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 7889;
const API = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'unread-srv-'));
const CLAUDE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'unread-claude-'));

let pass = 0; let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

// ---------- output identity, straight through the real parser ----------
const { parseClaudeForTest } = await import('../src/traces.js').then((m) => ({
  parseClaudeForTest: m.__parseClaudeForTest,
}));

const line = (o) => `${JSON.stringify(o)}\n`;
const assistant = (text, ts, id) => line({
  type: 'assistant', timestamp: ts, uuid: id,
  message: { id, content: [{ type: 'text', text }] },
});
const userMsg = (text, ts) => line({ type: 'user', timestamp: ts, message: { content: text } });
const toolUse = (ts, id) => line({
  type: 'assistant', timestamp: ts, uuid: `t${id}`,
  message: { id: `t${id}`, content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/x' } }] },
});

const digestOf = (txt) => parseClaudeForTest(txt).digest;
const idOf = (txt) => { const d = digestOf(txt); return `${d.outSeq}:${d.outHash}`; };

console.log('\nwhich reply is this?');
{
  const one = assistant('First answer.', '2026-01-01T00:00:00Z', 'm1');
  check('one reply is seq 1', digestOf(one).outSeq === 1, `seq ${digestOf(one).outSeq}`);

  const two = one + assistant('Second answer.', '2026-01-01T00:01:00Z', 'm2');
  check('a second reply advances the sequence', digestOf(two).outSeq === 2, `seq ${digestOf(two).outSeq}`);
  check('and is a different identity', idOf(one) !== idOf(two));

  // A real Claude mirror repeats the SAME message id — a re-emitted record, or
  // a second block of one message. That must not invent a reply.
  const mirrored = one + assistant('First answer.', '2026-01-01T00:00:05Z', 'm1');
  check('the same message id again is NOT a new reply', digestOf(mirrored).outSeq === 1, `seq ${digestOf(mirrored).outSeq}`);
  check('and not a new identity either', idOf(mirrored) === idOf(one));

  // A DIFFERENT message that happens to say the same words is a different
  // reply, and the operator who read the first has not read the second. Claude
  // gives us the message id, so this is a fact rather than a guess.
  const twice = assistant('Done.', '2026-01-01T00:00:00Z', 'msg-1')
    + toolUse('2026-01-01T00:00:10Z', 'tu9')
    + assistant('Done.', '2026-01-01T00:00:20Z', 'msg-3');
  check('two distinct messages with identical text are two replies',
    digestOf(twice).outSeq === 2, `seq ${digestOf(twice).outSeq}`);
  check('so reading the first leaves the second unread',
    idOf(twice) !== idOf(assistant('Done.', '2026-01-01T00:00:00Z', 'msg-1')));

  // A second text block of ONE message is more of the same reply: same
  // sequence, new content to be seen.
  const twoBlocks = `${JSON.stringify({
    type: 'assistant', timestamp: '2026-01-01T00:00:00Z', uuid: 'mb',
    message: { id: 'mb', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] },
  })}\n`;
  const mb = digestOf(twoBlocks);
  check('two blocks of one message are one reply', mb.outSeq === 1, `seq ${mb.outSeq}`);
  check('but the later block changes the version to be seen',
    mb.outHash !== digestOf(`${JSON.stringify({
      type: 'assistant', timestamp: '2026-01-01T00:00:00Z', uuid: 'mb',
      message: { id: 'mb', content: [{ type: 'text', text: 'part one' }] },
    })}\n`).outHash);

  // Two genuinely separate replies that happen to say the same thing.
  const sameText = one + userMsg('again please', '2026-01-01T00:00:30Z') + assistant('First answer.', '2026-01-01T00:01:00Z', 'm3');
  check('the same words after a prompt IS a new reply', digestOf(sameText).outSeq === 2, `seq ${digestOf(sameText).outSeq}`);

  // A streaming answer growing past the 280-char card clip: the visible summary
  // is unchanged, the reply is not.
  const long = 'x'.repeat(400);
  const partial = assistant(long, '2026-01-01T00:00:00Z', 'm1');
  const grown = assistant(`${long} and one more sentence.`, '2026-01-01T00:00:01Z', 'm1');
  const a = digestOf(partial); const b = digestOf(grown);
  check('a grown streaming answer is a new identity', `${a.outSeq}:${a.outHash}` !== `${b.outSeq}:${b.outHash}`);
  check('even though the clipped card text is identical', a.lastAssistantText === b.lastAssistantText);
  check('and the card says its copy is incomplete', b.outClipped === false && a.outClipped === false,
    'clipRaw caps at 6000, so 400 chars is whole');

  const huge = 'y'.repeat(7000);
  check('a reply longer than the card can hold is flagged clipped', digestOf(assistant(huge, '2026-01-01T00:00:00Z', 'mh')).outClipped === true);

  // Same timestamp, different replies.
  const tie = assistant('A', '2026-01-01T00:00:00Z', 'm1') + assistant('B', '2026-01-01T00:00:00Z', 'm2');
  check('two replies at the same timestamp are still two', digestOf(tie).outSeq === 2, `seq ${digestOf(tie).outSeq}`);
}

console.log('\nnoise that must not look like something to read');
{
  const base = assistant('The answer.', '2026-01-01T00:00:00Z', 'm1');
  const before = idOf(base);
  check('tool calls do not create a reply', idOf(base + toolUse('2026-01-01T00:00:10Z', 'tu1')) === before);
  check('a user prompt does not create a reply', idOf(base + userMsg('next', '2026-01-01T00:00:20Z')) === before);
  // The one that used to be a real bug: the digest clears its assistant fields
  // on a new prompt, which would have erased the unread cursor with them.
  const afterPrompt = digestOf(base + userMsg('next', '2026-01-01T00:00:20Z'));
  check('a prompt clears the card text but NOT the unread cursor',
    afterPrompt.lastAssistantText === '' && afterPrompt.outSeq === 1,
    `text=${JSON.stringify(afterPrompt.lastAssistantText)} seq=${afterPrompt.outSeq}`);
}

// ---------- the durable half ----------
const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...BASE_ENV } = process.env;
const boot = () => spawn('node', ['src/index.js'], {
  env: {
    ...BASE_ENV, PORT: String(PORT), DATA_DIR, AM_BASHRC: '/nonexistent',
    AM_ALLOW_MISSING_ORIGIN: '1', CLAUDE_CONFIG_DIR: CLAUDE_DIR,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srv = boot();
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, init = {}) => {
  const sep = route.includes('?') ? '&' : '?';
  const r = await fetch(`${API}${route}${sep}from=operator`, { headers: { 'content-type': 'application/json' }, ...init });
  let body = null; try { body = await r.json(); } catch { /* empty */ }
  return { status: r.status, body };
};
const waitUp = async () => {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false)) return;
    await sleep(250);
  }
};
const mkRemote = async (name) =>
  (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ cli: 'remote', name, path: name }) })).body;
const say = (name, text) => fetch(`${API}/api/remote/${name}/messages?from=agent`, {
  method: 'POST', headers: { 'content-type': 'text/plain' }, body: text,
});
const metaFor = async (id) => (await api('/api/meta')).body.sessions.find((s) => s.id === id);
// The same rule the Overview applies, kept deliberately in one line so it
// cannot drift into a friendlier version of itself: read means the mark names
// EXACTLY the newest output. web/src/lib/unread.ts is the implementation the
// app uses and web/test/unread.test.mjs pins its cases; this mirrors it so the
// server suite is asserting what the operator would actually see.
const unread = (s) => {
  const o = s?.output; const r = s?.read;
  if (!o || !o.seq) return false;
  return !r || r.src !== o.src || r.seq !== o.seq || r.hash !== o.hash;
};

try {
  await waitUp();

  const ack = (marks) => api('/api/read', { method: 'POST', body: JSON.stringify({ marks }) });

  console.log('\nthe rollout baseline: today is read, tomorrow is not');
  const a = await mkRemote('alpha');
  await say('alpha', 'An answer from before the feature existed.');
  const first = await metaFor(a.id);
  check('an existing reply starts read', !unread(first), JSON.stringify(first.read));
  await say('alpha', 'A reply that arrived afterwards.');
  check('the next reply is unread', unread(await metaFor(a.id)));

  const b = await mkRemote('beta');
  const bMeta = await metaFor(b.id);
  check('a session with nothing to read is not "read" — it has no mark at all', !bMeta.output && !bMeta.read);
  await say('beta', 'Its very first answer.');
  check('so its FIRST reply is unread, not presumed seen', unread(await metaFor(b.id)));

  console.log('\nan oversized batch is refused, not silently trimmed');
  {
    const big = Array.from({ length: 201 }, (_, i) => ({ id: `x${i}`, src: 's', seq: 1, hash: 'h' }));
    const r = await ack(big);
    check('over the cap is a 413, not a partial 200', r.status === 413, `status ${r.status}`);
    check('and nothing is reported as done', !r.body?.results);
  }

  console.log('\nacknowledging');
  const cur = await metaFor(a.id);
  const okMark = { id: a.id, ...cur.output };
  check('acknowledging what is on screen is recorded', (await ack([okMark])).body.results[a.id] === 'ok');
  check('and the session is read', !unread(await metaFor(a.id)));
  check('replaying the same acknowledgement is harmless', (await ack([okMark])).body.results[a.id] === 'ok');

  await say('alpha', 'Something new, after the acknowledgement.');
  check('new output is unread again', unread(await metaFor(a.id)));
  check('and the OLD acknowledgement replayed does not cover it',
    (await ack([okMark])).body.results[a.id] === 'ok' && unread(await metaFor(a.id)));

  // Out-of-order delivery: the reader acknowledged reply 2, then a duplicate of
  // the reply-1 acknowledgement arrives late. It is honest progress, so it is
  // accepted — but it must not drag the recorded position back to 1, or the
  // operator would be shown reply 2 as unread again after reading it.
  {
    const cur2 = (await metaFor(a.id)).output;
    await ack([{ id: a.id, ...cur2 }]);
    const high = (await metaFor(a.id)).read.seq;
    await ack([okMark]); // the older one, arriving late
    const after = (await metaFor(a.id)).read;
    check('a late acknowledgement for an older reply cannot move progress back',
      after.seq === high, `${high} -> ${after.seq}`);
    check('and the session it had caught up on stays read', !unread(await metaFor(a.id)));
    // Put it back where the rest of the suite expects it.
    await say('alpha', 'And one more, so the refusal cases have something to refuse.');
  }

  const latest = (await metaFor(a.id)).output;
  check('a mark claiming to have read further than exists is refused',
    (await ack([{ id: a.id, ...latest, seq: latest.seq + 50 }])).body.results[a.id] === 'future');
  check('a mark from another transcript generation is refused',
    (await ack([{ id: a.id, ...latest, src: 'someothergeneration' }])).body.results[a.id] === 'stale');
  check('the right position with the wrong content is refused',
    (await ack([{ id: a.id, ...latest, hash: 'notwhatwasshown' }])).body.results[a.id] === 'mismatch');
  check('after all those refusals it is still unread', unread(await metaFor(a.id)));
  check('an unknown session is refused, not invented', (await ack([{ id: 'ghost', src: 'x', seq: 1, hash: 'h' }])).body.results.ghost === 'unknown');

  console.log('\nbulk acknowledgement (Mark all read)');
  const both = [a.id, b.id];
  const marks = [];
  for (const id of both) { const m = await metaFor(id); if (m.output) marks.push({ id, ...m.output }); }
  const bulk = await ack(marks);
  check('one request covers the whole section', both.every((id) => bulk.body.results[id] === 'ok'));
  check('and both are read', !unread(await metaFor(a.id)) && !unread(await metaFor(b.id)));
  // A reply arriving during the request is not in the captured batch.
  await say('alpha', 'Arrived while the batch was in flight.');
  check('a reply that arrived mid-batch is NOT covered by it',
    (await ack(marks)).body.results[a.id] === 'ok' && unread(await metaFor(a.id)));

  console.log('\na write that fails is not published as read');
  {
    // The reviewer's reproduction: make the marker file unwritable by putting a
    // directory where its temp file goes. The acknowledgement must fail AND the
    // reply must still read as unread — publishing it from memory while the
    // bytes never landed is the failure this whole feature exists to avoid.
    const c = await mkRemote('gamma');
    await say('gamma', 'first');
    await metaFor(c.id);                 // baseline covers it
    await say('gamma', 'second, unread');
    const before = await metaFor(c.id);
    check('unread to begin with', unread(before));
    const blocker = path.join(DATA_DIR, 'read-marks.json.tmp');
    fs.mkdirSync(blocker, { recursive: true });
    let failed = false;
    try {
      const r = await ack([{ id: c.id, ...before.output }]);
      failed = r.status >= 400 || r.body?.results?.[c.id] !== 'ok';
    } catch { failed = true; }
    check('the acknowledgement does not report success', failed);
    check('and the reply is STILL unread', unread(await metaFor(c.id)),
      'a failed write must not be published from memory');
    fs.rmSync(blocker, { recursive: true, force: true });
    // The retry must actually write, not take an "already there" shortcut off
    // the in-memory copy the failed attempt left behind.
    const again = await metaFor(c.id);
    check('the retry is accepted', (await ack([{ id: c.id, ...again.output }])).body.results[c.id] === 'ok');
    check('and it is now read', !unread(await metaFor(c.id)));
    const onDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'read-marks.json'), 'utf8'));
    check('the mark reached the file, not just memory', !!onDisk.marks[c.id],
      JSON.stringify(onDisk.marks[c.id] || null));
  }

  console.log('\na replaced transcript does not inherit the old cursor');
  {
    // A rotated transcript restarts its sequence. The pane record cannot always
    // tell one run from the next — OpenClaw merges several session files into
    // one pane — so a mark numerically AHEAD of the current output must not be
    // read as "already seen".
    const d = await mkRemote('delta');
    await say('delta', 'one'); await say('delta', 'two'); await say('delta', 'three');
    const cur = await metaFor(d.id);
    await ack([{ id: d.id, ...cur.output }]);
    check('read after acknowledging', !unread(await metaFor(d.id)));
    // Simulate the replacement: the same generation key, a LOWER sequence.
    const lower = { ...cur.output, seq: 1, hash: 'freshstart' };
    check('a lower sequence under the same generation reads as unread',
      unread({ output: lower, read: (await metaFor(d.id)).read }),
      'a cursor from a transcript that is gone must not cover new output');
  }

  console.log('\nit survives a restart');
  const beforeRestart = (await metaFor(b.id)).read;
  srv.kill(); await sleep(700);
  srv = boot();
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  await waitUp();
  const afterRestart = (await metaFor(b.id)).read;
  check('the mark is still there', !!afterRestart && afterRestart.seq === beforeRestart.seq,
    `${JSON.stringify(beforeRestart)} -> ${JSON.stringify(afterRestart)}`);
  check('and the baseline is not taken a second time', unread(await metaFor(a.id)),
    'alpha had unread output before the restart and must still have it');

  console.log('\nrenaming keeps the read state');
  await api(`/api/sessions/${b.id}`, { method: 'PUT', body: JSON.stringify({ name: 'beta-renamed' }) });
  const renamed = await metaFor(b.id);
  check('a renamed session keeps its mark', !!renamed.read && !unread(renamed));
  // ---- a fresh install whose fleet has not spoken yet ----
  //
  // Its own store, because the point is the FIRST pass ever taken. Waiting for
  // some session to have output before baselining looked safer and was the
  // opposite: on an empty fleet the baseline sat untaken until the first reply
  // arrived, and then took that reply as history already read.
  console.log('\na fresh install does not baseline away its first reply');
  {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'unread-fresh-'));
    const port = PORT + 1;
    const child = spawn('node', ['src/index.js'], {
      env: { ...BASE_ENV, PORT: String(port), DATA_DIR: fresh, AM_BASHRC: '/nonexistent', AM_ALLOW_MISSING_ORIGIN: '1', CLAUDE_CONFIG_DIR: CLAUDE_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const base = `http://localhost:${port}`;
    const call = async (route, init = {}) => {
      const sep = route.includes('?') ? '&' : '?';
      const r = await fetch(`${base}${route}${sep}from=operator`, { headers: { 'content-type': 'application/json' }, ...init });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    try {
      for (let i = 0; i < 120; i++) {
        if (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)) break;
        await sleep(250);
      }
      const only = (await call('/api/sessions', { method: 'POST', body: JSON.stringify({ cli: 'remote', name: 'solo', path: 'solo' }) })).body;
      const seen = (await call('/api/meta')).body.sessions.find((x) => x.id === only.id);
      check('the first poll finds nothing to read, and records nothing', !seen.output && !seen.read);
      await fetch(`${base}/api/remote/solo/messages?from=agent`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'THE VERY FIRST REPLY' });
      const after = (await call('/api/meta')).body.sessions.find((x) => x.id === only.id);
      check('so its very first reply is UNREAD, not baselined away', unread(after),
        JSON.stringify({ output: after.output, read: after.read }));
      check('and the baseline was taken on that first pass, once',
        JSON.parse(fs.readFileSync(path.join(fresh, 'read-marks.json'), 'utf8')).initialized === true);
    } finally {
      child.kill();
      try { fs.rmSync(fresh, { recursive: true, force: true }); } catch { /* tmp */ }
    }
  }
} catch (e) {
  check(`suite threw: ${e && e.message}`, false, log.slice(-700));
} finally {
  srv.kill();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* tmp */ }
  try { fs.rmSync(CLAUDE_DIR, { recursive: true, force: true }); } catch { /* tmp */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
