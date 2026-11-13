// Is the agent state still being checkpointed to durable storage?
//
// scripts/agent-state.sh copies every harness's live tree to $DATA_DIR every
// few seconds, and after each pass writes what happened, per adapter, to
// $AM_LOCAL/agent-state-status/<adapter> as `key=value` lines. On 2026-11-06
// the Claude adapter started failing on every pass and nothing showed it for a
// week; the restart that followed brought back a week-old tree. This reads
// those files so /api/info can say so while it is happening.
//
// Local disk only, a handful of tiny files, cached for a few seconds: this
// rides on /api/info, which every open tab polls every 15 seconds.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// An adapter that has not had a clean pass for this long is reported. One
// failed pass is not news (a file can vanish mid-copy); five minutes of them is.
export const WARN_AFTER_MS = Number(process.env.AM_CHECKPOINT_WARN_SECONDS || 300) * 1000;
const CACHE_MS = 5000;

// No AM_LOCAL, no checkpoint loop (a local run): nothing to read.
const statusDir = () => (process.env.AM_LOCAL ? path.join(process.env.AM_LOCAL, 'agent-state-status') : null);
export const checkpointLogPath = () => process.env.AGENT_STATE_LOG || path.join(DATA_DIR, 'state', 'agent-state.log');

function parse(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}
const ms = (seconds) => (Number(seconds) > 0 ? Number(seconds) * 1000 : null);

/**
 * null when every adapter is being saved, which is the normal case and shows
 * nothing. Otherwise the adapters that are not, each with its reason:
 *   - `adapters`: failing on every pass since `since`, with no clean pass for
 *     WARN_AFTER_MS. `lastSuccessAt` is null when it has not had one since boot
 *     — that counts from the first failure. `copied > 0` means the rest of the
 *     adapter's files still go through and only `pending` paths are stuck.
 *   - `stalled`: no pass at all has finished for WARN_AFTER_MS (a hung copy, a
 *     dead loop). Only where the checkpoint loop runs: the status directory
 *     does not exist otherwise.
 */
export function readCheckpointHealth({ dir = statusDir(), now = Date.now(), warnAfterMs = WARN_AFTER_MS } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; } // also when dir is null
  const adapters = [];
  let stalled = null;
  for (const name of names) {
    if (name.startsWith('.')) continue; // a write in progress
    let s;
    try { s = parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    if (name === '_pass') {
      const finishedAt = ms(s.finished);
      if (finishedAt && now - finishedAt > warnAfterMs) stalled = { lastPassAt: finishedAt };
      continue;
    }
    const failures = Number(s.failures) || 0;
    if (!failures) continue;
    const since = ms(s.failing_since);
    const lastSuccessAt = ms(s.last_success);
    if (now - (lastSuccessAt || since || now) <= warnAfterMs) continue;
    adapters.push({
      adapter: s.adapter || name,
      failures,
      since,
      lastSuccessAt,
      rc: s.rc ? Number(s.rc) : null,
      pending: Number(s.pending) || 0,
      copied: Number(s.copied) || 0,
      reason: s.reason || null,
      paths: s.paths || null,
    });
  }
  if (!adapters.length && !stalled) return null;
  adapters.sort((a, b) => a.adapter.localeCompare(b.adapter));
  return { adapters, stalled, log: checkpointLogPath() };
}

let cache = { at: 0, value: null };
export function checkpointHealth() {
  const now = Date.now();
  if (now - cache.at > CACHE_MS) cache = { at: now, value: readCheckpointHealth({ now }) };
  return cache.value;
}
