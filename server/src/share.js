// Session sharing: publish one agent session's trace as a Hub dataset.
// Design and rationale: docs/session-sharing.md (§4 bundle, §5 access, §6 pipeline).
//
// Phase 1 scope: Claude Code only, trace only, publish + optional per-user
// access grants. Mailbox delivery (the PR on a recipient's am-inbox) is §5 and
// lands separately.
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
import { WORKSPACES_DIR } from './config.js';

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

/** The `cwd` a transcript records, read from its first line without slurping the file. */
async function transcriptCwd(p) {
  let fh;
  try {
    fh = await fsp.open(p, 'r');
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const nl = buf.indexOf(0x0a);
    const line = buf.toString('utf8', 0, nl >= 0 ? nl : bytesRead);
    return JSON.parse(line).cwd || null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
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
export async function shareSession(session, { visibility = 'public', name, grantTo = [], notify = [], allSessions = [] } = {}) {
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

    // Recipients of a PUBLIC share can't be granted anything — there is nothing
    // to grant — so tell them instead. Gated shares grant AND tell.
    const tell = [...new Set([...notify, ...(visibility === 'gated' ? granted : [])])];
    const { notified, notifyErrors } = tell.length
      ? await notifyRecipients(tell, { repo, sha, visibility, from: process.env.SPACE_AUTHOR_NAME || ns })
      : { notified: [], notifyErrors: [] };

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
      notified,
      notifyErrors,
    };
  } finally {
    // The bundle is a copy; the session's own transcript is untouched.
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}


/**
 * Notify recipients by opening a PULL REQUEST on their `am-inbox` dataset that
 * adds `incoming/<envelope-id>.json` (§5). No inbound connectivity is involved:
 * both sides only make outbound calls to the Hub, which is all a private Space
 * can do. A non-collaborator can open a PR, which is what makes this work
 * without the recipient granting anyone write access.
 *
 * A PR rather than a plain discussion because merging IS accepting: the envelope
 * lands in the inbox as a file, and closing the PR is a decline. The recipient's
 * poll reads open PRs and matches authors against their whitelist.
 *
 * The inbox repo's EXISTENCE is the opt-in — if a user has none they have not
 * enabled receiving, and we say so rather than creating one on their behalf.
 *
 * The envelope stays minimal because the inbox is public: who, when, and where
 * to fetch. Nothing about what the session contains (§5, Q5).
 */
export async function notifyRecipients(users, { repo, sha, visibility, from }) {
  const notified = [];
  const notifyErrors = [];
  for (const user of users) {
    const inbox = `${user}/am-inbox`;
    let info;
    try {
      info = await hfApi(`/api/datasets/${inbox}`);
    } catch (e) {
      notifyErrors.push({ user, error: e.status === 401 || e.status === 404
        ? 'no am-inbox repo — they have not enabled receiving'
        : e.message });
      continue;
    }
    const id = crypto.randomUUID();
    const envelope = { v: 1, kind: 'trace', id, from, ts: new Date().toISOString(), repo, sha, visibility };
    // NDJSON commit payload: a header line then one line per file operation.
    const body = [
      JSON.stringify({ key: 'header', value: {
        summary: `Trace from ${from}`,
        description: `${from} shared an agent session. Merge to accept, close to decline.`,
      } }),
      JSON.stringify({ key: 'file', value: {
        path: `incoming/${id}.json`,
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(envelope, null, 2) + '\n', 'utf8').toString('base64'),
      } }),
    ].join('\n') + '\n';
    try {
      const r = await fetch(`${HF}/api/datasets/${inbox}/commit/main?create_pr=1`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${hfToken()}`,
          'content-type': 'application/x-ndjson',
          'user-agent': 'agent-manager',
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`HF ${r.status}: ${text.slice(0, 160)}`);
      notified.push(user);
    } catch (e) {
      notifyErrors.push({ user, error: e.message });
    }
  }
  return { notified, notifyErrors };
}


/**
 * The inbox repo is the opt-in for receiving traces (§5): with none, the Hub
 * itself refuses every delivery, so there is nothing for us to enforce. Reported
 * as state rather than a stored flag — the Hub is the source of truth, and a repo
 * deleted from the website must not leave a setting claiming otherwise.
 */
export async function inboxState() {
  const ns = await shareNamespace();
  if (!ns) return { namespace: null, repo: null, enabled: false, reason: 'no-hf-token' };
  const repo = `${ns}/am-inbox`;
  try {
    await hfApi(`/api/datasets/${repo}`);
    return { namespace: ns, repo, enabled: true, url: `${HF}/datasets/${repo}` };
  } catch (e) {
    if (e.status === 401 || e.status === 404) return { namespace: ns, repo, enabled: false };
    throw e;
  }
}

/**
 * Turn receiving on or off by creating or deleting that repo.
 *
 * Deleting throws away any pending delivery PRs with it, which is the honest
 * meaning of "stop accepting traces" — but it is destructive, so the caller has
 * to have meant it. Kept public: senders must be able to open a PR without being
 * granted write access, and that is only possible on a repo they can see.
 */
export async function setInbox(enabled) {
  const state = await inboxState();
  if (!state.namespace) throw new Error('no HF_TOKEN — cannot manage the inbox');
  if (enabled === state.enabled) return state;
  if (enabled) {
    await hfApi('/api/repos/create', {
      method: 'POST',
      body: { type: 'dataset', name: 'am-inbox', organization: state.namespace, private: false },
    });
  } else {
    await hfApi('/api/repos/delete', { method: 'DELETE',
      body: { type: 'dataset', name: 'am-inbox', organization: state.namespace } });
  }
  return inboxState();
}

/** Current access state of a share, for a "who can see this" panel. */
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
