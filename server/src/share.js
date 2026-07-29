// Session sharing: publish one agent session's trace as a Hub dataset.
// Design and rationale: docs/session-sharing.md (§4 bundle, §5 access, §6 pipeline).
//
// Scope: trace only, publish + optional per-user access grants. Telling the
// recipient is deliberately NOT here — the operator sends them the dataset link
// and they open it with the Trace button in their own Space. The mailbox design
// (a PR on a recipient's am-inbox) is kept in docs/session-sharing.md §5 for
// whenever that is picked up; it is not in the code.
//
// Two hard rules this module exists to honour:
//
//  1. NOTHING heavy runs on the event loop. A transcript is routinely megabytes
//     and redaction is a regex sweep over all of it, so the bundle is built in a
//     CHILD PROCESS (scripts/share-session.mjs) — the same script that can be run
//     by hand. This app already wedged once on synchronous work (see
//     watchdog.js), and a share must never be the next cause.
//  2. Redaction is not optional, and a public share BLOCKS on any secret hit.
//     The exporter reports what it caught; we refuse to publish rather than
//     asking the operator to notice a warning.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { WORKSPACES_DIR, DATA_DIR } from './config.js';

const HF = 'https://huggingface.co';
const hfToken = () =>
  process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || process.env.HF_API_TOKEN || null;

// Repo root, so we can find scripts/share-session.mjs from server/src/.
const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const EXPORTER = path.join(REPO_ROOT, 'scripts', 'share-session.mjs');

// Rules whose hits must block a PUBLIC share. `email` is deliberately NOT here:
// it is redacted like everything else, but a redacted address is not a reason to
// refuse — a leaked credential is.
const isSecretRule = (rule) => rule !== 'email' && rule !== 'unparseable-line';

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 300_000, maxBuffer: 8 << 20, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout || '');
        err.stderr = String(stderr || '');
        return reject(err);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });

async function hfApi(pathname, { method = 'GET', body } = {}) {
  const token = hfToken();
  if (!token) throw new Error('no HF_TOKEN — add it as a Space secret to share sessions');
  const r = await fetch(`${HF}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': 'agent-manager',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!r.ok) {
    const msg = (json && (json.error || json.message)) || text.slice(0, 200) || r.statusText;
    const e = new Error(`HF ${r.status}: ${msg}`);
    e.status = r.status;
    throw e;
  }
  return json;
}

/** The Hub username this Space's token belongs to — the namespace we publish under. */
export async function shareNamespace() {
  if (!hfToken()) return null;
  try {
    const me = await hfApi('/api/whoami-v2');
    return (me && me.name) || null;
  } catch {
    return null;
  }
}

/**
 * Locate a Claude session's transcript. The filename IS the session id, so this
 * is a search for `<sessionUuid>.jsonl` under any projects/ dir we know about.
 * Returns null when the session has never produced a transcript.
 *
 * Claude keys its project dir on the working directory, so the SAME session id
 * can appear under more than one of them — resuming a session from a different
 * cwd (e.g. after moving into a git worktree) relocates it. Claude normally
 * moves the file rather than forking it, but if both ever exist the newest is
 * the live one, so pick by mtime instead of trusting directory order.
 */
/** Every Claude transcript on disk. Mirrors claudeFiles() in traces.js. */
async function claudeTranscripts() {
  const home = process.env.HOME || '';
  const roots = [process.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), path.join(home, '.config', 'claude')]
    .filter(Boolean)
    .filter((d, i, a) => a.indexOf(d) === i);
  const out = [];
  for (const root of roots) {
    const proj = path.join(root, 'projects');
    let entries = [];
    try { entries = await fsp.readdir(proj, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      let files = [];
      try { files = await fsp.readdir(path.join(proj, e.name)); } catch { continue; }
      for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(proj, e.name, f));
    }
  }
  return out;
}

/**
 * The `cwd` a transcript records, without slurping the file.
 *
 * NOT the first line. A transcript opens with metadata lines that carry no cwd
 * at all — `mode`, `permission-mode`, `file-history-snapshot`, `ai-title`,
 * `worktree-state` — and only the conversation lines have it. Measured across
 * ten real transcripts: the first line with a cwd is line 4 or 5 every time.
 * Reading line 1 alone always returned null, which silently disabled the
 * cwd-attribution fallback below for its whole existence.
 *
 * Bounded on both axes: a `file-history-snapshot` line can be megabytes, so cap
 * bytes as well as lines rather than trusting either alone.
 */
const CWD_SCAN_LINES = 64;
const CWD_SCAN_BYTES = 512 * 1024;

async function transcriptHead(p) {
  let fh;
  try {
    fh = await fsp.open(p, 'r');
    let carry = '';
    let read = 0;
    let lines = 0;
    while (read < CWD_SCAN_BYTES && lines < CWD_SCAN_LINES) {
      const buf = Buffer.alloc(Math.min(65536, CWD_SCAN_BYTES - read));
      const { bytesRead } = await fh.read(buf, 0, buf.length, read);
      if (!bytesRead) break;
      read += bytesRead;
      carry += buf.toString('utf8', 0, bytesRead);
      let nl;
      while ((nl = carry.indexOf('\n')) >= 0 && lines < CWD_SCAN_LINES) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        lines++;
        if (!line.trim()) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j && j.cwd) return { cwd: j.cwd, timestamp: j.timestamp || null };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function transcriptCwd(p) {
  const head = await transcriptHead(p);
  return (head && head.cwd) || null;
}

/**
 * Locate a Claude session's transcript.
 *
 * Normally the filename IS the session id. Two things stop that being enough:
 *
 *  - Claude keys its project dir on the working directory, so one session id can
 *    appear under several of them (resuming from a different cwd, e.g. after
 *    moving into a git worktree, relocates it). Pick the newest by mtime.
 *  - The pin can be WRONG. runner.js launches `claude --session-id <uuid> ||
 *    exec claude`; when the first invocation exits non-zero (onboarding on a
 *    fresh install does this), the fallback starts Claude with an id of its own
 *    and the session's sessionUuid matches nothing on disk. Observed live.
 *
 * So fall back to attributing by working directory — the same approach traces.js
 * already uses for codex/hermes/opencode, including the ambiguity guard: only
 * claim a transcript by cwd when this session has that folder to itself.
 */
export async function findTranscript(session, allSessions = []) {
  const files = await claudeTranscripts();

  // 1. By pinned id. `startsWith` rather than an exact name, matching the
  //    `<uuid>*` glob runner.js uses for its own transcript check.
  if (session.sessionUuid) {
    let best = null;
    for (const p of files) {
      if (!path.basename(p).startsWith(session.sessionUuid)) continue;
      try {
        const st = await fsp.stat(p);
        if (!best || st.mtimeMs > best.mtimeMs) best = { p, mtimeMs: st.mtimeMs };
      } catch { /* raced away */ }
    }
    if (best) return best.p;
  }

  // 2. By working directory, only if unambiguous.
  const folder = session.path ?? session.id;
  const workdir = path.join(WORKSPACES_DIR, folder);
  const rivals = allSessions.filter((o) => o.id !== session.id && o.cli === 'claude' && (o.path ?? o.id) === folder);
  if (rivals.length) return null; // shared folder — refuse to guess

  let best = null;
  for (const p of files) {
    if (await transcriptCwd(p) !== workdir) continue;
    try {
      const st = await fsp.stat(p);
      if (!best || st.mtimeMs > best.mtimeMs) best = { p, mtimeMs: st.mtimeMs };
    } catch { /* raced away */ }
  }
  return best && best.p;
}

/**
 * Locate a codex session's rollout.
 *
 * Codex picks its own conversation id, and runner.js captures it after launch
 * (codexSessionId + codexRollout), so the pinned path is authoritative when it
 * still exists. Otherwise fall back to the newest rollout whose recorded cwd is
 * this session's folder -- with the same ambiguity guard as the Claude path, and
 * additionally skipping codex's internal guardian/subagent rollouts, which share
 * the cwd but are not the user's conversation.
 */
export async function findRollout(session, allSessions = []) {
  if (session.codexRollout) {
    try { if ((await fsp.stat(session.codexRollout)).isFile()) return session.codexRollout; } catch { /* rotated away */ }
  }

  const folder = session.path ?? session.id;
  const workdir = path.join(WORKSPACES_DIR, folder);
  if (allSessions.some((o) => o.id !== session.id && o.cli === 'codex' && (o.path ?? o.id) === folder)) return null;

  const root = path.join(process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'), 'sessions');
  const found = [];
  const walk = async (dir, depth) => {
    if (depth > 5) return;
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) found.push(p);
    }
  };
  await walk(root, 0);

  let best = null;
  for (const p of found) {
    let meta;
    try { meta = JSON.parse(await firstLineOf(p)); } catch { continue; }
    const mp = (meta && meta.payload) || {};
    if (mp.cwd !== workdir) continue;
    if (mp.thread_source === 'subagent' || (mp.source && mp.source.subagent)) continue;
    try {
      const st = await fsp.stat(p);
      if (!best || st.mtimeMs > best.mtimeMs) best = { p, mtimeMs: st.mtimeMs };
    } catch { /* raced away */ }
  }
  return best && best.p;
}

/** First line of a file without reading all of it (codex meta lines are large). */
async function firstLineOf(p) {
  let fh;
  try {
    fh = await fsp.open(p, 'r');
    const buf = Buffer.alloc(131072);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const nl = buf.indexOf(0x0a);
    return buf.toString('utf8', 0, nl >= 0 ? nl : bytesRead);
  } finally {
    await fh?.close().catch(() => {});
  }
}

const opencodeDbPath = () =>
  path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || '', '.local', 'share'), 'opencode', 'opencode.db');
const hermesDbPath = () => path.join(process.env.HOME || '', '.hermes', 'state.db');

/**
 * SQLite-backed harnesses. The trace is a QUERY, not a file, so what we locate
 * is (db path, session id). Never the db itself — opencode's holds OAuth tokens
 * (§2), which is why the exporter selects one conversation rather than copying.
 *
 * opencode carries a pin (runner.js captures opencodeSessionId); hermes has none,
 * so it is attributed by recorded cwd, with the usual ambiguity guard.
 */
async function findDbSession(session, allSessions) {
  const folder = session.path ?? session.id;
  const workdir = path.join(WORKSPACES_DIR, folder);
  const rivals = allSessions.some((o) => o.id !== session.id && o.cli === session.cli && (o.path ?? o.id) === folder);

  if (session.cli === 'opencode') {
    const db = opencodeDbPath();
    if (!fs.existsSync(db)) return null;
    if (session.opencodeSessionId) return { db, sessionId: session.opencodeSessionId };
    if (rivals) return null;
    const id = await queryNewest(db, 'select id from session where directory = ? order by time_updated desc limit 1', workdir);
    return id && { db, sessionId: id };
  }
  if (session.cli === 'hermes') {
    const db = hermesDbPath();
    if (!fs.existsSync(db)) return null;
    if (rivals) return null;
    const id = await queryNewest(db, 'select id from sessions where cwd = ? order by started_at desc limit 1', workdir);
    return id && { db, sessionId: String(id) };
  }
  return null;
}

// One tiny read-only query, off the request path (share runs async) and never on
// a hot loop — these dbs are the wedge-prone ones (traces.js, watchdog.js).
async function queryNewest(dbPath, sql, arg) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return null; }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare(sql).get(arg);
    return (row && row.id) || null;
  } catch { return null; } finally { try { db?.close(); } catch {} }
}

/** OpenClaw writes one JSONL per session under agents/<agent>/sessions/. */
async function findOpenClaw(session, allSessions) {
  const folder = session.path ?? session.id;
  if (allSessions.some((o) => o.id !== session.id && o.cli === 'openclaw' && (o.path ?? o.id) === folder)) return null;
  const home = process.env.OPENCLAW_HOME || process.env.HOME || '';
  const agents = path.join(home, '.openclaw', 'agents');
  let best = null;
  const walk = async (dir, depth) => {
    if (depth > 4) return;
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        try { const st = await fsp.stat(p); if (!best || st.mtimeMs > best.mtimeMs) best = { p, mtimeMs: st.mtimeMs }; } catch {}
      }
    }
  };
  await walk(agents, 0);
  return best && best.p;
}

/**
 * The trace for any supported harness, as { src, sessionId } — sessionId is only
 * meaningful for the db-backed ones, where it selects the conversation.
 */
export async function findTrace(session, allSessions = []) {
  switch (session.cli) {
    case 'claude': { const p = await findTranscript(session, allSessions); return p && { src: p }; }
    case 'codex': { const p = await findRollout(session, allSessions); return p && { src: p }; }
    case 'openclaw': { const p = await findOpenClaw(session, allSessions); return p && { src: p }; }
    case 'opencode':
    case 'hermes': {
      const hit = await findDbSession(session, allSessions);
      return hit && { src: hit.db, sessionId: hit.sessionId };
    }
    default: return null;
  }
}

export const SHAREABLE_CLIS = ['claude', 'codex', 'hermes', 'opencode', 'openclaw'];
export const HARNESS_LABEL = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes',
                               opencode: 'opencode', openclaw: 'OpenClaw' };

/** Dataset card. `configs` pins the data file so meta/ can't collide on schema (§4). */
function datasetCard({ title, visibility, traceName, stats, redaction, harnessLabel }) {
  const gated = visibility === 'gated';
  const gateBlock = gated
    ? `extra_gated_heading: "Request access to this agent session"
extra_gated_prompt: >-
  This repository holds a coding-agent trace. Agent traces can contain source code, local
  file paths, command output and other context from the machine that produced them. Access
  is granted per user so the owner can see who has read the session.
`
    : '';
  const redactionLine = Object.entries(redaction || {})
    .map(([k, v]) => `${k} × ${v}`)
    .join(', ') || 'nothing matched';

  return `---
pretty_name: ${JSON.stringify(title)}
license: apache-2.0
language:
  - en
tags:
  - agent-traces
  - agent-manager
  - coding-agent
  - traces
  - tool-use
configs:
  - config_name: default
    data_files:
      - split: train
        path: "*.jsonl"
${gateBlock}---

# ${title}

One ${harnessLabel} session, exported from [Agent Manager](https://huggingface.co/spaces/lvwerra/agent-manager-template).

${gated
    ? '> **Access: gated.** The repo and this card are listed publicly, but the trace itself requires per-user approval.'
    : '> **Access: public.** Anyone with the link can read this trace.'}

## At a glance

- **${stats.prompts}** prompts · **${stats.turns}** assistant turns · **${stats.toolCalls}** tool calls
- Trace: \`${traceName}\`

## What's in here

| Path | Contents |
|---|---|
| \`${traceName}\` | the session, native ${harnessLabel} JSONL |
| \`meta/manifest.json\` | provenance: harness, session ids, stats, content hash, lineage |
| \`meta/briefing.md\` | mechanically generated handoff summary |
| \`meta/redaction.json\` | which redaction rules ran and what they caught |

## Redaction

Before upload the trace passed ruleset v1: token-shaped patterns, **value** matching against
this Space's secret-bearing environment variables, and an email rule. Derived artifacts go
through the same pass. \`file-history-snapshot\` lines are dropped — they embed full file
contents. Result: ${redactionLine}.

Traces can still contain local paths and command output. Review before relying on this being clean.
`;
}

/**
 * Build the share bundle for a session in a temp dir. Runs the exporter as a
 * child process (see rule 1 at the top of this file).
 * Returns { dir, report } where report is the exporter's JSON summary.
 */
export async function buildBundle(session, { title, visibility, allSessions = [] }) {
  const hit = await findTrace(session, allSessions);
  if (!hit) throw new Error('no transcript on disk for this session yet — run it first');

  // The exporter must be present in the image (Dockerfile copies scripts/).
  // Fail with the actual cause rather than an unparseable-output error.
  if (!fs.existsSync(EXPORTER)) throw new Error(`exporter missing at ${EXPORTER} — scripts/ was not deployed`);

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'am-share-'));
  const { stdout } = await run(process.execPath, [EXPORTER, hit.src, dir, session.cli, hit.sessionId || '-'], {
    // The exporter matches env-var VALUES against the trace, so it needs the
    // same environment we have — that is the point of the value rules.
    env: process.env,
    cwd: REPO_ROOT,
  });

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error(`exporter produced no report: ${stdout.slice(0, 200)}`);
  }

  await fsp.writeFile(
    path.join(dir, 'README.md'),
    datasetCard({
      title,
      visibility,
      traceName: report.trace,
      stats: report.stats,
      redaction: report.redaction_hits,
      harnessLabel: HARNESS_LABEL[session.cli] || session.cli,
    }),
  );

  return { dir, report };
}

/**
 * Publish a session as a dataset repo.
 *
 * @param session          the session record
 * @param visibility       'public' | 'gated'
 * @param name             optional repo name (namespace is this token's user)
 * @param grantTo          usernames to pre-authorize (gated only)
 */
export async function shareSession(session, { visibility = 'public', name, grantTo = [], allSessions = [] } = {}) {
  if (!['public', 'gated'].includes(visibility)) throw new Error(`bad visibility: ${visibility}`);
  const ns = await shareNamespace();
  if (!ns) throw new Error('cannot resolve the Hub namespace — check HF_TOKEN');

  const slug = (name || session.name || 'session')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
  const repo = `${ns}/am-session-${slug}-${(session.sessionUuid || '').slice(0, 6)}`;

  const title = `Agent Manager session — ${session.name || slug}`;
  const { dir, report } = await buildBundle(session, { title, visibility, allSessions });

  try {
    // Redaction gate. A public share must not go out with a credential in it,
    // and "we warned you" is not good enough for something irreversible.
    const secrets = Object.entries(report.redaction_hits || {}).filter(([r]) => isSecretRule(r));
    if (visibility === 'public' && secrets.length) {
      const e = new Error(`refusing to publish publicly: ${secrets.map(([r, n]) => `${r} × ${n}`).join(', ')}`);
      e.code = 'redaction-blocked';
      e.hits = report.redaction_hits;
      throw e;
    }

    // Gated repos are public repos with an access gate, so never --private here.
    await run('hf', ['repo', 'create', repo, '--type', 'dataset', '--no-private', '--exist-ok'])
      .catch(async (err) => {
        // Older/newer CLI may not have --exist-ok; a already-exists failure is fine.
        if (/exists/i.test(err.stderr || err.message || '')) return;
        // Fall back to the HTTP API, which is explicit about the namespace.
        await hfApi('/api/repos/create', {
          method: 'POST',
          body: { type: 'dataset', name: repo.split('/')[1], organization: ns, private: false },
        }).catch(() => { throw err; });
      });

    await run('hf', ['upload', repo, dir, '.', '--type', 'dataset',
      '--commit-message', 'Add Agent Manager session trace']);

    // Gating must be set BEFORE granting: grant_access 400s on a non-gated repo.
    if (visibility === 'gated') {
      await hfApi(`/api/datasets/${repo}/settings`, { method: 'PUT', body: { gated: 'manual' } });
    }

    const granted = [];
    const grantErrors = [];
    if (visibility === 'gated') {
      for (const user of grantTo) {
        try {
          await hfApi(`/api/datasets/${repo}/user-access-request/grant`, { method: 'POST', body: { user } });
          granted.push(user);
        } catch (e) {
          // 400 already-has-access is a success from the caller's point of view.
          if (e.status === 400 && /already/i.test(e.message)) granted.push(user);
          else grantErrors.push({ user, error: e.message });
        }
      }
    }

    const info = await hfApi(`/api/datasets/${repo}`).catch(() => null);
    const sha = (info && info.sha) || null;

    // Telling the recipient is out of scope: the operator sends them the link.
    return {
      repo,
      visibility,
      url: `${HF}/datasets/${repo}`,
      sha,
      trace: report.trace,
      stats: report.stats,
      redaction: report.redaction_hits,
      dropped: report.dropped,
      granted,
      grantErrors,
    };
  } finally {
    // The bundle is a copy; the session's own transcript is untouched.
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}


export async function shareAccess(repo) {
  const [accepted, pending] = await Promise.all([
    hfApi(`/api/datasets/${repo}/user-access-request/accepted`).catch(() => []),
    hfApi(`/api/datasets/${repo}/user-access-request/pending`).catch(() => []),
  ]);
  const names = (rows) => (Array.isArray(rows) ? rows.map((r) => r.user?.user || r.username || null).filter(Boolean) : []);
  return { accepted: names(accepted), pending: names(pending) };
}

export async function grantAccess(repo, users) {
  const granted = [];
  for (const user of users) {
    await hfApi(`/api/datasets/${repo}/user-access-request/grant`, { method: 'POST', body: { user } });
    granted.push(user);
  }
  return granted;
}

/**
 * Revoke access. Must move the user to `rejected`, not `pending`: a user added
 * by grant_access never filed a request, so the "cancel" path (which moves a
 * request back to pending) 404s with "No pending access request found". Learned
 * the hard way — the hub docstring lists both as revocation options.
 */
export async function revokeAccess(repo, users) {
  const revoked = [];
  for (const user of users) {
    await hfApi(`/api/datasets/${repo}/user-access-request/handle`, {
      method: 'POST',
      body: { user, status: 'rejected' },
    });
    revoked.push(user);
  }
  return revoked;
}

// ---------- receiving: materialise a shared trace on this Space ----------
// A share bundle IS a dataset repo: one `<name>.jsonl` at the root plus `meta/`.
// Pulling it into DATA_DIR/traces/<ref>/ is all a trace pane needs to render it
// (traces.js readTraceBundle), and it is exactly the step the accept-a-delivery
// flow will perform once the inbox side lands — so it lives here, not in a
// one-off script.
//
// Works for a private repo because the request carries this Space's token: the
// dataset viewer is blocked for a gated/private repo, authenticated download is
// not (docs/session-sharing.md §5).

export const TRACES_DIR = path.join(DATA_DIR, 'traces');

// A local directory name for a repo id. Must satisfy the route's `[\w.-]+`
// guard, so the namespace separator becomes '--'.
export const bundleRef = (repo) => repo.replace(/\//g, '--');

const MAX_TRACE_BYTES = 96 << 20; // a 6 MB session is normal; 96 MB is a mistake

/** Stream one file out of a dataset repo to disk. Never buffers it in memory. */
async function downloadTo(repo, rev, file, dest) {
  const token = hfToken();
  const url = `${HF}/datasets/${repo}/resolve/${encodeURIComponent(rev)}/${file.split('/').map(encodeURIComponent).join('/')}`;
  const r = await fetch(url, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'user-agent': 'agent-manager' },
    redirect: 'follow',
    signal: AbortSignal.timeout(300_000),
  });
  if (!r.ok) throw new Error(`HF ${r.status} fetching ${file}`);
  const declared = Number(r.headers.get('content-length') || 0);
  if (declared > MAX_TRACE_BYTES) throw new Error(`${file} is ${Math.round(declared / 1e6)} MB — refusing to import`);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const { Writable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  const out = fs.createWriteStream(dest);
  let bytes = 0;
  await pipeline(
    r.body,
    new Writable({
      write(chunk, _enc, cb) {
        bytes += chunk.length;
        if (bytes > MAX_TRACE_BYTES) return cb(new Error(`${file} exceeded ${MAX_TRACE_BYTES} bytes mid-download`));
        out.write(chunk, cb);
      },
      final(cb) { out.end(cb); },
      destroy(err, cb) { out.destroy(); cb(err); },
    }),
  );
  return bytes;
}

/**
 * Import a share bundle from a dataset repo into DATA_DIR/traces/<ref>/.
 * Returns { ref, dir, repo, sha, files, bytes, manifest } — `ref` is what a
 * trace pane's traceSource.ref should be set to.
 */
export async function importBundle(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Object.assign(new Error('expected a dataset id like "user/name"'), { code: 'bad-repo' });
  if (!hfToken()) throw Object.assign(new Error('no HF_TOKEN — add it as a Space secret to open shared traces'), { code: 'no-hf-token' });

  let info;
  try {
    info = await hfApi(`/api/datasets/${repo}`);
  } catch (e) {
    // 401/403/404 all mean the same thing to the operator: this token can't read
    // that repo. Say so, rather than leaking a status code into the UI.
    if (e.status === 404 || e.status === 401 || e.status === 403) {
      throw Object.assign(new Error(`can't read ${repo} — it doesn't exist, or this Space's token has no access`), { code: 'no-access' });
    }
    throw e;
  }

  const names = (info.siblings || []).map((s) => s.rfilename);
  const traces = names.filter((n) => n.endsWith('.jsonl') && !n.includes('/'));
  if (!traces.length) throw Object.assign(new Error(`${repo} has no trace file at its root — is it a session share?`), { code: 'not-a-bundle' });
  // One session per repo is the share unit (§4). More than one means this is
  // some other dataset that happens to hold jsonl; guessing would be wrong.
  if (traces.length > 1) throw Object.assign(new Error(`${repo} holds ${traces.length} .jsonl files; a session share has exactly one`), { code: 'not-a-bundle' });

  const wanted = [traces[0], ...names.filter((n) => n.startsWith('meta/'))];
  const ref = bundleRef(repo);
  const dir = path.join(TRACES_DIR, ref);
  // Re-importing replaces: a bundle is a snapshot of a repo revision, and half
  // of an old one mixed with half of a new one is worse than either.
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });

  const rev = info.sha || 'main';
  let bytes = 0;
  for (const file of wanted) bytes += await downloadTo(repo, rev, file, path.join(dir, file));

  let manifest = null;
  try { manifest = JSON.parse(await fsp.readFile(path.join(dir, 'meta', 'manifest.json'), 'utf8')); } catch { /* older bundle, or none */ }

  // Provenance: where this came from and when. A received trace that can't say
  // whose it is has lost the thing that makes it trustworthy.
  await fsp.writeFile(path.join(dir, 'meta', 'source.json'), JSON.stringify({
    repo, sha: rev, private: !!info.private, gated: info.gated || false,
    author: info.author || null, importedAt: new Date().toISOString(),
    url: `${HF}/datasets/${repo}`,
  }, null, 2));

  return { ref, dir, repo, sha: rev, files: wanted, bytes, manifest };
}

/** Bundles already on disk, newest import first. */
export async function listBundles() {
  const out = [];
  for (const name of await fsp.readdir(TRACES_DIR).catch(() => [])) {
    const dir = path.join(TRACES_DIR, name);
    try { if (!(await fsp.stat(dir)).isDirectory()) continue; } catch { continue; }
    let source = null, manifest = null;
    try { source = JSON.parse(await fsp.readFile(path.join(dir, 'meta', 'source.json'), 'utf8')); } catch {}
    try { manifest = JSON.parse(await fsp.readFile(path.join(dir, 'meta', 'manifest.json'), 'utf8')); } catch {}
    out.push({
      ref: name,
      repo: (source && source.repo) || null,
      url: (source && source.url) || null,
      importedAt: (source && source.importedAt) || null,
      harness: (manifest && manifest.harness && (manifest.harness.name || manifest.harness.id)) || null,
      name: (manifest && manifest.session && manifest.session.name) || null,
      from: (manifest && manifest.origin && manifest.origin.user) || null,
    });
  }
  return out.sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')));
}
