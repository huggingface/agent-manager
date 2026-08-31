// One exchange, at whatever depth the surface needs. (docs/conversation-view.md §2)
//
// The Overview card is one of these plus a reply box; RENDER mode is a stack of
// them. Nothing here knows which — that is the point, and it is why the two
// surfaces cannot drift apart again.
//
// Left edge: the prompt's ❯ is the ONLY thing outside the text column. No rail
// on the answer, no rail on the work — scrolling, you find turns by that arrow
// and the tinted prompt bar, and everything else lines up in one column.
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { SubAgentEntry, TraceTurn } from '../../api';
import { getSubAgentTrace } from '../../api';
import { Rails } from '../Rails';
import { renderMarkdown } from '../../lib/markdown';
import type { Exchange, Step } from './exchanges';
import { agentSpawnsOf, agentStatus, anyLive, capRows, railIsLast, fmtClock, fmtDur, fmtTok, oneLine, proseOf, splitExchanges, stepSummary, stepText, stepsOf } from './exchanges';
import type { AgentSpawn, AgentStatus } from './exchanges';
import ToolCall from './ToolCall';

const blocksOf = (t: TraceTurn | TraceTurn[] | null) =>
  (Array.isArray(t) ? t : [t]).flatMap((x) => x?.blocks || []);
const textOf = (t: TraceTurn | TraceTurn[] | null) =>
  blocksOf(t).filter((b) => b.type === 'text').map((b) => ('text' in b ? b.text : '')).join('\n\n').trim();
const moreOf = (t: TraceTurn | TraceTurn[] | null) =>
  blocksOf(t).reduce((n, b) => n + (('more' in b && b.more) || 0), 0);

/** `9` under `10` — a figure space (U+2007) is a digit wide in tabular figures. */
const padTurn = (n: number, total?: number) =>
  String(n).padStart(String(total ?? n).length, '\u2007');

const moreLabel = (more?: number) =>
  (more ? `+${more > 1024 ? `${Math.round(more / 1024)} KB` : `${more} chars`} not retained` : '');

/** Search hits in plain text. The answer's HTML gets the same treatment below. */
function Hi({ text, q }: { text: string; q?: string }) {
  if (!q) return <>{text}</>;
  const out: ReactNode[] = [];
  const hay = text.toLowerCase();
  let i = 0;
  for (let j = hay.indexOf(q); j >= 0; j = hay.indexOf(q, i)) {
    if (j > i) out.push(text.slice(i, j));
    out.push(<mark className="cx-hit" key={j}>{text.slice(j, j + q.length)}</mark>);
    i = j + q.length;
  }
  if (!out.length) return <>{text}</>;
  out.push(text.slice(i));
  return <>{out}</>;
}

/** Same, inside rendered markdown: text nodes only, so the tags survive untouched. */
function highlightHtml(html: string, q?: string): string {
  if (!q) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walk.nextNode()) nodes.push(walk.currentNode as Text);
  for (const n of nodes) {
    if (!n.data.toLowerCase().includes(q)) continue;
    const frag = doc.createDocumentFragment();
    let rest = n.data;
    for (let j = rest.toLowerCase().indexOf(q); j >= 0; j = rest.toLowerCase().indexOf(q)) {
      if (j) frag.appendChild(doc.createTextNode(rest.slice(0, j)));
      const m = doc.createElement('mark');
      m.className = 'cx-hit';
      m.textContent = rest.slice(j, j + q.length);
      frag.appendChild(m);
      rest = rest.slice(j + q.length);
    }
    if (rest) frag.appendChild(doc.createTextNode(rest));
    n.parentNode?.replaceChild(frag, n);
  }
  return doc.body.innerHTML;
}

/**
 * One line of work. The left column carries the row's status and nothing else:
 * a tool's ✓/✗, or a disclosure triangle — greyed when there is nothing more.
 *
 * Text steps (thinking, an aside, a compaction) expand *in place*: the preview
 * keeps its font and simply stops being truncated, so nothing is said twice.
 * Only a tool has something genuinely different below — its input and result.
 */
function StepRow({ s, q }: { s: Step; q?: string }) {
  const [selfOpen, setSelfOpen] = useState(false);
  // A search you cannot follow is a tease: a step holding the term opens itself,
  // body and all, so the hit is on screen and the ▲▼ nav can reach it.
  const hit = !!q && stepText(s).toLowerCase().includes(q);
  const open = selfOpen || hit;
  let label = '';
  let preview = '';
  let full = '';        // set for the kinds that expand in place
  if (s.kind === 'tools') {
    label = s.count > 1 ? `${s.name} ×${s.count}` : s.name;
    preview = s.details.join(', ');
  } else if (s.kind === 'think') {
    label = 'thinking';
    preview = oneLine(s.text, 120);
    full = s.text;
  } else if (s.kind === 'note') {
    preview = oneLine(s.text, 140);
    full = s.text;
  } else if (s.kind === 'shell') {
    label = 'shell';
    preview = oneLine(s.command, 100);
  } else if (s.kind === 'compact') {
    label = 'context compacted';
    preview = oneLine(s.text, 120);
    full = s.text;
  } else {
    label = 'image';
  }

  const more = 'more' in s ? s.more || 0 : 0;
  const can = s.kind === 'tools' ? s.blocks.length > 0
    : s.kind === 'shell' ? !!s.out.trim()
      : s.kind === 'image' ? true
        : full.trim().length > preview.length || more > 0;
  // Prose kinds — an aside, thinking out loud, a compaction — are markdown, and
  // an agent writes them like markdown: headings, lists, code spans, links. Only
  // the ANSWER used to be rendered, so the middle of a turn showed its syntax
  // raw. It renders through the same path the answer takes, highlight and all.
  //
  // Not in the head row: that row is a <button>, and markdown carries links and
  // block elements, neither of which is valid — or clickable — inside one. So the
  // row keeps its one-line preview and the rendered prose goes in the body, the
  // way every other expanded step already works (a tool's input, a shell's
  // output). `shown` therefore stays the preview at every state.
  const prose = proseOf(s);
  const proseHtml = useMemo(
    () => (open && prose.trim() ? highlightHtml(renderMarkdown(prose), q) : ''), [open, prose, q]);
  // Open, the head row stops carrying the text: the rendered prose is below it,
  // and the one-line preview above that would be the same words twice — once as
  // syntax. Collapsed it is the row's whole content, so it stays.
  const shown = proseHtml ? '' : preview;

  return (
    <div className={`cs${open ? ' open' : ''} ${s.kind}`}>
      <button className="cs-head" disabled={!can} onClick={() => setSelfOpen((o) => !o)}>
        {s.kind === 'tools'
          ? <span className={`cs-mark ${s.failed ? 'bad' : 'ok'}`}>{s.failed ? '✗' : '✓'}</span>
          : <span className={`cs-tri${can ? '' : ' off'}`}>{open ? '▾' : '▸'}</span>}
        {label && <span className="cs-label mono">{label}</span>}
        {shown ? <span className="cs-detail"><Hi text={shown} q={q} /></span> : <span className="cs-detail" />}
      </button>
      {open && (
        <div className="cs-body">
          {/* Rendered, not raw. A truncated message can end mid-fence or
              mid-table; marked closes both itself and DOMPurify reparses what it
              emits, so a cut tail cannot leave an open block that swallows the
              rest of the panel — pinned in test/stepMarkdown.test.mjs. */}
          {proseHtml ? (
            <div className="markdown cs-md" dangerouslySetInnerHTML={{ __html: proseHtml }} />
          ) : null}
          {!!full && !!more && <div className="cs-more mono">…{moreLabel(more)}</div>}
          {s.kind === 'tools' && s.blocks.map((b, i) => (
            b.type === 'tool_use' ? (
              <div key={i} className="cs-call">
                <ToolCall name={b.name} text={b.text} />
                {!!b.more && <div className="cs-more mono">…{moreLabel(b.more)}</div>}
              </div>
            ) : b.type === 'tool_result' ? (
              <pre key={i} className={`cs-pre out${b.failed ? ' bad' : ''}`}><Hi text={b.text.trim()} q={q} />{b.more ? `\n…${moreLabel(b.more)}` : ''}</pre>
            ) : null
          ))}
          {s.kind === 'shell' && <pre className="cs-pre out"><Hi text={s.out} q={q} /></pre>}
          {s.kind === 'image' && <img className="cs-img" src={s.src} alt="" />}
        </div>
      )}
    </div>
  );
}

/** The last step, as one line of status: "Bash cd /home/…", "Now the scan itself:". */
function nowDoing(s?: Step): string {
  if (!s) return '';
  if (s.kind === 'tools') return oneLine(`${s.name} ${s.details[s.details.length - 1] || ''}`, 70);
  if (s.kind === 'shell') return oneLine(s.command, 70);
  if (s.kind === 'image') return 'image';
  if (s.kind === 'think') return oneLine(s.text, 70);
  if (s.kind === 'compact') return 'context compacted';
  // "working · sub-agent Rework the Scene 1 intro" — what the pane last did was
  // start something, and saying so is more use than naming the tool.
  if (s.kind === 'agent') return oneLine(`sub-agent ${s.description}`, 70);
  return oneLine(s.text, 70);
}

/**
 * The prompt band — the one thing in a turn a person wrote.
 *
 * It renders as markdown now, like everything else in the reader: the answer
 * always did, and an aside, thinking and a compaction since #88, so a typed
 * `**important**` or a pasted fence was the last thing in the view still shown
 * as syntax. It goes through the answer's exact path — renderMarkdown, then
 * highlightHtml — so a search term lands in a rendered prompt the same way it
 * lands in a rendered answer, rather than through a second mechanism that
 * agrees with the first until it doesn't.
 *
 * ONE component for both call sites, deliberately. The band was written out by
 * hand in two places — the real turn and the optimistic echo — and #77 was
 * exactly those two drifting: the echo lost the `.cx` wrapper whose padding
 * cancels `margin-left: -1.23em`, and the newest prompt in every conversation
 * hung a gutter's width to the left. Two copies of markdown-plus-highlight is
 * the same bug with more surface, so there is one.
 */
function PromptBand({ text, q, queued }: { text: string; q?: string; queued?: boolean }) {
  // `breaks` because a prompt is typed, not authored — see renderMarkdown.
  const html = useMemo(() => highlightHtml(renderMarkdown(text, { breaks: true }), q), [text, q]);
  return (
    <div className="cx-prompt">
      <div className="markdown cx-pmd" dangerouslySetInnerHTML={{ __html: html }} />
      {/* Read from a queue record rather than a message: it was typed while the
          agent was working. Labelled because those records cannot say whether it
          was then consumed or cancelled — see TraceTurn.queued. It stays a
          sibling of the rendered block and still trails the last line: .cx-pmd
          is an inline-block, so the pill sits on that line's baseline instead of
          dropping below the block and making a queued one-liner a line taller
          than every other prompt. */}
      {queued ? <span className="cx-queued mono" title="Typed while the agent was working, so it waited in the queue">queued</span> : null}
    </div>
  );
}

/**
 * What one sub-agent did: the reader, one level down, and nothing else.
 *
 * A sub-agent's transcript is an ordinary trace — same records, same normalizer
 * — so it goes through splitExchanges and comes back out as exchanges that this
 * very component renders. Its first user message IS the task it was given, so
 * the prompt band the reader already draws for a user prompt is exactly the
 * right thing at the top of it: the task is highlighted because it is a prompt,
 * not because sub-agents get special paint.
 *
 * There is deliberately no wrapper of its own — no rail, no badge, no bespoke
 * task block. The step body it sits in already indents it, and that indent is
 * the whole hierarchy. An earlier cut of this had a rail, a clamped task panel
 * and a "show the whole task" button; all three were a second visual language
 * for content the reader can already draw, and they are gone.
 *
 * The window is 2 MB rather than the reader's 384 KB default because a
 * sub-agent's whole transcript is usually smaller than that (0.27–12 MB here,
 * most under four), and a window that holds the whole file is what puts the
 * task at the top. On the few that overflow it, the tail keeps the report and
 * the row above still names the task.
 */
function SubAgentTrace({ sessionId, agentId, live, roster }: {
  sessionId: string; agentId: string; live: boolean; roster?: SubAgentEntry[] | null;
}) {
  const [state, setState] = useState<{ turns?: TraceTurn[]; error?: string }>({});
  useEffect(() => {
    const ac = new AbortController();
    setState({});
    getSubAgentTrace(sessionId, agentId, 2_000_000, ac.signal)
      .then((w) => setState({ turns: w.turns }))
      .catch((e) => { if (!ac.signal.aborted) setState({ error: e?.message || 'could not read it' }); });
    return () => ac.abort();
  }, [sessionId, agentId]);

  if (state.error) return <div className="ca-msg mono">{state.error}</div>;
  if (!state.turns) return <div className="ca-msg mono">reading…</div>;
  const exchanges = splitExchanges(state.turns);
  if (!exchanges.length) return <div className="ca-msg mono">nothing recorded yet</div>;
  return (
    <>
      {exchanges.map((ex) => (
        <ExchangeView key={ex.key} x={ex} turns={state.turns} sessionId={sessionId} live={live} roster={roster} dim />
      ))}
    </>
  );
}

/**
 * One sub-agent, as a row. The same component in both places it appears: in the
 * step list, where it replaces the `Agent` tool row it used to be, and under the
 * working line while it runs. Two renderings of the same thing was how the
 * count and the list drifted apart in the first cut of this feature.
 */
function AgentRow({ spawn, entry, status, sessionId, live, rosterKnown, roster, rail }: {
  spawn: AgentSpawn; entry?: SubAgentEntry; status: AgentStatus;
  sessionId?: string; live: boolean; roster?: SubAgentEntry[] | null;
  /** the roster has answered, so "no entry" means "no transcript", not "not yet" */
  rosterKnown?: boolean;
  /**
   * Set in the live strip, where the rows hang off the pane's own working line
   * and the tree says so. Unset in the step list, where a sub-agent is one step
   * among many and a rail would draw a hierarchy that is not there.
   */
  rail?: { isLast: boolean };
}) {
  const [open, setOpen] = useState(false);
  const agentId = spawn.agentId || entry?.agentId;
  // Not every spawn has a transcript. the-gatherer's parent holds 168 `Agent`
  // calls and its `subagents/` directory holds 38 sidecars: the older CLI kept
  // no per-sub-agent file, so those turns can be counted and their outcomes
  // read from the notifications, but there is nothing to open. A row that
  // offers a triangle and then 404s is worse than a row that says so.
  const can = !!agentId && !!sessionId && (entry ? entry.hasTranscript : !rosterKnown);
  // The harness's own duration when the notification reported one; otherwise
  // how long it has been going. Never a guess from mtime — see agentStatus.
  const took = spawn.durationMs ? fmtDur(spawn.durationMs)
    : (spawn.outcomeAt && spawn.spawnedAt ? fmtDur(spawn.outcomeAt - spawn.spawnedAt) : '');
  const going = !spawn.outcome && spawn.spawnedAt ? fmtDur(Date.now() - spawn.spawnedAt) : '';
  const quiet = !spawn.outcome && entry?.lastWroteAt ? fmtDur(Date.now() - entry.lastWroteAt) : '';
  const mark = status === 'running' ? <span className="cs-mark spin" aria-label="running" />
    : status === 'done' ? <span className="cs-mark ok">✓</span>
      : status === 'failed' || status === 'killed' ? <span className="cs-mark bad">✗</span>
        : <span className="cs-tri off">–</span>;
  return (
    <div className={`cs agent ${status}${open ? ' open' : ''}`}>
      <button className={`cs-head${rail ? ' railed' : ''}`} disabled={!can} onClick={() => setOpen((o) => !o)}
              title={can ? 'Show the task and what it did' : 'no transcript on disk for this one'}>
        {rail ? <Rails prefix={[]} isLast={rail.isLast} /> : null}
        {open ? <span className="cs-tri">▾</span> : mark}
        <span className="cs-label mono">sub-agent</span>
        <span className="cs-detail">{spawn.description}</span>
        {status === 'stalled' || status === 'no-result' ? (
          <span className={`cs-state ${status}`}>{status === 'stalled' ? 'no write in 15m' : 'no result'}</span>
        ) : null}
        {!can && rosterKnown ? <span className="cs-state">no transcript kept</span> : null}
        <span className="cs-facts mono">
          {entry?.depth && entry.depth > 1 ? <span className="depth">↳{entry.depth}</span> : null}
          {/* codex names its sub-agents — Curie, Herschel, Boole — and that name
              is a better handle than the task path. Shown only when it IS a
              name: Claude's `general-purpose` is noise on every row. */}
          {entry?.agentType && !['general-purpose', 'sub-agent', 'agent'].includes(entry.agentType)
            ? <span className="who">{entry.agentType}</span> : null}
          {took ? <span>{took}</span> : going ? <span>{going}</span> : null}
          {/* Two different facts, and the second is not a verdict: `took` is what
              the parent recorded, `wrote` is when the file last changed. */}
          {!spawn.outcome && quiet ? <span className="dim" title="since it last wrote — not a verdict on whether it is alive">wrote {quiet} ago</span> : null}
          {/* What it spent, from the completion notification: the only place a
              sub-agent's own count is written down. Tokens and calls, not a bill
              — nearly all of what these read was cache. */}
          {spawn.toolCalls ? <span>{spawn.toolCalls} calls</span> : null}
          {spawn.tokens ? <span>{fmtTok(spawn.tokens)} tok</span> : null}
        </span>
      </button>
      {open && agentId && sessionId && (
        <div className="cs-body">
          {/* Its trace, drawn by the reader. The task arrives as that trace's own
              first prompt, so nothing here has to render it separately. */}
          <SubAgentTrace sessionId={sessionId} agentId={agentId} live={live} roster={roster} />
        </div>
      )}
    </div>
  );
}

/**
 * The sub-agents of this turn, listed under the working line — the thing the
 * feature is for. Collapsed exchange, nothing expanded: the pane says it is
 * working, and these say what is working underneath it.
 *
 * ALL OF THEM, and the strip is the unit that comes and goes. A sub-agent that
 * finishes stays in the strip with its finished mark for as long as any sibling
 * is still running; when the last one finishes the whole strip goes, and the
 * sub-agents are where every other step is — in the collapsed work. That is one
 * appearance and one disappearance per turn instead of one per sub-agent, and it
 * is why the six-second linger this file used to carry (and the client-side
 * "first seen finished" bookkeeping behind it) is deleted rather than kept: it
 * existed to soften rows leaving one at a time, which no longer happens.
 *
 * CAPPED, because rows now accumulate: a release-video turn ends at 22, and
 * the-gatherer's busiest ends at 40. Over the cap, the rows that give way are
 * the FINISHED ones, oldest first — the strip is about what is still going, and
 * the finished ones are one click away in the work. The strip's height therefore
 * stops growing at the cap instead of resizing every time one completes.
 */
const LIVE_CAP = 10;

function LiveAgents({ rows, sessionId, live, rosterKnown, roster }: {
  rows: { spawn: AgentSpawn; entry?: SubAgentEntry; status: AgentStatus }[];
  sessionId?: string; live: boolean; rosterKnown?: boolean; roster?: SubAgentEntry[] | null;
}) {
  const { shown, note } = capRows(rows, LIVE_CAP);
  if (!rows.length) return null;
  return (
    <div className="cx-live">
      {shown.map((r, i) => (
        <AgentRow key={r.spawn.toolUseId} spawn={r.spawn} entry={r.entry} status={r.status}
                  sessionId={sessionId} live={live} rosterKnown={rosterKnown} roster={roster}
                  // …and the elbow belongs to whatever is actually last. With the
                  // cap in play that is the overflow line, not the last row.
                  rail={{ isLast: railIsLast(i, shown.length, !!note) }} />
      ))}
      {note ? (
        <div className="cx-live-more mono">
          <Rails prefix={[]} isLast />
          {note}
        </div>
      ) : null}
    </div>
  );
}

export function ExchangeView({
  x, n, total, open, onToggle, running, dim, q, baseModel, turns, sessionId, live, roster,
}: {
  x: Exchange;
  n?: number;            // 1-based position — the viewer numbers turns, a card does not
  total?: number;
  open?: boolean;        // controlled fold of the work
  onToggle?: () => void;
  running?: boolean;     // no answer yet, and one is coming
  dim?: boolean;         // an earlier exchange, prepended above the current one
  q?: string;            // lowercased search term, highlighted where it lands
  baseModel?: string;    // the session's model; a turn only names its own if it differs
  /**
   * The whole loaded window. Only the sub-agent strip needs it: a background
   * sub-agent's completion is recorded in a LATER turn than the one that
   * spawned it, so an exchange cannot tell on its own whether its sub-agents
   * finished.
   */
  turns?: TraceTurn[];
  sessionId?: string;    // to fetch a sub-agent's transcript
  live?: boolean;        // the pane's own process is alive — gates the word "running"
  /**
   * The session's sub-agent roster, fetched ONCE by the reader rather than by
   * each exchange. It carries what the window cannot: the agentId of a spawn
   * whose launch receipt has scrolled away, the depth, and when each transcript
   * last changed. Per-exchange fetching also lost the answer — an effect keyed
   * on the pane's liveness re-ran the moment the pane started working and threw
   * the result away, so rows never got their `wrote 4m ago`.
   */
  roster?: SubAgentEntry[] | null;
}) {
  const [selfOpen, setSelfOpen] = useState(false);
  const toggle = onToggle ?? (() => setSelfOpen((o) => !o));

  // The work, split where the answer belongs. Grouping runs over each side
  // separately on purpose: two Reads either side of the agent's reply are two
  // things it did, before and after saying it, and collapsing them into one
  // `Read ×2` row would erase exactly the sequence this is here to keep.
  const at = x.answerAt;
  const stepsBefore = useMemo(() => stepsOf(at == null ? x.steps : x.steps.slice(0, at)), [x.steps, at]);
  const stepsAfter = useMemo(() => (at == null ? [] : stepsOf(x.steps.slice(at))), [x.steps, at]);
  const steps = useMemo(() => [...stepsBefore, ...stepsAfter], [stepsBefore, stepsAfter]);
  // A turn whose match is buried in the work unfolds it, or the search would
  // report a hit with nothing on screen to look at.
  const hitInWork = useMemo(
    () => (q ? steps.some((s) => stepText(s).toLowerCase().includes(q)) : false), [steps, q]);
  const isOpen = open ?? (selfOpen || hitInWork);
  const prompt = textOf(x.prompt);
  const answer = textOf(x.answer);
  const answerHtml = useMemo(
    () => (answer ? highlightHtml(renderMarkdown(answer), q) : ''), [answer, q]);
  const answerMore = moreOf(x.answer);
  // Counted over the split, deliberately: the fold control says how many rows
  // are behind it, so "2 steps" has to mean two rows when you open it. The cost
  // is that a turn whose answer landed mid-work can report one row more than an
  // identical turn whose answer came last — same tools, same time, different
  // grouping. `stepSummary(x, stepsOf(x.steps))` would count the whole turn
  // instead and disagree with what unfolds; between the two, the number that
  // matches what you are about to see wins.
  // The sub-agents this turn started. Computed over the whole window, not the
  // exchange, because a background one finishes in a later turn than the one
  // that spawned it.
  const spawns = useMemo(() => agentSpawnsOf(x, turns || []), [x, turns]);
  const summary = stepSummary(x, steps, spawns.length);
  // Two join keys, because the two harnesses record different things: Claude's
  // sidecar carries the spawning call's id, codex's rollout header carries the
  // task name and no id at all.
  const entryOf = useMemo(() => {
    const m = new Map<string, SubAgentEntry>();
    for (const e of roster || []) {
      if (e.toolUseId) m.set(e.toolUseId, e);
      const task = (e.taskName || '').split('/').filter(Boolean).pop();
      if (task) m.set(`task:${task}`, e);
    }
    return m;
  }, [roster]);
  const agentRows = useMemo(() => spawns.map((s) => {
    const entry = entryOf.get(s.toolUseId) || (s.taskName ? entryOf.get(`task:${s.taskName}`) : undefined);
    return { spawn: s, entry, status: agentStatus(s, { live: !!live, lastWroteAt: entry?.lastWroteAt }) };
  }), [spawns, entryOf, live]);
  // The strip is all-or-nothing: while ANY sub-agent of this turn is still
  // going it lists them all, finished ones included, so the list a glance sees
  // does not rearrange itself every time one lands. When none is live it is not
  // rendered at all and they are in the work with every other step.
  const liveNow = anyLive(agentRows.map((r) => r.status));
  const latest = running ? nowDoing(steps[steps.length - 1]) : '';
  // Naming the model on every turn is noise when it never changes; when it DOES
  // change mid-session that is worth a word, so say it only then.
  const model = x.model && x.model !== baseModel ? x.model : '';
  // Which turn, when, and on what — the viewer's business. A card shows one
  // turn, dated in its own header, so it says none of this. It is one fragment
  // because two rows can carry it: the meta row normally, and the working line
  // when the turn has nothing else to say yet.
  const facts = (
    <>
      <span className="spacer" />
      {model && <span className="cx-model">{model}</span>}
      {/* Padded to the width of the total, in FIGURE spaces: the row is mono and
          tabular, so one figure space is exactly one digit, and "turn  9/10"
          lines up under "turn 10/10" instead of the whole right cluster stepping
          left the moment a session passes nine turns. A plain space would
          collapse in HTML. */}
      <span className="cx-n">turn {padTurn(n ?? 0, total)}{total ? `/${total}` : ''}</span>
      {x.startTs ? <span className="cx-time">{fmtClock(x.startTs)}</span> : null}
    </>
  );
  const factsOnRunningRow = !summary && !!running && n != null;
  // A sub-agent step is a row with a life of its own, so it is drawn by the
  // component that also draws it under the working line — one rendering, two
  // places. Everything else is the step rail as it was.
  const rowByToolUse = new Map(agentRows.map((r) => [r.spawn.toolUseId, r]));
  const renderStep = (s: Step, key: string) => {
    if (s.kind !== 'agent') return <StepRow key={key} s={s} q={q} />;
    const r = rowByToolUse.get(s.toolUseId);
    return (
      <AgentRow key={key}
                spawn={r?.spawn ?? { toolUseId: s.toolUseId, taskName: s.taskName, description: s.description, agentType: s.agentType, background: false }}
                entry={r?.entry} status={r?.status ?? (live ? 'running' : 'no-result')}
                sessionId={sessionId} live={!!live} rosterKnown={!!roster} roster={roster} />
    );
  };

  return (
    <section className={`cx${dim ? ' dim' : ''}`}>
      {prompt ? <PromptBand text={prompt} q={q} queued={!!x.prompt?.queued} /> : null}

      {/* Everything about the turn on ONE line, under the prompt: what the work
          was on the left, which turn it is on the right. Nothing above.
          A turn that has not done anything yet has no left half — no steps, no
          duration, no tokens — and rendering the row anyway left an empty line
          above the `working` line, which is what read as the widget sitting
          "weirdly low". In that state the facts ride on the working line itself,
          so there is one row instead of one and a half. The working line does not
          move: it is the last row either way, at the text column. */}
      {(summary || spawns.length > 0 || (n != null && !factsOnRunningRow)) && (
      <div className="cx-meta mono">
        {steps.length > 0 ? (
          <button className={`cx-fold${isOpen ? ' on' : ''}`} onClick={toggle} title={isOpen ? 'Hide the work' : 'Show the work'}>
            <span className="cs-tri">{isOpen ? '▾' : '▸'}</span>
            {summary}
          </button>
        ) : <span className="cx-fold flat">{summary}</span>}
        {/* Sub-agents sit in this line, where the operator asked for them, but as
            their own control: the fold to their left opens the turn's work, and
            this one opens the list of sub-agents. One button cannot open two
            different things, and burying the count inside the work fold would
            make "how many are running" cost a click that also unfolds forty
            tool rows. */}
        {/* Which turn, when, and on what — the viewer's business. A card shows one
            turn, dated in its own header, so it says none of this. */}
        {n != null && facts}
      </div>
      )}
      {isOpen && stepsBefore.length > 0 && (
        <div className="cx-steps">{stepsBefore.map((s, i) => renderStep(s, `b${i}`))}</div>
      )}

      {/* The answer sits where it was said. Usually that is after all the work;
          when the agent answered and then kept going, `answerAt` puts it back
          between the two runs of steps instead of under work it predates. */}
      {answerHtml ? (
        <div className="cx-answer">
          <div className="markdown cx-md" dangerouslySetInnerHTML={{ __html: answerHtml }} />
          {!!answerMore && <div className="cx-note mono">…{moreLabel(answerMore)}</div>}
        </div>
      ) : null}
      {isOpen && stepsAfter.length > 0 && (
        <div className="cx-steps">{stepsAfter.map((s, i) => renderStep(s, `a${i}`))}</div>
      )}
      {/* Mid-task there is no answer — an agent's aside is not a reply — so the
          running line carries the latest thing that happened instead. */}
      {running && (
        <div className="cx-running mono">
          working{latest && <span className="cx-running-at">· {latest}</span>}
          {factsOnRunningRow && facts}
        </div>
      )}
      {/* …and what is working underneath it. This is the point of the feature:
          the exchange is collapsed, nothing has been expanded, and the pane's
          own `working` line is followed by every sub-agent this turn started —
          the ones still going and the ones that have landed. Each row is the row
          the step list shows, so opening one here costs no navigation. */}
      {liveNow && !isOpen && (
        <LiveAgents rows={agentRows} sessionId={sessionId} live={!!live} rosterKnown={!!roster} roster={roster} />
      )}
    </section>
  );
}

/**
 * The prompt you just sent, before the transcript has caught up.
 *
 * It is laid out as an exchange — a `.cx` section, exactly like the turn it
 * becomes a second later — and not as a loose band. Written out by hand at both
 * call sites it was neither: `.cx-prompt`'s `margin-left: -1.23em` exists to
 * cancel `.cx`'s matching padding, and with no `.cx` around it there was
 * nothing to cancel, so the newest prompt in a conversation hung 16px left of
 * every prompt above it — in the reader and in the card alike. The band itself
 * is PromptBand, the same component the real turn renders, so what it contains
 * cannot drift either.
 */
export function PendingExchange({ text }: { text: string }) {
  return (
    <section className="cx">
      <PromptBand text={text} />
      <div className="cx-running mono">working</div>
    </section>
  );
}

export default ExchangeView;
