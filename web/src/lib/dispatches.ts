// The sessions this session handed work to through the manager's own API, as
// the reader draws them: one icon per session on the turn that made the call,
// and the call itself as a step where it happened. (Not the in-harness
// sub-agents — subagentRoster.ts is those.)
//
// Everything here is a pure function of the server's answer
// (server/src/dispatches.js) except the cache at the bottom, so the rules —
// what counts as running, as finished, as failed, and which turn and which
// tool call a dispatch belongs to — are tested without a browser.
import { getDispatches, type Dispatch, type TraceBlock, type TraceTurn } from '../api';
import { splitExchanges, type Exchange } from '../components/conversation/exchanges';
import { rememberReading } from '../components/conversation/readingPosition';
import { requestOpenSession } from './openSession';

export type { Dispatch };

/**
 * What became of one dispatch. Deliberately NOT "succeeded": a turn that ended
 * says the peer stopped, not that it did the job. `failed` is reserved for what
 * the records prove — the harness wrote an error turn, the call was refused,
 * the turn ended without a final message, or the prompt never started a turn.
 */
export type Outcome = 'running' | 'queued' | 'finished' | 'failed' | 'gone' | 'unknown';

export interface DispatchResult {
  d: Dispatch;
  outcome: Outcome;
  /** why it failed, in a few words */
  why?: string;
  /** the turn it started, read with the reader's own rules */
  x: Exchange | null;
  answer: string;
}

/** Long enough for a stopped CLI to boot and take the prompt. */
const START_GRACE_MS = 2 * 60_000;

const ERROR_WORDS: Record<string, string> = {
  authentication_failed: 'login expired',
  rate_limit: 'rate limited',
  billing_error: 'billing',
};

const answerText = (x: Exchange | null) =>
  (x ? x.answer : []).flatMap((t) => t.blocks).filter((b) => b.type === 'text').map((b) => ('text' in b ? b.text : '')).join('\n\n').trim();

export function resultOf(d: Dispatch, now = Date.now()): DispatchResult {
  if (!d.ok) return { d, outcome: 'failed', why: `refused (${d.status})`, x: null, answer: '' };
  if (d.exchange) {
    const x = splitExchanges(d.exchange.turns)[0] || null;
    const answer = answerText(x);
    const err = d.exchange.turns.find((t) => t.error)?.error;
    if (err) return { d, outcome: 'failed', why: ERROR_WORDS[err] || err.replace(/_/g, ' '), x, answer };
    if (!d.exchange.ended) return { d, outcome: 'running', x, answer };
    if (!answer) return { d, outcome: 'failed', why: 'no final message', x, answer };
    return { d, outcome: 'finished', x, answer };
  }
  if (!d.target.exists) return { d, outcome: 'gone', why: 'session deleted', x: null, answer: '' };
  if (d.untraced) return { d, outcome: d.target.state === 'working' ? 'running' : 'unknown', x: null, answer: '' };
  // Not in its transcript yet. Busy with something else, or just booting: it
  // is waiting its turn. Idle long after the call: it never ran.
  if (d.target.state === 'working' || now - d.at < START_GRACE_MS) return { d, outcome: 'queued', x: null, answer: '' };
  return { d, outcome: 'failed', why: 'never started', x: null, answer: '' };
}

/** A call logged a moment after its tool turn was written still belongs to it. */
const SKEW_MS = 2_000;

/**
 * Which loaded exchange made each dispatch: the last one that had started by
 * then. Dispatches older than the loaded window belong to no exchange here.
 */
export function byExchange(exchanges: Exchange[], ds: Dispatch[]): Map<string, Dispatch[]> {
  const out = new Map<string, Dispatch[]>();
  const starts = exchanges.filter((x) => x.startTs);
  if (!starts.length) return out;
  for (const d of ds) {
    let hit: Exchange | null = null;
    for (const x of starts) { if (x.startTs <= d.at + SKEW_MS) hit = x; else break; }
    if (!hit) continue;
    const list = out.get(hit.key) || [];
    list.push(d);
    out.set(hit.key, list);
  }
  return out;
}

/** A tool call that talks to the manager's agents API. */
const DISPATCHING = /\/api\/agents\b/;

/**
 * Which tool call made each dispatch: the latest call to the agents API whose
 * turn was written before the call was logged. A loop that launched three
 * sessions is one call carrying three dispatches. Dispatches no call can be
 * found for come back in `loose`, and are drawn after the work.
 */
export function dispatchBlocks(turns: TraceTurn[], ds: Dispatch[]): { byBlock: Map<TraceBlock, Dispatch[]>; loose: Dispatch[] } {
  const calls: { ts: number; b: TraceBlock }[] = [];
  for (const t of turns) {
    if (!t.ts) continue;
    for (const b of t.blocks) if (b.type === 'tool_use' && DISPATCHING.test(b.text || '')) calls.push({ ts: t.ts, b });
  }
  const byBlock = new Map<TraceBlock, Dispatch[]>();
  const loose: Dispatch[] = [];
  for (const d of ds) {
    let hit: TraceBlock | null = null;
    for (const c of calls) if (c.ts <= d.at + SKEW_MS) hit = c.b;
    if (!hit) { loose.push(d); continue; }
    const list = byBlock.get(hit) || [];
    list.push(d);
    byBlock.set(hit, list);
  }
  return { byBlock, loose };
}

/** Anything still moving, so the reader keeps asking after its own turn ended. */
export const anyMoving = (ds: Dispatch[], now = Date.now()) =>
  ds.some((d) => { const o = resultOf(d, now).outcome; return o === 'running' || o === 'queued'; });

// ---------- loading, cached outside React (same reasons as subagentRoster.ts) ----------

const FRESH_MS = 15_000;
const cache = new Map<string, { at: number; since: number; list: Dispatch[] }>();
const inflight = new Map<string, Promise<Dispatch[]>>();

export const cachedDispatches = (sessionId: string): Dispatch[] | null => cache.get(sessionId)?.list ?? null;

export function loadDispatches(sessionId: string, since: number, force = false): Promise<Dispatch[]> {
  const hit = cache.get(sessionId);
  if (!force && hit && hit.since <= since && Date.now() - hit.at < FRESH_MS) return Promise.resolve(hit.list);
  const key = `${sessionId}:${since}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = getDispatches(sessionId, since)
    .then((r) => { cache.set(sessionId, { at: Date.now(), since, list: r.dispatches }); return r.dispatches; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Open a dispatched session on its latest turn: what it is doing NOW is what
 * the icon was about, so a remembered reading position gives way to the end.
 */
export const openSession = (id: string) => {
  rememberReading(id, { ts: 0, off: 0, end: true });
  requestOpenSession(id);
};
