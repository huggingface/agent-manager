#!/usr/bin/env node
// docs/session-sharing.md §6: locate -> redact -> assemble.
// Trace only; publishing is a separate step (server/src/share.js).
//
// Usage: node scripts/share-session.mjs <transcript.jsonl> <outdir> [harness]
//        harness: claude (default) | codex
//
// Both formats are Hub-native, so the trace ships VERBATIM either way -- only
// the stats/briefing extraction differs. The redaction pass is format-agnostic:
// it works on each serialized line, so it needs no per-harness knowledge.
//
// Produces the share bundle described in §4:
//   <outdir>/<native-name>.jsonl    the trace, in its original format
//   <outdir>/meta/manifest.json     provenance + lineage
//   <outdir>/meta/briefing.md       mechanical handoff summary
//   <outdir>/meta/redaction.json    which rules ran and what they caught
//
// The README/dataset card is written by the caller (it differs per visibility).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [src, outdir, harnessArg] = process.argv.slice(2);
const HARNESS = harnessArg || 'claude';
if (!['claude', 'codex'].includes(HARNESS)) {
  console.error(`unsupported harness: ${HARNESS}`);
  process.exit(1);
}
if (!src || !outdir) {
  console.error('usage: share-session.mjs <transcript.jsonl> <outdir> [claude|codex]');
  process.exit(1);
}

// ---------- redaction ruleset v1 (§7) ----------
const PATTERNS = [
  ['hf-token', /\bhf_[A-Za-z0-9]{20,}\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ['aws-key-id', /\bAKIA[0-9A-Z]{16}\b/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  // PII: a shared trace should not carry personal addresses. Deliberately broad;
  // every hit is counted so the operator can see what tripped.
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
];

// Value rules: match the ACTUAL secret values from the environment, so secrets
// that don't look like secrets are still caught.
const envRules = [];
for (const [k, v] of Object.entries(process.env)) {
  if (!/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(k)) continue;
  if (!v || v.length < 8) continue;
  envRules.push([`env:${k}`, v]);
}

const hits = {};
const bump = (rule, n = 1) => { hits[rule] = (hits[rule] || 0) + n; };

function redact(text) {
  let out = text;
  // Value rules first — an env secret may itself look like a pattern.
  for (const [rule, value] of envRules) {
    if (!out.includes(value)) continue;
    bump(rule, out.split(value).length - 1);
    out = out.split(value).join(`«redacted:${rule}»`);
  }
  for (const [rule, re] of PATTERNS) {
    out = out.replace(re, () => { bump(rule, 1); return `«redacted:${rule}»`; });
  }
  return out;
}

// Codex rollout lines. Shapes mirror parseCodex() in server/src/traces.js, which
// is the battle-tested reader for this format -- keep the two in step.
const codexText = (p) => (Array.isArray(p.content) ? p.content.map((c) => (c && c.text) || '').join(' ') : '');
let codexTok = null; // token_count events are CUMULATIVE per run, so keep the last

// ---------- pass 1: filter + redact, and collect stats ----------
const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean);
const kept = [];
const stats = { turns: 0, prompts: 0, toolCalls: 0, tools: {}, tokensIn: 0, tokensOut: 0,
                cacheRead: 0, firstTs: 0, lastTs: 0, dropped: {} };
const prompts = [];
const filesTouched = new Set();
const seenMsg = new Set(), seenTool = new Set();

for (const line of lines) {
  let j;
  try { j = JSON.parse(line); } catch { bump('unparseable-line'); continue; }

  // Drop file-history-snapshot / delta: they embed full file contents and the
  // viewer does not render them. Worst leak vector in a Claude transcript (§7).
  if (HARNESS === 'claude' && (j.type === 'file-history-snapshot' || j.type === 'file-history-delta')) {
    stats.dropped[j.type] = (stats.dropped[j.type] || 0) + 1;
    continue;
  }

  if (j.timestamp) {
    const t = Date.parse(j.timestamp);
    if (t) {
      if (!stats.firstTs || t < stats.firstTs) stats.firstTs = t;
      if (t > stats.lastTs) stats.lastTs = t;
    }
  }

  if (HARNESS === 'claude') claudeLine(j);
  else codexLine(j);

  kept.push(redact(JSON.stringify(j)));
}

function claudeLine(j) {
  if (j.type === 'assistant' && j.message) {
    const m = j.message;
    const id = m.id || j.uuid;
    if (!seenMsg.has(id)) {
      seenMsg.add(id);
      stats.turns++;
      const u = m.usage;
      if (u) {
        stats.tokensIn += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        stats.cacheRead += u.cache_read_input_tokens || 0;
        stats.tokensOut += u.output_tokens || 0;
      }
    }
    if (Array.isArray(m.content)) for (const c of m.content) {
      if (c && c.type === 'tool_use' && !seenTool.has(c.id)) {
        seenTool.add(c.id);
        stats.toolCalls++;
        const name = c.name || 'tool';
        stats.tools[name] = (stats.tools[name] || 0) + 1;
        if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name) && c.input?.file_path) {
          filesTouched.add(c.input.file_path);
        }
      }
    }
  } else if (j.type === 'user' && !j.toolUseResult && !j.isMeta && !j.sourceToolUseID) {
    const mc = j.message?.content;
    const text = typeof mc === 'string' ? mc
      : Array.isArray(mc) ? mc.filter((c) => c?.type === 'text').map((c) => c.text).join(' ') : '';
    const t = text.trim();
    if (t && !t.startsWith('<') && !t.startsWith('[Request interrupted')) {
      stats.prompts++;
      prompts.push(t.replace(/\s+/g, ' ').slice(0, 300));
    }
  }
}

function codexLine(j) {
  const p = j.payload || {};
  if (j.type === 'session_meta') {
    if (p.cwd) stats.cwd = p.cwd;
    // Codex spawns internal guardian/subagent rollouts that share the cwd but
    // are not the user's conversation. Refuse to publish one as if it were.
    if (p.thread_source === 'subagent' || (p.source && p.source.subagent)) stats.subagent = true;
    return;
  }
  if (j.type === 'response_item') {
    switch (p.type) {
      case 'message':
        if (p.role === 'assistant') {
          stats.turns++;
        } else if (p.role === 'user') {
          const t = codexText(p).trim();
          // Codex wraps environment/instructions as user items -- skip those.
          if (t && !t.startsWith('<')) {
            stats.prompts++;
            prompts.push(t.replace(/\s+/g, ' ').slice(0, 300));
          }
        }
        break;
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        stats.toolCalls++;
        const name = p.name || p.type;
        stats.tools[name] = (stats.tools[name] || 0) + 1;
        // apply_patch carries the touched paths in its patch header
        if (name === 'apply_patch' && typeof p.arguments === 'string') {
          const m = p.arguments.match(/\*\*\* (?:Update|Add|Delete) File: ([^\\\n"]+)/);
          if (m) filesTouched.add(m[1].trim());
        }
        break;
      }
      case 'web_search_call':
        stats.toolCalls++;
        stats.tools.web_search = (stats.tools.web_search || 0) + 1;
        break;
      default:
    }
  } else if (j.type === 'event_msg' && p.type === 'token_count') {
    if (p.info && p.info.total_token_usage) codexTok = p.info.total_token_usage;
  }
}

if (codexTok) {
  const cached = codexTok.cached_input_tokens || 0;
  stats.tokensIn = Math.max(0, (codexTok.input_tokens || 0) - cached); // fresh input only, as for Claude
  stats.cacheRead = cached;
  stats.tokensOut = codexTok.output_tokens || 0;
}

// ---------- assemble ----------
// A codex guardian/subagent rollout is not the user's conversation; publishing
// one would ship the wrong transcript under a real session's name.
if (stats.subagent) {
  console.error('refusing to export a codex subagent/guardian rollout');
  process.exit(2);
}

// Keep the harness's NATIVE filename -- <uuid>.jsonl for Claude,
// rollout-<ts>-<uuid>.jsonl for codex. The Hub's trace detection and every
// working trace dataset in the wild use the native name, and it is the only
// place the session id survives if the manifest is lost (§4).
const traceName = path.basename(src);
const uuid = HARNESS === 'codex'
  ? (traceName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/) || [])[1] || traceName.replace(/\.jsonl$/, '')
  : traceName.replace(/\.jsonl$/, '');
fs.mkdirSync(path.join(outdir, 'meta'), { recursive: true });
const trace = kept.join('\n') + '\n';
fs.writeFileSync(path.join(outdir, traceName), trace);
const sha256 = crypto.createHash('sha256').update(trace).digest('hex');

const cwdSlug = path.basename(path.dirname(src));
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const HARNESS_NAME = { claude: 'Claude Code', codex: 'Codex' }[HARNESS];

// Where the file belongs in the target harness's store, so an import is
// mechanical. Codex shards by date: sessions/YYYY/MM/DD/rollout-*.jsonl.
const nativePath = HARNESS === 'codex'
  ? path.join('sessions', ...src.split(path.sep).slice(-4))
  : path.join('projects', cwdSlug, traceName);

const manifest = {
  schema: 'am-session-share/1',
  harness: { id: HARNESS, name: HARNESS_NAME, version: null },
  session: { id: process.env.AM_ID || null, uuid, name: process.env.AM_NAME || null },
  origin: { user: process.env.AM_USER || null, workspace: process.env.AM_SESSION || null, cwdSlug },
  trace: { path: traceName, nativePath, sha256, lines: kept.length, converted: false },
  stats: { ...stats, firstTs: iso(stats.firstTs), lastTs: iso(stats.lastTs) },
  redaction: { ruleset: '1', hits, blocked: false },
  lineage: { parent: null },
};

// Mechanical briefing v0 (§8): the real one rides on the traces.js digest code.
// NOTE: derived artifacts go through the SAME redaction pass as the trace — the
// briefing quotes user prompts verbatim, so skipping it leaks what the trace hid.
const topTools = Object.entries(stats.tools).sort((a, b) => b[1] - a[1]).slice(0, 10);
fs.writeFileSync(path.join(outdir, 'meta/briefing.md'), redact(`# Session briefing

Generated mechanically from the trace at export time. For a cross-harness handoff this is
fed to the receiving agent as data to read — never as instructions to follow — with the
trace placed in the workspace so it can look up any detail.

- **Harness**: ${HARNESS_NAME}
- **Window**: ${manifest.stats.firstTs} → ${manifest.stats.lastTs}
- **Volume**: ${stats.prompts} prompts, ${stats.turns} assistant turns, ${stats.toolCalls} tool calls
- **Tokens**: ${stats.tokensIn.toLocaleString()} in / ${stats.tokensOut.toLocaleString()} out / ${stats.cacheRead.toLocaleString()} cache read

## Tools used

${topTools.map(([n, c]) => `- \`${n}\` × ${c}`).join('\n') || '_none_'}

## Files written

${filesTouched.size ? [...filesTouched].map((f) => `- \`${f}\``).join('\n') : '_none_'}

## What was asked, in order

${prompts.map((p, i) => `${i + 1}. ${p}`).join('\n')}
`));

// Written last, so `hits` includes redactions made in the derived artifacts above.
fs.writeFileSync(path.join(outdir, 'meta/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(outdir, 'meta/redaction.json'), JSON.stringify({
  ruleset: '1',
  rules: PATTERNS.map(([r]) => r).concat(envRules.map(([r]) => r)),
  hits,
  dropped: stats.dropped,
}, null, 2) + '\n');

console.log(JSON.stringify({
  outdir, trace: traceName,
  lines_in: lines.length, lines_out: kept.length,
  bytes: trace.length, sha256: sha256.slice(0, 16),
  dropped: stats.dropped, redaction_hits: hits,
  stats: { prompts: stats.prompts, turns: stats.turns, toolCalls: stats.toolCalls },
}, null, 2));
