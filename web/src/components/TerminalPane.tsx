import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
import type { Cli, Session } from '../types';
import { STATE_LABEL } from '../types';
import Logo from './Logo';

const THEMES: Record<'light' | 'dark', ITheme> = {
  dark: {
    background: '#0e1217', foreground: '#c6d0d8',
    cursor: '#43c98a', cursorAccent: '#0e1217',
    selectionBackground: '#2bb3bd44',
    // ANSI tuned bright enough for the dark background (used by the prompt).
    green: '#43c98a', brightGreen: '#5fe0a0',
    cyan: '#5fd0d8', brightCyan: '#7fe3ea',
    blue: '#6ea8fe', brightBlue: '#8cbcff',
    red: '#e0726a', yellow: '#e0a948',
  },
  light: {
    background: '#ffffff', foreground: '#1b2329',
    cursor: '#0e7c86', cursorAccent: '#ffffff',
    selectionBackground: '#0e7c8633',
    // ANSI darkened for contrast on white (fixes the unreadable prompt in light mode).
    green: '#1c8c57', brightGreen: '#1c8c57',
    cyan: '#0e7c86', brightCyan: '#0e7c86',
    blue: '#2257c4', brightBlue: '#2257c4',
    red: '#c2433a', yellow: '#9a6a00',
  },
};

type ConnState = 'connecting' | 'connected' | 'closed' | 'exited';

// Close code the server uses when the session's process exited for real (vs a
// transient drop). The client must NOT auto-reconnect on this, or it would
// respawn the agent in a loop and trample an in-progress login flow.
const EXIT_CODE = 4000;

// Serialize the current selection, joining soft-wrapped rows instead of
// emitting a newline per visual row. tmux repaints with explicit cursor moves,
// so a wrapped logical line arrives as separate full-width rows that xterm's
// default getSelection() would break with '\n'. We rejoin a row to the next
// when xterm flags it wrapped OR it's filled to the last column (the tmux case).
function selectionText(term: Terminal): string {
  try {
    const pos = term.getSelectionPosition?.();
    if (!pos) return term.getSelection();
    const buf = term.buffer.active;
    const cols = term.cols;
    const out: string[] = [];
    let cur = '';
    for (let y = pos.start.y; y <= pos.end.y; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const startX = y === pos.start.y ? pos.start.x : 0;
      const endX = y === pos.end.y ? pos.end.x : cols;
      cur += line.translateToString(false, startX, endX);
      const lastChar = line.getCell(cols - 1)?.getChars() ?? '';
      const full = endX >= cols && lastChar !== '' && lastChar !== ' ';
      const wrapped = y < pos.end.y && ((buf.getLine(y + 1)?.isWrapped ?? false) || full);
      if (!wrapped) { out.push(cur.replace(/[ \t]+$/, '')); cur = ''; }
    }
    if (cur) out.push(cur.replace(/[ \t]+$/, ''));
    const joined = out.join('\n');
    return joined || term.getSelection();
  } catch {
    return term.getSelection();
  }
}

// Write to the system clipboard, falling back to the legacy execCommand path
// when the async Clipboard API is unavailable or blocked (e.g. lost activation).
function writeClipboard(text: string) {
  if (!text) return;
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch { /* ignore */ }
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(fallback);
  else fallback();
}

export default function TerminalPane({
  session, theme, focused, active, zoom = 100, onFocus, onRename, onClose,
}: {
  session: Session;
  cli?: Cli;
  theme: 'light' | 'dark';
  focused?: boolean;
  active?: boolean;
  zoom?: number;
  onFocus?: () => void;
  onRename?: (name: string) => void;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const resyncRef = useRef<() => void>(() => {});
  const reconnectRef = useRef<() => void>(() => {});
  const [conn, setConn] = useState<ConnState>('connecting');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name);
  const commitName = () => {
    const v = draft.trim();
    if (v && v !== session.name) onRename?.(v);
    setEditing(false);
  };

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, 'Cascadia Code', monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 20000,
      theme: THEMES[theme],
      // Let users make a *local* selection even when the app (tmux / an agent
      // TUI) has grabbed the mouse: ⌥-drag on macOS, Shift-drag elsewhere.
      macOptionClickForcesSelection: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new ClipboardAddon()); // honour OSC 52 → system clipboard
    term.open(hostRef.current!);
    termRef.current = term;

    // Copy any selection to the system clipboard. Selections happen via the
    // local-selection gesture above (any pane) or tmux drag-select (shell pane,
    // which also fires OSC 52 handled by the ClipboardAddon).
    const copySelection = () => {
      if (term.hasSelection()) writeClipboard(selectionText(term));
    };
    const host = hostRef.current!;
    const onMouseUp = () => setTimeout(copySelection, 0);
    host.addEventListener('mouseup', onMouseUp);

    // ⌘/Ctrl+C copies the selection (and swallows the keystroke) only when text
    // is selected; otherwise it falls through as the usual interrupt. Paste is
    // left to xterm's native handler so bracketed-paste framing is preserved.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C') && term.hasSelection()) {
        copySelection();
        term.clearSelection();
        return false;
      }
      return true;
    });
    try { fit.fit(); } catch { /* layout not ready yet */ }
    // Re-measure once the webfont is ready (glyph width changes vs the fallback).
    document.fonts?.ready.then(() => { try { fit.fit(); } catch { /* ignore */ } });

    let ws: WebSocket | null = null;
    let closedByUs = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const send = (o: unknown) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
    };

    const connect = () => {
      setConn('connecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/ws?session=${encodeURIComponent(session.id)}&cols=${term.cols}&rows=${term.rows}`;
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        setConn('connected');
        try { fit.fit(); } catch { /* ignore */ }
        send({ t: 'r', cols: term.cols, rows: term.rows });
      };
      ws.onmessage = (e) =>
        term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
      ws.onclose = (e) => {
        // A real process exit: stop here and let the user relaunch. Anything
        // else is a transient drop (sleep/wake, network) → auto-reconnect and
        // reattach to the still-running tmux session.
        if (e.code === EXIT_CODE) { setConn('exited'); return; }
        setConn('closed');
        if (!closedByUs) retry = setTimeout(connect, 1200);
      };
      ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
    };
    reconnectRef.current = () => { if (retry) clearTimeout(retry); connect(); };

    // Re-fit and tell the server our size. With tmux window-size=latest this
    // makes the focused window own the size, so a duplicate window open at a
    // different size doesn't leave us with tmux's "dots" filler.
    const resync = () => {
      try { fit.fit(); send({ t: 'r', cols: term.cols, rows: term.rows }); } catch { /* ignore */ }
    };
    const onVisible = () => { if (!document.hidden) resync(); };
    resyncRef.current = resync; // so the zoom control can refit

    const dataSub = term.onData((d) => send({ t: 'i', d }));
    const ro = new ResizeObserver(resync);
    ro.observe(hostRef.current!);
    window.addEventListener('focus', resync);
    document.addEventListener('visibilitychange', onVisible);

    connect();

    return () => {
      closedByUs = true;
      if (retry) clearTimeout(retry);
      ro.disconnect();
      host.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('focus', resync);
      document.removeEventListener('visibilitychange', onVisible);
      dataSub.dispose();
      try { ws?.close(); } catch { /* ignore */ }
      term.dispose();
      termRef.current = null;
    };
  }, [session.id]);

  // Switch theme live without tearing down the terminal / connection.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[theme];
  }, [theme]);

  // Zoom: adjust font size (100% = 13px) and refit.
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    t.options.fontSize = Math.round((13 * zoom) / 100);
    resyncRef.current();
  }, [zoom]);

  // Move keyboard focus into the terminal whenever this pane becomes the active
  // one (e.g. selected from the sidebar, or newly created).
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => termRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [active]);

  return (
    <div className={`slot${focused ? ' focused' : ''}`} onMouseDown={() => onFocus?.()}>
      {/* preventDefault so clicking the (non-focusable) header keeps keyboard
          focus in the terminal instead of the browser blurring it. */}
      <div className="pane-head" onMouseDown={(e) => { e.preventDefault(); onFocus?.(); termRef.current?.focus(); }}>
        <div className="ph-left">
          <Logo cli={session.cli} size={20} />
          <span className={`status ${session.state}`} title={`${STATE_LABEL[session.state]} · ${conn}`} />
        </div>
        {editing ? (
          <input
            className="ph-title-input" autoFocus value={draft}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setEditing(false); }}
          />
        ) : (
          <span className="ph-title" title="Double-click to rename" onDoubleClick={() => { setDraft(session.name); setEditing(true); }}>{session.name}</span>
        )}
        <button className="mini-btn ph-close" title="Close" onClick={(e) => { e.stopPropagation(); onClose(); }}>✕</button>
      </div>
      <div className="term-host" ref={hostRef} />
      {conn === 'exited' && (
        <div className="term-overlay">
          <div className="term-overlay-card">
            <div className="to-text">
              <span className="to-title">Process exited</span>
              <span className="to-help">Output above is preserved.</span>
            </div>
            <button
              className="btn-ghost"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); reconnectRef.current(); }}
            >↻ Restart</button>
          </div>
        </div>
      )}
    </div>
  );
}
