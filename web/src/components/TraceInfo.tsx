import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import type { Session } from '../types';
import { fmtTok } from './conversation/exchanges';
import { DownloadGlyph, ShareGlyph } from './icons';

/**
 * What is true of this conversation, and what you can do with the file behind
 * it — behind one `i` in the pane header, so it is in the same place whether you
 * are watching the terminal or reading the transcript.
 *
 * It lives in the header rather than in the reader's toolbar because these are
 * facts about the SESSION, not about the reader: a pane that is showing a
 * terminal has the same model, the same token total and the same start date, and
 * the operator asked for the info to be reachable from both views. One instance
 * also means one place to look, one tap target to keep, and — because the reader
 * hands its already-loaded head down as `facts` — no second read of the
 * transcript when the reader is the view you are in.
 */
const fmtNum = (n: number) => n.toLocaleString();
const fmtUsage = (u?: { in: number; out: number } | null) =>
  (u ? `${fmtTok(u.in)}↓ ${fmtTok(u.out)}↑` : '');
/** The day it started: "14 Aug", with the year when it is not this one. */
const fmtStarted = (ms: number) => {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
};

type Load = 'idle' | 'loading' | 'ready' | 'none' | 'error';

export default function TraceInfo({ session, facts, turnsLoaded, onShare }: {
  session: Session;
  /** What the reader already holds. Present only while the reader is the view. */
  facts?: api.TraceSummary | null;
  /** Turns the reader is holding, for the window-only state before its summary. */
  turnsLoaded?: number;
  /** Publish this session — the same dialog the sidebar row opens. */
  onShare?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<api.TraceSummary | null>(null);
  const [load, setLoad] = useState<Load>('idle');
  const wrap = useRef<HTMLDivElement | null>(null);
  const abort = useRef<AbortController | null>(null);

  // A pane switching to another session keeps this component; its facts must not.
  useEffect(() => {
    abort.current?.abort();
    abort.current = null;
    setSummary(null);
    setLoad('idle');
    setOpen(false);
  }, [session.id]);
  useEffect(() => () => abort.current?.abort(), []);

  // The whole-file read happens when the panel is OPENED, and once. A terminal
  // pane has no reason to have parsed the transcript, and that parse is the
  // expensive one (docs/conversation-view.md §5) — every pane paying for a
  // summary nobody asked to see is exactly what the reader's own delay avoids.
  const show = () => {
    setOpen(true);
    if (facts || summary || load === 'loading') return;
    setLoad('loading');
    const controller = new AbortController();
    abort.current = controller;
    api.getTraceSummary(session.id, controller.signal)
      .then((s) => { setSummary(s); setLoad('ready'); })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setLoad(e instanceof api.TraceUnavailable && e.code === 'no-trace' ? 'none' : 'error');
      })
      .finally(() => { if (abort.current === controller) abort.current = null; });
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const known = facts ?? summary;
  const prompts = known?.userTurns?.length ?? null;
  const messages = known?.total ?? null;
  // Reading the transcript, or there is nothing to read: say which, rather than
  // showing a panel of blanks or a confident row of zeros.
  const pending = !known && (load === 'loading' || load === 'idle');

  return (
    <div className="tinfo-wrap" ref={wrap} onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`tinfo-btn${open ? ' on' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="About this conversation"
        title="About this conversation"
        draggable={false}
        onClick={(e) => { e.stopPropagation(); if (open) setOpen(false); else show(); }}
      >i</button>
      {open && (
        <div className="tinfo" role="dialog" aria-label="About this conversation">
          {pending && <div className="tinfo-state mono" aria-live="polite">reading the transcript…</div>}
          {!known && load === 'none' && (
            <div className="tinfo-state mono">
              No transcript yet — this agent has not written one. It appears here once it answers.
            </div>
          )}
          {!known && load === 'error' && (
            <div className="tinfo-state mono">Could not read the transcript. Close this and try again.</div>
          )}
          {known && (
            <dl className="tinfo-facts">
              {known.model && (<><dt>Model</dt><dd>{known.model}</dd></>)}
              <dt>Turns</dt>
              <dd>
                {prompts != null ? `${fmtNum(prompts)} turn${prompts === 1 ? '' : 's'}` : '—'}
                {messages != null
                  ? ` · ${fmtNum(messages)} message${messages === 1 ? '' : 's'}`
                  : (turnsLoaded != null ? ` · ${fmtNum(turnsLoaded)} loaded` : '')}
              </dd>
              {known.usage && (
                <>
                  <dt>Tokens</dt>
                  <dd>
                    {fmtUsage(known.usage)}
                    {known.usage.cacheRead ? ` · ${fmtTok(known.usage.cacheRead)} cached` : ''}
                  </dd>
                </>
              )}
              {!!known.firstTs && (
                <>
                  <dt>Started</dt>
                  <dd>
                    <span className="tinfo-when">{fmtStarted(known.firstTs)}</span>
                    {' · '}{new Date(known.firstTs).toLocaleString()}
                  </dd>
                </>
              )}
            </dl>
          )}
          {/* The file itself. Offered once we know there IS one: a session that
              has not spoken would answer this link with `no-trace`, and a button
              that 404s is worse than a sentence saying why it is not there. */}
          <div className="tinfo-actions">
            {known && (
              <a
                className="btn-ghost"
                href={api.traceDownloadUrl(session.id)}
                download
                aria-label="Download this conversation's transcript"
                onClick={() => setOpen(false)}
              ><DownloadGlyph /> Download</a>
            )}
            {onShare && (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => { setOpen(false); onShare(); }}
              ><ShareGlyph /> Share…</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
