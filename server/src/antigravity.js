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
// is simply skipped and retried on the next poll.

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
// are skipped. A malformed buffer throws, and the caller drops that step.
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
const sub = (m, f) => { const v = one(m, f); return Buffer.isBuffer(v) ? pbDecode(v) : EMPTY; };
const subs = (m, f) => (m.get(f) || []).filter(Buffer.isBuffer).map(pbDecode);
const str = (m, f) => { const v = one(m, f); return Buffer.isBuffer(v) ? v.toString('utf8') : ''; };
const num = (m, f) => { const v = one(m, f); return typeof v === 'number' ? v : 0; };
const tsMs = (m) => (m.size ? Math.round(num(m, 1) * 1000 + num(m, 2) / 1e6) : 0);

function toolCall(m) {
  if (!m.size) return null;
  const name = str(m, 2);
  if (!name) return null;
  return { id: str(m, 1), name, args: str(m, 3) };
}
function errorText(m) {
  if (!m.size) return '';
  return str(m, 1) || str(m, 2) || str(m, 3) || str(m, 9);
}

/** One step, decoded to what a reader needs. Null for an unreadable payload. */
export function decodeStep(row) {
  let s;
  try { s = pbDecode(Buffer.from(row.step_payload || [])); } catch { return null; }
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
      step.images = [...subs(u, 9), ...subs(u, 5)]
        .map((im) => ({ mediaType: str(im, 1), data: one(im, 2) }))
        .filter((im) => im.mediaType.startsWith('image/') && Buffer.isBuffer(im.data) && im.data.length);
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
      step.output = str(sub(sub(s, 140), 2), 1);
    }
  }
  return step;
}

function fileUriPath(u) {
  if (!u.startsWith('file://')) return u || null;
  try { return decodeURIComponent(new URL(u).pathname); } catch { return u.slice(7); }
}

export const stepInFlight = (st) => IN_FLIGHT.has(st.status);

/** Every decodable step of one conversation, in order. Throws when the database
 *  cannot be opened or read; the caller keeps what it had. */
export function readAgySteps(dbPath) {
  if (!DatabaseSync) { const e = new Error('node:sqlite unavailable'); e.code = 'unsupported-harness'; throw e; }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const out = [];
    for (const row of db.prepare('select idx, step_type, status, step_payload from steps order by idx').all()) {
      const st = decodeStep(row);
      if (st) out.push(st);
    }
    return out;
  } finally { try { db.close(); } catch {} }
}

// The folder a print-mode conversation runs in, from its first user input. It
// never changes, so it is remembered per file once found.
// A conversation with no prompt yet is looked at again only once it changes.
const cwdMemo = new Map(); // dbPath -> { cwd } | { none: activeMs }
function conversationCwd(dbPath, activeMs) {
  const hit = cwdMemo.get(dbPath);
  if (hit && (hit.cwd || hit.none === activeMs)) return hit.cwd || null;
  if (!DatabaseSync) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('select idx, step_type, status, step_payload from steps where step_type = ? order by idx limit 1').get(STEP.USER_INPUT);
    const cwd = row ? decodeStep(row)?.cwd || null : null;
    if (cwdMemo.size > 2000) cwdMemo.clear();
    cwdMemo.set(dbPath, cwd ? { cwd } : { none: activeMs });
    return cwd;
  } catch { return null; } finally { try { db?.close(); } catch {} }
}

/** Newest activity of a conversation database: WAL writes leave the main
 *  file's mtime alone, so both are read. */
export function agyActivityMs(dbPath) {
  let m = 0;
  try { m = fs.statSync(dbPath).mtimeMs; } catch { return 0; }
  try { m = Math.max(m, fs.statSync(`${dbPath}-wal`).mtimeMs); } catch {}
  return m;
}

// agy's own record of the newest conversation per folder (what `agy -c`
// resumes): { "<cwd>": "<id>" }. An interactive conversation names its folder
// nowhere else — only print mode writes it into the prompt step — so this is
// how a pane's conversation is found, and older ones in the same folder lose
// their folder once a newer one starts there.
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

export function agyConversationExists(id) {
  return !!id && AGY_ID.test(id) && fs.existsSync(agyConversationPath(id));
}
