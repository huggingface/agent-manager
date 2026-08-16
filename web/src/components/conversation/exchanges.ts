// Turns → exchanges → step lines. (docs/conversation-view.md §4)
//
// One prompt, the work, the answer. Every surface in the app is some depth of
// this, so the grouping lives here and not in a component.
import type { TraceBlock, TraceTurn } from '../../api';

export interface Exchange {
  key: string;
  /** Index into the turn array — what a "jump to this exchange" needs. */
  at: number;
  prompt: TraceTurn | null;
  steps: TraceTurn[];
  /** Everything the agent said after its last action — usually one turn. */
  answer: TraceTurn[];
  /**
   * Where the answer sits among the steps, when it is NOT last: the index in
   * `steps` the answer was lifted from. An agent that answered and then went
   * back to work leaves its reply in the middle of the turn, and a reader that
   * prints it under the tools that ran after it is telling the story in the
   * wrong order. Undefined — the usual case — means the answer is simply last.
   */
  answerAt?: number;
  startTs: number;
  endTs: number;
  tokens: number;
  toolCalls: number;
  model?: string;
}

// Mirrors the digest's rule in server/src/traces.js: a "user" line that opens
// with a tag or an interrupt marker is the harness talking, not the operator.
export const isOperatorPrompt = (t: TraceTurn) => {
  if (t.role !== 'user') return false;
  const text = t.blocks.filter((b) => b.type === 'text').map((b) => ('text' in b ? b.text : '')).join('').trim();
  if (!text) return t.blocks.some((b) => b.type === 'image');
  return !text.startsWith('<') && !text.startsWith('[Request interrupted');
};

const usageOf = (t: TraceTurn) => (t.usage ? (t.usage.in || 0) + (t.usage.out || 0) : 0);

export function splitExchanges(turns: TraceTurn[]): Exchange[] {
  const out: Exchange[] = [];
  let cur: Exchange | null = null;
  const open = (at: number, prompt: TraceTurn | null) => {
    cur = {
      key: `x${at}`, at, prompt, steps: [], answer: [],
      startTs: prompt?.ts || 0, endTs: prompt?.ts || 0, tokens: 0, toolCalls: 0,
    };
    out.push(cur);
  };
  // Everything lands in `steps` in the order it happened; the answer is chosen
  // afterwards and lifted out. Promoting as we go used to reorder the middle:
  // a superseded answer was appended wherever the NEXT one arrived, so an
  // intermediate message jumped below the tool calls that came after it.
  turns.forEach((t, i) => {
    if (isOperatorPrompt(t)) { open(i, t); return; }
    if (!cur) open(i, null);
    const x = cur!;
    if (t.ts) { if (!x.startTs) x.startTs = t.ts; x.endTs = Math.max(x.endTs, t.ts); }
    x.tokens += usageOf(t);
    x.toolCalls += t.blocks.filter((b) => b.type === 'tool_use').length;
    if (t.model && !x.model) x.model = t.model;
    if (t.role !== 'system') x.steps.push(t);
  });

  const saidSomething = (t: TraceTurn) =>
    t.role === 'assistant' && t.blocks.some((b) => b.type === 'text' && b.text.trim());
  // …and stopped there. A message followed by more tool calls is the agent
  // thinking out loud mid-task, not its reply — which is most of what you see
  // while one is still working.
  const endedOnIt = (t: TraceTurn) => {
    const said = t.blocks.filter((b) => b.type !== 'text' || b.text.trim());
    return said.length > 0 && said[said.length - 1].type === 'text';
  };
  const spoke = (t: TraceTurn) => saidSomething(t) && endedOnIt(t);

  for (const x of out) {
    // The answer is the trailing RUN of messages: everything the agent said
    // after its last action. Taking only the last one buried real answers —
    // a harness marks the last assistant text of a request as `final`, and
    // that is sometimes a throwaway ("No response requested.") written in
    // reply to a notification, with the actual answer in the turn above it.
    let from = x.steps.length;
    while (from > 0 && spoke(x.steps[from - 1])) from--;
    if (from < x.steps.length) {
      x.answer = x.steps.slice(from);
      x.steps.length = from;
      continue;
    }
    // Nothing at the end: an agent that answered and then went back to work
    // (a resumed task) still answered. Its last `final` stands — and `answerAt`
    // remembers WHERE, because it is not the last thing that happened. The
    // steps that follow it are the work it did afterwards, and they belong
    // below it, not above.
    for (let i = x.steps.length - 1; i >= 0; i--) {
      if (x.steps[i].kind === 'final' && saidSomething(x.steps[i])) {
        x.answer = [x.steps[i]];
        x.steps.splice(i, 1);
        x.answerAt = i;
        break;
      }
    }
  }
  return out;
}

// ---------- step lines ----------

export type Step =
  | { kind: 'think'; text: string; more?: number }
  | { kind: 'tools'; name: string; count: number; details: string[]; failed: boolean; blocks: TraceBlock[] }
  | { kind: 'note'; text: string; more?: number }
  | { kind: 'shell'; command: string; out: string; failed: boolean }
  | { kind: 'image'; src: string }
  | { kind: 'compact'; text: string };

// The one field of a tool call worth a line: what it acted on.
const ARG_KEYS = ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'glob', 'url', 'query', 'prompt', 'description', 'subagent_type'];
const shortPath = (p: string) => {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
};

export function argSummary(text: string): string {
  let v: unknown = null;
  try { v = JSON.parse(text); } catch {
    // A block the reader had to cut mid-JSON still names what it acted on.
    for (const k of ARG_KEYS) {
      const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(text);
      if (m && m[1].trim()) return oneLine(m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"'), 70);
    }
    return oneLine(text.replace(/^[{\s"]+/, ''), 70);
  }
  if (!v || typeof v !== 'object') return oneLine(String(v), 70);
  const o = v as Record<string, unknown>;
  for (const k of ARG_KEYS) {
    const raw = o[k];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    return oneLine(k.includes('path') ? shortPath(raw) : raw, 70);
  }
  return oneLine(Object.keys(o).join(', '), 70);
}

/** Everything in a step a search could reasonably land on, including bodies. */
export function stepText(s: Step): string {
  if (s.kind === 'tools') return [s.name, ...s.details, ...s.blocks.map((b) => ('text' in b ? b.text : ''))].join('\n');
  if (s.kind === 'shell') return `${s.command}\n${s.out}`;
  if (s.kind === 'image') return '';
  return s.text;
}

export const oneLine = (s: string, n = 90) => {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function stepsOf(turns: TraceTurn[]): Step[] {
  const out: Step[] = [];
  const pushTool = (name: string, detail: string, blocks: TraceBlock[], failed: boolean) => {
    const last = out[out.length - 1];
    // Consecutive calls to the SAME tool read as one line: "Read ×4".
    if (last && last.kind === 'tools' && last.name === name) {
      last.count++;
      if (detail && last.details.length < 4) last.details.push(detail);
      last.blocks.push(...blocks);
      last.failed = last.failed || failed;
      return;
    }
    out.push({ kind: 'tools', name, count: 1, details: detail ? [detail] : [], failed, blocks });
  };

  for (const t of turns) {
    const bs = t.blocks;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (b.type === 'tool_use') {
        // Sweep up this call's results (the server files them next to the call).
        const group: TraceBlock[] = [b];
        let failed = false;
        let j = i + 1;
        while (j < bs.length && bs[j].type === 'tool_result') {
          const r = bs[j] as Extract<TraceBlock, { type: 'tool_result' }>;
          group.push(r);
          failed = failed || !!r.failed;
          j++;
        }
        i = j - 1;
        pushTool(b.name, argSummary(b.text), group, failed);
      } else if (b.type === 'tool_result') {
        pushTool('result', oneLine(b.text, 60), [b], !!b.failed);
      } else if (b.type === 'thinking') {
        out.push({ kind: 'think', text: b.text, more: b.more });
      } else if (b.type === 'shell') {
        out.push({ kind: 'shell', command: b.command, out: `${b.stdout || ''}${b.stderr || ''}`, failed: !!b.exitCode });
      } else if (b.type === 'compaction') {
        out.push({ kind: 'compact', text: b.text });
      } else if (b.type === 'image') {
        out.push({ kind: 'image', src: b.src });
      } else if (b.type === 'text' && b.text.trim()) {
        out.push({ kind: 'note', text: b.text, more: b.more });
      }
    }
  }
  return out;
}

// ---------- formatting ----------

/** 954 · 21.0k · 654k · 2.2M · 1.4B — one decimal only where it says something. */
export const fmtTok = (n = 0) => {
  const [v, unit] = n >= 1e9 ? [n / 1e9, 'B'] : n >= 1e6 ? [n / 1e6, 'M'] : n >= 1e3 ? [n / 1e3, 'k'] : [n, ''];
  if (!unit) return String(Math.round(v));
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}${unit}`;
};

export const fmtDur = (ms: number) => {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

export const fmtClock = (ms?: number) =>
  ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

/**
 * "14 steps · 9 tools · 42s · 21.0k tok" — the whole turn in one line. There is
 * no header above the prompt any more, so this carries the numbers everywhere.
 */
export function stepSummary(x: Exchange, steps: Step[]): string {
  const bits: string[] = [];
  if (steps.length) bits.push(`${steps.length} step${steps.length === 1 ? '' : 's'}`);
  if (x.toolCalls) bits.push(`${x.toolCalls} tool${x.toolCalls === 1 ? '' : 's'}`);
  const d = fmtDur(x.endTs - x.startTs);
  if (d) bits.push(d);
  if (x.tokens) bits.push(`${fmtTok(x.tokens)} tok`);
  return bits.join(' · ');
}
