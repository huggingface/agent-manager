import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteInfo, RemoteMessage, Session } from '../types';
import { REMOTE_STATE_LABEL } from '../types';
import * as api from '../api';
import StateLogo from './StateLogo';
import { renderMarkdown } from '../lib/markdown';
import { groupLabel, sessionTitle } from '../lib/sessionTitle';
import { BackGlyph, CloseGlyph, StopGlyph, PlayGlyph, ShareGlyph, AckGlyph } from './icons';

// Looks like the terminal, is not one: no PTY, no xterm.js, no WebSocket. The
// agent's real TUI is running on its own machine — what crosses the wire is
// messages, so this renders markdown into a mono-styled log with a composer
// underneath. See docs/remote-agents.md §7.

const POLL_MS = 2000; // the app's existing /api/tree cadence
const MAX_RENDER = 2000; // a human-paced conversation, not a 6 MB transcript

const fmtAgo = (ts?: number | null) => {
  if (!ts) return null;
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

export default function RemotePane({
  session, focused, zoom = 100, dragId, groupName, onBack, onDragActive, onFocus, onClose, onRename,
}: {
  session: Session;
  groupName?: string | null; // the group this pane belongs to, if any
  focused?: boolean;
  zoom?: number;
  dragId?: string;
  onBack?: () => void;       // mobile: leave the pane for the list (see .ph-back)
  onDragActive?: (dragging: boolean) => void;
  onFocus?: () => void;
  onClose: () => void;
  onRename?: (name: string) => void;
}) {
  const name = session.remote?.name || '';
  const group = groupLabel(groupName);
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [messages, setMessages] = useState<RemoteMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(session.name);
  const [connectOpen, setConnectOpen] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const cursor = useRef(0);
  const atBottom = useRef(true);
  const autoOpened = useRef(false);

  // One font size for the log, the composer and the status line, so the pane
  // reads as one surface and the zoom control moves all of it together.
  const fontSize = `${(13 * zoom) / 100}px`;

  const absorb = useCallback((incoming: RemoteMessage[]) => {
    if (!incoming.length) return;
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.seq));
      const merged = [...prev, ...incoming.filter((m) => !seen.has(m.seq))];
      merged.sort((a, b) => a.seq - b.seq);
      return merged.length > MAX_RENDER ? merged.slice(-MAX_RENDER) : merged;
    });
    cursor.current = Math.max(cursor.current, ...incoming.map((m) => m.seq));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api.getRemoteLog(session.id, cursor.current);
      const { messages: msgs, ...rest } = r;
      setInfo(rest);
      absorb(msgs);
      setErr(null);
    } catch {
      setErr('lost contact with the manager');
    }
  }, [session.id, absorb]);

  useEffect(() => {
    cursor.current = 0;
    setMessages([]);
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Stay pinned to the newest message unless the operator has scrolled up to
  // read something — then leave their scroll position alone.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const loadPrompt = useCallback(async () => {
    if (!name) return;
    try { setPrompt(await api.getRemotePrompt(name)); } catch { setPrompt('could not load the connect prompt'); }
  }, [name]);

  // Nothing has ever spoken from the other side, so this pane's whole job right
  // now is pairing: open the connect popover once, unasked. It closes like any
  // other popover and never re-opens itself.
  const neverConnected = !!info && !info.connected && !messages.some((m) => m.role === 'agent');
  useEffect(() => {
    if (!neverConnected || autoOpened.current) return;
    autoOpened.current = true;
    setConnectOpen(true);
    loadPrompt();
  }, [neverConnected, loadPrompt]);

  // Anchored popover, so dismissal works the way every other popover does.
  useEffect(() => {
    if (!connectOpen) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setConnectOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setConnectOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [connectOpen]);

  const toggleConnect = () => {
    setConnectOpen((open) => {
      if (!open && prompt === null) loadPrompt();
      return !open;
    });
  };

  const copy = () => {
    if (!prompt) return;
    navigator.clipboard?.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft('');
    atBottom.current = true;
    try {
      await api.sayToRemote(session.id, text);
      await refresh();
    } catch {
      setErr('could not send — the message was not delivered');
      setDraft(text);
    } finally {
      setSending(false);
    }
  };

  const togglePaused = async () => {
    if (!info) return;
    try {
      setInfo(await api.setRemotePaused(session.id, !info.paused));
      await refresh();
    } catch { setErr('could not change the connection'); }
  };

  const commitName = () => {
    setEditing(false);
    const next = titleDraft.trim();
    if (next && next !== session.name) onRename?.(next);
  };

  const state = info?.state || session.state;
  const paused = info?.paused ?? !!session.remote?.paused;
  const peer = info?.peer || null;
  const stateLabel = REMOTE_STATE_LABEL[state];
  const seenAgo = fmtAgo(info?.lastSeenAt);

  // Whichever of these the connection actually knows, in order. Built as a list
  // so the dots can join them rather than prefix them: with the state gone from
  // this row, a prefixing dot would leave whatever comes first starting with a
  // stray separator.
  const facts = [
    peer?.harness && { key: 'harness', node: <span>{peer.harness}</span> },
    peer?.cwd && { key: 'cwd', node: <span className="rp-cwd" title={peer.cwd}>{peer.cwd}</span> },
    peer?.host && { key: 'host', node: <span>on {peer.host}</span> },
    !peer && { key: 'path', node: <span className="rp-cwd">remote-agents/{name}/</span> },
  ].filter((f): f is { key: string; node: JSX.Element } => !!f);

  const MAX_ROWS = 10;
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto'; // let it report its natural content height
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const cap = lh * MAX_ROWS;
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    el.style.overflowY = el.scrollHeight > cap ? 'auto' : 'hidden';
  }, [draft, fontSize]);

  const rendered = useMemo(
    () => messages.map((m) => ({ ...m, html: m.role === 'agent' ? renderMarkdown(m.text) : '' })),
    [messages],
  );

  return (
    <div className={`slot${focused ? ' focused' : ''}`} onMouseDown={onFocus}>
      {/* The standard three-column pane header: identity left, name centred,
          actions right — same as every other agent's pane. Everything else the
          operator might want to know lives in the status line under the
          composer, the way a CLI keeps its context on one bottom row. */}
      <div
        className={`pane-head${dragId ? ' draggable' : ''}`}
        draggable={!!dragId}
        onDragStart={dragId ? (e) => { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; onDragActive?.(true); } : undefined}
        onDragEnd={dragId ? () => onDragActive?.(false) : undefined}
      >
        <div className="ph-left">
          {onBack && (
            // See TerminalPane: on a phone the way back rides in the header
            // rather than costing the pane a bar of its own.
            <button
              className="mini-btn ph-back"
              title="Back to list"
              aria-label="Back to list"
              draggable={false}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onBack(); }}
            >
              <BackGlyph />
            </button>
          )}
          <StateLogo cli="remote" state={state} size={16} tint="#5ec2e0" title={stateLabel} />
        </div>
        {editing ? (
          <input
            className="ph-title-input" autoFocus value={titleDraft}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setEditing(false); }}
          />
        ) : (
          <span
            className="ph-title"
            title={`${sessionTitle(session.name, groupName)}${onRename ? ' · double-click to rename' : ''}`}
            onDoubleClick={onRename ? () => { setTitleDraft(session.name); setEditing(true); } : undefined}
          >
            {group && <span className="ph-group">[{group}]</span>}
            <span className="ph-name">{session.name}</span>
          </span>
        )}
        <div className="ph-right">
          <div className="rp-pop-wrap" ref={popRef}>
            <button
              className={`mini-btn${connectOpen ? ' on' : ''}`}
              title="Connect an agent — show the prompt to copy"
              onClick={(e) => { e.stopPropagation(); toggleConnect(); }}
            ><ShareGlyph /></button>
            {connectOpen && (
              <div className="rp-pop" onMouseDown={(e) => e.stopPropagation()}>
                <div className="rp-pop-head">
                  <span>connect an agent as <b>{name}</b></span>
                  <span className="spacer" />
                  <button className="mini-btn" onClick={copy} disabled={!prompt}>{copied ? 'copied' : 'copy'}</button>
                  <button className="mini-btn" onClick={() => setConnectOpen(false)}><CloseGlyph /></button>
                </div>
                <pre className="rp-pop-prompt">{prompt ?? 'loading…'}</pre>
                <div className="rp-pop-foot">
                  paste into a coding CLI on the machine you want to work from · nothing here is secret
                </div>
              </div>
            )}
          </div>
          <button
            className="mini-btn"
            title={paused ? 'Reconnect — let an agent poll again' : 'Disconnect — tell the agent to stop'}
            onClick={(e) => { e.stopPropagation(); togglePaused(); }}
          >{paused ? <PlayGlyph /> : <StopGlyph />}</button>
          <button className="mini-btn ph-close" title="Close" onClick={(e) => { e.stopPropagation(); onClose(); }}><CloseGlyph /></button>
        </div>
      </div>

      <div
        className="rp-body"
        ref={bodyRef}
        onScroll={() => {
          const el = bodyRef.current;
          if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        style={{ fontSize }}
      >
        {rendered.map((m) => (
          m.role === 'system' ? (
            <div key={m.seq} className="rp-sys">· {m.text}</div>
          ) : m.role === 'user' ? (
            <div key={m.seq} className="rp-user">
              <span className="rp-caret">❯</span>
              <div className="rp-user-body">
                <span className="rp-user-text">{m.text}</span>
                {/* The receipt sits at the foot of the message it is about, on
                    the text column, so a wrapped message does not leave it
                    stranded wherever the last line happened to end.

                    Both states come from the highest seq a poll actually
                    returned, and claim nothing beyond it: the agent either has
                    this message or has not collected it yet. */}
                <span className="rp-receipt">
                  {m.seq <= (info?.deliveredThrough ?? 0)
                    ? <AckGlyph className="rp-ack" />
                    : <span className="rp-pending" title="the agent has not collected this yet">pending</span>}
                </span>
              </div>
            </div>
          ) : (
            <div key={m.seq} className="rp-agent" dangerouslySetInnerHTML={{ __html: m.html }} />
          )
        ))}
        {err && <div className="rp-err">{err}</div>}
      </div>

      {/* The one fact here that changes while you watch, so it sits against the
          conversation rather than down in the context row. Drawn the way the
          trace reader draws its `working` line: the mark hangs in the gutter and
          the word starts on the message text column, on the log's own
          background with no rule above it, so it reads as the last line of the
          log rather than as a second bar of chrome.

          The mark reads the app's one state-mark contract (--mark-* beside
          ov-spin in styles.css): the braille spinner while working, and that
          motion's completed path when it is not. It is `.rp-mark`, not
          `.status` — a pane's own identity slot is a StateLogo frame (#92) and
          no component renders a state-classed `.status` any more; this is the
          other family, the one .cx-running and .ov-busy belong to.

          Nothing follows the word: RemoteInfo carries no "what it is doing
          now", and a made-up one would be worse than none. */}
      <div className="rp-state-line" style={{ fontSize }}>
        <span className={`rp-mark ${state}`} aria-hidden="true" />
        <span className={`rp-state ${state}`}>{stateLabel}</span>
      </div>

      <div className="rp-composer" style={{ fontSize }}>
        <span className="rp-caret">❯</span>
        <textarea
          ref={inputRef}
          className="rp-input"
          rows={1}
          value={draft}
          placeholder={paused ? 'disconnected — a message will wait in the log' : 'message this agent'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
      </div>

      {/* The bottom context row: where the agent actually is, when we last heard
          from it, and how to send. These are settings and facts about the
          connection rather than things that change as you watch — the CLI
          bottom row that carries them — so the state left and they did not.

          The separators join the facts rather than prefixing them, so whichever
          one comes first does not start with a stray dot now that the state is
          no longer always there to lead. */}
      <div className="rp-status" style={{ fontSize }}>
        {facts.map((f, i) => (
          <Fragment key={f.key}>
            {i > 0 && <span className="rp-dot">·</span>}
            {f.node}
          </Fragment>
        ))}
        <span className="spacer" />
        {seenAgo && <span className="rp-seen">last seen {seenAgo}</span>}
        <span className="rp-hint">↵ send · ⇧↵ newline</span>
      </div>
    </div>
  );
}
