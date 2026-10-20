// The sessions a session handed work to, through this manager's own API.
//
// Not the in-harness sub-agents (traces.js `subagentRoster` covers those): these
// are PEER sessions, started with `POST /api/agents` or prompted with
// `POST /api/agents/:id/prompt`. Both calls are already in the operations log
// with who made them (`origin`, which a mutating call cannot omit) and the
// prompt they carried, so "who sent what to whom, when" is a read of that log.
//
// What the log cannot say is what the peer DID with it. A long-lived peer is
// prompted many times, by several sessions and by the operator, so its own
// state ("waiting") answers nothing about this dispatch. The answer is the turn
// that this call's prompt started in the peer's transcript, and only that turn:
// found by the prompt text (the peer receives it verbatim behind a
// "[message from <name>:]" envelope), and ended by the peer's next prompt.
//
// Finding it must not mean reading a transcript from the top — they run to
// hundreds of megabytes here. Claude and Codex stamp every line with an ISO
// `timestamp`, so the byte offset where the dispatch's minute begins is a
// bisection away, and the reader's own forward windows parse from there. A
// match is remembered: an ended turn never changes, and a running one is
// re-read from where it started rather than searched for again.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as store from './sessions.js';
import { OPERATIONS_FILE } from './operations.js';
import { findTrace } from './share.js';
import { readTrace } from './traces.js';

const PROMPT_ROUTE = /^\/api\/agents\/([^/]+)\/prompt$/;
// Dispatch records are small and few (a busy month here: ~120), but the log
// holds every call. Only lines that can be one are parsed.
const MAYBE = /"method":"POST"/;
const MAX_INDEX_READ = 256 * 1024 * 1024;

/** Where the index has read to, and what it found. Reset if the log shrinks. */
const index = { offset: 0, carry: '', rows: [], ids: new Set(), file: OPERATIONS_FILE, pending: null };

export function _resetForTest(file = OPERATIONS_FILE) {
  index.offset = 0; index.carry = ''; index.rows = []; index.ids = new Set(); index.file = file; index.pending = null;
  matches.clear();
}
export const _indexSizeForTest = () => index.rows.length;

const textOf = (request) => {
  if (typeof request === 'string') return request;
  if (request && typeof request === 'object' && typeof request.text === 'string') return request.text;
  return '';
};

/** One operations-log row as a dispatch, or null when it is not one. */
export function dispatchOf(op) {
  if (!op || op.method !== 'POST' || !op.origin || !op.origin.id) return null;
  let kind; let targetId;
  if (op.path === '/api/agents') {
    kind = 'launch';
    targetId = op.result && typeof op.result === 'object' ? op.result.id : null;
  } else {
    const m = PROMPT_ROUTE.exec(op.path || '');
    if (!m) return null;
    kind = 'prompt';
    targetId = m[1];
  }
  const result = op.result && typeof op.result === 'object' ? op.result : {};
  return {
    id: op.id,
    at: Date.parse(op.at) || 0,
    originId: op.origin.id,
    // The name the manager put in the "[message from <name>:]" envelope it
    // delivered this prompt in — the sender's session name at the time.
    originName: op.origin.name || null,
    kind,
    status: op.status,
    ok: !!op.ok,
    target: {
      id: targetId || null,
      name: (op.target && op.target.name) || result.name || (op.query && op.query.name) || targetId || null,
      cli: (op.target && op.target.cli) || result.cli || (op.query && op.query.cli) || null,
    },
    prompt: textOf(op.request),
  };
}

/**
 * Bring the index up to the end of the log. ONE read at a time: several open
 * readers poll this route at once, and two refreshes that both started from
 * the same offset each appended the same rows — duplicated for good, since
 * nothing ever re-reads them. Concurrent callers share the read in flight, and
 * rows are kept unique by operation id as well, so neither guard alone is load-
 * bearing.
 */
function refreshIndex() {
  if (!index.pending) index.pending = readNew().finally(() => { index.pending = null; });
  return index.pending;
}

async function readNew() {
  let st;
  try { st = await fsp.stat(index.file); } catch { return; }
  if (st.size < index.offset) { index.offset = 0; index.carry = ''; index.rows = []; index.ids = new Set(); }
  if (st.size === index.offset) return;
  const from = index.offset === 0 ? Math.max(0, st.size - MAX_INDEX_READ) : index.offset;
  const fh = await fsp.open(index.file, 'r');
  try {
    const buf = Buffer.alloc(st.size - from);
    await fh.read(buf, 0, buf.length, from);
    let text = index.carry + buf.toString('utf8');
    // a cold read that starts mid-file begins mid-line
    if (index.offset === 0 && from > 0) text = text.slice(text.indexOf('\n') + 1);
    const lines = text.split('\n');
    index.carry = lines.pop() || '';
    for (const line of lines) {
      if (!line || !MAYBE.test(line)) continue;
      let op;
      try { op = JSON.parse(line); } catch { continue; }
      const d = dispatchOf(op);
      if (d && !index.ids.has(d.id)) { index.ids.add(d.id); index.rows.push(d); }
    }
    index.offset = st.size;
  } finally {
    await fh.close();
  }
}

// ---------- the peer's turn ----------

// The envelope the manager delivers a peer's prompt in, and the shared-Codex
// form, which stamps the sending session's id after it (codex-input.js):
//   [message from alpha:] text
//   [message from alpha:] [AM source {"amSessionId":"alpha-1",…}]\ntext
const SENDER = /^\s*\[message from ([^\]]*?):\]\s*(?:\[AM source (\{[^\n]*?\})\]\s*)?/;
// As the manager writes a name into the envelope (codex-input.js sanitises it
// this way; index.js writes it as is, and the two agree for ordinary names).
const cleanName = (s) => String(s || '').replace(/[\x00-\x1f\x7f\[\]]/g, ' ').trim();

/**
 * Who a prompt in a peer's transcript came from, as its envelope says — or
 * null when it has none (the operator typed it, or a cron sent it).
 */
export function senderOf(text) {
  const m = SENDER.exec(String(text || ''));
  if (!m) return null;
  let sessionId = null;
  if (m[2]) { try { sessionId = JSON.parse(m[2]).amSessionId || null; } catch { sessionId = null; } }
  return { name: m[1].trim(), sessionId };
}

/**
 * Whether a prompt in the peer's transcript is THIS dispatch's, by who sent it.
 * The text alone cannot say: two sessions can send a long-lived peer the same
 * words a second apart, and stripping the envelope before comparing gave one
 * the other's turn — another session's work shown under this one.
 */
const fromOrigin = (text, d) => {
  const who = senderOf(text);
  if (!who) return false;
  if (who.sessionId) return who.sessionId === d.originId;
  return !d.originName || cleanName(who.name) === cleanName(d.originName);
};

/** The prompt as compared: no envelope, whitespace collapsed, a prefix. */
// Repeated: an orchestrator that writes its own envelope gets the manager's too.
const ENVELOPE = /^(?:\s*\[(?:message from [^\]]*|AM source \{[^\n]*?\})\]\s*)+/;
const norm = (s) => String(s || '').replace(ENVELOPE, '').replace(/\s+/g, ' ').trim();
const KEY_CHARS = 80;
const keyOf = (prompt) => norm(prompt).slice(0, KEY_CHARS);

const HARNESS_TEXT = /^<(?:task-notification|environment_context|system-reminder|app-context|recommended_plugins|fork-boilerplate)(?:\s|>)/;
const turnText = (t) => (t.blocks || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim();
/** Same rule as the reader's isOperatorPrompt: what opens an exchange. */
export function opensExchange(t) {
  if (!t || t.role !== 'user') return false;
  const text = turnText(t);
  if (!text) return (t.blocks || []).some((b) => b.type === 'image');
  return !HARNESS_TEXT.test(text)
    && !/^#\s*AGENTS\.md instructions\s*\n(?:\s*\n)*<INSTRUCTIONS>/.test(text)
    && !text.startsWith('[Request interrupted')
    && !text.startsWith('[SYSTEM NOTIFICATION');
}

// A peer's clock and the manager's are the same machine's, but the prompt is
// written a moment after the call is logged, and a call is logged when it
// STARTED. A queued prompt can be written minutes later; that is still after.
const EARLY_SLACK = 60_000;
const SCAN_CAP = 48 * 1024 * 1024;       // per lookup; a turn bigger than this is reported cut
const PAGE = 2 * 1024 * 1024;
const TEXT_CAP = 4000;

/** Trim a turn to what the strip and the preview read: no tool bodies, no thinking. */
function slim(t) {
  const blocks = [];
  for (const b of t.blocks || []) {
    if (b.type === 'text') blocks.push({ type: 'text', text: String(b.text || '').slice(0, TEXT_CAP) });
    else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', name: b.name, text: '' });
    else if (b.type === 'tool_result') blocks.push({ type: 'tool_result', text: '', ...(b.failed ? { failed: true } : {}) });
  }
  const out = { role: t.role, blocks };
  for (const k of ['ts', 'kind', 'usage', 'model', 'queued', 'error']) if (t[k] !== undefined) out[k] = t[k];
  return out;
}

const TS_RE = /"timestamp":"(\d{4}-\d\d-\d\dT[^"]{6,40})"/;

/** The first line timestamp at or after `pos`, or null when none is in reach. */
async function tsAfter(fh, pos, size) {
  for (let span = 64 * 1024; span <= 4 * 1024 * 1024; span *= 4) {
    const len = Math.min(span, size - pos);
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, pos);
    const text = buf.toString('utf8');
    const nl = pos === 0 ? 0 : text.indexOf('\n') + 1;
    if (nl <= 0 && pos !== 0) { if (len < span) return null; continue; }
    const m = TS_RE.exec(text.slice(nl));
    if (m) return Date.parse(m[1]) || null;
    if (len < span) return null;
  }
  return null;
}

/**
 * A line-aligned offset at or before the first line stamped `atMs` or later.
 * Errs early, never late: a late start would miss the prompt, an early one
 * only parses a little more.
 */
export async function offsetBefore(file, atMs) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    let lo = 0; let hi = size;
    while (hi - lo > 512 * 1024) {
      const mid = Math.floor((lo + hi) / 2);
      const ts = await tsAfter(fh, mid, size);
      if (ts !== null && ts < atMs) lo = mid; else hi = mid;
    }
    if (lo === 0) return 0;
    // align to the start of the line `lo` falls in the middle of
    const buf = Buffer.alloc(Math.min(4 * 1024 * 1024, size - lo));
    await fh.read(buf, 0, buf.length, lo);
    const nl = buf.indexOf(0x0a);
    return nl < 0 ? 0 : lo + nl + 1;
  } finally {
    await fh.close();
  }
}

/** opId -> { cursor, promptTs, ended, turns, truncated } — ended entries never change. */
const matches = new Map();

const window = (peer, cursor) => readTrace(peer, { window: { at: 'after', cursor, bytes: PAGE, version: 2 } });

/**
 * The turn this dispatch started in `peer`, from `cursor` forward.
 * `claimed` holds prompt timestamps other dispatches to this peer already took,
 * so the same heads-up sent twice finds two turns, not one twice.
 */
async function scanFrom(peer, d, cursor, claimed) {
  const key = keyOf(d.prompt);
  let scanned = 0;
  let found = null;          // { cursor, promptTs, turns }
  for (;;) {
    const page = await window(peer, cursor);
    const w = page.window || {};
    if (w.mode && w.mode !== 'bytes') return { unsupported: true };
    for (const t of page.turns || []) {
      // A prompt that arrives while the peer is busy is first a queue event
      // (Claude). It is then either handed to the running turn mid-flight
      // (`remove`), or becomes an ordinary prompt when that turn ends
      // (`dequeue`, then a user message). Either way the queue event is where
      // it landed; a user message with the same text, if one follows, is where
      // it started a turn of its own.
      const queued = t.role === 'system' && t.event && t.event.type === 'queue' && t.event.operation === 'enqueue';
      const same = (text) => !!key && fromOrigin(text, d) && norm(text).startsWith(key);
      if (!found || found.queued) {
        if (!t.ts || t.ts < d.at - EARLY_SLACK || claimed.has(t.ts)) {
          if (found && opensExchange(t)) return { ...found, ended: true };
          if (found) found.turns.push(slim(t));
          continue;
        }
        if (t.role === 'user' && same(turnText(t))) { found = { cursor, promptTs: t.ts, turns: [slim(t)] }; continue; }
        if (!found && queued && same(t.event.text)) {
          found = { cursor, promptTs: t.ts, queued: true,
            turns: [{ role: 'user', ts: t.ts, queued: true, blocks: [{ type: 'text', text: String(t.event.text).slice(0, TEXT_CAP) }] }] };
          continue;
        }
        if (!found) continue;
      }
      if (opensExchange(t)) return { ...found, ended: true };
      if (t.role !== 'system') found.turns.push(slim(t));
    }
    scanned += Math.max(0, (w.end || 0) - cursor);
    if (w.atEnd || !(w.end > cursor) || w.blocked) return found ? { ...found, ended: false } : { notFound: true };
    if (scanned > SCAN_CAP) return found ? { ...found, ended: false, truncated: true } : { notFound: true, truncated: true };
    cursor = w.end;
  }
}

async function resolve(d, peer, peerState, claimed) {
  const memo = matches.get(d.id);
  if (memo && memo.ended) return memo;
  if (!peer) return null;
  let start = memo && memo.cursor;
  if (start === undefined) {
    const hit = await findTrace(peer, store.list());
    if (!hit) return { noTrace: true };
    try { start = await offsetBefore(hit.src, d.at - EARLY_SLACK); } catch { start = 0; }
  }
  let r;
  try {
    r = await scanFrom(peer, d, start, claimed);
  } catch (e) {
    if (['no-trace', 'unsupported-harness', 'trace-not-user-conversation'].includes(e && e.code)) return { noTrace: true };
    throw e;
  }
  if (r.unsupported || r.notFound) return r;
  matches.set(d.id, r);
  if (matches.size > 5000) matches.delete(matches.keys().next().value);
  // The last turn in the file has ended when its session stopped working on it.
  // Not remembered as ended: a pane between two tool calls can read as idle
  // for a moment, and only the peer's NEXT prompt closes a turn for good.
  if (!r.ended && peerState !== 'working') return { ...r, ended: 'idle' };
  return r;
}

/**
 * Every dispatch `originId` made at or after `since`, newest last, each with the
 * turn it started in its target (slimmed) when that can be found.
 *
 * `stateOf(session)` is the caller's live state for a session ('working', …).
 */
export async function dispatchesOf(originId, { since = 0, limit = 200, stateOf = () => null, colorOf = () => null } = {}) {
  await refreshIndex();
  const mine = index.rows.filter((d) => d.originId === originId && d.at >= since).slice(-limit);
  const claimedByPeer = new Map();
  const out = [];
  for (const d of mine) {
    const peer = d.target.id ? store.get(d.target.id) : null;
    const state = peer ? stateOf(peer) : null;
    let claimed = claimedByPeer.get(d.target.id);
    if (!claimed) { claimed = new Set(); claimedByPeer.set(d.target.id, claimed); }
    let r = null;
    if (d.ok && peer) r = await resolve(d, peer, state, claimed);
    if (r && r.promptTs) claimed.add(r.promptTs);
    out.push({
      id: d.id, at: d.at, kind: d.kind, status: d.status, ok: d.ok,
      target: {
        ...d.target,
        name: peer ? peer.name : d.target.name,
        cli: peer ? peer.cli : d.target.cli,
        color: colorOf(peer ? peer.cli : d.target.cli),
        exists: !!peer,
        state,
      },
      prompt: d.prompt.slice(0, TEXT_CAP),
      exchange: r && r.turns ? { turns: r.turns, ended: !!r.ended, truncated: !!r.truncated } : null,
      ...(r && (r.noTrace || r.unsupported) ? { untraced: true } : {}),
    });
  }
  return out;
}
