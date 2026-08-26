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
import { getSubAgents, getSubAgentTrace } from '../../api';
import { renderMarkdown } from '../../lib/markdown';
import type { Exchange, Step } from './exchanges';
import { agentCounts, agentSpawnsOf, fmtClock, fmtDur, fmtTok, oneLine, proseOf, splitExchanges, stepSummary, stepText, stepsOf } from './exchanges';
import type { AgentSpawn } from './exchanges';
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
 * What one sub-agent did — the reader, one level down.
 *
 * A sub-agent's transcript is an ordinary trace: same records, same normalizer,
 * so it goes through splitExchanges and comes back out as exchanges that this
 * very component renders. Its first user message is the task it was given, so
 * the prompt band is already the right thing to show at the top. It is also why
 * a sub-agent that spawned sub-agents (rl-llm-wiki did, seven of them at depth
 * 2) unfolds the same way without a second implementation: the directory is
 * flat, so the same endpoint answers for a child of a child.
 */
function SubAgentTrace({ sessionId, agentId, live }: { sessionId: string; agentId: string; live: boolean }) {
  const [state, setState] = useState<{ turns?: TraceTurn[]; error?: string }>({});
  useEffect(() => {
    const ac = new AbortController();
    setState({});
    getSubAgentTrace(sessionId, agentId, 400_000, ac.signal)
      .then((w) => setState({ turns: w.turns }))
      .catch((e) => { if (!ac.signal.aborted) setState({ error: e?.message || 'could not read it' }); });
    return () => ac.abort();
  }, [sessionId, agentId]);

  if (state.error) return <div className="ca-msg mono">{state.error}</div>;
  if (!state.turns) return <div className="ca-msg mono">reading…</div>;
  const exchanges = splitExchanges(state.turns);
  if (!exchanges.length) return <div className="ca-msg mono">nothing recorded yet</div>;
  return (
    <div className="ca-trace">
      {exchanges.map((ex) => (
        <ExchangeView key={ex.key} x={ex} turns={state.turns} sessionId={sessionId} live={live} dim />
      ))}
    </div>
  );
}

/** One row: what it was asked, what became of it, and how big it got. */
function SubAgentRow({ spawn, entry, sessionId, live }: {
  spawn: AgentSpawn; entry?: SubAgentEntry; sessionId?: string; live: boolean;
}) {
  const [open, setOpen] = useState(false);
  const agentId = spawn.agentId || entry?.agentId;
  // Whether it is FINISHED is the parent's word (a notification, or a
  // synchronous report). Whether it is running is the pane's state. Neither is
  // ever inferred from the file's mtime — see exchanges.ts.
  const status = spawn.outcome
    ? (spawn.outcome === 'reported' ? 'done' : spawn.outcome)
    : (live ? 'running' : 'no result');
  // The harness's own duration when it reported one, the span between the two
  // records otherwise. Both are the parent's word; neither is a guess from mtime.
  const took = spawn.durationMs ? fmtDur(spawn.durationMs)
    : (spawn.outcomeAt && spawn.spawnedAt ? fmtDur(spawn.outcomeAt - spawn.spawnedAt) : '');
  const since = !spawn.outcome && entry?.lastWroteAt ? fmtDur(Date.now() - entry.lastWroteAt) : '';
  const can = !!agentId && !!sessionId && (entry ? entry.hasTranscript : true);
  return (
    <div className={`ca-row${open ? ' open' : ''}`}>
      <button className="ca-head" disabled={!can} onClick={() => setOpen((o) => !o)}
              title={can ? 'Show what this sub-agent did' : 'no transcript on disk for this one'}>
        <span className={`cs-tri${can ? '' : ' off'}`}>{open ? '▾' : '▸'}</span>
        <span className={`ca-state ${status.replace(' ', '-')}`}>{status}</span>
        <span className="ca-what">{spawn.description}</span>
        <span className="spacer" />
        {entry?.depth && entry.depth > 1 ? <span className="ca-depth mono">↳{entry.depth}</span> : null}
        <span className="ca-type mono">{entry?.agentType || spawn.agentType}</span>
        {/* Two different facts, and the second one is not a verdict: `took` is
            the parent's recorded span, `wrote` is how long since the file last
            changed. Silence inside a live sub-agent reached 601s here, so the
            reader shows the number and lets the operator judge it. */}
        {took ? <span className="ca-num mono">{took}</span>
              : since ? <span className="ca-num mono" title="since it last wrote — not a verdict on whether it is alive">wrote {since} ago</span> : null}
        {/* What it spent, from the completion notification — the only place a
            sub-agent's own token count is written down. Output-side tokens and
            tool calls, not a bill: nearly all of the tokens these read were
            cache reads. */}
        {spawn.toolCalls ? <span className="ca-num mono">{spawn.toolCalls} calls</span> : null}
        {spawn.tokens ? <span className="ca-num mono">{fmtTok(spawn.tokens)} tok</span> : null}
        {entry?.bytes ? <span className="ca-num mono">{fmtTok(entry.bytes)}B</span> : null}
      </button>
      {open && agentId && sessionId && (
        <div className="ca-body"><SubAgentTrace sessionId={sessionId} agentId={agentId} live={live} /></div>
      )}
    </div>
  );
}

/**
 * The count in the summary line, and the two levels it opens onto.
 *
 * Level one is the number, next to the steps and tools — the operator asked for
 * "how many are done/running" in that line. Level two is this turn's sub-agents,
 * one row each. Level three is a row's own transcript.
 *
 * The roster is fetched only when the list is opened, and it comes from the
 * `subagents/` directory rather than the parent transcript — the parent reaches
 * 292 MB on this machine, the roster is a directory listing. It fills in what
 * the window cannot see: the agentId for a spawn whose launch receipt scrolled
 * out of the window, the depth, and the size of what each one wrote.
 */
function SubAgentsButton({ spawns, live, open, onToggle }: {
  spawns: AgentSpawn[]; live: boolean; open: boolean; onToggle: () => void;
}) {
  const counts = agentCounts(spawns, live);
  return (
    <button className={`cx-agents${open ? ' on' : ''}`} onClick={onToggle}
            title={open ? 'Hide the sub-agents' : 'Show what each sub-agent was asked to do'}>
      <span className="cs-tri">{open ? '▾' : '▸'}</span>
      {counts.label}
    </button>
  );
}

/**
 * The list, one row per sub-agent this turn started.
 *
 * The roster is fetched when the list opens, and it comes from the `subagents/`
 * directory rather than the parent transcript — the parent reaches 292 MB on
 * this machine, the roster is a directory listing plus 187 bytes per agent. It
 * fills in what the window cannot see: the agentId for a spawn whose launch
 * receipt has scrolled out of view, the depth, and how much each one wrote.
 */
function SubAgentsList({ spawns, sessionId, live }: { spawns: AgentSpawn[]; sessionId?: string; live: boolean }) {
  const [roster, setRoster] = useState<SubAgentEntry[] | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!sessionId) return;
    const ac = new AbortController();
    getSubAgents(sessionId, ac.signal)
      .then((r) => { setRoster(r.agents); if (!r.supported && r.reason) setNote(r.reason); })
      .catch(() => setNote('the roster could not be read'));
    return () => ac.abort();
  }, [sessionId]);

  const byToolUse = useMemo(() => {
    const m = new Map<string, SubAgentEntry>();
    for (const e of roster || []) if (e.toolUseId) m.set(e.toolUseId, e);
    return m;
  }, [roster]);
  const inThisTurn = new Set(spawns.map((s) => s.toolUseId));
  const elsewhere = (roster || []).filter((e) => !e.toolUseId || !inThisTurn.has(e.toolUseId)).length;

  return (
    <div className="cx-agents-list">
      {spawns.map((s) => (
        <SubAgentRow key={s.toolUseId} spawn={s} entry={byToolUse.get(s.toolUseId)} sessionId={sessionId} live={live} />
      ))}
      {/* Said plainly rather than folded into the count: the number above is this
          TURN's spawns, and a session's directory usually holds more — including
          sub-agents that other sub-agents started, which the parent's own tool
          calls never mention. */}
      {elsewhere ? <div className="ca-msg mono">{elsewhere} more in this session, from other turns</div> : null}
      {note ? <div className="ca-msg mono">{note}</div> : null}
    </div>
  );
}

export function ExchangeView({
  x, n, total, open, onToggle, running, dim, q, baseModel, turns, sessionId, live,
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
  sessionId?: string;    // to fetch a sub-agent's roster and transcript
  live?: boolean;        // the pane's own process is alive — gates the word "running"
}) {
  const [selfOpen, setSelfOpen] = useState(false);
  const toggle = onToggle ?? (() => setSelfOpen((o) => !o));
  // Its own disclosure, next to the work's: the sub-agent list is a different
  // question from "show me the tool calls", and opening one should not open the
  // other. It lives here rather than inside the button so the list can render
  // BELOW the meta row — the row is a flex line, and a list inside it lands to
  // the right of the numbers instead of under them.
  const [agentsOpen, setAgentsOpen] = useState(false);

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
  const summary = stepSummary(x, steps);
  // The sub-agents this turn started. Computed over the whole window, not the
  // exchange, because a background one finishes in a later turn than the one
  // that spawned it.
  const spawns = useMemo(() => agentSpawnsOf(x, turns || []), [x, turns]);
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
        {spawns.length > 0 && (
          <SubAgentsButton spawns={spawns} live={!!live} open={agentsOpen} onToggle={() => setAgentsOpen((o) => !o)} />
        )}
        {/* Which turn, when, and on what — the viewer's business. A card shows one
            turn, dated in its own header, so it says none of this. */}
        {n != null && facts}
      </div>
      )}
      {agentsOpen && spawns.length > 0 && (
        <SubAgentsList spawns={spawns} sessionId={sessionId} live={!!live} />
      )}
      {isOpen && stepsBefore.length > 0 && (
        <div className="cx-steps">{stepsBefore.map((s, i) => <StepRow key={i} s={s} q={q} />)}</div>
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
        <div className="cx-steps">{stepsAfter.map((s, i) => <StepRow key={`a${i}`} s={s} q={q} />)}</div>
      )}
      {/* Mid-task there is no answer — an agent's aside is not a reply — so the
          running line carries the latest thing that happened instead. */}
      {running && (
        <div className="cx-running mono">
          working{latest && <span className="cx-running-at">· {latest}</span>}
          {factsOnRunningRow && facts}
        </div>
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
