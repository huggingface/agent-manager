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
  return !text.startsWith('<') && !text.startsWith('[Request interrupted')
    && !text.startsWith('[SYSTEM NOTIFICATION');
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
  /**
   * A sub-agent spawn. Its own kind, and NOT a `tools` row, for two reasons:
   * consecutive calls to one tool collapse into `Read ×4`, and spawns arrive
   * consecutively — three in a row inside one real turn — so grouping would
   * render four sub-agents as a single `Agent ×3` row with no state, no
   * duration and nothing to open. And a sub-agent has a life after the call
   * returns, which no other tool row has to represent.
   */
  | { kind: 'agent'; toolUseId: string; description: string; agentType: string; taskName?: string; blocks: TraceBlock[] }
  | { kind: 'tools'; name: string; count: number; details: string[]; failed: boolean; blocks: TraceBlock[] }
  | { kind: 'note'; text: string; more?: number }
  | { kind: 'shell'; command: string; out: string; failed: boolean }
  | { kind: 'image'; src: string }
  | { kind: 'compact'; text: string };

/**
 * The prose a step carries, or '' when it carries none.
 *
 * These three kinds are the agent writing for a reader — an aside, thinking out
 * loud, a compaction summary — and it writes them in markdown, so the reader
 * renders them. The others are not prose and must stay literal: a tool's input
 * is JSON, a shell's output and a tool result are terminal bytes where two
 * spaces mean two spaces, and an image is an image.
 */
export const proseOf = (s: Step): string =>
  (s.kind === 'think' || s.kind === 'note' || s.kind === 'compact' ? s.text : '');

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
  // A sub-agent row is searchable by the task it was given and by the call's
  // own input; its transcript is a different file and is not in this window.
  if (s.kind === 'agent') return [s.description, s.agentType, ...s.blocks.map((b) => ('text' in b ? b.text : ''))].join('\n');
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
        if (AGENT_TOOLS.has(b.name) && b.id) {
          const input = agentInput(b.text);
          const task = (input.task_name || '').split('/').filter(Boolean).pop() || '';
          out.push({
            kind: 'agent', toolUseId: b.id, blocks: group, taskName: task || undefined,
            description: input.description || task || argSummary(b.text) || 'sub-agent',
            agentType: input.subagent_type || (task ? 'sub-agent' : 'agent'),
          });
          continue;
        }
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

// ---------- sub-agents ----------
//
// A Claude pane spawns a sub-agent with the `Agent` tool (named `Task` in older
// CLIs; both are matched). Everything the reader needs about the SPAWN is in the
// turn it is already showing: the call names the task, and the parent's own
// later records say how it ended.
//
// The one trap, measured on this machine rather than assumed: for a BACKGROUND
// spawn — which is all 22 of release-video's and all 38 of the-gatherer's — the
// `tool_result` arrives two seconds after the call and says "Async agent
// launched successfully". It is a receipt, not an outcome. Treating a result as
// completion marks every sub-agent finished the moment it starts; on the agent
// checked end to end that would have been 4m26s early:
//
//   08:36:05  Agent tool_use            spawn
//   08:36:07  tool_result               "Async agent launched successfully… agentId: a000425…"
//   08:40:31  (child's last record)
//   08:40:33  <task-notification>       <tool-use-id>…</tool-use-id><status>completed</status>
//
// So the outcome is the NOTIFICATION for a background spawn, and the result
// itself only when it is the agent's own report (a synchronous spawn). Observed
// statuses: completed, failed, killed.
// Claude spawns with `Agent` (older CLIs: `Task`); codex spawns with
// `spawn_agent` in its `collaboration` namespace. The first cut of this feature
// treated `collaboration.spawn_agent` as Agent Manager's own peer-spawning tool
// and excluded codex on that basis. That was wrong: a real run on this machine
// produced three rollouts whose headers name the pane as `parent_thread_id`
// with `thread_source: "subagent"`, and codex itself called them "native
// subagents in this conversation's subagent tree". Same facility, different
// plumbing.
const AGENT_TOOLS = new Set(['Agent', 'Task', 'spawn_agent']);
// Two launch acknowledgements, both of which arrive at once and neither of
// which is the sub-agent's work: the background spawn's, and a fork's. Getting
// the second one wrong marked every fork finished the moment it started.
const LAUNCH_RECEIPT = /^(Async agent launched successfully|Fork started)/;
const AGENT_ID_IN_RECEIPT = /agentId:\s*([A-Za-z0-9_-]+)/;
const NOTIFICATION_ID = /<tool-use-id>([^<]+)<\/tool-use-id>/;
const NOTIFICATION_STATUS = /<status>([a-z]+)<\/status>/;
// The notification also carries what the sub-agent SPENT, which is the only
// place that number is written down: `<usage><subagent_tokens>41700</…>
// <tool_uses>13</…><duration_ms>172127</…></usage>`. Reported as tokens and
// calls rather than a cost — 554M of the 556M tokens read by the sub-agents on
// this machine were cache reads, which are not billed like fresh input.
const NOTIFICATION_TOKENS = /<subagent_tokens>(\d+)<\/subagent_tokens>/;
const NOTIFICATION_CALLS = /<tool_uses>(\d+)<\/tool_uses>/;
const NOTIFICATION_MS = /<duration_ms>(\d+)<\/duration_ms>/;

export type AgentOutcome = 'completed' | 'failed' | 'killed' | 'reported';

/**
 * Codex's completion post, in the parent's own rollout:
 *
 *   Message Type: FINAL_ANSWER
 *   Sender: /root/pty_summary
 *   Payload: …the sub-agent's answer…
 *
 * This is codex's equivalent of Claude's `<task-notification>` — recorded by
 * the parent, naming which sub-agent, timestamped, and carrying what it handed
 * back. The feasibility study reported "no terminal event observed" because it
 * looked for `sub_agent_activity` events, which CLI 0.149.1 does not emit at
 * all; this is what it emits instead. `wait_agent` is NOT usable for this: its
 * output is `{"message":"Wait completed.","timed_out":false}` and names no
 * agent, so it says something finished without saying what.
 */
const FINAL_ANSWER = /Message Type:\s*FINAL_ANSWER/;
// The type has to BE final, not listed among the options: codex documents this
// very format in its own developer prompt — "Message Type: MESSAGE |
// FINAL_ANSWER … Sender: <author>" — in the same thread the real posts arrive
// in, so a looser match reads the explanation as an event. (A sender-shape
// guard was tried too and removed: an unmatched name matches no spawn, so it
// changed nothing and no test could tell the difference.)
const POST_SENDER = /Sender:\s*(\S+)/;
/** the parent's own path is `/root`; a child's is `/root/<task name>` */
const taskOf = (p: string) => (p || '').split('/').filter(Boolean).pop() || '';

export interface AgentSpawn {
  /** the parent's own call id — the join key the sidecar files carry too */
  toolUseId: string;
  /**
   * Codex's join key instead of an id: the `spawn_agent` call names a
   * `task_name`, the child's rollout header repeats it as `agent_path`, and the
   * completion post names it as `Sender:`. There is no shared id anywhere in
   * that chain, so the name IS the link — exact, not a heuristic.
   */
  taskName?: string;
  description: string;
  agentType: string;
  /** from the launch receipt; the roster supplies it when the receipt is not in view */
  agentId?: string;
  spawnedAt?: number;
  outcome?: AgentOutcome;
  outcomeAt?: number;
  /** from the completion notification: what it spent, as the harness counted it */
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  /** a spawn whose receipt says it was launched into the background */
  background: boolean;
  /** the task, verbatim from the call — what the row shows when it is opened */
  prompt?: string;
}

/** The `Agent` call's input, which is JSON unless the block was capped mid-object. */
export const agentInput = (text: string): { description?: string; subagent_type?: string; prompt?: string; task_name?: string } => {
  try { return JSON.parse(text || '{}'); } catch { /* capped */ }
  const pick = (k: string) => {
    const m = new RegExp(`"${k}":\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text || '');
    return m ? m[1].replace(/\\"/g, '"') : undefined;
  };
  return { description: pick('description'), subagent_type: pick('subagent_type'), prompt: pick('prompt'), task_name: pick('task_name') };
};

const textOfTurn = (t: TraceTurn) =>
  t.blocks.filter((b) => b.type === 'text').map((b) => ('text' in b ? b.text : '')).join('\n');

/**
 * What the parent said about the END of each of its spawns, across the whole
 * window — not just this exchange. A background sub-agent outlives the turn
 * that started it, so its notification lands in a later one; scoping the search
 * to one exchange would report finished agents as unfinished forever.
 */
function outcomes(turns: TraceTurn[]) {
  const byId = new Map<string, { outcome: AgentOutcome; at?: number; tokens?: number; toolCalls?: number; durationMs?: number }>();
  const byTask = new Map<string, { outcome: AgentOutcome; at?: number }>();
  const receipts = new Map<string, { text: string; at?: number; failed?: boolean }>();
  for (const t of turns) {
    for (const b of t.blocks) {
      if (b.type === 'tool_result' && b.id) receipts.set(b.id, { text: b.text || '', at: t.ts, failed: b.failed });
    }
    // The harness's own completion messages arrive as user text and the trace
    // reader keeps them as `system` turns, which is why they are readable here.
    const text = textOfTurn(t);
    // codex: a sub-agent's own answer, posted back into the parent's thread
    if (FINAL_ANSWER.test(text)) {
      const who = POST_SENDER.exec(text);
      const task = taskOf(who ? who[1] : '');
      if (task) byTask.set(task, { outcome: 'reported', at: t.ts });
    }
    if (!text.includes('<task-notification>')) continue;
    for (const part of text.split('<task-notification>').slice(1)) {
      const id = NOTIFICATION_ID.exec(part);
      const st = NOTIFICATION_STATUS.exec(part);
      if (!id) continue;
      const status = st && ['completed', 'failed', 'killed'].includes(st[1]) ? (st[1] as AgentOutcome) : 'completed';
      const num = (re: RegExp) => { const m = re.exec(part); return m ? Number(m[1]) : undefined; };
      byId.set(id[1], {
        outcome: status, at: t.ts,
        tokens: num(NOTIFICATION_TOKENS), toolCalls: num(NOTIFICATION_CALLS), durationMs: num(NOTIFICATION_MS),
      });
    }
  }
  return { byId, byTask, receipts };
}

/** The sub-agents THIS exchange spawned, with whatever the parent knows of their end. */
export function agentSpawnsOf(x: Exchange, turns: TraceTurn[]): AgentSpawn[] {
  const { byId, byTask, receipts } = outcomes(turns);
  const out: AgentSpawn[] = [];
  for (const t of x.steps) {
    for (const b of t.blocks) {
      if (b.type !== 'tool_use' || !AGENT_TOOLS.has(b.name) || !b.id) continue;
      const input = agentInput(b.text || '');
      const task = taskOf(input.task_name || '');
      const receipt = receipts.get(b.id);
      // codex's `spawn_agent` answers `{"task_name":"/root/pty_summary"}` — an
      // acknowledgement, exactly like Claude's async launch receipt, and never
      // the sub-agent's work. Without this, every codex spawn read as finished
      // the moment it started: the same trap as Claude's background receipt,
      // one shape further along. Its sub-agents always run concurrently, so
      // this path has no synchronous case at all.
      const codex = b.name === 'spawn_agent';
      const background = codex || (!!receipt && LAUNCH_RECEIPT.test(receipt.text));
      const note = byId.get(b.id);
      const spawn: AgentSpawn = {
        toolUseId: b.id,
        taskName: task || undefined,
        // codex's spawn carries a task NAME and an encrypted message, so the
        // name is the description there; Claude's carries a written description.
        description: input.description || task || (b.text || '').slice(0, 80) || 'sub-agent',
        agentType: input.subagent_type || (task ? 'sub-agent' : 'agent'),
        spawnedAt: t.ts,
        background,
        // …and nothing readable to show as a task: codex encrypts the message it
        // sends its sub-agent, so there is no prompt on this path. The child's
        // own trace still opens.
        prompt: input.prompt,
      };
      const idInReceipt = receipt && AGENT_ID_IN_RECEIPT.exec(receipt.text);
      if (idInReceipt) spawn.agentId = idInReceipt[1];
      const post = task ? byTask.get(task) : undefined;
      if (note) {
        spawn.outcome = note.outcome; spawn.outcomeAt = note.at;
        spawn.tokens = note.tokens; spawn.toolCalls = note.toolCalls; spawn.durationMs = note.durationMs;
      } else if (post) {
        // codex: the answer came back, which is the whole of what is recorded.
        // No token count, no tool count — those are not written down on this
        // path, and the row shows the span it can prove instead of inventing
        // numbers.
        spawn.outcome = post.outcome; spawn.outcomeAt = post.at;
      }
      else if (receipt && !background) {
        // A synchronous spawn hands its report back AS the result, so this one
        // is genuinely an outcome — and the only kind of result that is.
        spawn.outcome = receipt.failed ? 'failed' : 'reported';
        spawn.outcomeAt = receipt.at;
      }
      out.push(spawn);
    }
  }
  return out;
}

export const isFinished = (s: AgentSpawn) => !!s.outcome;

/**
 * How long a sub-agent may go without writing before the reader stops calling
 * it "running".
 *
 * mtime is not a verdict on its own: measured across 8,757 gaps between
 * consecutive records inside sub-agent transcripts, the median is 2.7s, p99 is
 * 112s and the LONGEST silence inside a run that finished normally is 601s. So
 * any threshold near ten minutes calls live sub-agents dead — a first draft of
 * this constant was exactly 600s and the test caught it by one second. This one
 * is 1.5× the worst silence observed, and still a guess: which is why the row
 * that crosses it says how long it has been quiet rather than saying "dead",
 * and keeps its transcript one click away.
 *
 * It exists because of the case it catches: 9 of release-video's 22 sub-agents
 * have no recorded outcome at all, because the pane was restarted or the
 * notification was lost to a compaction. Without this rule those rows spin
 * under the working line forever — a phantom worker, which is worse than
 * showing nothing.
 */
export const STALE_MS = 15 * 60 * 1000;

export type AgentStatus = 'done' | 'failed' | 'killed' | 'running' | 'stalled' | 'no-result';

/**
 * One place decides what a row says, because three inputs decide it: what the
 * parent recorded, whether the pane's own process is alive, and when the
 * sub-agent's transcript last changed.
 */
export function agentStatus(
  s: AgentSpawn,
  opts: { live: boolean; lastWroteAt?: number | null; now?: number },
): AgentStatus {
  if (s.outcome === 'completed' || s.outcome === 'reported') return 'done';
  if (s.outcome === 'failed') return 'failed';
  if (s.outcome === 'killed') return 'killed';
  // No outcome recorded. A pane that is not running cannot have anything
  // running under it, whatever the files say.
  if (!opts.live) return 'no-result';
  const quiet = opts.lastWroteAt ? (opts.now ?? Date.now()) - opts.lastWroteAt : 0;
  return quiet > STALE_MS ? 'stalled' : 'running';
}

/**
 * How deep the reader will nest a sub-agent inside a sub-agent.
 *
 * The measured maximum on this machine is depth 2 (rl-llm-wiki: three agents
 * that spawned seven), and nothing deeper exists in any of the sessions here,
 * so this is a backstop rather than a limit anyone will meet. It is here
 * because the reader must not hang on malformed data: a transcript that names
 * itself as its own child — which a fork's inherited prelude did until the
 * parser stopped handing it over — would otherwise open forever.
 */
export const MAX_NEST = 3;

/**
 * Whether a row may be opened, given who is already open above it.
 *
 * `ancestors` is the chain of agentIds from the outermost open row down to this
 * one. A row that names an agent already in that chain is a cycle, and it
 * renders as a row that cannot be opened rather than as infinite nesting.
 */
export function canOpenAgent(agentId: string | undefined, ancestors: string[], cap = MAX_NEST) {
  if (!agentId) return false;
  if (ancestors.includes(agentId)) return false;
  return ancestors.length < cap;
}

/** A sub-agent the parent has not heard back from, on a pane that is alive. */
export const isLive = (st: AgentStatus) => st === 'running' || st === 'stalled';

/**
 * The strip under the working line is all-or-nothing: while ANY sub-agent of the
 * turn is still going it lists them all, finished ones included, and when the
 * last one lands it is gone and they are in the collapsed work with every other
 * step. One appearance and one disappearance per turn, instead of one per
 * sub-agent.
 */
export const anyLive = (statuses: AgentStatus[]) => statuses.some(isLive);

/**
 * Which of those rows fit, and what the line at the bottom says about the rest.
 *
 * Rows accumulate now, so the cap does real work: a release-video turn ends at
 * 22 sub-agents and the-gatherer's busiest at 40. What gives way is the
 * FINISHED rows, oldest first — the strip is about what is still going, and a
 * landed sub-agent is one click away in the work. Two consequences worth having:
 * the strip's height stops growing at the cap instead of resizing every time one
 * completes, and the overflow line has to describe what it is holding back by
 * STATE. "…and 16 more running" would be a lie in the state the cap exists for,
 * where most of the hidden rows are done.
 */
/**
 * Which row in the strip gets the `└`. The rails are the file browser's, and
 * they only read as a tree if the elbow is on whatever is actually last — with
 * the cap in play that is the overflow line, not the last sub-agent, and an
 * unclosed `├` at the bottom looks like a row that failed to render.
 */
export const railIsLast = (index: number, shownCount: number, hasOverflow: boolean) =>
  !hasOverflow && index === shownCount - 1;

export function capRows<T extends { status: AgentStatus }>(rows: T[], cap: number) {
  if (rows.length <= cap) return { shown: rows, hidden: [] as T[], note: '' };
  const giveWay = new Set(
    [...rows]
      .sort((a, b) => Number(isLive(a.status)) - Number(isLive(b.status)))   // finished first, order otherwise kept
      .slice(0, rows.length - cap),
  );
  const shown = rows.filter((r) => !giveWay.has(r));
  const hidden = rows.filter((r) => giveWay.has(r));
  const liveHidden = hidden.filter((r) => isLive(r.status)).length;
  const bits = [hidden.length - liveHidden ? `${hidden.length - liveHidden} done` : '', liveHidden ? `${liveHidden} running` : '']
    .filter(Boolean).join(', ');
  return { shown, hidden, note: `…and ${hidden.length} more${bits ? ` — ${bits}` : ''} — open the work to see them all` };
}

/**
 * The count for the summary line, and the reason it needs the pane's state.
 *
 * Three states, not two. A sub-agent with no recorded outcome is running only
 * if the pane that spawned it is alive; if the pane was killed mid-task its
 * sub-agents never finish and never write again, and a UI without the third
 * state says "2 running" forever — wrong in the direction that makes the
 * operator wait for something that will never arrive.
 */
export function agentCounts(list: AgentSpawn[], live: boolean) {
  const done = list.filter((s) => s.outcome === 'completed' || s.outcome === 'reported').length;
  const bad = list.filter((s) => s.outcome === 'failed' || s.outcome === 'killed').length;
  const open = list.length - done - bad;
  const bits: string[] = [];
  if (done) bits.push(`${done} done`);
  if (bad) bits.push(`${bad} failed`);
  if (open) bits.push(`${open} ${live ? 'running' : 'unfinished'}`);
  return {
    total: list.length, done, bad, open,
    label: `${list.length} sub-agent${list.length === 1 ? '' : 's'}${bits.length ? ` · ${bits.join(' · ')}` : ''}`,
  };
}

/**
 * "14 steps · 9 tools · 42s · 21.0k tok" — the whole turn in one line. There is
 * no header above the prompt any more, so this carries the numbers everywhere.
 */
export function stepSummary(x: Exchange, steps: Step[], subAgents = 0): string {
  const bits: string[] = [];
  if (steps.length) bits.push(`${steps.length} step${steps.length === 1 ? '' : 's'}`);
  // Sub-agents are counted as sub-agents and not also as tools. They ARE tool
  // calls, but reporting one turn's four spawns inside "53 tools" and again as
  // "4 sub-agents" makes the two numbers argue about the same work.
  const tools = Math.max(0, x.toolCalls - subAgents);
  if (tools) bits.push(`${tools} tool${tools === 1 ? '' : 's'}`);
  if (subAgents) bits.push(`${subAgents} sub-agent${subAgents === 1 ? '' : 's'}`);
  const d = fmtDur(x.endTs - x.startTs);
  if (d) bits.push(d);
  if (x.tokens) bits.push(`${fmtTok(x.tokens)} tok`);
  return bits.join(' · ');
}
