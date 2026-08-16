// One exchange, at whatever depth the surface needs. (docs/conversation-view.md §2)
//
// The Overview card is one of these plus a reply box; RENDER mode is a stack of
// them. Nothing here knows which — that is the point, and it is why the two
// surfaces cannot drift apart again.
//
// Left edge: the prompt's ❯ is the ONLY thing outside the text column. No rail
// on the answer, no rail on the work — scrolling, you find turns by that arrow
// and the tinted prompt bar, and everything else lines up in one column.
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { TraceTurn } from '../../api';
import { renderMarkdown } from '../../lib/markdown';
import type { Exchange, Step } from './exchanges';
import { fmtClock, fmtDur, fmtTok, oneLine, stepSummary, stepText, stepsOf } from './exchanges';
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
  const shown = open && full ? full : preview;

  return (
    <div className={`cs${open ? ' open' : ''} ${s.kind}`}>
      <button className="cs-head" disabled={!can} onClick={() => setSelfOpen((o) => !o)}>
        {s.kind === 'tools'
          ? <span className={`cs-mark ${s.failed ? 'bad' : 'ok'}`}>{s.failed ? '✗' : '✓'}</span>
          : <span className={`cs-tri${can ? '' : ' off'}`}>{open ? '▾' : '▸'}</span>}
        {label && <span className="cs-label mono">{label}</span>}
        <span className={`cs-detail${open && full ? ' full' : ''}`}><Hi text={shown} q={q} /></span>
      </button>
      {open && (
        <div className="cs-body">
          {/* the text already expanded above; only its cut tail is left to say */}
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

export function ExchangeView({
  x, n, total, open, onToggle, running, dim, q, baseModel,
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
  const summary = stepSummary(x, steps);
  const latest = running ? nowDoing(steps[steps.length - 1]) : '';
  // Naming the model on every turn is noise when it never changes; when it DOES
  // change mid-session that is worth a word, so say it only then.
  const model = x.model && x.model !== baseModel ? x.model : '';

  return (
    <section className={`cx${dim ? ' dim' : ''}`}>
      {prompt ? <div className="cx-prompt"><Hi text={prompt} q={q} /></div> : null}

      {/* Everything about the turn on ONE line, under the prompt: what the work
          was on the left, which turn it is on the right. Nothing above. */}
      {(summary || n != null) && (
      <div className="cx-meta mono">
        {steps.length > 0 ? (
          <button className={`cx-fold${isOpen ? ' on' : ''}`} onClick={toggle} title={isOpen ? 'Hide the work' : 'Show the work'}>
            <span className="cs-tri">{isOpen ? '▾' : '▸'}</span>
            {summary}
          </button>
        ) : <span className="cx-fold flat">{summary}</span>}
        {/* Which turn, when, and on what — the viewer's business. A card shows one
            turn, dated in its own header, so it says none of this. */}
        {n != null && (
          <>
            <span className="spacer" />
            {model && <span className="cx-model">{model}</span>}
            {/* Padded to the width of the total, in FIGURE spaces: the row is
                mono and tabular, so one figure space is exactly one digit, and
                "turn  9/10" lines up under "turn 10/10" instead of the whole
                right cluster stepping left the moment a session passes nine
                turns. A plain space would collapse in HTML. */}
            <span className="cx-n">turn {padTurn(n, total)}{total ? `/${total}` : ''}</span>
            {x.startTs ? <span className="cx-time">{fmtClock(x.startTs)}</span> : null}
          </>
        )}
      </div>
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
 * every prompt above it — in the reader and in the card alike.
 */
export function PendingExchange({ text }: { text: string }) {
  return (
    <section className="cx">
      <div className="cx-prompt">{text}</div>
      <div className="cx-running mono">working</div>
    </section>
  );
}

export default ExchangeView;
