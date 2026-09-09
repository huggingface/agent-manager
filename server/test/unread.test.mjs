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

  // The mirror case: codex writes agent_message and task_complete with the same
  // words; Claude repeats a block. Same text must not invent a reply.
  const mirrored = one + assistant('First answer.', '2026-01-01T00:00:05Z', 'm1b');
  check('the same words again is NOT a new reply', digestOf(mirrored).outSeq === 1, `seq ${digestOf(mirrored).outSeq}`);
  check('and not a new identity either', idOf(mirrored) === idOf(one));

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
const unread = (s) => {
  const o = s?.output; const r = s?.read;
  if (!o || !o.seq) return false;
  if (!r) return true;
  return r.src !== o.src || r.seq < o.seq || (r.seq === o.seq && r.hash !== o.hash);
};

try {
  await waitUp();

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

  console.log('\nacknowledging');
  const cur = await metaFor(a.id);
  const ack = (marks) => api('/api/read', { method: 'POST', body: JSON.stringify({ marks }) });
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
} catch (e) {
  check(`suite threw: ${e && e.message}`, false, log.slice(-700));
} finally {
  srv.kill();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* tmp */ }
  try { fs.rmSync(CLAUDE_DIR, { recursive: true, force: true }); } catch { /* tmp */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
