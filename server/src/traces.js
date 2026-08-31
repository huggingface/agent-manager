import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import * as store from './sessions.js';
import { WORKSPACES_DIR, PASSIVE_CLIS, isRemote } from './config.js';
import { remoteDigest } from './remote.js';
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

// Fallback discovery for installations where the exact-event plugin is absent:
// newest opencode conversation in `directory` created at/after `sinceMs` and
// not already claimed by another session. This is deliberately used only for
// unshared folders; same-folder panes cannot safely attribute a newest row.
// Read straight from the db so a just-created session is seen immediately.
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

// Does a pinned opencode conversation still exist? The launch line resumes by id
// (`opencode --session <ses_…>`), and opencode exits 1 with "Session not found"
// the moment the row is gone — verified on 1.18.9 — which would kill the pane on
// sight. So the pin is checked here, before it can reach the shell: a purged
// conversation starts fresh instead, the same honest fallback the Claude
// transcript check and the codex rollout check give.
export function opencodeSessionExists(id) {
  if (!DatabaseSync || !id) return false;
  let db;
  try { db = new DatabaseSync(opencodeDbPath(), { readOnly: true }); } catch { return false; }
  try {
    return !!db.prepare('select 1 from session where id = ?').get(id);
  } catch { return false; } finally { try { db.close(); } catch {} }
}

// Exact row metadata for a session id reported by the opencode plugin. The
// plugin tells us which id the pane is using; the database remains the local
// authority for its folder and whether it is a root conversation rather than a
// task/subagent child.
export function opencodeSessionInfo(id) {
  if (!DatabaseSync || !id) return null;
  let db;
  try { db = new DatabaseSync(opencodeDbPath(), { readOnly: true }); } catch { return null; }
  try {
    const row = db.prepare(
      'select id, directory, parent_id as parentId from session where id = ?',
    ).get(id);
    return row ? { id: row.id, directory: row.directory || null, parentId: row.parentId || null } : null;
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
      // Remote agents are excluded on purpose: their tokens are spent by a
      // harness on the operator's own machine, so counting them here would
      // inflate this Space's usage with numbers we never paid and cannot see.
      .filter((s) => s.cli !== 'shell' && !PASSIVE_CLIS.includes(s.cli) && !isRemote(s.cli))
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
    // A remote agent's conversation IS its message folder — nothing to parse,
    // and no transcript on this machine to find.
    if (isRemote(s.cli)) return remoteDigest(s);
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

/** Where this session's raw conversation trace lives on disk, so an agent (or
 *  the operator) can read it directly at whatever depth it wants instead of
 *  asking us to summarize. Only the CLIs whose conversation we can pin down to
 *  ONE session get a location; the rest return null rather than a path that
 *  might belong to a sibling. */
export async function traceLocation(s) {
  try {
    if (s.cli === 'claude' && s.sessionUuid) {
      for (const p of await claudeFiles()) {
        if (path.basename(p).includes(s.sessionUuid)) return { format: 'jsonl', path: p };
      }
      return null;
    }
    if (s.cli === 'codex' && s.codexRollout && fs.existsSync(s.codexRollout)) {
      return { format: 'jsonl', path: s.codexRollout };
    }
    if (s.cli === 'opencode' && s.opencodeSessionId) {
      const p = opencodeDbPath();
      if (fs.existsSync(p)) return { format: 'sqlite', path: p, sessionId: s.opencodeSessionId };
    }
  } catch {}
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
// `range` (optional) reads only a BYTE WINDOW of the file — see the window
// reader below. Without it the whole file streams through, which is what the
// index-mode readers and the summary pass still want.
async function* jsonLines(file, range = null) {
  if (range) { yield* rangeJsonLines(file, range); return; }
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

// Bytes [from, to) of a file, as one buffer. Callers bound the span themselves
// (WINDOW_MAX_BYTES), so this never has to stream.
async function rangeBuf(file, from, to) {
  const len = Math.max(0, to - from);
  if (!len) return Buffer.alloc(0);
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, from);
    return bytesRead === len ? buf : buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

// One byte window of a .jsonl, aligned to line boundaries.
//
// `range` is { from, to, aligned, eof } and is FILLED IN with the { start, end }
// this actually consumed, which is what the client gets back as a cursor:
//   - a window that begins mid-line drops that fragment — the window BEFORE it
//     ends at `start` and owns that line, so nothing is read twice or lost;
//   - a file being appended to right now ends in a half-written line, which is
//     nobody's yet: `end` stops before it, and the next `after: end` picks it up
//     once it is whole.
// Line splitting happens on the BUFFER, not on decoded text: an arbitrary byte
// offset can cut a UTF-8 character in half, and offsets derived from the decoded
// string would then be a byte or two off — enough to corrupt the next cursor.
async function* rangeJsonLines(file, range) {
  const buf = range.buf || await rangeBuf(file, range.from, range.to);
  let i = 0;
  if (!range.aligned) {
    const nl = buf.indexOf(0x0a);
    i = nl < 0 ? buf.length : nl + 1;
  }
  range.start = range.from + i;
  range.end = range.start;
  let n = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    const last = nl < 0;
    // Mid-file, an unterminated tail belongs to the next window.
    if (last && !range.eof) break;
    const line = buf.toString('utf8', i, last ? buf.length : nl);
    i = last ? buf.length : nl + 1;
    let j = null;
    let whole = false;
    if (line.trim()) { try { j = JSON.parse(line); whole = true; } catch { whole = false; } }
    // A newline ends a line whether or not we could read it. The FINAL line of a
    // file has no newline to prove it is finished, so it counts as consumed only
    // if it parses: a transcript can legitimately end without a newline, and an
    // agent halfway through writing one looks exactly the same until it does.
    if (!last || whole) range.end = range.from + i;
    if (!whole) continue;
    yield j;
    if (++n % VIEW_YIELD_LINES === 0) await yieldLoop();
  }
}

// Claude Code — $CLAUDE_CONFIG_DIR/projects/<slug>/<uuid>.jsonl
// Streaming writes the SAME message.id across several lines, each carrying the
// same usage. parseClaude() above dedupes by dropping repeats; a viewer must
// instead MERGE them, or half the assistant text disappears. So: first line for
// an id creates the message and owns the usage, later lines append blocks.
// A prompt typed while the agent is mid-turn is not written as a `user` message
// at all. Claude Code queues it:
//   {"type":"queue-operation","operation":"enqueue","content":"<the prompt>"}
// and the text exists NOWHERE else until the queue is consumed. Two things then
// happen, and they need opposite treatment:
//   - `dequeue` (86 of 91 in the reference transcript): the prompt arrives as an
//     ordinary user message afterwards, so the queued copy must give way to it
//     or the reader shows the same prompt twice;
//   - `remove` (5 of 91): it never arrives. The queue record is the only copy
//     there will ever be — which is why those prompts were invisible in the
//     reader, permanently, not late.
// The two paths are distinguishable from the records alone, which matters
// because a window can contain the enqueue and not the message that follows it:
// `dequeue` carries no content and pops the oldest queued prompt (the real
// message is coming, so the queued copy stands down), while `remove` names the
// text it takes out (nothing else will carry it, so the queued copy is what the
// reader gets). Text matching against later messages was the first attempt and
// it double-rendered a prompt the operator had queued eight times in a loop:
// the window held six enqueues and two of the messages.
const queueKey = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// The same filter the rest of this file applies to user text: an enqueued
// `<task-notification>` is the harness talking to itself, not something the
// operator typed. One of the five removes in the reference transcript is exactly
// that, and showing it as a prompt would be a new bug in place of the old one.
const isHarnessText = (t) => t.startsWith('<') || t.startsWith('[Request interrupted');

async function normalizeClaude(file, out, range) {
  const stitch = makeStitcher();
  const byMsgId = new Map();
  const pending = [];   // queued prompts, oldest first, until dequeued or removed
  for await (const j of jsonLines(file, range)) {
    // These embed whole file contents; share.js drops them and so do we.
    if (j.type === 'file-history-snapshot' || j.type === 'file-history-delta') continue;
    // `isMeta` is the harness talking to itself, and dropped — with one
    // exception, added for the reader's sub-agent strip: a `task-notification`
    // is the ONLY record that says a sub-agent finished, and what it handed
    // back. In a sub-agent's own transcript (CLI 2.1.209) those records carry
    // isMeta, while in a parent's they do not, so dropping them meant a
    // sub-agent that spawned sub-agents could never show any of them as done.
    // It still renders as a `system` turn, which the reader does not draw.
    if ((j.isMeta || j.sourceToolUseID) && j.origin?.kind !== 'task-notification') continue;
    if (j.type === 'queue-operation') {
      const text = queueKey(j.content);
      if (j.operation === 'enqueue') {
        // Harness noise is not a prompt: one of the five removes in the
        // reference transcript is an enqueued <task-notification>, and showing
        // that as something the operator typed would be a new bug for an old one.
        if (!text || isHarnessText(text)) continue;
        const msg = {
          role: 'user',
          ts: j.timestamp ? Date.parse(j.timestamp) || undefined : undefined,
          queued: true,
          blocks: [textBlock('text', String(j.content))],
        };
        out.push(msg);
        pending.push({ text, msg });
        msg.superseded = true;   // until a `remove` proves it is the only copy
      } else if (j.operation === 'dequeue') {
        // popped into a request: the ordinary user message is on its way, and
        // that one keeps the prompt. Positional, because dequeue names no text.
        pending.shift();
      } else if (j.operation === 'remove') {
        const at = pending.findIndex((p) => p.text === text);
        if (at >= 0) pending.splice(at, 1)[0].msg.superseded = false;
      }
      continue;
    }
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
        // `[SYSTEM NOTIFICATION - NOT USER INPUT]` is how CLI 2.1.209 opens a
        // task-notification inside a SUB-AGENT's transcript, where the parent's
        // copy opens with the tag itself. It says so on the tin; without it in
        // this list the record reads as something the operator typed, and the
        // reader would open a new exchange with harness noise in the prompt band.
        if (j.type === 'user' && (t.startsWith('<') || t.startsWith('[Request interrupted') || t.startsWith('[SYSTEM NOTIFICATION'))) {
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
  // Dropped at the end rather than never pushed: which path a queued prompt took
  // is not known until its dequeue or remove has been read. Anything still
  // pending when the window ends stays dropped — it is about to be dequeued, and
  // the message that follows is the copy the reader should have.
  if (out.messages.some((m) => m.superseded)) {
    out.messages = out.messages.filter((m) => !m.superseded);
  }
  for (const m of out.messages) delete m.superseded;
}

// Codex — $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// Everything is under `payload`, and the same content appears in TWO streams:
// `response_item` (what was sent to/from the model) and `event_msg` (what the TUI
// showed). Reading both naively double-counts; reading only one loses content.
// Verified against a real 393-line rollout:
//
//   - every `event_msg/task_complete.last_agent_message` was byte-identical to
//     the preceding `response_item` assistant message. It is a POINTER to the
//     final answer, not an extra one — so it marks a message, never emits one.
//   - `event_msg/agent_message` (27) duplicated the assistant `response_item`s
//     exactly: ignored.
//   - `event_msg/agent_reasoning` held 4 readable texts that appear NOWHERE in
//     the `response_item` reasoning summaries, so both are read and deduped.
//     49 of 56 reasoning items carry only `encrypted_content` and no readable
//     summary at all; those are counted, not invented.
//   - web searches exist only as `event_msg/web_search_end` (no
//     `web_search_call` response item), so that is where they are read from.
//   - `info.last_token_usage` is PER TURN; `total_token_usage` is cumulative.
//     Both are used: the turn gets its own, the session header gets the total.
//   - the model is in `turn_context.model`, not in `session_meta`.
//
// GROUPING: an assistant TEXT opens a turn, and the tool calls that follow
// attach to it — so one row reads "text + 16 tool calls (exec_command,
// apply_patch, write_stdin)" the way the Hub's own viewer shows it, instead of
// 17 separate rows.
async function normalizeCodex(file, out, range, allowSubagent = false) {
  // Where this sub-agent's OWN conversation starts.
  //
  // A codex sub-agent is spawned with `fork_turns: "all"`, so its rollout opens
  // with the whole parent conversation copied into it — the operator's prompt,
  // the parent's earlier turns, the lot — and only then the task it was given.
  // Rendered whole, an expanded sub-agent shows the parent's history and reads
  // as if the child had done the parent's work. It is the file that says this,
  // not the renderer, so the fix is here: the boundary is the NEW_TASK post
  // addressed to this thread, and everything before it is somebody else's.
  //
  //   0  session_meta (this child)      ← its own header
  //   1  session_meta (the parent)      ┐
  //   …  developer/user messages        │ the forked conversation
  //  14  inter_agent_communication…     ┘
  //  15  agent_message  NEW_TASK → /root/pty_summary   ← the child's own start
  //  16… its reasoning, its tools, its answer
  let forkEnd = null;
  const stitch = makeStitcher();
  const seenThinking = new Set();
  let cur = null;      // the assistant turn being built
  let encrypted = 0;   // reasoning items with no readable summary

  // Blocks attach to the open assistant turn; a user/system message closes it.
  const assistant = (ts) => {
    if (!cur) { cur = { role: 'assistant', ts, blocks: [] }; out.push(cur); }
    return cur;
  };
  const hasText = (m) => !!m && m.blocks.some((b) => b.type === 'text');

  for await (const j of jsonLines(file, range)) {
    const p = j.payload || {};
    const ts = j.timestamp ? Date.parse(j.timestamp) || undefined : undefined;

    if (j.type === 'session_meta') {
      // A sub-agent's rollout is refused as a SESSION view — it is an internal
      // thread, not the operator's conversation — but the sub-agent strip asks
      // for it deliberately, by an id it resolved from this pane's own roster.
      // Same file, two callers, one of which has the right to see it.
      if (!allowSubagent && (p.thread_source === 'subagent' || p.source?.subagent)) {
        const err = new Error('this rollout is an internal guardian/subagent thread, not the session');
        err.code = 'trace-not-user-conversation';
        throw err;
      }
      out.cwd = p.cwd || out.cwd;
      continue;
    }

    // One per user turn, and the only place the model is named.
    if (j.type === 'turn_context') {
      if (p.model) out.model = p.model;
      out.cwd = out.cwd || p.cwd || null;
      continue;
    }

    if (j.type === 'response_item') {
      if (p.type === 'message') {
        const text = Array.isArray(p.content) ? p.content.map((c) => (c && c.text) || '').join('') : '';
        if (!text.trim()) continue;
        if (p.role === 'assistant') {
          // A second text block means a new step, not an addition to this one.
          if (hasText(cur)) cur = null;
          assistant(ts).blocks.push(textBlock('text', text));
          continue;
        }
        // `developer` is the harness talking to the model (app context, skills,
        // permissions) — system, not something the operator typed. Codex also
        // wraps environment blobs as role:'user' text starting with '<'.
        const isEnv = p.role === 'developer' || text.trim().startsWith('<');
        cur = null;
        out.push({ role: isEnv ? 'system' : 'user', ts, blocks: [textBlock('text', text)] });
      } else if (p.type === 'reasoning') {
        // One block per summary ENTRY, not the entries joined. The same texts
        // arrive as individual `agent_reasoning` events first, and a joined
        // string would never dedupe against them — this session had 11 distinct
        // reasoning texts and naive joining showed 16.
        const parts = Array.isArray(p.summary)
          ? p.summary.map((x) => String((x && x.text) || '')).filter((t) => t.trim())
          : [String(p.text || '')].filter((t) => t.trim());
        if (!parts.length) { encrypted++; continue; }
        for (const text of parts) {
          if (seenThinking.has(text.trim())) continue;
          seenThinking.add(text.trim());
          assistant(ts).blocks.push(textBlock('thinking', text));
        }
      } else if (p.type === 'agent_message') {
        // The task hand-off to THIS thread ends the forked prelude. Its payload
        // is encrypted, so there is nothing to render from it either way.
        if (allowSubagent && forkEnd === null && /Message Type:\s*NEW_TASK/.test(
          (Array.isArray(p.content) ? p.content : []).map((c) => String((c && c.text) || '')).join('\n'))) {
          forkEnd = out.messages.length;
        }
        // Codex's sub-agent post. The parent's rollout carries one per child:
        //
        //   author: "/root/pty_summary"   recipient: "/root"
        //   "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/pty_summary\nPayload: …"
        //
        // and that is the authoritative "this sub-agent finished, and here is
        // what it handed back" — the same job Claude's `<task-notification>`
        // does. The study reported no terminal event for codex because it was
        // looking for `sub_agent_activity`, which CLI 0.149.1 does not emit at
        // all; this is what it emits instead. Kept as `system` so the reader
        // does not draw it and the strip can read it, exactly like Claude's.
        // Encrypted parts are dropped: the NEW_TASK a parent sends a child
        // carries its payload encrypted, so there is nothing to show.
        const parts = (Array.isArray(p.content) ? p.content : [])
          .map((c) => String((c && c.text) || ''))
          .filter((t) => t.trim());
        if (!parts.length) continue;
        const from = p.author ? `Sender: ${p.author}` : '';
        const text = parts.join('\n');
        out.push({ role: 'system', ts, blocks: [textBlock('text', text.includes('Sender:') ? text : `${from}\n${text}`)] });
      } else if (['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call'].includes(p.type)) {
        const use = { type: 'tool_use', id: p.call_id || p.id, name: p.name || p.type, ...capText(p.arguments ?? p.input) };
        const msg = assistant(ts);
        msg.blocks.push(use);
        stitch.register(use, msg);
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const res = { type: 'tool_result', id: p.call_id, ...capText(flattenToolContent(p.output)) };
        if (!stitch.file(res.id, res)) assistant(ts).blocks.push(res);
      }
      continue;
    }

    if (j.type === 'event_msg') {
      if (p.type === 'token_count') {
        const info = p.info || {};
        const tot = info.total_token_usage;
        if (tot) {
          out.usage = {
            in: Math.max(0, (tot.input_tokens || 0) - (tot.cached_input_tokens || 0)),
            out: tot.output_tokens || 0,
            cacheRead: tot.cached_input_tokens || 0,
          };
        }
        // Per-turn cost belongs on the turn it paid for.
        const last = info.last_token_usage;
        if (last && cur && !cur.usage) {
          cur.usage = {
            in: Math.max(0, (last.input_tokens || 0) - (last.cached_input_tokens || 0)),
            out: last.output_tokens || 0,
            cacheRead: last.cached_input_tokens || 0,
          };
        }
      } else if (p.type === 'agent_reasoning') {
        // Readable reasoning the response_item stream encrypted away.
        const text = String(p.text || p.message || '');
        if (text.trim() && !seenThinking.has(text.trim())) {
          seenThinking.add(text.trim());
          assistant(ts).blocks.push(textBlock('thinking', text));
        }
      } else if (p.type === 'web_search_end') {
        // The only record of a web search in this format.
        const msg = assistant(ts);
        const use = { type: 'tool_use', id: p.call_id, name: 'web_search', ...capText(p.query || (p.action && p.action.url) || '') };
        msg.blocks.push(use);
        stitch.register(use, msg);
        const res = { type: 'tool_result', id: p.call_id, ...capText(p.results) };
        if (!stitch.file(res.id, res)) msg.blocks.push(res);
      } else if (p.type === 'task_complete') {
        // In every task of the rollout I checked, `last_agent_message` was
        // byte-identical to the preceding assistant message — a POINTER to the
        // final answer, so marking it is right and emitting it would duplicate.
        // But don't bet the content on that: if it genuinely differs, it is an
        // answer we have not shown, so show it.
        const text = String(p.last_agent_message || '').trim();
        if (text) {
          let marked = null;
          for (let i = out.messages.length - 1; i >= 0; i--) {
            const m = out.messages[i];
            if (m.role === 'assistant' && hasText(m)) { marked = m; break; }
          }
          const shown = marked ? marked.blocks.filter((b) => b.type === 'text').map((b) => b.text.trim()) : [];
          // A capped block only holds a prefix, so compare as a prefix there.
          if (marked && shown.some((t) => t === text || (t.length >= VIEW_BLOCK_CAP && text.startsWith(t)))) {
            marked.kind = 'final';
          } else if (range && range.danglingTaskComplete === 'ignore') {
            // This window had to cut a task in half (one bigger than the growth
            // ceiling), so the answer this event points at is in a window we did
            // not read — where it is already rendered, and already marked. A
            // pointer to something outside the window is not an answer; emitting
            // it here would show the reader a copy of a turn that occurs once.
            cur = null;
          } else {
            cur = null;
            out.push({ role: 'assistant', kind: 'final', ts, blocks: [textBlock('text', text)] });
          }
        }
        cur = null;
      } else if (p.type === 'turn_aborted' || p.type === 'thread_rolled_back') {
        cur = null;
      }
      // Did this window's last task close inside it? That is what decides
      // whether its final answer is really final — see oneWindow.
      if (p.type === 'task_started') out.taskOpen = true;
      else if (p.type === 'task_complete' || p.type === 'turn_aborted') out.taskOpen = false;
      continue;
    }
  }
  if (encrypted) out.note = `${encrypted} reasoning step${encrypted === 1 ? '' : 's'} were encrypted by the model and carry no readable text`;
  // …and drop it, now that the whole file has been read. Only when a boundary
  // was found: a sub-agent spawned without a fork, or one whose hand-off is
  // outside this window, is better shown whole than shown empty.
  if (allowSubagent && forkEnd !== null && forkEnd > 0) {
    out.messages = out.messages.slice(forkEnd);
  }

}

// OpenClaw — already close to STS: {type:'message', message:{role,content,usage}}
async function normalizeOpenClaw(file, out, range) {
  const stitch = makeStitcher();
  for await (const j of jsonLines(file, range)) {
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
async function normalizeSts(file, out, range) {
  const stitch = makeStitcher();
  for await (const j of jsonLines(file, range)) {
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
// This is now on the path of EVERY window request (it decides whether the trace
// can be seeked at all), so the answer is remembered rather than re-read off the
// bucket each time. Briefly, though: a path is not permanently one format — a
// bundle ref can be re-imported with a different harness underneath it.
const harnessMemo = new Map(); // path -> { at, harness }
const HARNESS_TTL = 60_000;
async function sniffHarness(file) {
  const hit = harnessMemo.get(file);
  if (hit && Date.now() - hit.at < HARNESS_TTL) return hit.harness;
  const found = await sniffHarnessUncached(file);
  if (found) {
    if (harnessMemo.size > 200) harnessMemo.clear();
    harnessMemo.set(file, { at: Date.now(), harness: found });
  }
  return found;
}

async function sniffHarnessUncached(file) {
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
    firstTs: 0, lastTs: 0, usage: null, usageSum: null, source: null, sharedBy: null, note: null, messages: [],
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

/**
 * Mark the last assistant turn before each user turn as the answer to it.
 *
 * The Hub's viewer draws this one differently — an accent rule down its left
 * edge — because in a long agent turn it is the only message written FOR the
 * reader; the rest are the agent narrating its way there. Codex names it itself
 * (`task_complete`), but the rule generalises to every harness, so it is derived
 * here rather than per-format. One reverse pass: an assistant text turn is final
 * if no later assistant text turn precedes the next user turn.
 */
function markFinalTurns(out) {
  const ms = out.messages;
  let laterAnswer = false;
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    if (m.role === 'user') { laterAnswer = false; continue; }
    if (m.role !== 'assistant') continue;
    if (!m.blocks.some((b) => b.type === 'text')) continue;
    if (!laterAnswer) m.kind = 'final';
    laterAnswer = true;
  }
}

async function parseTraceFile(harness, file, sessionId, range = null, allowSubagent = false) {
  const out = newTrace(harness);
  out.sessionId = sessionId || null;
  switch (harness) {
    case 'claude': await normalizeClaude(file, out, range); break;
    case 'codex': await normalizeCodex(file, out, range, allowSubagent); break;
    case 'openclaw': await normalizeOpenClaw(file, out, range); break;
    case 'sts': await normalizeSts(file, out, range); break;
    case 'opencode': normalizeOpencodeDb(file, sessionId, out); break;
    case 'hermes': normalizeHermesDb(file, sessionId, out); break;
    default: { const e = new Error(`no trace reader for '${harness}'`); e.code = 'unsupported-harness'; throw e; }
  }
  // A harness that reports its own session total (codex's cumulative
  // token_count, the db-backed session rows) wins; otherwise use the sum of the
  // per-turn numbers.
  if (!out.usage) out.usage = out.usageSum;
  markFinalTurns(out);
  return out;
}

// Everything a response says about the trace itself, as opposed to the turns in
// it. Shared by pages, windows and the summary so the three can't drift.
function headOf(parsed) {
  return {
    harness: parsed.harness, harnessLabel: parsed.harnessLabel, sessionId: parsed.sessionId,
    title: parsed.title, model: parsed.model, cwd: parsed.cwd,
    firstTs: parsed.firstTs, lastTs: parsed.lastTs, usage: parsed.usage,
    source: parsed.source, sharedBy: parsed.sharedBy, note: parsed.note || null,
    truncated: !!parsed.truncated,
  };
}

function pageOf(parsed, offset, limit) {
  const total = parsed.messages.length;
  // Indices of the operator's own prompts, for the pane's prompt navigator.
  // Sent whole rather than per page: jumping to the next prompt must work
  // before the page holding it has been fetched.
  const userTurns = [];
  for (let i = 0; i < total; i++) if (parsed.messages[i].role === 'user') userTurns.push(i);
  // A negative offset reads from the END — what any surface showing the tail of
  // a conversation wants (the Overview card, RENDER mode) without first making a
  // round trip just to learn `total`.
  const off = offset | 0;
  const from = off < 0 ? Math.max(0, total + off) : Math.max(0, Math.min(off, total));
  const to = Math.min(total, from + Math.max(1, Math.min(limit | 0 || 200, 500)));
  return {
    ...headOf(parsed),
    total, offset: from, limit: to - from,
    userTurns,
    turns: parsed.messages.slice(from, to),
  };
}

// ---------- windows: open at the END, page backwards ----------
// Index-mode paging (above) can only answer "turns 400–600" after the whole file
// has been normalized, because nothing else knows where turn 400 is. That is the
// wrong bargain for a reader that opens on the last exchange: on a 19 MB
// transcript it spends a full read + parse before the first pixel, and it spends
// it again every time the file changes underneath (a working agent rewrites the
// memo key on every append).
//
// A window is a BYTE RANGE of the transcript, parsed by the same normalizers,
// with line-aligned cursors handed back to the caller. `tail` reads the last
// WINDOW_BYTES; `before: <start we just gave you>` reads the stretch in front of
// it; `after: <end>` picks up whatever the agent has written since. Windows abut
// exactly, so a reader can stitch them into one conversation with no gaps and no
// repeats — and never pays for the part of the trace nobody scrolled to.
const WINDOWABLE = new Set(['claude', 'codex', 'openclaw', 'sts']);
const WINDOW_BYTES = 384 * 1024;         // default span (see the PR for the measurements)
const WINDOW_MIN_BYTES = 32 * 1024;
const WINDOW_MAX_BYTES = 8 * 1024 * 1024; // a single window can't cost more than this
// Grow the span until at least this many turns are in it — a floor against
// opening on a stub, NOT a target. It is deliberately low, and growth doubles
// rather than quadruples: a codex rollout packs ~20 turns into 384 KB, and
// insisting on 30 grew that window to 1.5 MB and the response to 591 KB, which
// is the whole-file cost this exists to avoid. Measured on `finetuning boy`
// (2 MB rollout): 384 KB = 19 turns / 135 KB, 1.5 MB = 75 turns / 591 KB.
const WINDOW_MIN_TURNS = 12;
const clampN = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function windowOf(parsed, cur) {
  return {
    ...headOf(parsed),
    // `firstTs`, `usage` and `note` describe the WHOLE conversation. A window
    // that doesn't span the whole file knows none of them, and reporting its own
    // first line as the start of the session, its own tokens as the session's
    // bill, or its own count of encrypted reasoning steps as the session's,
    // would be a confident lie — the last one visibly so, since it would change
    // every time you scrolled. The summary pass fills them in.
    firstTs: cur.atStart ? parsed.firstTs : 0,
    usage: cur.atStart && cur.atEnd ? parsed.usage : null,
    note: cur.atStart && cur.atEnd ? parsed.note || null : null,
    total: null,
    userTurns: null,
    turns: parsed.messages,
    window: cur,
  };
}

// The whole-trace facts a window can't know: how many turns there are, where the
// prompts are, what the session cost. One full parse, memoized like any other —
// the reader asks for it AFTER it has painted, so it never delays the first view.
function summaryOf(parsed) {
  const userTurns = [];
  for (let i = 0; i < parsed.messages.length; i++) if (parsed.messages[i].role === 'user') userTurns.push(i);
  return { ...headOf(parsed), total: parsed.messages.length, userTurns };
}

// A window that stops mid-conversation must not call its last assistant turn the
// final answer — it isn't one; the window simply ran out.
function unmarkTrailingFinal(parsed) {
  const ms = parsed.messages;
  for (let i = ms.length - 1; i >= 0; i--) {
    if (ms[i].role === 'user') break;
    if (ms[i].kind === 'final') delete ms[i].kind;
  }
}

// ---------- codex: windows are cut at task boundaries ----------
// A byte window is sound for a format whose lines stand alone. Codex's do not:
// `event_msg/task_complete` POINTS BACK at the assistant message it marks, and
// `agent_reasoning` is deduped against reasoning items earlier in the same turn.
// Cut the file anywhere and those references dangle — and a dangling
// `task_complete` does not degrade, it INVENTS: `normalizeCodex` cannot find the
// answer, so it pushes a verbatim second copy of it. Measured on a real 4.8 MB
// rollout at 128 KB windows: 955 stitched turns against the full parse's 953,
// two answers shown twice.
//
// Two things make it right, and it is worth being precise about which does what,
// because a review found the code claiming more than it delivers.
//
//  1. A window PREFERS to begin at a `task_started` line. When the window holds
//     one, the task it opens — with its answer, its reasoning and its token
//     count — lands whole, and the turn grouping is not split at the seam.
//  2. When it holds none (any window smaller than the task it lands in, which at
//     64 KB is most of them), the window is cut mid-task anyway, and what keeps
//     the output correct is that a `task_complete` whose answer is NOT in this
//     window is treated as a marker only — see `danglingTaskComplete`. That
//     fallback is load-bearing, not a corner case.
//
// Measured over every rollout on this Space: 339 `task_started`, 333
// `task_complete`, no `task_complete` outside a started task, largest task
// 768 KB. Stitching every window back together reproduces the full parse exactly
// — turns, blocks and `final` accents — at 64 KB, 128 KB and 384 KB.
const TASK_MARK = '"task_started"';

/** Byte offset of the first `task_started` line at or after `buf`'s first whole
 *  line, or -1 if this window holds none. `base` is the file offset of buf[0]. */
function codexTaskStart(buf, base, firstLine) {
  let i = firstLine;
  while (i < buf.length) {
    let nl = buf.indexOf(0x0a, i);
    if (nl < 0) nl = buf.length;
    // Cheap filter first: parsing every line of every window to find a boundary
    // would cost as much as the parse itself.
    if (buf.includes(TASK_MARK, i) && buf.indexOf(TASK_MARK, i) < nl) {
      let j = null;
      try { j = JSON.parse(buf.toString('utf8', i, nl)); } catch { j = null; }
      if (j && j.type === 'event_msg' && j.payload && j.payload.type === 'task_started') return base + i;
    }
    i = nl + 1;
  }
  return -1;
}

/** Where a window's first whole line begins inside `buf`. */
function firstWholeLine(buf, aligned) {
  if (aligned) return 0;
  const nl = buf.indexOf(0x0a);
  return nl < 0 ? buf.length : nl + 1;
}

async function oneWindow(harness, file, sessionId, range, size, prebuilt, allowSubagent = false) {
  let taskAligned = false;
  if (prebuilt) range.buf = prebuilt;
  if (harness === 'codex' && range.from > 0) {
    // Read once, align, then parse the same bytes — `range.buf` keeps this to a
    // single read of the window.
    const buf = range.buf || await rangeBuf(file, range.from, range.to);
    const at = codexTaskStart(buf, range.from, firstWholeLine(buf, range.aligned));
    if (at >= 0) {
      range.buf = buf.subarray(at - range.from);
      range.from = at;
      range.aligned = true;
      taskAligned = true;
    } else {
      range.buf = buf;
      // No boundary in reach: this window cuts a task in half, so a
      // `task_complete` inside it may point at an answer we cannot see. Tell the
      // normalizer to treat it as a marker only — pointing at something outside
      // the window is not a reason to invent a copy of it.
      range.danglingTaskComplete = 'ignore';
    }
  }
  const parsed = await parseTraceFile(harness, file, sessionId, range, allowSubagent);
  const start = range.start ?? range.from;
  const end = range.end ?? range.to;
  // Having READ to the end of the file is what makes this the end of the
  // conversation. `end` can legitimately stop short of `size` — a line the agent
  // is halfway through writing, or one a killed writer left broken — and taking
  // that as "there is more to come" would deny the last answer its accent
  // forever. The cursor still stops in front of the fragment, so the next
  // `after: end` picks it up if it ever becomes whole.
  const atEnd = range.to >= size;
  // Withhold the "final answer" accent only from a window that cannot know
  // whether the answer is final. For codex that is precisely a window whose last
  // task is still open at its edge — a closed task's answer is named by the
  // harness itself. For the line-oriented formats it is any window that does not
  // reach the end of the file, since "final" there means "no later answer before
  // the next prompt", and the next prompt may be in the window after this one.
  const openEdge = harness === 'codex' ? !!parsed.taskOpen : true;
  if (!atEnd && openEdge) unmarkTrailingFinal(parsed);
  return { parsed, cur: { mode: 'bytes', start, end, atStart: start <= 0, atEnd } };
}

async function readWindow(harness, file, sessionId, size, req, allowSubagent = false) {
  const bytes = clampN(Math.trunc(req.bytes) || WINDOW_BYTES, WINDOW_MIN_BYTES, WINDOW_MAX_BYTES);
  const min = clampN(Math.trunc(req.min) || WINDOW_MIN_TURNS, 1, 500);
  const cursor = clampN(Math.trunc(req.cursor) || 0, 0, size);

  if (req.at === 'after') {
    // A pane left open while the agent wrote megabytes: don't try to catch up in
    // one window. Hand back the tail and flag the gap, so the reader replaces
    // what it holds instead of splicing a hole into the middle of it.
    if (size - cursor > WINDOW_MAX_BYTES) {
      const w = await readWindow(harness, file, sessionId, size, { at: 'tail', bytes, min }, allowSubagent);
      return { ...w, cur: { ...w.cur, gap: true } };
    }
    return oneWindow(harness, file, sessionId, { from: cursor, to: size, aligned: true, eof: true }, size, undefined, allowSubagent);
  }

  const to = req.at === 'before' ? cursor : size;
  const eof = to >= size;
  // Turns vary wildly in size — one window can hold 200 of them or one 300 KB
  // tool result. Grow the span until it holds a readable number of turns, or
  // until it reaches the start of the file / the per-window ceiling.
  //
  // Growing EXTENDS the buffer downwards rather than reading the wider span from
  // scratch: doubling and re-reading turned one response into 384K + 768K + 1.5M
  // + 3M of reads (5.76 MB for a single window, and 28 MB to page a 19 MB file
  // back to its start — more bytes than the file has). On the bucket this
  // reader exists for, those are the expensive ones.
  let span = bytes;
  let buf = null;
  let bufFrom = to;
  for (;;) {
    const from = Math.max(0, to - span);
    if (from < bufFrom) {
      const head = await rangeBuf(file, from, bufFrom);
      buf = buf && buf.length ? Buffer.concat([head, buf]) : head;
      bufFrom = from;
    }
    const w = await oneWindow(harness, file, sessionId, { from, to, aligned: from === 0, eof }, size, buf, allowSubagent);
    if (w.parsed.messages.length >= min || from === 0 || span >= WINDOW_MAX_BYTES) {
      // A window that consumed nothing at all has hit a single line longer than
      // the ceiling (a file-history blob), and no amount of asking again will
      // get past it. Say that, rather than let the reader conclude it has
      // reached the beginning of the conversation.
      if (w.cur.start >= to && to > 0) w.cur.blocked = true;
      return w;
    }
    span = Math.min(span * 2, WINDOW_MAX_BYTES);
  }
}

// Harnesses whose conversation lives in SQLite have no byte offsets to seek, and
// a bundle small enough not to matter doesn't need them. They answer the same
// shape with message INDICES as cursors: the reader treats a cursor as opaque.
const INDEX_WINDOW_TURNS = 100; // no bytes to seek: page by turns, as index mode always did

function windowIndex(parsed, req) {
  const total = parsed.messages.length;
  const min = clampN(Math.trunc(req.min) || INDEX_WINDOW_TURNS, 1, 500);
  const cursor = clampN(Math.trunc(req.cursor) || 0, 0, total);
  let from; let to;
  if (req.at === 'after') { from = cursor; to = total; } else if (req.at === 'before') { to = cursor; from = Math.max(0, to - min); } else { to = total; from = Math.max(0, total - min); }
  return {
    ...headOf(parsed),
    total,
    userTurns: null,
    turns: parsed.messages.slice(from, to),
    window: { mode: 'index', start: from, end: to, atStart: from <= 0, atEnd: to >= total },
  };
}

// The subagent marker lives in `session_meta`, the FIRST line of a codex
// rollout — a tail window never sees it, so a guardian thread would render as if
// it were the operator's conversation. Check the head before serving a window.
//
// That line is NOT small: it carries `base_instructions.text`, and every real
// rollout on this Space starts with 18–44 KB of it. Reading a fixed 16 KB and
// parsing what came back therefore never parsed at all, and the `catch` turned
// "I could not tell" into "not a subagent" — the guard silently never fired.
// So: grow the read until the line is whole, and if it still cannot be read,
// say so rather than assume the safe answer.
const FIRST_LINE_MAX = 4 * 1024 * 1024;

async function firstLine(file) {
  for (let span = 64 * 1024; ; span *= 4) {
    const buf = await rangeBuf(file, 0, span);
    const nl = buf.indexOf(0x0a);
    if (nl >= 0) return buf.toString('utf8', 0, nl);
    // Shorter than the span means we read the whole file: it is one line.
    if (buf.length < span) return buf.toString('utf8');
    if (span >= FIRST_LINE_MAX) return null;
  }
}

async function refuseCodexSubagent(file) {
  const line = await firstLine(file);
  let j = null;
  try { j = line == null ? null : JSON.parse(line); } catch { j = null; }
  if (!j) {
    // Unreadable head: fall back to the reader that walks the whole rollout,
    // which throws on the marker itself. Rare, and correctness beats the window.
    const e = new Error('could not read the head of this rollout');
    e.code = 'window-unavailable';
    throw e;
  }
  const p = j.payload || {};
  if (j.type === 'session_meta' && (p.thread_source === 'subagent' || p.source?.subagent)) {
    const err = new Error('this rollout is an internal guardian/subagent thread, not the session');
    err.code = 'trace-not-user-conversation';
    throw err;
  }
}

/**
 * One request against one located trace. `opts` picks the mode:
 *   { window: { at, cursor, bytes, min } } — a byte window (the reader's path)
 *   { summary: true }                      — whole-trace facts, no turns
 *   { offset, limit }                      — index paging (Overview, RENDER mode)
 * `decorate` is the bundle manifest pass, applied to every fresh parse.
 */
async function serveTrace({ key, harness, file, sessionId, size, decorate, allowSubagent }, opts) {
  const full = async () => {
    if (viewMemo.key !== key) {
      const parsed = await tracked(PHASE.readTrace, () => parseTraceFile(harness, file, sessionId, null, allowSubagent));
      if (decorate) await decorate(parsed);
      viewMemo = { key, val: parsed };
    }
    return viewMemo.val;
  };

  if (opts.summary) return summaryOf(await full());
  if (!opts.window) return pageOf(await full(), opts.offset ?? 0, opts.limit ?? 200);
  if (!WINDOWABLE.has(harness)) return windowIndex(await full(), opts.window);

  if (harness === 'codex' && !allowSubagent) {
    try {
      await refuseCodexSubagent(file);
    } catch (e) {
      if (e.code !== 'window-unavailable') throw e;
      return windowIndex(await full(), opts.window); // whole-file read, which checks it properly
    }
  }
  const { parsed, cur } = await tracked(PHASE.readTrace, () =>
    readWindow(harness, file, sessionId, size, opts.window, allowSubagent));
  if (decorate) await decorate(parsed);
  return windowOf(parsed, cur);
}

/**
 * Read one session's trace, paginated. `session` is an Agent Manager session
 * record; locating the file is delegated to findTrace() in share.js, which
 * already handles all five harnesses, per-session pins, cwd attribution,
 * ambiguity refusal and codex subagent rollouts. Do not reimplement it.
 */
export async function readTrace(session, opts = {}) {
  const hit = await findTrace(session, store.list());
  if (!hit) { const e = new Error('no trace found for this session'); e.code = 'no-trace'; throw e; }

  const st = await statRetry(hit.src);
  if (!st) { const e = new Error(`trace file unreadable: ${hit.src}`); e.code = 'no-trace'; throw e; }

  return serveTrace({
    key: `s:${session.id}:${hit.src}:${hit.sessionId || ''}:${st.mtimeMs}:${st.size}`,
    harness: session.cli,
    file: hit.src,
    sessionId: hit.sessionId || session.sessionUuid || null,
    size: st.size,
  }, opts);
}

/**
 * Codex keeps a sub-agent's transcript as an ordinary rollout, in the same tree
 * as every other session, and says whose child it is in its own header:
 *
 *   "thread_source": "subagent",
 *   "source": { "subagent": { "thread_spawn": {
 *       "parent_thread_id": "01a0581a-5757-…", "depth": 1,
 *       "agent_path": "/root/pty_summary", "agent_nickname": "Curie" } } }
 *
 * So the roster is: every rollout whose header names this session as its parent.
 * That means reading first lines rather than a directory listing, which is why
 * the header is memoized per file+mtime — a rollout's header never changes once
 * written, and there are tens of files, not thousands.
 *
 * `agent_path` is the join key back to the parent's own records: the parent's
 * `spawn_agent` call carries `{"task_name":"pty_summary"}` and its output
 * `{"task_name":"/root/pty_summary"}`, and the completion post names the same
 * path as `Sender:`. There is no shared id anywhere in the pair, so the name is
 * the link — and it is exact, not a heuristic.
 */
const codexHeadMemo = new Map();   // file -> { key, head }

async function codexSubagentHeader(file) {
  const st = await statRetry(file);
  if (!st) return null;
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = codexHeadMemo.get(file);
  if (hit && hit.key === key) return hit.head;
  let head = null;
  try {
    for await (const j of jsonLines(file)) {
      const p = j.payload || j;
      if (j.type !== 'session_meta' && p?.type !== 'session_meta' && !p?.id) break;
      const spawn = p?.source?.subagent?.thread_spawn;
      head = {
        threadId: p?.id || null,
        parentThreadId: spawn?.parent_thread_id || null,
        depth: Number.isFinite(spawn?.depth) ? spawn.depth : null,
        agentPath: spawn?.agent_path || null,
        nickname: spawn?.agent_nickname || null,
        firstTs: j.timestamp ? Date.parse(j.timestamp) || null : null,
        bytes: st.size,
        mtimeMs: Math.round(st.mtimeMs),
      };
      break;                       // the first line is the header
    }
  } catch { /* unreadable file: not a sub-agent as far as we know */ }
  if (codexHeadMemo.size > 400) codexHeadMemo.clear();
  codexHeadMemo.set(file, { key, head });
  return head;
}

async function codexSubagentRoster(session) {
  const parentId = session.codexSessionId
    || (session.codexRollout && (path.basename(session.codexRollout).match(UUID_RE) || [])[1])
    || null;
  if (!parentId) return { supported: true, reason: 'no rollout for this pane yet', dir: null, agents: [] };
  const agents = [];
  for (const file of await codexFiles()) {
    const head = await codexSubagentHeader(file);
    if (!head || head.parentThreadId !== parentId) continue;
    const task = head.agentPath || '';
    agents.push({
      agentId: head.threadId,
      agentType: head.nickname || 'sub-agent',
      description: task.split('/').filter(Boolean).pop() || head.nickname || 'sub-agent',
      /** codex has no per-call id; the task path is what the parent's records name */
      toolUseId: null,
      taskName: task || null,
      parentAgentId: head.parentThreadId,
      depth: head.depth,
      spawnedAt: head.firstTs,
      lastWroteAt: head.mtimeMs,
      bytes: head.bytes,
      hasTranscript: true,
    });
  }
  agents.sort((a, b) => (a.spawnedAt || 0) - (b.spawnedAt || 0));
  return { supported: true, dir: null, agents };
}

/**
 * The sub-agents a Claude session spawned, from the directory beside its own
 * transcript. (PoC — see docs/… nothing; this is the reader's sub-agent strip.)
 *
 *   <project>/<session-uuid>.jsonl          the parent, up to 292 MB here
 *   <project>/<session-uuid>/subagents/
 *       agent-<agentId>.jsonl               the child's transcript
 *       agent-<agentId>.meta.json           187 bytes, and the whole point
 *
 * The roster is a directory listing plus a few kilobytes: the sidecar names the
 * task (`description`), the exact spawning call (`toolUseId`), the parent agent
 * and the depth. Nothing here opens the parent transcript, which is the only
 * reason this can be asked for on a poll — reading the parent per poll is not
 * survivable at 292 MB.
 *
 * Two timestamps come free from stat(), and they are not the same thing:
 *   spawnedAt   — the sidecar's mtime. Written once, when the agent is created.
 *   lastWroteAt — the transcript's mtime. Moves while it works, and then stops
 *                 whether it finished or died. It is reported, never judged:
 *                 measured gaps between consecutive records inside a LIVE
 *                 sub-agent run to 601s (p99 112s), so "silent means dead" is
 *                 wrong several times an hour. Whether one is finished is
 *                 decided in the client from the parent's own records.
 */
export async function subagentRoster(session) {
  if (session.cli === 'codex') return codexSubagentRoster(session);
  const loc = await traceLocation(session);
  if (!loc || session.cli !== 'claude' || loc.format !== 'jsonl') {
    return { supported: false, reason: session.cli === 'claude' ? 'no transcript yet' : `${session.cli} keeps sub-agents elsewhere`, dir: null, agents: [] };
  }
  const dir = path.join(loc.path.replace(/\.jsonl$/, ''), 'subagents');
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return { supported: true, dir, agents: [] }; }

  const agents = [];
  for (const name of names) {
    const m = /^agent-([A-Za-z0-9_-]+)\.meta\.json$/.exec(name);
    if (!m) continue;
    const agentId = m[1];
    const metaPath = path.join(dir, name);
    const filePath = path.join(dir, `agent-${agentId}.jsonl`);
    let meta = {};
    try { meta = JSON.parse(await fsp.readFile(metaPath, 'utf8')) || {}; } catch { /* a half-written sidecar is still an agent */ }
    const [metaSt, fileSt] = await Promise.all([statRetry(metaPath), statRetry(filePath)]);
    agents.push({
      agentId,
      agentType: meta.agentType || null,
      description: meta.description || null,
      toolUseId: meta.toolUseId || null,
      parentAgentId: meta.parentAgentId || null,
      depth: Number.isFinite(meta.spawnDepth) ? meta.spawnDepth : null,
      spawnedAt: metaSt ? Math.round(metaSt.mtimeMs) : null,
      lastWroteAt: fileSt ? Math.round(fileSt.mtimeMs) : null,
      bytes: fileSt ? fileSt.size : 0,
      hasTranscript: !!fileSt,
    });
  }
  agents.sort((a, b) => (a.spawnedAt || 0) - (b.spawnedAt || 0));
  return { supported: true, dir, agents };
}

/**
 * One sub-agent's transcript, read as an ordinary trace.
 *
 * It IS an ordinary trace — same records, same normalizer, so the reader can
 * render a sub-agent with the component it already uses for a session. The file
 * is small (11 MB across all 38 of the largest session here) where the parent
 * is not, which is the other half of why this feature is affordable.
 *
 * `agentId` arrives from the browser and lands in a path, so it is matched
 * against the id shape rather than trusted.
 */
export async function readSubagentTrace(session, agentId, opts = {}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(agentId || ''))) {
    const e = new Error('not a sub-agent id'); e.code = 'no-trace'; throw e;
  }
  if (session.cli === 'codex') {
    // The id IS a thread id, and a rollout's name carries it. Matched against
    // the roster rather than pasted into a path, so a browser cannot ask for a
    // file this session is not the parent of.
    const { agents } = await codexSubagentRoster(session);
    const mine = agents.find((a) => a.agentId === agentId);
    if (!mine) { const e = new Error('not a sub-agent of this pane'); e.code = 'no-trace'; throw e; }
    for (const file of await codexFiles()) {
      if (path.basename(file).includes(agentId)) return readTraceByPath(file, opts, true);
    }
    const e = new Error('sub-agent rollout not found'); e.code = 'no-trace'; throw e;
  }
  const loc = await traceLocation(session);
  if (!loc || session.cli !== 'claude' || loc.format !== 'jsonl') {
    const e = new Error('this session keeps no sub-agent transcripts'); e.code = 'unsupported-harness'; throw e;
  }
  const file = path.join(loc.path.replace(/\.jsonl$/, ''), 'subagents', `agent-${agentId}.jsonl`);
  return readTraceByPath(file, opts);
}

/**
 * Is this file a trace we can render? Cheap: reads at most the first few lines.
 * Returns the harness id, or null for "just a .jsonl".
 */
export async function traceHarnessOf(file) {
  try { return await sniffHarness(file); } catch { return null; }
}

/**
 * Read ANY transcript on disk as a trace, by path — what the Files pane needs
 * when you open a rollout or a Claude transcript directly. The session-bound
 * reader above locates a file for a session; this one is handed the file and
 * sniffs the format the same way an imported bundle does.
 */
export async function readTraceByPath(file, opts = {}, allowSubagent = false) {
  const st = await statRetry(file);
  if (!st) { const e = new Error('trace file unreadable'); e.code = 'no-trace'; throw e; }

  const harness = await sniffHarness(file);
  if (!harness) { const e = new Error('unrecognized trace format'); e.code = 'unsupported-harness'; throw e; }

  return serveTrace({
    key: `f:${file}:${st.mtimeMs}:${st.size}${allowSubagent ? ':sub' : ''}`,
    harness,
    file,
    sessionId: null,
    size: st.size,
    allowSubagent,
  }, opts);
}

/**
 * Read an accepted incoming bundle: DATA_DIR/traces/<envelopeId>/<name>.jsonl
 * plus meta/. The harness is sniffed from the file, since a bundle carries
 * whatever format the sender's harness ships.
 */
export async function readTraceBundle(dir, opts = {}) {
  const names = (await fsp.readdir(dir).catch(() => [])).filter((n) => n.endsWith('.jsonl'));
  if (!names.length) { const e = new Error('bundle has no trace file'); e.code = 'no-trace'; throw e; }
  const file = path.join(dir, names[0]);
  const st = await statRetry(file);
  if (!st) { const e = new Error('bundle trace unreadable'); e.code = 'no-trace'; throw e; }

  const harness = await sniffHarness(file);
  if (!harness) { const e = new Error('unrecognized trace format'); e.code = 'unsupported-harness'; throw e; }

  // Applied to every parse of this bundle — a window is as entitled to the
  // sender's own description of it as a full read is.
  const decorate = async (parsed) => {
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
      parsed.sharedBy = (manifest.origin && manifest.origin.user) || null;
    }
    // Provenance, written by importBundle: a received trace that can't say whose
    // it is has lost what makes it trustworthy.
    try {
      const src = JSON.parse(await fsp.readFile(path.join(dir, 'meta', 'source.json'), 'utf8'));
      parsed.source = { repo: src.repo || null, url: src.url || null, importedAt: src.importedAt || null };
    } catch { /* hand-placed bundle, or an older import */ }
  };

  return serveTrace({
    key: `b:${file}:${st.mtimeMs}:${st.size}`,
    harness,
    file,
    sessionId: null,
    size: st.size,
    decorate,
  }, opts);
}
