import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as store from './sessions.js';
import { WORKSPACES_DIR } from './config.js';

// Workspace-wide trace analytics: parse every Claude transcript and Codex
// rollout on the Space into per-conversation stats (turns, tool calls, web
// searches, tokens), attribute them to Agent Manager sessions where possible
// (Claude: transcript filename == sessionUuid; Codex: pinned codexSessionId),
// and aggregate the rest as "other".
//
// Parsing is memoized per file by (mtime, size), so repeat calls only re-read
// files that actually changed — important on the bucket mount.

const fileCache = new Map(); // path -> { key, parsed: { stats, digest } }
let resultMemo = { ts: 0, val: null };
const TTL = 5_000; // Overview polls; per-file mtime caching keeps re-scans cheap

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
  return { lastPromptText: '', lastPromptTs: 0, lastAssistantText: '', lastAssistantMd: '', lastAssistantTs: 0, sinceTurns: 0, sinceToolCalls: 0, sinceTools: {}, sinceFiles: [], sinceTokens: 0 };
}
const clip = (s, n = 280) => { const t = (s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// Markdown-preserving variant (keeps newlines) for the expandable card view.
const clipRaw = (s, n = 6000) => { const t = (s || '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
function digestPrompt(d, text, ts) {
  d.lastPromptText = clip(text); d.lastPromptTs = Date.parse(ts) || 0;
  d.sinceTurns = 0; d.sinceToolCalls = 0; d.sinceTools = {}; d.sinceFiles = []; d.sinceTokens = 0;
  // The previous answer belongs to the previous prompt — never show it as "LAST".
  d.lastAssistantText = ''; d.lastAssistantMd = ''; d.lastAssistantTs = 0;
}
function digestAssistant(d, text, ts) {
  d.lastAssistantText = clip(text);
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
    } else if (j.type === 'user' && !j.toolUseResult) {
      st.prompts++;
      const mc = j.message && j.message.content;
      const text = typeof mc === 'string' ? mc
        : Array.isArray(mc) ? mc.filter((c) => c && c.type === 'text').map((c) => c.text).join(' ') : '';
      // Skip harness noise (slash-command wrappers, attachments) as "prompts".
      if (text.trim() && !text.trim().startsWith('<')) digestPrompt(dg, text, j.timestamp);
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
    if (j.type === 'session_meta' && p.cwd) st.cwd = p.cwd; // for cwd-fallback attribution
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
          break;
        default:
      }
    } else if (j.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.total_token_usage) {
      tok = p.info.total_token_usage;
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

async function openclawFiles() {
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
  if (ocMemo.key && Date.now() - ck.hotMs < 15_000) return ocMemo.rows;
  const key = ck.key;
  let db;
  try { db = new DatabaseSync(p, { readOnly: true }); } catch { return ocMemo.rows; }
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
      rows.push({ directory: s.directory || null, parsed: { stats: st, digest: dg } });
    }
  } catch { /* torn read / schema drift: keep previous */ } finally {
    try { db.close(); } catch {}
  }
  ocMemo = { key, rows };
  return rows;
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
  if (hermesMemo.key && Date.now() - ck.hotMs < 15_000) return hermesMemo.rows;
  let db;
  try { db = new DatabaseSync(p, { readOnly: true }); } catch { return hermesMemo.rows; }
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
  }
  hermesMemo = { key: ck.key, rows };
  return rows;
}

async function statsFor(p, parser, quietMs = 0) {
  let m;
  try { m = await fsp.stat(p); } catch { return null; }
  const key = `${m.mtimeMs}:${m.size}`;
  const c = fileCache.get(p);
  if (c && c.key === key) return c.parsed;
  // Don't read a file its owner is actively writing. OpenClaw's session fence
  // fingerprints metadata at nanosecond precision, and on the FUSE bucket our
  // reads can disturb what it sees — so while a fence-sensitive file is hot,
  // serve the previous parse and re-read once writes have gone quiet.
  if (quietMs && c && Date.now() - m.mtimeMs < quietMs) return c.parsed;
  let parsed;
  try { parsed = parser(await fsp.readFile(p, 'utf8')); } catch { return null; }
  fileCache.set(p, { key, parsed });
  return parsed;
}

async function claudeFiles() {
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

async function codexFiles() {
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

async function build() {
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

  for (const p of await claudeFiles()) {
    const m = path.basename(p).match(UUID_RE);
    attribute(m ? byClaudeUuid.get(m[1]) : null, await statsFor(p, parseClaude));
  }
  // Codex fallback: sessions created before capture-and-pin have no
  // codexSessionId — attribute their rollouts by cwd when it's unambiguous.
  const byCodexCwd = new Map();
  for (const s of sessions.filter((x) => x.cli === 'codex')) {
    const key = path.resolve(WORKSPACES_DIR, s.path ?? s.id);
    byCodexCwd.set(key, byCodexCwd.has(key) ? 'ambiguous' : s);
  }
  for (const p of await codexFiles()) {
    const parsed = await statsFor(p, parseCodex);
    if (!parsed) continue;
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
    attribute(ocOwner, await statsFor(p, parseOpenClaw, 30_000)); // fence-sensitive: read only when quiet
  }

  // opencode: sessions attribute by their recorded directory (like codex cwd).
  const opencodeByDir = new Map();
  for (const s of sessions.filter((x) => x.cli === 'opencode')) {
    const key = path.resolve(WORKSPACES_DIR, s.path ?? s.id);
    opencodeByDir.set(key, opencodeByDir.has(key) ? 'ambiguous' : s);
  }
  for (const { directory, parsed } of readOpencode()) {
    const hit = directory ? opencodeByDir.get(path.resolve(directory)) : null;
    attribute(hit && hit !== 'ambiguous' ? hit : null, parsed);
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

function memoized() {
  if (resultMemo.val && Date.now() - resultMemo.ts < TTL) return resultMemo.val;
  const val = build().catch(() => ({ perSession: new Map(), digests: new Map(), other: emptyStats(), totals: emptyStats(), sessions: store.list() }));
  resultMemo = { ts: Date.now(), val };
  return val;
}

export async function buildTraces() {
  const { perSession, other, totals, sessions } = await memoized();
  return {
    sessions: sessions
      .filter((s) => perSession.has(s.id))
      .map((s) => ({ id: s.id, name: s.name, cli: s.cli, path: s.path, ...perSession.get(s.id) }))
      .sort((a, b) => b.lastTs - a.lastTs),
    other: other.files ? other : null,
    totals,
    generatedAt: new Date().toISOString(),
  };
}

/** Per-session "since your last prompt" digests, keyed by session id. */
export async function traceDigests() {
  const { digests } = await memoized();
  return digests;
}
