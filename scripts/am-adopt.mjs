#!/usr/bin/env node
// Register the Claude conversation running in this folder as a stopped AM
// Claude session (POST /api/agents/adopt). Run it from inside that conversation:
//
//   node scripts/am-adopt.mjs [uuid] [--name NAME] [--group GROUP] [--dry-run]
//
// Without a uuid, the most recently written transcript of this folder's Claude
// project (${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<cwd>/) is taken — that is
// the conversation running this command. The folder sent to AM is the current
// directory relative to $AM_ROOT. Nothing starts: exit this claude process
// before opening the new session in AM, or two processes resume one conversation.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { UUID_RE, claudeConfigDir, projectDirName } from '../server/src/claude-adopt.js';

const die = (message) => { console.error(`am-adopt: ${message}`); process.exit(1); };

export function parseArgs(argv) {
  const opts = { uuid: null, name: '', group: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name' || a === '--group') {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = argv[++i];
    } else if (a === '--dry-run') opts.dryRun = true;
    else if (!a.startsWith('-') && !opts.uuid) opts.uuid = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return opts;
}

// Newest <uuid>.jsonl in the project directory Claude uses for `cwd`.
export function newestTranscript(cwd, configDir = claudeConfigDir()) {
  const dir = path.join(configDir, 'projects', projectDirName(cwd));
  let best = null;
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  for (const name of entries) {
    const uuid = name.replace(/\.jsonl$/, '');
    if (uuid === name || !UUID_RE.test(uuid)) continue;
    const mtime = fs.statSync(path.join(dir, name)).mtimeMs;
    if (!best || mtime > best.mtime) best = { uuid, mtime };
  }
  return best?.uuid ?? null;
}

export function workspaceFolder(cwd, root) {
  const rel = path.relative(path.resolve(root), path.resolve(cwd));
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { die(e.message); }
  const env = process.env;
  if (!env.AM_ID) die('$AM_ID is not set — run this inside an Agent Manager pane');
  if (!env.AM_ROOT) die('$AM_ROOT is not set — run this inside an Agent Manager pane');
  const cwd = process.cwd();
  const folder = workspaceFolder(cwd, env.AM_ROOT);
  if (folder === null) die(`${cwd} is outside the workspaces root ${env.AM_ROOT}`);
  const uuid = opts.uuid || newestTranscript(cwd);
  if (!uuid) die(`no Claude transcript found for ${cwd}; pass the conversation uuid`);
  if (!UUID_RE.test(uuid)) die(`not a Claude session uuid: ${uuid}`);
  const q = new URLSearchParams({ adoptSessionUuid: uuid, path: folder, from: env.AM_ID });
  if (opts.name) q.set('name', opts.name);
  if (opts.group) q.set('group', opts.group);
  const url = `http://${env.AM_HOST || '127.0.0.1'}:${env.AM_PORT || '7860'}/api/agents/adopt?${q}`;
  if (opts.dryRun) { console.log(JSON.stringify({ url, uuid, path: folder }, null, 2)); return; }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'X-AM-Request': '1', 'X-AM-Message-Id': randomUUID() },
    signal: AbortSignal.timeout(15000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) die(`${r.status} ${body.code || ''} ${body.error || ''}`.trim());
  console.log(JSON.stringify(body, null, 2));
  console.error(`\nAdopted as '${body.id}' (stopped). ${body.note || ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => die(e.message || String(e)));
}
