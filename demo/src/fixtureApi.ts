// The demo's transport. It serves the bundled session file the way
// server/src/traces.js serves a .jsonl: byte windows aligned to whole records,
// honouring `bytes` and growing to `min`. Everything above it — ReaderStore's
// paging and budgets, reconcileTrace, isOperatorPrompt, countExchanges,
// splitExchanges and the reader's own rendering — is the production code.
export * from '../../web/src/api';
import type { TraceReq, TraceSummary, TraceWindow } from '../../web/src/api';
/**
 * The session file is FETCHED, not inlined, so dropping a different
 * session.jsonl into this Space replaces the conversation without rebuilding
 * anything.
 */
const decoder = new TextDecoder();
let loaded: Promise<{ bytes: Uint8Array; starts: number[] }> | null = null;
const source = () => (loaded ??= fetch('./session.jsonl')
  .then((r) => { if (!r.ok) throw new Error(`session.jsonl: ${r.status}`); return r.arrayBuffer(); })
  .then((buf) => {
    const bytes = new Uint8Array(buf);
    const starts = [0];
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a && i + 1 < bytes.length) starts.push(i + 1);
    return { bytes, starts };
  }));

/** Demo-only: slow enough to see the spinner. Zero makes it instant. */
export const demo = { latencyMs: 750, reads: 0 };

const META = {
  harness: 'claude', harnessLabel: 'Demo session', sessionId: 'demo', title: 'Reader demo',
  model: 'demo-model', cwd: '/data/workspaces/demo', firstTs: 0, lastTs: 0, usage: null,
  source: null, sharedBy: null, note: null, truncated: false, total: null, userTurns: null,
  activity: 'waiting' as const, generation: 'demo', revision: 'r1',
};

function window_(file: { bytes: Uint8Array; starts: number[] }, req: TraceReq, want = 128 * 1024, min = 1): TraceWindow {
  const { bytes, starts } = file;
  const SIZE = bytes.length;
  const recordAt = (i: number) => {
    const end = i + 1 < starts.length ? starts[i + 1] - 1 : SIZE;
    return { text: decoder.decode(bytes.subarray(starts[i], end)), start: starts[i], end: end + 1 };
  };
  // Which record indices this window covers, aligned like the server's.
  let lo: number;
  let hi: number;
  if (req.at === 'after') {
    lo = starts.findIndex((s) => s >= (req as { cursor: number }).cursor);
    if (lo < 0) lo = starts.length;
    hi = starts.length;
  } else {
    const ceiling = req.at === 'before' ? (req as { cursor: number }).cursor : SIZE;
    hi = starts.findIndex((s) => s >= ceiling);
    if (hi < 0) hi = starts.length;
    lo = hi;
    let held = 0;
    // Grow backward by whole records until the byte span is spent AND the
    // record floor is met — the server's rule, not a fixed page size.
    while (lo > 0) {
      const next = recordAt(lo - 1);
      const span = (lo < starts.length ? starts[lo] : SIZE) - next.start;
      if (held + span > want && hi - lo >= min) break;
      held += span;
      lo--;
    }
  }
  const turns = [];
  for (let i = lo; i < hi; i++) {
    try { turns.push(JSON.parse(recordAt(i).text)); } catch { /* a partial record is nobody's */ }
  }
  const start = lo < starts.length ? starts[lo] : SIZE;
  const end = hi < starts.length ? starts[hi] : SIZE;
  return { ...META, turns, window: { mode: 'bytes', start, end, atStart: start <= 0, atEnd: end >= SIZE,
    generation: 'demo', revision: 'r1' } } as unknown as TraceWindow;
}

const wait = () => new Promise((r) => setTimeout(r, demo.latencyMs));

export const getTraceWindow = async (_id: string, req: TraceReq, size?: number, min?: number): Promise<TraceWindow> => {
  const file = await source();
  demo.reads++;
  await wait();
  return window_(file, req, size, min);
};
export const getTraceSummary = async (): Promise<TraceSummary> => {
  const { starts } = await source();
  await wait();
  return { ...META, total: starts.length, userTurns: [] } as unknown as TraceSummary;
};
export const getSubAgents = () => Promise.resolve({ agents: [] });
export const sendInput = () => Promise.resolve({});
export const getOperations = () => Promise.resolve({ operations: [], generatedAt: '' });
