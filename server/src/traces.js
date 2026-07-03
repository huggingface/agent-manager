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
  return { lastPromptText: '', lastPromptTs: 0, lastAssistantText: '', lastAssistantMd: '', lastAssistantTs: 0, sinceTurns: 0, sinceToolCalls: 0, sinceTools: {}, sinceFiles: [] };
}
const clip = (s, n = 280) => { const t = (s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// Markdown-preserving variant (keeps newlines) for the expandable card view.
const clipRaw = (s, n = 6000) => { const t = (s || '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
function digestPrompt(d, text, ts) {
  d.lastPromptText = clip(text); d.lastPromptTs = Date.parse(ts) || 0;
  d.sinceTurns = 0; d.sinceToolCalls = 0; d.sinceTools = {}; d.sinceFiles = [];
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
            if (t.trim() && !t.trim().startsWith('<')) digestPrompt(dg, t, j.timestamp);
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
  }
  return { stats: st, digest: dg };
}

async function statsFor(p, parser) {
  let m;
  try { m = await fsp.stat(p); } catch { return null; }
  const key = `${m.mtimeMs}:${m.size}`;
  const c = fileCache.get(p);
  if (c && c.key === key) return c.parsed;
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
