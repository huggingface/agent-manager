import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteInfo, RemoteMessage, Session } from '../types';
import { REMOTE_STATE_LABEL } from '../types';
import * as api from '../api';
import Logo from './Logo';
import { renderMarkdown } from '../lib/markdown';
import { CloseGlyph, StopGlyph, PlayGlyph, ShareGlyph } from './icons';

// Looks like the terminal, is not one: no PTY, no xterm.js, no WebSocket. The
// agent's real TUI is running on its own machine — what crosses the wire is
// messages, so this renders markdown into a mono-styled log with a composer
// underneath. See docs/remote-agents.md §7.

const POLL_MS = 2000; // the app's existing /api/tree cadence
const MAX_RENDER = 2000; // a human-paced conversation, not a 6 MB transcript

export default function RemotePane({
  session, focused, zoom = 100, dragId, onDragActive, onFocus, onClose, onRename,
}: {
  session: Session;
  focused?: boolean;
  zoom?: number;
  dragId?: string;
  onDragActive?: (dragging: boolean) => void;
  onFocus?: () => void;
  onClose: () => void;
  onRename?: (name: string) => void;
}) {
  const name = session.remote?.name || '';
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [messages, setMessages] = useState<RemoteMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const cursor = useRef(0);
  const atBottom = useRef(true);

  // Merge a delta into the log. The server only ever appends, so de-duping on
  // seq is enough — no reconciliation, no flicker.
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

  const onScroll = () => {
    const el = bodyRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const loadPrompt = useCallback(async () => {
    if (!name) return;
    try { setPrompt(await api.getRemotePrompt(name)); } catch { setPrompt('could not load the connect prompt'); }
  }, [name]);

  const openConnect = () => {
    setShowConnect(true);
    if (prompt === null) loadPrompt();
  };

  // Nothing in the prompt is secret, so a plain clipboard copy is the whole
  // pairing step.
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
    // Optimistic: the operator's own words appear at once, then the poll
    // replaces them with the server's copy (which owns the seq).
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

  const state = info?.state || session.state;
  const paused = info?.paused ?? !!session.remote?.paused;
  const peer = info?.peer || null;
  // Once connected, the header stops showing the folder and shows where the
  // agent actually is — the more useful fact.
  const where = peer
    ? [peer.harness, peer.cwd].filter(Boolean).join(' · ')
    : `workspace/remote-agents/${name}/`;
  // Nothing has ever spoken from the other side, so the pane's job right now is
  // pairing — the connect prompt IS the pane, not a modal behind a button.
  const neverConnected = !!info && !info.connected && !messages.some((m) => m.role === 'agent');
  useEffect(() => { if (neverConnected && prompt === null) loadPrompt(); }, [neverConnected, prompt, loadPrompt]);

  const rendered = useMemo(
    () => messages.map((m) => ({ ...m, html: m.role === 'agent' ? renderMarkdown(m.text) : '' })),
    [messages],
  );

  return (
    <div className={`slot${focused ? ' focused' : ''}`} onMouseDown={onFocus}>
      <div
        className={`pane-head rp-head${dragId ? ' draggable' : ''}`}
        draggable={!!dragId}
        onDragStart={dragId ? (e) => { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; onDragActive?.(true); } : undefined}
        onDragEnd={dragId ? () => onDragActive?.(false) : undefined}
      >
        <Logo cli="remote" size={16} tint="#5ec2e0" />
        <span className={`dot ${state}`} title={REMOTE_STATE_LABEL[state]} />
        <span
          className="rp-name"
          title={onRename ? 'Double-click to rename' : undefined}
          onDoubleClick={onRename ? () => {
            const next = window.prompt('Rename pane', session.name);
            if (next && next.trim()) onRename(next.trim());
          } : undefined}
        >{session.name}</span>
        <span className="rp-where" title={peer?.host ? `on ${peer.host}` : undefined}>{where}</span>
        <span className="spacer" />
        <button className="mini-btn" title="Show the connect prompt" onClick={(e) => { e.stopPropagation(); openConnect(); }}><ShareGlyph /></button>
        <button
          className="mini-btn"
          title={paused ? 'Reconnect — let an agent poll again' : 'Disconnect — tell the agent to stop'}
          onClick={(e) => { e.stopPropagation(); togglePaused(); }}
        >{paused ? <PlayGlyph /> : <StopGlyph />}</button>
        <button className="mini-btn ph-close" title="Close" onClick={(e) => { e.stopPropagation(); onClose(); }}><CloseGlyph /></button>
      </div>

      <div
        className="rp-body"
        ref={bodyRef}
        onScroll={onScroll}
        style={{ fontSize: `${(13 * zoom) / 100}px` }}
      >
        {/* The pairing state IS the pane — no modal. */}
        {(showConnect || neverConnected) && (
          <div className="rp-connect">
            <div className="rp-connect-head">
              <span>{neverConnected && !showConnect ? 'waiting for an agent to connect' : `connect an agent as "${name}"`}</span>
              <span className="spacer" />
              <button className="mini-btn" onClick={copy} disabled={!prompt}>{copied ? 'copied' : 'copy'}</button>
              {showConnect && <button className="mini-btn" onClick={() => setShowConnect(false)}>hide</button>}
            </div>
            <pre className="rp-prompt">{prompt ?? 'loading…'}</pre>
            <div className="rp-connect-foot">
              paste this into a coding CLI on the machine you want to work from · nothing here is secret
            </div>
          </div>
        )}
        {rendered.map((m) => (
          m.role === 'system' ? (
            <div key={m.seq} className="rp-sys">· {m.text}</div>
          ) : m.role === 'user' ? (
            <div key={m.seq} className="rp-user">
              <span className="rp-caret">❯</span>
              <span className="rp-user-text">{m.text}</span>
              {/* Honest: the server drew this from the highest seq a poll
                  actually returned. Nothing more is claimed. */}
              {m.seq <= (info?.deliveredThrough ?? 0) && (
                <span className="rp-ack" title="picked up by the agent">✓</span>
              )}
            </div>
          ) : (
            <div key={m.seq} className="rp-agent" dangerouslySetInnerHTML={{ __html: m.html }} />
          )
        ))}
        {err && <div className="rp-err">{err}</div>}
      </div>

      <div className="rp-composer">
        <span className="rp-caret">❯</span>
        <textarea
          className="rp-input"
          rows={1}
          value={draft}
          placeholder={paused ? 'disconnected — a message will wait in the log' : 'message this agent'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <span className="rp-hint">↵ send · ⇧↵ newline</span>
      </div>
    </div>
  );
}
