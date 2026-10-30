// ---------- Antigravity CLI (`agy`) conversations ----------
//
// agy keeps ONE SQLite database per conversation, in WAL mode:
//   ~/.gemini/antigravity-cli/conversations/<uuid>.db
// Each row of `steps` is one step of the trajectory, and `step_payload` is that
// step as a protobuf (exa.cortex_pb.CortexStep). No schema is published, but the
// binary embeds its descriptors, and the field numbers below were read from
// them (agy 1.4.10) and checked against real conversations:
//
//   CortexStep           1 type · 4 status · 5 metadata · 19 user_input
//                        20 planner_response · 24 error_message · 31 error
//                        114 system_message · 140 generic
//   CortexStepMetadata   1 created_at · 4 tool_call · 9 model_usage
//   CortexStepUserInput  1 query · 2 user_response · 3 items[].text
//                        9 media · 12 user_config.dynamic_workspace_uris (12)
//   PlannerResponse      1 response · 8 modified_response · 3 thinking
//                        16 raw_thinking · 7 tool_calls
//   ChatToolCall         1 id · 2 name · 3 arguments_json
//   GenericStepResult    1 result (CortexStepGeneric 2)
//   CortexErrorDetails   1 user_error_message · 2 short_error · 3 full_error
//   ModelUsageStats      2 input · 3 output · 5 cache_read
//
// Every tool is a GENERIC step in 1.4.10 (its call is metadata.tool_call); the
// older per-tool step types are read the same way when they carry a call.
// Anything else (checkpoints, ephemeral messages, history) is not conversation.
//
// Read-only, never copied: the database may be mid-write (WAL), and a torn read
// is simply skipped and retried on the next poll. Reading leaves agy's folder
// as it was: a database agy has closed (no -wal, no -shm) is opened immutable,
// because a plain read-only open would create both sidecars beside it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* older node: no agy reader */ }

export const STEP = { USER_INPUT: 14, PLANNER_RESPONSE: 15, ERROR_MESSAGE: 17, SYSTEM_MESSAGE: 101, GENERIC: 132 };
// CortexStepStatus: PENDING, RUNNING, GENERATING and QUEUED are work in flight.
// WAITING (9) is a tool waiting on the operator's permission.
const IN_FLIGHT = new Set([1, 2, 8, 11]);
export const STATUS = { DONE: 3, ERROR: 7, WAITING: 9 };

export function agyHome() {
  return path.join(process.env.HOME || '', '.gemini', 'antigravity-cli');
}
export function agyConversationsDir() { return path.join(agyHome(), 'conversations'); }
export function agyConversationPath(id) { return path.join(agyConversationsDir(), `${id}.db`); }
// The conversation id is the database's file name, and it reaches the launch
// line unquoted: only a uuid may ever be interpolated.
export const AGY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------- protobuf wire format, just enough to read a step ----------
// A message decodes to Map<field, value[]>: varints as Numbers, length-delimited
// fields as Buffers (a nested message is decoded on demand). Fixed-width fields
// are skipped. A malformed buffer throws; a malformed NESTED field reads as
// empty, so one bad field costs that field, not the step.
function varint(b, i) {
  let r = 0; let mul = 1;
  for (;;) {
    if (i >= b.length) throw new Error('truncated varint');
    const c = b[i++];
    r += (c & 0x7f) * mul;
    if (c < 0x80) return [r, i];
    mul *= 128;
    if (mul > 2 ** 70) throw new Error('varint too long');
  }
}
export function pbDecode(b) {
  const m = new Map();
  let i = 0;
  while (i < b.length) {
    let key; [key, i] = varint(b, i);
    const f = Math.floor(key / 8); const w = key % 8;
    let v;
    if (w === 0) [v, i] = varint(b, i);
    else if (w === 2) {
      let n; [n, i] = varint(b, i);
      if (i + n > b.length) throw new Error('truncated field');
      v = b.subarray(i, i + n); i += n;
    } else if (w === 1) { i += 8; continue; } else if (w === 5) { i += 4; continue; } else throw new Error(`wire type ${w}`);
    if (!m.has(f)) m.set(f, []);
    m.get(f).push(v);
  }
  return m;
}
const EMPTY = new Map();
const one = (m, f) => (m.get(f) || [])[0];
const tryDecode = (b) => { try { return pbDecode(b); } catch { return EMPTY; } };
const sub = (m, f) => { const v = one(m, f); return Buffer.isBuffer(v) ? tryDecode(v) : EMPTY; };
const subs = (m, f) => (m.get(f) || []).filter(Buffer.isBuffer).map(tryDecode).filter((x) => x.size);
const str = (m, f) => { const v = one(m, f); return Buffer.isBuffer(v) ? v.toString('utf8') : ''; };
const num = (m, f) => { const v = one(m, f); return typeof v === 'number' ? v : 0; };
// A Timestamp, as ms. Anything outside 1970..9999 reads as none: a garbled one
// would otherwise throw out of toISOString() downstream.
const tsMs = (m) => {
  if (!m.size) return 0;
  const ms = Math.round(num(m, 1) * 1000 + num(m, 2) / 1e6);
  return ms > 0 && ms < 253402300800000 ? ms : 0;
};
// Tool arguments and output are kept clipped, with their full length, so a
// conversation of large tool results doesn't sit whole in the server's memory.
// Well above what the Reader shows of one block.
export const TEXT_KEEP = 32_000;
function clipped(step, key, text) {
  if (text.length <= TEXT_KEEP) { step[key] = text; return; }
  step[key] = text.slice(0, TEXT_KEEP);
  step[`${key}Length`] = text.length;
}

function toolCall(m) {
  if (!m.size) return null;
  const name = str(m, 2);
  if (!name) return null;
  const call = { id: str(m, 1), name };
  clipped(call, 'args', str(m, 3));
  return call;
}
function errorText(m) {
  if (!m.size) return '';
  return str(m, 1) || str(m, 2) || str(m, 3) || str(m, 9);
}

/** One step, decoded to what a reader needs. A payload that can't be read at
 *  all is still a step: its row's type and status, marked `unreadable`, so the
 *  steps after it and the conversation's state stay right. */
export function decodeStep(row) {
  try { return decodeStepPayload(row); } catch {
    return { idx: Number(row.idx), type: Number(row.step_type) || 0, status: Number(row.status) || 0, ts: 0, unreadable: true };
  }
}
function decodeStepPayload(row) {
  const s = pbDecode(Buffer.from(row.step_payload || []));
  const type = Number(row.step_type) || num(s, 1);
  const status = Number(row.status) || num(s, 4);
  const md = sub(s, 5);
  const step = { idx: Number(row.idx), type, status, ts: tsMs(sub(md, 1)) };
  const error = errorText(sub(s, 31));
  if (error) step.error = error;
  const usage = sub(md, 9);
  if (usage.size) step.usage = { in: num(usage, 2), out: num(usage, 3), cacheRead: num(usage, 5) };
  switch (type) {
    case STEP.USER_INPUT: {
      const u = sub(s, 19);
      const items = subs(u, 3).map((it) => str(it, 1)).filter(Boolean).join('\n');
      step.text = str(u, 2) || items || str(u, 1);
      const cwd = sub(u, 12).get(12)?.find(Buffer.isBuffer);
      if (cwd) step.cwd = fileUriPath(cwd.toString('utf8'));
      // Copied out, so an image doesn't keep its whole step payload alive.
      step.images = [...subs(u, 9), ...subs(u, 5)]
        .map((im) => ({ mediaType: str(im, 1), data: one(im, 2) }))
        .filter((im) => im.mediaType.startsWith('image/') && Buffer.isBuffer(im.data) && im.data.length)
        .map((im) => ({ mediaType: im.mediaType, data: Buffer.from(im.data) }));
      break;
    }
    case STEP.PLANNER_RESPONSE: {
      const p = sub(s, 20);
      step.text = str(p, 8) || str(p, 1);
      step.thinking = str(p, 3) || str(p, 16);
      step.calls = subs(p, 7).map(toolCall).filter(Boolean);
      break;
    }
    case STEP.SYSTEM_MESSAGE:
      step.text = str(sub(s, 114), 1);
      break;
    case STEP.ERROR_MESSAGE:
      step.error = errorText(sub(sub(s, 24), 3)) || step.error || 'error';
      break;
    default: {
      // GENERIC (every tool in 1.4.10) and the older per-tool step types: the
      // call rides the metadata, the output the generic result.
      const call = toolCall(sub(md, 4));
      if (!call) break;
      step.call = call;
      clipped(step, 'output', str(sub(sub(s, 140), 2), 1));
    }
  }
  return step;
}

function fileUriPath(u) {
  if (!u.startsWith('file://')) return u || null;
  try { return decodeURIComponent(new URL(u).pathname); } catch { return u.slice(7); }
}

export const stepInFlight = (st) => IN_FLIGHT.has(st.status);

// A WAL that holds no frame (a header at most) is no write. SQLite leaves an
// empty one behind a read-only connection, so it must not count as activity.
const WAL_HEADER = 32;
function walStat(p) {
  try { const w = fs.statSync(`${p}-wal`); return w.size > WAL_HEADER ? w : null; } catch { return null; }
}
/** What changes when a conversation database is written: the file, or its WAL. */
export function agyChangeKey(p) {
  let m;
  try { m = fs.statSync(p); } catch { return null; }
  const w = walStat(p);
  return `${m.mtimeMs}:${m.size}:${w?.mtimeMs || 0}:${w?.size || 0}`;
}

// Open a conversation database to read it. While agy has it open, a -wal and
// a -shm sit beside it and a read-only connection shares them. Once agy has
// closed it, both are gone and everything committed is in the main file; a
// read-only open would create them again (and that fresh -wal looked like agy
// writing), so it is opened immutable instead: no sidecar, no lock. Should agy
// checkpoint into the main file during that read, `stable()` turns false and
// the read is thrown away.
function openAgy(p) {
  if (fs.existsSync(`${p}-wal`) || fs.existsSync(`${p}-shm`)) {
    return { db: new DatabaseSync(p, { readOnly: true }), stable: () => true };
  }
  const st = (s = fs.statSync(p)) => `${s.mtimeMs}:${s.size}:${s.ino}`;
  const before = st();
  const uri = `file:${p.split('/').map(encodeURIComponent).join('/')}?immutable=1`;
  const db = new DatabaseSync(uri, { readOnly: true });
  return { db, stable: () => { try { return st() === before; } catch { return false; } } };
}
const payloadHash = (b) => crypto.createHash('sha1').update(b || '').digest('base64').slice(0, 16);
function changedDuringRead() { return new Error('conversation database changed during the read'); }

// A step agy may still rewrite: in flight, or waiting on the operator.
const settled = (st) => !IN_FLIGHT.has(st.status) && st.status !== STATUS.WAITING;
// Steps re-read on every refresh even when settled, as a margin against a
// late rewrite near the end.
const REREAD_TAIL = 32;

/** Every step of one conversation, in order. With `prev` (this database's last
 *  read) only the tail is read again: settled steps before it are kept, and
 *  everything from the first unsettled step on is replaced. A step left
 *  unsettled by a turn the operator has since moved on from (a WAITING tool of
 *  a killed run, then a new prompt) no longer holds the tail open. The kept
 *  steps must still be what the database holds below the tail: as many rows,
 *  as many payload bytes, and the last of them unchanged (each payload carries
 *  its own timestamp, so a rewritten row differs). A conversation that lost or
 *  rewrote rows there is read whole. Throws when the database cannot be opened or read; the caller
 *  keeps what it had. */
export function readAgySteps(dbPath, prev = null) {
  if (!DatabaseSync) { const e = new Error('node:sqlite unavailable'); e.code = 'unsupported-harness'; throw e; }
  const { db, stable } = openAgy(dbPath);
  try {
    let keep = [];
    if (prev && prev.length) {
      let cut = Math.max(0, prev.length - REREAD_TAIL);
      let lastPrompt = -1;
      for (let i = prev.length - 1; i >= 0; i--) if (prev[i].type === STEP.USER_INPUT) { lastPrompt = i; break; }
      const open = prev.findIndex((st, i) => i >= lastPrompt && !settled(st));
      if (open >= 0 && open < cut) cut = open;
      if (cut > 0) {
        const head = db.prepare('select count(*) n, coalesce(sum(length(step_payload)), 0) b from steps where idx < ?').get(prev[cut].idx);
        let bytes = 0;
        for (let i = 0; i < cut; i++) bytes += prev[i].bytes || 0;
        const last = db.prepare('select step_payload from steps where idx = ?').get(prev[cut - 1].idx);
        if (Number(head.n) === cut && Number(head.b) === bytes && last && payloadHash(last.step_payload) === prev[cut - 1].hash) {
          keep = prev.slice(0, cut);
        }
      }
    }
    const from = keep.length ? keep[keep.length - 1].idx + 1 : -1;
    const out = keep.slice();
    for (const row of db.prepare('select idx, step_type, status, step_payload from steps where idx >= ? order by idx').iterate(from)) {
      const st = decodeStep(row);
      st.bytes = row.step_payload ? row.step_payload.length : 0;
      st.hash = payloadHash(row.step_payload);
      out.push(st);
    }
    if (!stable()) throw changedDuringRead();
    return out;
  } finally { try { db.close(); } catch {} }
}

// The folder a conversation runs in, from the first prompt step that names it.
// It never changes, so it is remembered per file once found.
// A conversation with no prompt yet is looked at again only once it changes.
const cwdMemo = new Map(); // dbPath -> { cwd } | { none: activeMs }
function conversationCwd(dbPath, activeMs) {
  const hit = cwdMemo.get(dbPath);
  if (hit && (hit.cwd || hit.none === activeMs)) return hit.cwd || null;
  if (!DatabaseSync) return null;
  let db;
  try {
    let stable;
    ({ db, stable } = openAgy(dbPath));
    let cwd = null;
    for (const row of db.prepare('select idx, step_type, status, step_payload from steps where step_type = ? order by idx limit 8').all(STEP.USER_INPUT)) {
      cwd = decodeStep(row).cwd || null;
      if (cwd) break;
    }
    if (!stable()) return null;
    if (cwdMemo.size > 2000) cwdMemo.clear();
    cwdMemo.set(dbPath, cwd ? { cwd } : { none: activeMs });
    return cwd;
  } catch { return null; } finally { try { db?.close(); } catch {} }
}

/** Newest activity of a conversation database: WAL writes leave the main
 *  file's mtime alone, so both are read. A WAL with no frame in it is no
 *  write (see walStat). */
export function agyActivityMs(dbPath) {
  let m = 0;
  try { m = fs.statSync(dbPath).mtimeMs; } catch { return 0; }
  const w = walStat(dbPath);
  return w ? Math.max(m, w.mtimeMs) : m;
}

// agy's own record of the newest conversation per folder (what `agy -c`
// resumes): { "<cwd>": "<id>" }. It is read first. Prompt steps carry the
// folder too, in print and interactive runs, except a prompt seeded at launch
// (`agy -i`), which carries none; they cover conversations that lost their
// cache entry to a newer one in the same folder.
function lastConversations() {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(agyHome(), 'cache', 'last_conversations.json'), 'utf8')); } catch { return new Map(); }
  const byId = new Map();
  if (j && typeof j === 'object') for (const [cwd, id] of Object.entries(j)) if (typeof id === 'string') byId.set(id, cwd);
  return byId;
}

/** Every conversation database, with the folder it runs in (null when agy
 *  recorded none). */
export function listAgyConversations() {
  let names = [];
  try { names = fs.readdirSync(agyConversationsDir()); } catch { return []; }
  const latest = lastConversations();
  const out = [];
  for (const n of names) {
    const m = n.match(/^(.+)\.db$/);
    if (!m || !AGY_ID.test(m[1])) continue;
    const p = path.join(agyConversationsDir(), n);
    const activeMs = agyActivityMs(p);
    out.push({ id: m[1], path: p, cwd: latest.get(m[1]) || conversationCwd(p, activeMs), activeMs });
  }
  return out;
}

/**
 * The conversation an agy pane in `directory` is using: the most recently
 * written one rooted there, written at/after `sinceMs`, not claimed by another
 * pane. Activity rather than creation time, because `agy -c` continues an
 * older conversation. Only used for a pane that holds its folder alone;
 * same-folder panes cannot be told apart this way.
 */
export function captureAgyConversation(directory, sinceMs, claimed) {
  const want = path.resolve(directory);
  let best = null;
  for (const c of listAgyConversations()) {
    if (c.activeMs < sinceMs || (claimed && claimed.has(c.id))) continue;
    if (!c.cwd || path.resolve(c.cwd) !== want) continue;
    if (!best || c.activeMs > best.activeMs) best = c;
  }
  return best ? { id: best.id } : null;
}

// The step a conversation is held on for the operator (a tool waiting for
// permission): the newest WAITING step with no prompt after it, so one left
// WAITING by a killed run doesn't outlive the next turn. Read from the status
// column alone, so a payload agy changed can't hide a pending approval.
// Remembered per database until it changes.
const waitingMemo = new Map(); // dbPath -> { key, value }
export function agyWaitingStep(id) {
  if (!DatabaseSync || !AGY_ID.test(id || '')) return null;
  const p = agyConversationPath(id);
  const key = agyChangeKey(p);
  if (!key) { waitingMemo.delete(p); return null; }
  const hit = waitingMemo.get(p);
  if (hit && hit.key === key) return hit.value;
  let db;
  let value = null;
  try {
    let stable;
    ({ db, stable } = openAgy(p));
    const row = db.prepare(`select idx from steps s where status = ?
      and not exists (select 1 from steps u where u.step_type = ? and u.idx > s.idx)
      order by idx desc limit 1`).get(STATUS.WAITING, STEP.USER_INPUT);
    value = row ? { idx: Number(row.idx) } : null;
    if (!stable()) throw changedDuringRead();
  } catch { return hit ? hit.value : null; } finally { try { db?.close(); } catch {} }
  if (waitingMemo.size > 2000) waitingMemo.clear();
  waitingMemo.set(p, { key, value });
  return value;
}

export function agyConversationExists(id) {
  return !!id && AGY_ID.test(id) && fs.existsSync(agyConversationPath(id));
}

// The conversation a running agy is on, from the process itself: agy holds
// `presence/<uuid>.lock` open for its current conversation, from its first
// prompt on, and moves it to the new id on `/new`. That names this pane's
// conversation exactly, whoever else writes conversations in the same folder.
// `pid` is the pane's root: agy itself, or the shell of a `-c || exec` launch
// with agy as its direct child (never a deeper descendant: an agy started by a
// tool is not the pane's).
//   { id }        agy is on this conversation
//   { id: null }  agy is running and holds no conversation yet
//   null          no agy process to read (not started, gone, or /proc unreadable)
export function agyConversationForPid(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const comm = (p) => { try { return fs.readFileSync(`/proc/${p}/comm`, 'utf8').trim(); } catch { return ''; } };
  let agy = null;
  if (comm(pid) === 'agy') agy = pid;
  else if (['bash', 'sh', 'dash'].includes(comm(pid))) {
    let children = [];
    try { children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean); } catch {}
    const found = children.filter((c) => comm(c) === 'agy');
    if (found.length === 1) agy = Number(found[0]);
  }
  if (!agy) return null;
  let fds;
  try { fds = fs.readdirSync(`/proc/${agy}/fd`); } catch { return null; }
  let presence = null;
  try { presence = fs.realpathSync(path.join(agyHome(), 'presence')); } catch {}
  const ids = new Set();
  if (presence) {
    for (const fd of fds.slice(0, 1024)) {
      let target;
      try { target = fs.readlinkSync(`/proc/${agy}/fd/${fd}`); } catch { continue; }
      if (path.dirname(target) !== presence) continue;
      const m = /^(.+)\.lock$/.exec(path.basename(target));
      if (m && AGY_ID.test(m[1])) ids.add(m[1]);
    }
  }
  return { id: ids.size === 1 ? [...ids][0] : null };
}
