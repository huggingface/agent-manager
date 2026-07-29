import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import * as store from './sessions.js';
import { WORKSPACES_DIR, PASSIVE_CLIS } from './config.js';
import { mark, tracked, PHASE } from './watchdog.js';
// The trace panel reader (bottom of this file) locates its file with the same
// resolver sharing uses. share.js does not import traces.js, so no cycle.
import { findTrace, HARNESS_LABEL } from './share.js';

// Workspace-wide trace analytics: parse every Claude transcript and Codex
// rollout on the Space into per-conversation stats (turns, tool calls, web
// searches, tokens), attribute them to Agent Manager sessions where possible
// (Claude: transcript filename == sessionUuid; Codex: pinned codexSessionId),
// and aggregate the rest as "other".
//
// Parsing is memoized per file by (mtime, size), so repeat calls only re-read
// files that actually changed — important on the bucket mount.

const fileCache = new Map(); // path -> { key, parsed: { stats, digest } }
// Parsing is synchronous CPU; between files we hand the event loop back so a
// cold build (boot warmup after a rebuild) doesn't freeze every request for
// minutes. Worst blocking stretch becomes one file (~1s), not the whole scan.
const yieldLoop = () => new Promise((r) => setImmediate(r));
let resultMemo = { ts: 0, val: null };
const TTL = 400; // Overview polls at ~1Hz; per-file mtime caching keeps re-scans cheap

function emptyStats() {
  return { turns: 0, prompts: 0, toolCalls: 0, tools: {}, web: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, firstTs: 0, lastTs: 0, files: 0 };
}

function addTs(st, iso) {
  const t = Date.parse(iso);
  if (!t) return;
  if (!st.firstTs || t < st.firstTs) st.firstTs = t;
  if (t > st.lastTs) st.lastTs = t;
}

function mergeInto(a, b) {
  a.turns += b.turns; a.prompts += b.prompts; a.toolCalls += b.toolCalls; a.web += b.web;
  a.tokensIn += b.tokensIn; a.tokensOut += b.tokensOut; a.cacheRead += b.cacheRead; a.files += b.files;
  for (const [k, v] of Object.entries(b.tools)) a.tools[k] = (a.tools[k] || 0) + v;
  if (b.firstTs && (!a.firstTs || b.firstTs < a.firstTs)) a.firstTs = b.firstTs;
  if (b.lastTs > a.lastTs) a.lastTs = b.lastTs;
}

// ---------- "since your last prompt" digest (for the Overview cards) ----------
// Built in the same parse pass: every real user prompt resets the segment, so
// whatever accumulated by EOF is the activity since the last thing you said.
function emptyDigest() {
  return { lastPromptText: '', lastPromptRaw: '', lastPromptTs: 0, lastAssistantText: '', lastAssistantMd: '', lastAssistantTs: 0, sinceTurns: 0, sinceToolCalls: 0, sinceTools: {}, sinceFiles: [], sinceTokens: 0, running: false, turnsLog: [] };
}
const clip = (s, n = 280) => { const t = (s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// Markdown-preserving variant (keeps newlines) for the expandable card view.
const clipRaw = (s, n = 6000) => { const t = (s || '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// turnsLog: the model's intermediate turns WITHIN the current request (newest
// first) so the Overview can page through them. Each new assistant text pushes
// the previous one into the log; a new user prompt clears it.
const MAX_TURNS_LOG = 24;
function digestPrompt(d, text, ts) {
  d.lastPromptText = clip(text); d.lastPromptRaw = clipRaw(text); d.lastPromptTs = Date.parse(ts) || 0;
  d.sinceTurns = 0; d.sinceToolCalls = 0; d.sinceTools = {}; d.sinceFiles = []; d.sinceTokens = 0;
  d.turnsLog = []; // arrows only walk the current request's turns
  // The previous answer belongs to the previous prompt — never show it as "LAST".
  d.lastAssistantText = ''; d.lastAssistantMd = ''; d.lastAssistantTs = 0;
}
function digestAssistant(d, text, ts) {
  const clipped = clip(text);
  // Same text again (codex mirrors agent_message/response_item/task_complete):
  // refresh metadata only, don't log a phantom turn.
  if (clipped !== d.lastAssistantText) {
    if (d.lastAssistantText) {
      d.turnsLog.unshift({ answer: d.lastAssistantText, answerMd: d.lastAssistantMd, ts: d.lastAssistantTs });
      if (d.turnsLog.length > MAX_TURNS_LOG) d.turnsLog.pop();
    }
    d.lastAssistantText = clipped;
  }
  d.lastAssistantMd = clipRaw(text);
  d.lastAssistantTs = Date.parse(ts) || d.lastAssistantTs;
}
function digestTool(d, name, file) {
  d.sinceToolCalls++;
  d.sinceTools[name] = (d.sinceTools[name] || 0) + 1;
  if (file && !d.sinceFiles.includes(file) && d.sinceFiles.length < 12) d.sinceFiles.push(file);
}

// ---------- Claude transcripts (CLAUDE_CONFIG_DIR/projects/**/<uuid>.jsonl) ----------
// Multi-block assistant messages repeat the same message.id AND usage across
// several lines — dedupe both turns/usage (by message id) and tool_use blocks
// (by block id) or everything double-counts.
function parseClaude(txt) {
  const st = emptyStats();
  const dg = emptyDigest();
  st.files = 1;
  const seenMsg = new Set();
  const seenTool = new Set();
  for (const line of txt.split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.timestamp) addTs(st, j.timestamp);
    if (j.type === 'assistant' && j.message) {
      const m = j.message;
      const id = m.id || `${j.uuid || Math.random()}`;
      if (!seenMsg.has(id)) {
        seenMsg.add(id);
        st.turns++;
        dg.sinceTurns++;
        const u = m.usage;
        if (u) {
          st.tokensIn += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          st.cacheRead += u.cache_read_input_tokens || 0;
          st.tokensOut += u.output_tokens || 0;
          dg.sinceTokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
          const w = u.server_tool_use;
          if (w) st.web += (w.web_search_requests || 0) + (w.web_fetch_requests || 0);
        }
      }
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (!c) continue;
          if (c.type === 'tool_use' && !seenTool.has(c.id)) {
            seenTool.add(c.id);
            st.toolCalls++;
            const name = c.name || 'tool';
            st.tools[name] = (st.tools[name] || 0) + 1;
            if (/^web(search|fetch)$/i.test(name)) st.web++;
            const file = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name) && c.input && c.input.file_path;
            digestTool(dg, name, file || null);
          } else if (c.type === 'text' && c.text && c.text.trim()) {
            digestAssistant(dg, c.text, j.timestamp);
          }
        }
      }
    } else if (j.type === 'user' && !j.toolUseResult && !j.isMeta && !j.sourceToolUseID) {
      // isMeta/sourceToolUseID mark harness-injected "user" lines (skill
      // payloads, attached context) — not something the operator typed.
      st.prompts++;
      const mc = j.message && j.message.content;
      const text = typeof mc === 'string' ? mc
        : Array.isArray(mc) ? mc.filter((c) => c && c.type === 'text').map((c) => c.text).join(' ') : '';
      // Skip harness noise (slash-command wrappers, attachments, interrupt
      // markers) as "prompts".
      const t = text.trim();
      if (t && !t.startsWith('<') && !t.startsWith('[Request interrupted')) digestPrompt(dg, text, j.timestamp);
    }
  }
  return { stats: st, digest: dg };
}

// ---------- Codex rollouts (CODEX_HOME/sessions/**/rollout-*-<uuid>.jsonl) ----------
const codexText = (p) => (Array.isArray(p.content) ? p.content.map((c) => (c && c.text) || '').join(' ') : '');

function parseCodex(txt) {
  const st = emptyStats();
  const dg = emptyDigest();
  st.files = 1;
  let tok = null; // token_count events are cumulative per run — keep the last
  let tokAtPrompt = 0; // cumulative total when you last prompted (for sinceTokens)
  for (const line of txt.split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.timestamp) addTs(st, j.timestamp);
    const p = j.payload || {};
    if (j.type === 'session_meta') {
      if (p.cwd) st.cwd = p.cwd; // for cwd-fallback attribution
      // Codex >=0.142 spawns internal "guardian" safety-judge subagents whose
      // rollouts share the session's cwd. They aren't the user's conversation —
      // flag them so build() skips attribution (they'd otherwise pollute or
      // blank out the Overview digest).
      if (p.thread_source === 'subagent' || (p.source && p.source.subagent)) st.subagent = true;
    }
    if (j.type === 'response_item') {
      switch (p.type) {
        case 'message':
          if (p.role === 'assistant') {
            st.turns++;
            dg.sinceTurns++;
            const t = codexText(p);
            if (t.trim()) digestAssistant(dg, t, j.timestamp);
          } else if (p.role === 'user') {
            st.prompts++;
            const t = codexText(p);
            // Codex wraps environment/instructions as user items — skip those.
            if (t.trim() && !t.trim().startsWith('<')) {
              digestPrompt(dg, t, j.timestamp);
              tokAtPrompt = tok ? (tok.total_tokens || 0) : 0;
            }
          }
          break;
        case 'function_call':
        case 'custom_tool_call':
        case 'local_shell_call': {
          st.toolCalls++;
          const name = p.name || p.type;
          st.tools[name] = (st.tools[name] || 0) + 1;
          // apply_patch arguments carry the touched files in the patch header
          let file = null;
          if (name === 'apply_patch' && typeof p.arguments === 'string') {
            const m = p.arguments.match(/\*\*\* (?:Update|Add|Delete) File: ([^\\\n"]+)/);
            if (m) file = m[1].trim();
          }
          digestTool(dg, name, file);
          break;
        }
        case 'web_search_call':
          st.web++;
          st.toolCalls++;
          st.tools.web_search = (st.tools.web_search || 0) + 1;
          digestTool(dg, 'web_search', null);
          break;
        default:
      }
    } else if (j.type === 'event_msg') {
      // Task lifecycle: Codex runs one task per user prompt, made of several
      // model turns. task_started/task_complete bracket it — that (not "an
      // assistant message appeared") is the real running/done signal, and
      // task_complete carries the authoritative final answer.
      switch (p.type) {
        case 'token_count':
          if (p.info && p.info.total_token_usage) tok = p.info.total_token_usage;
          break;
        case 'task_started':
          dg.running = true;
          break;
        case 'agent_message':
          if (p.message) digestAssistant(dg, p.message, j.timestamp); // live progress text
          break;
        case 'task_complete':
          dg.running = false;
          if (p.last_agent_message) digestAssistant(dg, p.last_agent_message, j.timestamp);
          break;
        default:
      }
    }
  }
  if (tok) {
    const cached = tok.cached_input_tokens || 0;
    st.tokensIn = Math.max(0, (tok.input_tokens || 0) - cached); // align with Claude: fresh input only
    st.cacheRead = cached;
    st.tokensOut = tok.output_tokens || 0;
    dg.sinceTokens = Math.max(0, (tok.total_tokens || 0) - tokAtPrompt);
  }
  return { stats: st, digest: dg };
}

// ---------- OpenClaw sessions (~/.openclaw/agents/*/sessions/<uuid>.jsonl) ----------
// Line shape: { type: 'message', timestamp, message: { role, content: [{type:'text',text}],
// usage: { input, output, cacheRead, ... } } } — other line types are metadata.
const ocText = (m) => Array.isArray(m.content)
  ? m.content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join(' ')
  : (typeof m.content === 'string' ? m.content : '');

function parseOpenClaw(txt) {
  const st = emptyStats();
  const dg = emptyDigest();
  st.files = 1;
  for (const line of txt.split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.timestamp) addTs(st, j.timestamp);
    if (j.type !== 'message' || !j.message) continue;
    const m = j.message;
    const text = ocText(m);
    if (m.role === 'user') {
      st.prompts++;
      if (text.trim() && !text.trim().startsWith('<')) digestPrompt(dg, text, j.timestamp);
    } else if (m.role === 'assistant') {
      st.turns++;
      dg.sinceTurns++;
      if (text.trim()) digestAssistant(dg, text, j.timestamp);
      const u = m.usage;
      if (u) {
        const cached = u.cacheRead || 0;
        st.tokensIn += Math.max(0, (u.input || 0) - cached);
        st.cacheRead += cached;
        st.tokensOut += u.output || 0;
        dg.sinceTokens += (u.input || 0) + (u.output || 0);
      }
      if (Array.isArray(m.content)) {
        for (const cb of m.content) {
          if (cb && typeof cb.type === 'string' && /tool/i.test(cb.type)) {
            st.toolCalls++;
            const name = cb.name || cb.toolName || 'tool';
            st.tools[name] = (st.tools[name] || 0) + 1;
            digestTool(dg, name, null);
          }
        }
      }
    }
  }
  return { stats: st, digest: dg };
}

function openclawFiles() {
  return memoList('openclaw', openclawFilesUncached);
}
async function openclawFilesUncached() {
  const root = path.join(process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || '', '.openclaw'), 'agents');
  const out = [];
  let agents = [];
  try { agents = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const a of agents) {
    if (!a.isDirectory()) continue;
    const dir = path.join(root, a.name, 'sessions');
    let files = [];
    try { files = await fsp.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (f.endsWith('.jsonl') && !f.includes('.trajectory')) out.push(path.join(dir, f));
    }
  }
  return out;
}

// ---------- opencode (SQLite: ~/.local/share/opencode/opencode.db) ----------
// v1.x keeps conversations in SQLite (session/message/part with JSON payloads).
// Read-only via node:sqlite (node >= 22.5; degrades to "no digest" elsewhere).
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* older node: skip opencode */ }

function opencodeDbPath() {
  const xdgData = process.env.XDG_DATA_HOME || path.join(process.env.HOME || '', '.local', 'share');
  return path.join(xdgData, 'opencode', 'opencode.db');
}

// WAL mode appends to <db>-wal without touching the main file's mtime — the
// change key and the hot-file check must look at both.
function dbChangeKey(p) {
  let m;
  try { m = fs.statSync(p); } catch { return null; }
  let w = null;
  try { w = fs.statSync(`${p}-wal`); } catch {}
  return {
    key: `${m.mtimeMs}:${m.size}:${w?.mtimeMs || 0}:${w?.size || 0}`,
    hotMs: Math.max(m.mtimeMs, w?.mtimeMs || 0),
  };
}

let ocMemo = { key: '', rows: [] };

function readOpencode() {
  if (!DatabaseSync) return [];
  const p = opencodeDbPath();
  const ck = dbChangeKey(p);
  if (!ck) return [];
  if (ocMemo.key === ck.key) return ocMemo.rows;
  // actively written db on the FUSE mount: serve the previous read (first read allowed)
  if (ocMemo.key && Date.now() - ck.hotMs < 8_000) return ocMemo.rows;
  const key = ck.key;
  let db;
  // Synchronous DB read — the historically wedge-prone spot. Breadcrumb it so a
  // stall while it runs is attributed (see watchdog.js).
  const ocPhase = mark(PHASE.readOpencode);
  try { db = new DatabaseSync(p, { readOnly: true }); } catch { mark(ocPhase); return ocMemo.rows; }
  const rows = [];
  try {
    const sessions = db.prepare('select * from session').all();
    const qLastUser = db.prepare("select id, time_created from message where session_id = ? and json_extract(data,'$.role') = 'user' order by time_created desc limit 1");
    const qPromptText = db.prepare("select json_extract(data,'$.text') t from part where message_id = ? and json_extract(data,'$.type') = 'text' order by time_created");
    const qCount = db.prepare("select count(*) c from message where session_id = ? and time_created > ? and json_extract(data,'$.role') = ?");
    const qTools = db.prepare("select json_extract(data,'$.tool') tool, count(*) c from part where session_id = ? and time_created > ? and json_extract(data,'$.type') = 'tool' group by 1");
    const qSinceTok = db.prepare("select coalesce(sum(json_extract(data,'$.tokens.total')), 0) t from part where session_id = ? and time_created > ? and json_extract(data,'$.type') = 'step-finish'");
    const qLastAssistant = db.prepare("select json_extract(p.data,'$.text') t, p.time_created ts from part p join message m on m.id = p.message_id where p.session_id = ? and p.time_created > ? and json_extract(p.data,'$.type') = 'text' and json_extract(m.data,'$.role') = 'assistant' order by p.time_created desc limit 1");
    for (const s of sessions) {
      const st = emptyStats();
      const dg = emptyDigest();
      st.files = 1;
      st.cwd = s.directory || null;
      st.tokensIn = s.tokens_input || 0;
      st.tokensOut = s.tokens_output || 0;
      st.cacheRead = s.tokens_cache_read || 0;
      st.firstTs = Number(s.time_created) || 0;
      st.lastTs = Number(s.time_updated) || st.firstTs;
      st.prompts = qCount.get(s.id, 0, 'user').c;
      st.turns = qCount.get(s.id, 0, 'assistant').c;
      for (const t of qTools.all(s.id, 0)) {
        const name = t.tool || 'tool';
        st.tools[name] = (st.tools[name] || 0) + t.c;
        st.toolCalls += t.c;
        if (/web/i.test(name)) st.web += t.c;
      }
      const lastU = qLastUser.get(s.id);
      const t0 = lastU ? Number(lastU.time_created) || 0 : 0;
      if (lastU) {
        const text = qPromptText.all(lastU.id).map((r) => r.t).filter(Boolean).join(' ');
        if (text.trim() && !text.trim().startsWith('<')) {
          dg.lastPromptText = clip(text);
          dg.lastPromptRaw = clipRaw(text);
          dg.lastPromptTs = t0;
        }
        dg.sinceTurns = qCount.get(s.id, t0, 'assistant').c;
        for (const t of qTools.all(s.id, t0)) {
          const name = t.tool || 'tool';
          dg.sinceTools[name] = (dg.sinceTools[name] || 0) + t.c;
          dg.sinceToolCalls += t.c;
        }
        dg.sinceTokens = qSinceTok.get(s.id, t0).t || 0;
      }
      // Only an answer NEWER than the prompt counts — a stale one means "working".
      const lastA = qLastAssistant.get(s.id, t0);
      if (lastA && lastA.t) {
        dg.lastAssistantText = clip(lastA.t);
        dg.lastAssistantMd = clipRaw(lastA.t);
        dg.lastAssistantTs = Number(lastA.ts) || 0;
      }
      rows.push({ sessionId: s.id, timeCreated: Number(s.time_created) || 0, directory: s.directory || null, parsed: { stats: st, digest: dg } });
    }
  } catch { /* torn read / schema drift: keep previous */ } finally {
    try { db.close(); } catch {}
    mark(ocPhase);
  }
  ocMemo = { key, rows };
  return rows;
}

// Newest opencode conversation in `directory` created at/after `sinceMs` and
// not already claimed by another session. The runner calls this shortly after
// launch to PIN a session to its own `ses_…` id — opencode has no
// per-conversation handle of its own (unlike codex's rollout uuid), so two
// agents sharing a folder would otherwise cross-attribute. Read straight from
// the db (not the memoized rows) so a just-created session is seen immediately.
export function captureOpencodeSession(directory, sinceMs, claimed) {
  if (!DatabaseSync || !directory) return null;
  let db;
  try { db = new DatabaseSync(opencodeDbPath(), { readOnly: true }); } catch { return null; }
  try {
    const rows = db.prepare(
      'select id, time_created from session where directory = ? and time_created >= ? order by time_created desc',
    ).all(directory, sinceMs);
    for (const r of rows) if (!claimed || !claimed.has(r.id)) return { id: r.id, timeCreated: Number(r.time_created) || 0 };
    return null;
  } catch { return null; } finally { try { db.close(); } catch {} }
}

// ---------- Hermes (SQLite: ~/.hermes/state.db, WAL) ----------
// sessions carry cwd + token totals; messages carry role/content/tool_name.
// Timestamps are float SECONDS — converted to ms for digest fields.
let hermesMemo = { key: '', rows: [] };

function readHermes() {
  if (!DatabaseSync) return [];
  const p = path.join(process.env.HOME || '', '.hermes', 'state.db');
  const ck = dbChangeKey(p);
  if (!ck) return [];
  if (hermesMemo.key === ck.key) return hermesMemo.rows;
  if (hermesMemo.key && Date.now() - ck.hotMs < 8_000) return hermesMemo.rows;
  let db;
  const hermesPhase = mark(PHASE.readHermes);
  try { db = new DatabaseSync(p, { readOnly: true }); } catch { mark(hermesPhase); return hermesMemo.rows; }
  const rows = [];
  try {
    const sessions = db.prepare('select * from sessions').all();
    const qLastUser = db.prepare("select content, timestamp from messages where session_id = ? and role = 'user' and active = 1 order by timestamp desc limit 1");
    const qRole = db.prepare("select count(*) c from messages where session_id = ? and timestamp > ? and role = ?");
    const qTools = db.prepare("select tool_name, count(*) c from messages where session_id = ? and timestamp > ? and tool_name is not null group by 1");
    const qTok = db.prepare("select coalesce(sum(token_count), 0) t from messages where session_id = ? and timestamp > ?");
    const qLastAssistant = db.prepare("select content, timestamp from messages where session_id = ? and role = 'assistant' and content is not null and content != '' and timestamp > ? order by timestamp desc limit 1");
    const qMaxTs = db.prepare('select max(timestamp) t from messages where session_id = ?');
    for (const s of sessions) {
      const st = emptyStats();
      const dg = emptyDigest();
      st.files = 1;
      st.cwd = s.cwd || null;
      st.tokensIn = s.input_tokens || 0;
      st.tokensOut = s.output_tokens || 0;
      st.cacheRead = s.cache_read_tokens || 0;
      st.firstTs = Math.round((Number(s.started_at) || 0) * 1000);
      const maxTs = qMaxTs.get(s.id)?.t;
      st.lastTs = maxTs ? Math.round(Number(maxTs) * 1000) : st.firstTs;
      st.prompts = qRole.get(s.id, 0, 'user').c;
      st.turns = qRole.get(s.id, 0, 'assistant').c;
      for (const t of qTools.all(s.id, 0)) {
        const name = t.tool_name || 'tool';
        st.tools[name] = (st.tools[name] || 0) + t.c;
        st.toolCalls += t.c;
        if (/web|search/i.test(name)) st.web += t.c;
      }
      const lastU = qLastUser.get(s.id);
      const t0 = lastU ? Number(lastU.timestamp) || 0 : 0; // seconds, for queries
      if (lastU) {
        const text = String(lastU.content || '');
        if (text.trim() && !text.trim().startsWith('<')) {
          dg.lastPromptText = clip(text);
          dg.lastPromptRaw = clipRaw(text);
          dg.lastPromptTs = Math.round(t0 * 1000);
        }
        dg.sinceTurns = qRole.get(s.id, t0, 'assistant').c;
        for (const t of qTools.all(s.id, t0)) {
          const name = t.tool_name || 'tool';
          dg.sinceTools[name] = (dg.sinceTools[name] || 0) + t.c;
          dg.sinceToolCalls += t.c;
        }
        dg.sinceTokens = qTok.get(s.id, t0).t || 0;
      }
      const lastA = qLastAssistant.get(s.id, t0);
      if (lastA && lastA.content) {
        dg.lastAssistantText = clip(lastA.content);
        dg.lastAssistantMd = clipRaw(lastA.content);
        dg.lastAssistantTs = Math.round((Number(lastA.timestamp) || 0) * 1000);
      }
      rows.push({ directory: s.cwd || null, parsed: { stats: st, digest: dg } });
    }
  } catch { /* torn read / schema drift: keep previous */ } finally {
    try { db.close(); } catch {}
    mark(hermesPhase);
  }
  hermesMemo = { key: ck.key, rows };
  return rows;
}

// Cap how much of a transcript we load. A long-running agent's .jsonl can grow
// to hundreds of MB; reading it whole (and splitting into a line array) can OOM
// the single process. Above the cap we read only the tail (dropping the partial
// first line), which keeps the "since your last prompt" digest accurate while
// bounding memory — older cumulative totals for that one file become approximate.
const MAX_TRACE_BYTES = 12 * 1024 * 1024;
async function readTraceFile(p, size) {
  if (size <= MAX_TRACE_BYTES) return fsp.readFile(p, 'utf8');
  const fh = await fsp.open(p, 'r');
  try {
    const buf = Buffer.alloc(MAX_TRACE_BYTES);
    await fh.read(buf, 0, MAX_TRACE_BYTES, size - MAX_TRACE_BYTES);
    const s = buf.toString('utf8');
    const nl = s.indexOf('\n');
    return nl >= 0 ? s.slice(nl + 1) : s;
  } finally { await fh.close(); }
}

async function statsFor(p, parser, quietMs = 0) {
  const c = fileCache.get(p);
  const now = Date.now();
  // Dormant transcripts (untouched for a day) skip the stat entirely for a
  // minute at a time: hundreds of FUSE getattr round-trips per rebuild were
  // most of the Overview's first-open wait.
  if (c && c.statAt && now - c.statAt < 60_000 && c.mtimeMs && now - c.mtimeMs > 86_400_000) return c.parsed;
  let m;
  try { m = await fsp.stat(p); } catch { return null; }
  const key = `${m.mtimeMs}:${m.size}`;
  if (c && c.key === key) { c.statAt = now; c.mtimeMs = m.mtimeMs; return c.parsed; }
  // Don't read a file its owner is actively writing. OpenClaw's session fence
  // fingerprints metadata at nanosecond precision, and on the FUSE bucket our
  // reads can disturb what it sees — so while a fence-sensitive file is hot,
  // serve the previous parse and re-read once writes have gone quiet.
  if (quietMs && c && Date.now() - m.mtimeMs < quietMs) return c.parsed;
  // Parsing is synchronous CPU on THE event loop. A big transcript being
  // actively written changes every poll; re-parsing tens of MB once a second
  // starves every other request (blank app). Heavy files therefore re-parse
  // on a duty cycle: at most ~10% of wall time, capped at one parse per 10s.
  if (c && c.cost > 150 && Date.now() - c.at < Math.min(10_000, c.cost * 10)) return c.parsed;
  let parsed;
  const t0 = Date.now();
  try { parsed = parser(await readTraceFile(p, m.size)); } catch { return null; }
  fileCache.set(p, { key, parsed, cost: Date.now() - t0, at: t0, statAt: now, mtimeMs: m.mtimeMs });
  return parsed;
}

// Directory walks (readdir over FUSE) also add up when repeated per rebuild —
// remember each file list briefly. New transcript files appear within 5s.
const listMemo = new Map(); // key -> { ts, val: Promise<string[]> }
function memoList(key, fn) {
  const c = listMemo.get(key);
  if (c && Date.now() - c.ts < 5_000) return c.val;
  const val = fn();
  listMemo.set(key, { ts: Date.now(), val });
  return val;
}

function claudeFiles() {
  return memoList('claude', claudeFilesUncached);
}
async function claudeFilesUncached() {
  const home = process.env.HOME || '';
  const dirs = [process.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), path.join(home, '.config', 'claude')]
    .filter(Boolean).filter((d, i, a) => a.indexOf(d) === i);
  const out = [];
  for (const d of dirs) {
    const proj = path.join(d, 'projects');
    let projects = [];
    try { projects = await fsp.readdir(proj, { withFileTypes: true }); } catch { continue; }
    for (const e of projects) {
      if (!e.isDirectory()) continue;
      let files = [];
      try { files = await fsp.readdir(path.join(proj, e.name)); } catch { continue; }
      for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(proj, e.name, f));
    }
  }
  return out;
}

function codexFiles() {
  return memoList('codex', codexFilesUncached);
}
async function codexFilesUncached() {
  const home = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
  const root = path.join(home, 'sessions');
  const out = [];
  const walk = async (dir, depth) => {
    if (depth > 5) return;
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  await walk(root, 0);
  return out;
}

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/;

// Breadcrumb the whole build so a wedge anywhere in it is attributed to
// 'buildTraces' (the db reads narrow it further to their own phase). tracked()
// restores the prior breadcrumb even if the build throws.
function build() { return tracked(PHASE.buildTraces, buildImpl); }

async function buildImpl() {
  const sessions = store.list();
  const byClaudeUuid = new Map(sessions.filter((s) => s.cli === 'claude' && s.sessionUuid).map((s) => [s.sessionUuid, s]));
  const byCodexId = new Map(sessions.filter((s) => s.codexSessionId).map((s) => [s.codexSessionId, s]));

  const perSession = new Map(); // session id -> aggregate stats
  const digests = new Map();    // session id -> digest of the freshest file
  const other = emptyStats();
  const totals = emptyStats();

  const attribute = (session, parsed) => {
    if (!parsed) return;
    const { stats, digest } = parsed;
    mergeInto(totals, stats);
    if (session) {
      if (!perSession.has(session.id)) perSession.set(session.id, emptyStats());
      mergeInto(perSession.get(session.id), stats);
      const prev = digests.get(session.id);
      if (!prev || stats.lastTs > prev._ts) digests.set(session.id, { ...digest, _ts: stats.lastTs });
    } else {
      mergeInto(other, stats);
    }
  };

  const seenFiles = new Set(); // for fileCache eviction (rotated/deleted transcripts)
  for (const p of await claudeFiles()) {
    seenFiles.add(p);
    const m = path.basename(p).match(UUID_RE);
    attribute(m ? byClaudeUuid.get(m[1]) : null, await statsFor(p, parseClaude));
    await yieldLoop();
  }
  // Codex fallback: sessions created before capture-and-pin have no
  // codexSessionId — attribute their rollouts by cwd when it's unambiguous.
  const byCodexCwd = new Map();
  for (const s of sessions.filter((x) => x.cli === 'codex')) {
    const key = path.resolve(WORKSPACES_DIR, s.path ?? s.id);
    byCodexCwd.set(key, byCodexCwd.has(key) ? 'ambiguous' : s);
  }
  for (const p of await codexFiles()) {
    seenFiles.add(p);
    const parsed = await statsFor(p, parseCodex);
    await yieldLoop();
    if (!parsed) continue;
    if (parsed.stats.subagent) continue; // Codex guardian subagent — not the user's thread
    const m = path.basename(p).match(UUID_RE);
    let session = m ? byCodexId.get(m[1]) : null;
    if (!session && parsed.stats.cwd) {
      const hit = byCodexCwd.get(parsed.stats.cwd);
      if (hit && hit !== 'ambiguous') session = hit;
    }
    attribute(session, parsed);
  }

  // OpenClaw: every pane shares the ONE embedded agent (agent "main"), so its
  // traces belong to the single OpenClaw session when unambiguous, else other.
  const ocSessions = sessions.filter((s) => s.cli === 'openclaw');
  const ocOwner = ocSessions.length === 1 ? ocSessions[0] : null;
  for (const p of await openclawFiles()) {
    seenFiles.add(p);
    // OpenClaw state lives on LOCAL disk now (see entrypoint.sh), so reads no
    // longer risk tripping its metadata fence like on FUSE — keep a small
    // quiet margin anyway since its session fence is unusually touchy.
    attribute(ocOwner, await statsFor(p, parseOpenClaw, 10_000));
    await yieldLoop();
  }
  // Evict cache entries for files that no longer exist (rotated Codex rollouts,
  // deleted transcripts) so fileCache doesn't grow unbounded on a long-lived Space.
  for (const k of fileCache.keys()) if (!seenFiles.has(k)) fileCache.delete(k);

  // opencode: attribute by the PINNED ses_ id first (the runner captures it at
  // launch — see scheduleOpencodeCapture). Two agents in one folder are
  // otherwise indistinguishable: opencode has no per-conversation handle, so a
  // bare directory match marks a shared folder 'ambiguous' and shows nothing.
  // Directory is kept only as a fallback for UNPINNED sessions that hold their
  // folder alone (legacy sessions, dedicated folders).
  const ocRows = readOpencode();
  const ocById = new Map(ocRows.map((r) => [r.sessionId, r]));
  const pinnedIds = new Set(sessions.filter((s) => s.cli === 'opencode' && s.opencodeSessionId).map((s) => s.opencodeSessionId));
  const attributed = new Set();
  for (const s of sessions.filter((x) => x.cli === 'opencode' && x.opencodeSessionId)) {
    const r = ocById.get(s.opencodeSessionId);
    if (r) { attribute(s, r.parsed); attributed.add(r.sessionId); }
  }
  const opencodeByDir = new Map();
  for (const s of sessions.filter((x) => x.cli === 'opencode' && !x.opencodeSessionId)) {
    const key = path.resolve(WORKSPACES_DIR, s.path ?? s.id);
    opencodeByDir.set(key, opencodeByDir.has(key) ? 'ambiguous' : s);
  }
  for (const r of ocRows) {
    if (attributed.has(r.sessionId) || pinnedIds.has(r.sessionId)) continue; // placed by pin, or reserved for one
    const hit = r.directory ? opencodeByDir.get(path.resolve(r.directory)) : null;
    attribute(hit && hit !== 'ambiguous' ? hit : null, r.parsed);
  }

  // Hermes: same story — sessions record their cwd.
  const hermesByDir = new Map();
  for (const s of sessions.filter((x) => x.cli === 'hermes')) {
    const key = path.resolve(WORKSPACES_DIR, s.path ?? s.id);
    hermesByDir.set(key, hermesByDir.has(key) ? 'ambiguous' : s);
  }
  for (const { directory, parsed } of readHermes()) {
    const hit = directory ? hermesByDir.get(path.resolve(directory)) : null;
    attribute(hit && hit !== 'ambiguous' ? hit : null, parsed);
  }

  return { perSession, digests, other, totals, sessions };
}

// Stale-while-revalidate: a build over a large transcript history can take
// longer than the poll interval. Serve the last result INSTANTLY and refresh
// in the background, and never run two builds at once — otherwise every poll
// kicked off a fresh overlapping build and pinned the event loop (the Overview
// lag). The first-ever call (no cached value) awaits the build once.
let building = null;
function memoized() {
  const fresh = resultMemo.val && Date.now() - resultMemo.ts < TTL;
  if (fresh) return resultMemo.val;
  if (!building) {
    building = build()
      .then((v) => { resultMemo = { ts: Date.now(), val: Promise.resolve(v) }; return v; })
      .catch(() => resultMemo.val || Promise.resolve({ perSession: new Map(), digests: new Map(), other: emptyStats(), totals: emptyStats(), sessions: store.list() }))
      .finally(() => { building = null; });
  }
  return resultMemo.val || building;
}

export async function buildTraces() {
  const { perSession, totals, sessions } = await memoized();
  // Every agent session gets a row, traced or not; files that belong to no
  // live session (deleted panes, ambiguous attribution) only show in totals.
  return {
    sessions: sessions
      .filter((s) => s.cli !== 'shell' && !PASSIVE_CLIS.includes(s.cli))
      .map((s) => ({ id: s.id, name: s.name, cli: s.cli, path: s.path, ...(perSession.get(s.id) || emptyStats()) }))
      .sort((a, b) => b.lastTs - a.lastTs),
    totals,
    generatedAt: new Date().toISOString(),
  };
}

/** Per-session "since your last prompt" digests, keyed by session id. */
export async function traceDigests() {
  const { digests } = await memoized();
  return digests;
}

/** Targeted digest for ONE session — parses only its own transcript files so
 *  the Overview can fill tiles progressively instead of waiting for the full
 *  build. Cheap for Claude (transcript filename == sessionUuid) and Codex (the
 *  pinned rollout); db-backed CLIs return null and ride the bulk pass. Parsed
 *  files land in the shared per-file cache, so nothing is read twice. */
export async function digestFor(s) {
  try {
    if (s.cli === 'claude' && s.sessionUuid) {
      let best = null;
      for (const p of await claudeFiles()) {
        if (!path.basename(p).includes(s.sessionUuid)) continue;
        const parsed = await statsFor(p, parseClaude);
        if (parsed && (!best || parsed.stats.lastTs > best.stats.lastTs)) best = parsed;
      }
      return best ? best.digest : null;
    }
    if (s.cli === 'codex' && s.codexRollout && fs.existsSync(s.codexRollout)) {
      const parsed = await statsFor(s.codexRollout, parseCodex);
      if (parsed && !parsed.stats.subagent) return parsed.digest;
    }
  } catch { /* fall through to the bulk pass */ }
  return null;
}

// ---------- Trace panel: ONE session, read in full, on demand ----------
// Deliberately NOT part of buildTraces()/traceDigests(): those walk every
// session on a ~1Hz poll and memoize per file, so making them retain turns
// would balloon memory across the whole Space (spec §2). This path is only
// entered when a Trace panel is open, and it memoizes exactly ONE session.
//
// Shape borrowed from the Hub's trace viewer (moon-landing
// server/lib/datasets/trace/): every harness normalizes into the same
// `{ role, blocks[] }` message, and the renderer only ever knows about block
// types — never about harnesses. Adding a harness = one normalizer, zero UI
// changes. See the notes on `stitchTool` below for why results are blocks
// inside a message rather than a `toolResult` field on the turn.
//
// Message = {
//   role: 'user' | 'assistant' | 'system',
//   kind?: 'final' | 'update',            // codex: only 'final' is the answer
//   ts?: number,                          // epoch ms
//   model?: string,
//   usage?: { in, out, cacheRead },
//   blocks: Block[],
// }
// Block =
//   | { type:'text',        text, more? }
//   | { type:'thinking',    text, more? }
//   | { type:'tool_use',    id?, name, text, more? }    // text = serialized args
//   | { type:'tool_result', id?, text, more?, failed? }
//   | { type:'shell',       command, stdout?, stderr?, exitCode? }
//   | { type:'image',       src, mediaType? }
//   | { type:'compaction',  text }
//
// `more` = number of characters dropped, so the UI can say "+412 KB more"
// instead of pretending it has the whole thing.

const VIEW_BLOCK_CAP = 20_000;      // chars retained per block (spec §10 Q3)
const VIEW_MAX_MESSAGES = 20_000;   // hard stop; a 6 MB session is ~40k lines
const VIEW_YIELD_LINES = 2_000;     // hand the loop back every N lines
let viewMemo = { key: '', val: null }; // exactly one session at a time

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function capText(value, cap = VIEW_BLOCK_CAP) {
  const t = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) || '';
  return t.length <= cap ? { text: t } : { text: t.slice(0, cap), more: t.length - cap };
}
const textBlock = (type, value) => ({ type, ...capText(value) });

// The bucket mount serves stale directory listings: a file written seconds ago
// can read as absent (spec §2). Retry before believing it.
async function statRetry(p, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { return await fsp.stat(p); } catch { if (i < tries - 1) await sleep(150); }
  }
  return null;
}

// ---------- tool-result stitching ----------
// Parallel tool calls finish out of order, so a result can arrive several lines
// after a *later* call was already recorded — and in Claude transcripts results
// arrive on a different line (a `type:'user'` line) entirely. Keying results by
// tool_use_id and inserting them next to their call is what makes the collapsed
// "3 tool calls (Bash, Read)" group renderable at all. This is the single most
// valuable thing to copy from the Hub viewer (ToolResultStitcher in
// lib/datasets/trace/utils.ts); a `toolResult` field on the turn cannot express
// it.
function makeStitcher() {
  const byId = new Map(); // toolCallId -> { msg, useBlock }
  return {
    register(useBlock, msg) { if (useBlock.id) byId.set(useBlock.id, { msg, useBlock }); },
    /** true if filed next to its call; false if the call was never seen. */
    file(id, resultBlock) {
      const hit = id ? byId.get(id) : null;
      if (!hit) return false;
      const at = hit.msg.blocks.indexOf(hit.useBlock);
      if (at === -1) { hit.msg.blocks.push(resultBlock); return true; }
      let i = at + 1;
      while (i < hit.msg.blocks.length && hit.msg.blocks[i].type === 'tool_result') i++;
      hit.msg.blocks.splice(i, 0, resultBlock);
      return true;
    },
  };
}

// ---------- line-oriented harnesses ----------
async function* jsonLines(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let n = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      yield j;
      // readline is stream-driven so the loop already breathes, but a long run
      // of tiny lines can still hog a tick.
      if (++n % VIEW_YIELD_LINES === 0) await yieldLoop();
    }
  } finally { rl.close(); }
}

// Claude Code — $CLAUDE_CONFIG_DIR/projects/<slug>/<uuid>.jsonl
// Streaming writes the SAME message.id across several lines, each carrying the
// same usage. parseClaude() above dedupes by dropping repeats; a viewer must
// instead MERGE them, or half the assistant text disappears. So: first line for
// an id creates the message and owns the usage, later lines append blocks.
async function normalizeClaude(file, out) {
  const stitch = makeStitcher();
  const byMsgId = new Map();
  for await (const j of jsonLines(file)) {
    // These embed whole file contents; share.js drops them and so do we.
    if (j.type === 'file-history-snapshot' || j.type === 'file-history-delta') continue;
    if (j.isMeta || j.sourceToolUseID) continue;
    if (j.type !== 'user' && j.type !== 'assistant') continue;

    const m = j.message;
    if (!m) continue;
    const ts = j.timestamp ? Date.parse(j.timestamp) || undefined : undefined;
    if (!out.cwd && j.cwd) out.cwd = j.cwd;

    const id = j.type === 'assistant' ? m.id || j.uuid : null;
    let msg = id ? byMsgId.get(id) : undefined;
    const fresh = !msg;
    if (!msg) {
      msg = { role: j.type, ts, blocks: [] };
      if (j.type === 'assistant') {
        if (m.model) { msg.model = m.model; out.model = m.model; }
        const u = m.usage;
        if (u) {
          msg.usage = {
            in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
            out: u.output_tokens || 0,
            cacheRead: u.cache_read_input_tokens || 0,
          };
        }
      }
    }

    const content = m.content;
    const items = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const c of items) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'text') {
        const t = String(c.text || '');
        if (!t.trim()) continue;
        // Injected environment/reminder blobs are not prompts — show them, but
        // as system so the conversation reads correctly (same rule the digest
        // uses to avoid counting them).
        if (j.type === 'user' && (t.startsWith('<') || t.startsWith('[Request interrupted'))) {
          out.push({ role: 'system', ts, blocks: [textBlock('text', t)] });
          continue;
        }
        msg.blocks.push(textBlock('text', t));
      } else if (c.type === 'thinking' && String(c.thinking || '').trim()) {
        msg.blocks.push(textBlock('thinking', c.thinking));
      } else if (c.type === 'tool_use') {
        const use = { type: 'tool_use', id: c.id, name: c.name || 'tool', ...capText(c.input) };
        msg.blocks.push(use);
        stitch.register(use, msg);
      } else if (c.type === 'tool_result') {
        const res = {
          type: 'tool_result', id: c.tool_use_id,
          failed: !!c.is_error,
          ...capText(flattenToolContent(c.content)),
        };
        if (!stitch.file(c.tool_use_id, res)) msg.blocks.push(res);
      } else if (c.type === 'image' && c.source?.data) {
        msg.blocks.push({ type: 'image', src: dataUrl(c.source.data, c.source.media_type), mediaType: c.source.media_type });
      }
    }

    if (!msg.blocks.length) continue;
    if (fresh) {
      out.push(msg);
      if (id) byMsgId.set(id, msg);
    }
  }
}

// Codex — $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// Everything under `payload`. token_count is CUMULATIVE per run, so it is
// attached to the session header, not to a turn. `task_complete` carries the
// authoritative final answer, and response_item messages are intermediate:
// that distinction is `kind: 'final' | 'update'` (the Hub calls it
// assistantKind and greys out non-final assistant text).
async function normalizeCodex(file, out) {
  const stitch = makeStitcher();
  for await (const j of jsonLines(file)) {
    const p = j.payload || {};
    const ts = j.timestamp ? Date.parse(j.timestamp) || undefined : undefined;

    if (j.type === 'session_meta') {
      if (p.thread_source === 'subagent' || p.source?.subagent) {
        const err = new Error('this rollout is an internal guardian/subagent thread, not the session');
        err.code = 'trace-not-user-conversation';
        throw err;
      }
      out.cwd = p.cwd || out.cwd;
      continue;
    }

    if (j.type === 'response_item') {
      if (p.type === 'message') {
        const text = Array.isArray(p.content) ? p.content.map((c) => (c && c.text) || '').join('') : '';
        if (!text.trim()) continue;
        // codex wraps environment/instruction blobs as role:'user' items whose
        // text starts with '<'.
        const isEnv = p.role === 'user' && text.trim().startsWith('<');
        out.push({
          role: isEnv ? 'system' : p.role === 'assistant' ? 'assistant' : 'user',
          kind: p.role === 'assistant' ? 'update' : undefined,
          ts, blocks: [textBlock('text', text)],
        });
      } else if (p.type === 'reasoning') {
        const text = Array.isArray(p.summary) ? p.summary.map((s) => (s && s.text) || '').join('\n') : String(p.text || '');
        if (text.trim()) out.push({ role: 'assistant', kind: 'update', ts, blocks: [textBlock('thinking', text)] });
      } else if (['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call'].includes(p.type)) {
        // Codex writes a call and its output as two separate top-level items, so
        // without stitching every call and every result becomes its own row and
        // nothing ever folds into a "2 tool calls (shell)" group.
        const use = { type: 'tool_use', id: p.call_id || p.id, name: p.name || p.type, ...capText(p.arguments ?? p.input) };
        const msg = { role: 'assistant', ts, blocks: [use] };
        out.push(msg);
        stitch.register(use, msg);
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const res = { type: 'tool_result', id: p.call_id, ...capText(flattenToolContent(p.output)) };
        if (!stitch.file(res.id, res)) out.push({ role: 'assistant', ts, blocks: [res] });
      }
      continue;
    }

    if (j.type === 'event_msg') {
      if (p.type === 'token_count') {
        const u = p.info?.total_token_usage;
        if (u) {
          out.usage = {
            in: Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)),
            out: u.output_tokens || 0,
            cacheRead: u.cached_input_tokens || 0,
          };
        }
      } else if (p.type === 'task_complete' && String(p.last_agent_message || '').trim()) {
        out.push({ role: 'assistant', kind: 'final', ts, blocks: [textBlock('text', p.last_agent_message)] });
      }
      continue;
    }
  }
}

// OpenClaw — already close to STS: {type:'message', message:{role,content,usage}}
async function normalizeOpenClaw(file, out) {
  const stitch = makeStitcher();
  for await (const j of jsonLines(file)) {
    if (j.type !== 'message' || !j.message) continue;
    const m = j.message;
    const ts = j.timestamp ? Date.parse(j.timestamp) || undefined : undefined;
    const msg = { role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', ts, blocks: [] };
    const u = m.usage;
    if (u) msg.usage = { in: Math.max(0, (u.input || 0) - (u.cacheRead || 0)), out: u.output || 0, cacheRead: u.cacheRead || 0 };

    if (typeof m.content === 'string') {
      if (m.content.trim()) msg.blocks.push(textBlock('text', m.content));
    } else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (!c || typeof c !== 'object') continue;
        if (typeof c.type === 'string' && /tool/i.test(c.type)) {
          if (/result|output/i.test(c.type)) {
            const res = { type: 'tool_result', id: c.toolCallId || c.id, ...capText(flattenToolContent(c.output ?? c.content ?? c.text)) };
            if (!stitch.file(res.id, res)) msg.blocks.push(res);
          } else {
            const use = { type: 'tool_use', id: c.id, name: c.name || c.toolName || 'tool', ...capText(c.input) };
            msg.blocks.push(use);
            stitch.register(use, msg);
          }
        } else if (c.type === 'thinking' && String(c.thinking || c.text || '').trim()) {
          msg.blocks.push(textBlock('thinking', c.thinking || c.text));
        } else if (c.text) {
          msg.blocks.push(textBlock('text', c.text));
        }
      }
    }
    if (msg.blocks.length) out.push(msg);
  }
}

// STS (Session Trace Simple Format) — what share-session.mjs emits for the
// converted harnesses, so accepted bundles from hermes/opencode/openclaw come
// back through this one reader.
async function normalizeSts(file, out) {
  const stitch = makeStitcher();
  for await (const j of jsonLines(file)) {
    if (j.type === 'session') {
      out.harnessLabel = label(j.harness) || out.harnessLabel;
      out.sessionId = j.id || out.sessionId;
      out.title = j.name || out.title; // the sender's name for the session
      continue;
    }
    if (j.type !== 'message' || !j.message) continue;
    const m = j.message;
    const msg = {
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : m.role === 'tool' ? 'assistant' : 'user',
      ts: typeof m.timestamp === 'number' ? m.timestamp : undefined,
      blocks: [],
    };
    if (m.role === 'tool') {
      const res = { type: 'tool_result', id: m.toolCallId, ...capText(m.content) };
      if (stitch.file(m.toolCallId, res)) continue;
      msg.blocks.push(res);
    } else if (String(m.content || '').trim()) {
      msg.blocks.push(textBlock('text', m.content));
    }
    for (const t of m.toolCalls || []) {
      const use = { type: 'tool_use', id: t.id, name: t.function?.name || 'tool', ...capText(t.function?.arguments) };
      msg.blocks.push(use);
      stitch.register(use, msg);
    }
    if (msg.blocks.length) out.push(msg);
  }
}

// ---------- SQLite harnesses ----------
// One conversation, selected by id. NEVER copy the db: opencode's holds
// account.access_token / refresh_token (spec §6). Read-only, off the hot path.
function normalizeOpencodeDb(dbPath, sessionId, out) {
  if (!DatabaseSync) { const e = new Error('node:sqlite unavailable'); e.code = 'unsupported-harness'; throw e; }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const s = db.prepare('select * from session where id = ?').get(sessionId);
    if (!s) return;
    out.cwd = s.directory || null;
    out.usage = { in: s.tokens_input || 0, out: s.tokens_output || 0, cacheRead: s.tokens_cache_read || 0 };
    out.title = s.title || out.title;
    // `model` is a JSON blob ({id, providerID, variant}), not a string — the id
    // is what belongs on the header chip.
    try { const mm = JSON.parse(s.model || 'null'); out.model = (mm && mm.id) || (typeof s.model === 'string' ? s.model : null); } catch { out.model = s.model || null; }
    const parts = db.prepare('select * from part where message_id = ? order by time_created');
    for (const m of db.prepare('select * from message where session_id = ? order by time_created').all(sessionId)) {
      let md = {}; try { md = JSON.parse(m.data || '{}'); } catch {}
      const msg = { role: md.role === 'assistant' ? 'assistant' : 'user', ts: Number(m.time_created) || undefined, blocks: [] };
      for (const part of parts.all(m.id)) {
        let pd = {}; try { pd = JSON.parse(part.data || '{}'); } catch {}
        if (pd.type === 'text' && pd.text) msg.blocks.push(textBlock('text', pd.text));
        else if (pd.type === 'reasoning' && (pd.text || pd.reasoning)) msg.blocks.push(textBlock('thinking', pd.text || pd.reasoning));
        else if (pd.type === 'tool') {
          const id = part.id;
          msg.blocks.push({ type: 'tool_use', id, name: pd.tool || 'tool', ...capText(pd.state?.input ?? pd.input) });
          const res = pd.state?.output ?? pd.output;
          if (res != null) msg.blocks.push({ type: 'tool_result', id, ...capText(res) });
        }
      }
      if (msg.blocks.length) out.push(msg);
    }
  } finally { try { db.close(); } catch {} }
}

// hermes — flat content; `timestamp` is SECONDS. A row with tool_name set is a
// tool interaction, which we render as a call + its result so it collapses into
// the same tool group as every other harness.
function normalizeHermesDb(dbPath, sessionId, out) {
  if (!DatabaseSync) { const e = new Error('node:sqlite unavailable'); e.code = 'unsupported-harness'; throw e; }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const s = db.prepare('select * from sessions where id = ?').get(sessionId);
    if (!s) return;
    out.cwd = s.cwd || null;
    out.title = s.title || out.title;
    out.usage = { in: s.input_tokens || 0, out: s.output_tokens || 0, cacheRead: s.cache_read_tokens || 0 };
    const rows = db.prepare('select * from messages where session_id = ? order by timestamp').all(sessionId);
    for (const m of rows) {
      const ts = m.timestamp != null ? Math.round(Number(m.timestamp) * 1000) : undefined;
      if (m.tool_name) {
        out.push({
          role: 'assistant', ts,
          blocks: [
            { type: 'tool_use', id: `t${m.id}`, name: m.tool_name, ...capText('{}') },
            { type: 'tool_result', id: `t${m.id}`, ...capText(m.content) },
          ],
        });
        continue;
      }
      const text = String(m.content || '');
      if (!text.trim()) continue;
      out.push({
        role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
        ts, blocks: [textBlock('text', text)],
      });
    }
  } finally { try { db.close(); } catch {} }
}

// ---------- shared helpers ----------
const dataUrl = (b64, mediaType) => `data:${mediaType || 'image/png'};base64,${b64}`;

// "harness" is a bare string on an STS session line but an OBJECT
// ({id,name,version}) in a bundle manifest. Both reach harnessLabel, which the
// pane header renders directly — and React throws on an object child. Coerce.
function label(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v.name || v.id || null;
}

// Tool results arrive as a string, a content-block array, or an object.
function flattenToolContent(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((c) => (typeof c === 'string' ? c : c && typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
  }
  if (typeof value === 'object' && typeof value.text === 'string') return value.text;
  return JSON.stringify(value, null, 2);
}

// Bundles have no session record telling us the harness, so sniff the first
// lines — same trick as the Hub's detect.ts / sniffTraceHarness.
async function sniffHarness(file) {
  let n = 0;
  for await (const j of jsonLines(file)) {
    if (j.type === 'session' && j.harness) return 'sts';
    if (j.type === 'session_meta' || j.payload) return 'codex';
    if (j.type === 'file-history-snapshot' || ((j.type === 'user' || j.type === 'assistant') && j.message)) return 'claude';
    if (j.type === 'message' && j.message) return 'openclaw';
    if (++n >= 8) break;
  }
  return null;
}

function newTrace(harness) {
  const t = {
    harness, harnessLabel: HARNESS_LABEL[harness] || harness, sessionId: null, title: '', model: null, cwd: null,
    firstTs: 0, lastTs: 0, usage: null, usageSum: null, messages: [],
    push(msg) {
      if (this.messages.length >= VIEW_MAX_MESSAGES) { this.truncated = true; return; }
      if (msg.ts) {
        if (!this.firstTs || msg.ts < this.firstTs) this.firstTs = msg.ts;
        if (msg.ts > this.lastTs) this.lastTs = msg.ts;
      }
      // Claude and OpenClaw record usage per assistant message and nowhere else,
      // so the session total has to be summed here. Safe against the duplicate
      // message.id lines because usage lands only on the first one.
      const u = msg.usage;
      if (u) {
        const s = this.usageSum || (this.usageSum = { in: 0, out: 0, cacheRead: 0 });
        s.in += u.in || 0; s.out += u.out || 0; s.cacheRead += u.cacheRead || 0;
      }
      this.messages.push(msg);
    },
  };
  return t;
}

async function parseTraceFile(harness, file, sessionId) {
  const out = newTrace(harness);
  out.sessionId = sessionId || null;
  switch (harness) {
    case 'claude': await normalizeClaude(file, out); break;
    case 'codex': await normalizeCodex(file, out); break;
    case 'openclaw': await normalizeOpenClaw(file, out); break;
    case 'sts': await normalizeSts(file, out); break;
    case 'opencode': normalizeOpencodeDb(file, sessionId, out); break;
    case 'hermes': normalizeHermesDb(file, sessionId, out); break;
    default: { const e = new Error(`no trace reader for '${harness}'`); e.code = 'unsupported-harness'; throw e; }
  }
  // A harness that reports its own session total (codex's cumulative
  // token_count, the db-backed session rows) wins; otherwise use the sum of the
  // per-turn numbers.
  if (!out.usage) out.usage = out.usageSum;
  return out;
}

function pageOf(parsed, offset, limit) {
  const total = parsed.messages.length;
  const from = Math.max(0, Math.min(offset | 0, total));
  const to = Math.min(total, from + Math.max(1, Math.min(limit | 0 || 200, 500)));
  return {
    harness: parsed.harness, harnessLabel: parsed.harnessLabel, sessionId: parsed.sessionId,
    title: parsed.title, model: parsed.model, cwd: parsed.cwd,
    firstTs: parsed.firstTs, lastTs: parsed.lastTs, usage: parsed.usage,
    total, offset: from, limit: to - from, truncated: !!parsed.truncated,
    turns: parsed.messages.slice(from, to),
  };
}

/**
 * Read one session's trace, paginated. `session` is an Agent Manager session
 * record; locating the file is delegated to findTrace() in share.js, which
 * already handles all five harnesses, per-session pins, cwd attribution,
 * ambiguity refusal and codex subagent rollouts. Do not reimplement it.
 */
export async function readTrace(session, { offset = 0, limit = 200 } = {}) {
  const hit = await findTrace(session, store.list());
  if (!hit) { const e = new Error('no trace found for this session'); e.code = 'no-trace'; throw e; }

  const st = await statRetry(hit.src);
  if (!st) { const e = new Error(`trace file unreadable: ${hit.src}`); e.code = 'no-trace'; throw e; }

  const key = `s:${session.id}:${hit.src}:${hit.sessionId || ''}:${st.mtimeMs}:${st.size}`;
  if (viewMemo.key !== key) {
    const parsed = await tracked(PHASE.readTrace, () =>
      parseTraceFile(session.cli, hit.src, hit.sessionId || session.sessionUuid || null));
    viewMemo = { key, val: parsed };
  }
  return pageOf(viewMemo.val, offset, limit);
}

/**
 * Read an accepted incoming bundle: DATA_DIR/traces/<envelopeId>/<name>.jsonl
 * plus meta/. The harness is sniffed from the file, since a bundle carries
 * whatever format the sender's harness ships.
 */
export async function readTraceBundle(dir, { offset = 0, limit = 200 } = {}) {
  const names = (await fsp.readdir(dir).catch(() => [])).filter((n) => n.endsWith('.jsonl'));
  if (!names.length) { const e = new Error('bundle has no trace file'); e.code = 'no-trace'; throw e; }
  const file = path.join(dir, names[0]);
  const st = await statRetry(file);
  if (!st) { const e = new Error('bundle trace unreadable'); e.code = 'no-trace'; throw e; }

  const key = `b:${file}:${st.mtimeMs}:${st.size}`;
  if (viewMemo.key !== key) {
    const harness = await sniffHarness(file);
    if (!harness) { const e = new Error('unrecognized trace format'); e.code = 'unsupported-harness'; throw e; }
    const parsed = await tracked(PHASE.readTrace, () => parseTraceFile(harness, file, null));
    let manifest = null;
    try { manifest = JSON.parse(await fsp.readFile(path.join(dir, 'meta', 'manifest.json'), 'utf8')); } catch {}
    // The manifest is the sender's own description of the bundle
    // (scripts/share-session.mjs writes it) and knows things the trace lines
    // don't: which harness produced it, what the sender called the session, the
    // working directory, and the session totals. Field names follow that
    // manifest, not this reader's shape — `harness` is an object there.
    if (manifest) {
      parsed.harnessLabel = label(manifest.harness) || parsed.harnessLabel;
      parsed.title = (manifest.session && manifest.session.name) || parsed.title;
      parsed.sessionId = parsed.sessionId || (manifest.session && manifest.session.uuid) || null;
      const s = manifest.stats || {};
      parsed.cwd = parsed.cwd || s.cwd || null;
      if (!parsed.usage && (s.tokensIn || s.tokensOut || s.cacheRead)) {
        parsed.usage = { in: s.tokensIn || 0, out: s.tokensOut || 0, cacheRead: s.cacheRead || 0 };
      }
    }
    viewMemo = { key, val: parsed };
  }
  return pageOf(viewMemo.val, offset, limit);
}
