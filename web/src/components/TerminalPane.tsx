import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon, Base64 } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
import type { Cli, Session } from '../types';
import { STATE_LABEL } from '../types';
import Logo from './Logo';
import { CloseGlyph, RefreshGlyph } from './icons';

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

function workspaceLabel(p: string | null) {
  const rel = (p || '').replace(/^\.\/?/, '').replace(/^\/+|\/+$/g, '');
  return rel ? `workspace/${rel}/` : 'workspace/';
}

// Serialize the current selection, joining soft-wrapped rows instead of
// emitting a newline per visual row. Some full-width rows painted with cursor
// movement lack xterm's wrap flag, so a filled last cell is a second signal.
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

// Copying to the system clipboard has to survive two hostile conditions on the
// Space: the app is usually embedded in Hugging Face's cross-origin iframe
// (which blocks the async Clipboard API entirely), and the tab is often
// unfocused. So explicit user copies layer:
//   1. execCommand('copy') via a hidden textarea — the ONLY path that works
//      inside the iframe, and it works during any user gesture.
//   2. navigator.clipboard.writeText — the modern path (focused, top-level).
//   3. if both fail (a requested copy couldn't write), stash briefly
//      and flush on the user's next click, so the copy lands when they return.
// It must run synchronously inside the triggering event — deferring to a
// setTimeout loses the activation that execCommand needs.
// Server → client control frames (restore, shared-grid size) ride the terminal
// socket with this leading NUL sentinel, which real pty output never begins with.
const MODE_CTRL = '\x00\x00AM:';

function legacyCopy(text: string): boolean {
  const prev = document.activeElement as HTMLElement | null;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    prev?.focus?.(); // don't steal focus from the terminal
    return ok;
  } catch { return false; }
}

let clipStash: { text: string; at: number } | null = null;
function copyText(text: string) {
  if (!text) return;
  if (legacyCopy(text)) { clipStash = null; return; }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => { clipStash = null; })
      .catch(() => { clipStash = { text, at: Date.now() }; });
  } else {
    clipStash = { text, at: Date.now() };
  }
}
// A user-requested copy we couldn't complete lands on the next real interaction
// — bounded so a stale copy can't clobber the clipboard much later.
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => {
    if (clipStash && Date.now() - clipStash.at < 8000) legacyCopy(clipStash.text);
    clipStash = null;
  }, true);
}

export default function TerminalPane({
  session, cli, theme, focused, active, zoom = 100, dragId, isMobile, onDragActive, onFocus, onRename, onClose,
}: {
  session: Session;
  cli?: Cli;
  theme: 'light' | 'dark';
  focused?: boolean;
  active?: boolean;
  zoom?: number;
  dragId?: string;          // set when the pane can be rearranged (group view)
  isMobile?: boolean;       // show the on-screen control-key bar
  onDragActive?: (dragging: boolean) => void;
  onFocus?: () => void;
  onRename?: (name: string) => void;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const localLayoutRef = useRef<() => void>(() => {});
  const reconnectRef = useRef<() => void>(() => {});
  const controllerRef = useRef(false);
  // Send a raw byte string to the PTY (for the mobile key-bar: arrows, Esc…).
  const sendKeyRef = useRef<(d: string) => void>(() => {});
  const [conn, setConn] = useState<ConnState>('connecting');
  // "starting…" cover while the CLI boots into an empty pane (starting on the
  // Space can take seconds). Hidden only when the screen actually SHOWS
  // something — byte counts lie because a blank-screen repaint can already be
  // kilobytes of escape sequences.
  const [booting, setBooting] = useState(true);
  const [controller, setController] = useState(false);
  const [viewers, setViewers] = useState(1);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name);
  // Fallback paste sheet: shown only when we can't read the clipboard directly.
  const [pasteOpen, setPasteOpen] = useState(false);
  const commitName = () => {
    const v = draft.trim();
    if (v && v !== session.name) onRename?.(v);
    setEditing(false);
  };

  // Hand text to xterm rather than the socket: paste() applies bracketed-paste
  // framing and normalises newlines, so a multi-line paste arrives as one blob
  // instead of a burst of Enters that submit half-typed prompts.
  const commitPaste = (text: string) => {
    if (!text) return;
    setPasteOpen(false);
    termRef.current?.paste(text);
    termRef.current?.focus();
  };

  // Phones have no Ctrl+V, so the key-bar needs an explicit paste. Two paths,
  // because the direct read is unavailable exactly where this app usually runs:
  //   1. navigator.clipboard.readText() — works top-level (iOS shows its own
  //      "Paste" confirmation). BLOCKED in Hugging Face's cross-origin iframe,
  //      and absent on older mobile browsers.
  //   2. a focused textarea the user pastes into with the OS long-press menu.
  //      A `paste` event's clipboardData is always readable — it's user-driven,
  //      not permissioned — so this works even when (1) is denied.
  // execCommand('paste') is not an option: unlike 'copy' it's disabled for web
  // content in every browser, so there is no synchronous legacy path.
  const requestPaste = () => {
    let p: Promise<string> | undefined;
    try { p = navigator.clipboard?.readText?.(); } catch { p = undefined; }
    if (!p) { setPasteOpen(true); return; }
    p.then((text) => { if (text) commitPaste(text); else setPasteOpen(true); })
      .catch(() => setPasteOpen(true));
  };

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, 'Cascadia Code', monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 20000,
      theme: THEMES[theme],
      // Let users make a local selection even when an agent TUI has grabbed
      // the mouse: ⌥-drag on macOS, Shift-drag elsewhere.
      macOptionClickForcesSelection: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    let lastSelection = '';
    let osc52Text = '';
    let osc52At = 0;

    // An agent may deliberately emit OSC 52. Browsers generally reject an
    // unsolicited clipboard write, so retain it briefly and let Cmd/C perform
    // the write inside a real user gesture.
    const clipboardProvider = {
      readText: (sel: string) => (sel !== 'p' && navigator.clipboard?.readText ? navigator.clipboard.readText().catch(() => '') : ''),
      writeText: (sel: string, data: string) => {
        if (sel !== 'p') {
          osc52Text = data;
          osc52At = Date.now();
        }
      },
    };
    // addon-clipboard@0.1.0 has a (base64, provider) runtime constructor but
    // types it as (provider) — construct positionally to match the runtime.
    term.loadAddon(new (ClipboardAddon as unknown as new (b: Base64, p: typeof clipboardProvider) => ClipboardAddon)(new Base64(), clipboardProvider));
    term.open(hostRef.current!);
    termRef.current = term;

    // Track the committed local xterm selection so Cmd/Ctrl+C can copy it
    // synchronously — deferring (setTimeout) would break execCommand's gesture.
    const selSub = term.onSelectionChange(() => {
      lastSelection = term.hasSelection() ? selectionText(term) : '';
    });
    const copySelection = () => {
      const text = term.hasSelection() ? selectionText(term) : lastSelection;
      if (text) copyText(text);
    };
    const host = hostRef.current!;
    const onCopy = (e: ClipboardEvent) => {
      if (!term.hasSelection()) return;
      const text = selectionText(term);
      if (!text || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    };
    document.addEventListener('copy', onCopy, true);

    let ws: WebSocket | null = null;
    const send = (o: unknown) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
    };
    const claimControl = () => {
      if (controllerRef.current) return;
      // Optimistic locally so the input event following this gesture is not
      // dropped. WebSocket ordering guarantees claim reaches the server first.
      controllerRef.current = true;
      setController(true);
      send({ t: 'claim' });
    };
    const onPointerDown = (e: PointerEvent) => {
      // A touch may only be inspecting local scrollback. Claim lazily below if
      // the gesture actually needs to drive an application's mouse mode.
      if (e.pointerType !== 'touch') claimControl();
    };
    const onPaste = () => claimControl();
    host.addEventListener('pointerdown', onPointerDown, true);
    host.addEventListener('paste', onPaste, true);

    // The mobile key-bar sends control sequences the on-screen keyboard can't.
    sendKeyRef.current = (d: string) => {
      claimControl();
      send({ t: 'i', d });
      endBoot();
    };

    // ⌘/Ctrl+C copies a local selection. Without one, Ctrl+C remains SIGINT;
    // Cmd+C may accept a recent OSC 52 payload deliberately emitted by the app.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C') && term.hasSelection()) {
        copySelection();
        term.clearSelection();
        return false;
      }
      if (e.metaKey && (e.key === 'c' || e.key === 'C')) {
        if (osc52Text && Date.now() - osc52At < 120_000) copyText(osc52Text);
        return false;
      }
      claimControl();
      return true;
    });
    // The only local fit: this terminal is still empty, so there is no buffer to
    // reflow, and it gives the initial size we open the socket with. Every later
    // size change goes through resync() as a REQUEST — see there.
    try { fit.fit(); } catch { /* layout not ready yet */ }
    let layoutFrame = 0;
    const syncLocalLayout = () => {
      cancelAnimationFrame(layoutFrame);
      layoutFrame = requestAnimationFrame(() => {
        const box = hostRef.current;
        const root = box?.querySelector<HTMLElement>('.xterm');
        const screen = box?.querySelector<HTMLElement>('.xterm-screen');
        if (!box || !root || !screen) return;
        const style = getComputedStyle(box);
        const innerWidth = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const innerHeight = box.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        root.style.width = `${Math.max(innerWidth, Math.ceil(screen.getBoundingClientRect().width))}px`;
        root.style.height = `${Math.max(innerHeight, Math.ceil(screen.getBoundingClientRect().height))}px`;
      });
    };
    localLayoutRef.current = syncLocalLayout;
    syncLocalLayout();
    // Re-measure once the webfont is ready (glyph width changes vs the fallback).
    document.fonts?.ready.then(() => { resync(); syncLocalLayout(); });

    let closedByUs = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    // Reconnect with backoff: a sleeping/unreachable Space shouldn't be hammered
    // every second by every open pane. Reset once a connection succeeds.
    let retryDelay = 1200;

    // Does the visible screen show real text in its UPPER two-thirds? Agent
    // TUIs paint their bottom input bar first and load the actual content
    // (banner, resumed history) seconds later — only the upper region tells us
    // the pane is genuinely ready. Shell prompts paint at the top anyway.
    const screenHasContent = () => {
      try {
        const buf = term.buffer.active;
        const upper = Math.max(2, Math.floor(term.rows * 2 / 3));
        for (let y = 0; y < upper; y++) {
          const line = buf.getLine(buf.baseY + y);
          if (line && line.translateToString(true).trim().length >= 2) return true;
        }
      } catch { return true; } // never trap the cover on an internal error
      return false;
    };
    let bootLive = false;
    let bootTimer: ReturnType<typeof setTimeout> | null = null;   // safety cap
    let bootCheck: ReturnType<typeof setTimeout> | null = null;   // throttled content probe
    const endBoot = () => {
      bootLive = false;
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
      if (bootCheck) { clearTimeout(bootCheck); bootCheck = null; }
      setBooting(false);
    };
    const connect = () => {
      controllerRef.current = false;
      setController(false);
      setConn('connecting');
      setBooting(true);
      bootLive = true;
      if (bootTimer) clearTimeout(bootTimer);
      bootTimer = setTimeout(endBoot, 20_000);
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/ws?session=${encodeURIComponent(session.id)}&cols=${term.cols}&rows=${term.rows}`;
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        setConn('connected');
        retryDelay = 1200;
        requestSize();
      };
      ws.onmessage = (e) => {
        const d = typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer);
        // Control frame: a leading NUL sentinel that raw pty output never
        // produces — handle it instead of writing to the term.
        if (typeof d === 'string' && d.startsWith(MODE_CTRL)) {
          try {
            const m = JSON.parse(d.slice(MODE_CTRL.length));
            if (m.t === 'grid' || m.t === 'restore') {
              controllerRef.current = !!m.controller;
              setController(!!m.controller);
              setViewers(Math.max(1, Number(m.viewers) || 1));
              const applyGrid = () => {
                try {
                  if (m.reset) {
                    term.reset();
                    term.clear();
                  }
                  if (m.cols > 0 && m.rows > 0 && (term.cols !== m.cols || term.rows !== m.rows)) {
                    term.resize(m.cols, m.rows);
                  }
                  syncLocalLayout();
                } catch { /* ignore */ }
              };
              // Writes are asynchronous. A queued empty write is a barrier so
              // resize/reset cannot reinterpret bytes from the preceding grid.
              const geometryChanged = m.cols > 0 && m.rows > 0
                && (term.cols !== m.cols || term.rows !== m.rows);
              if (m.reset || geometryChanged) term.write('', applyGrid);
              else applyGrid();
            }
          } catch { /* ignore */ }
          return;
        }
        term.write(d);
        // Probe shortly after each burst (throttled; write() is async).
        if (bootLive && !bootCheck) {
          bootCheck = setTimeout(() => {
            bootCheck = null;
            if (bootLive && screenHasContent()) endBoot();
          }, 150);
        }
      };
      ws.onclose = (e) => {
        // A real process exit: stop here and let the user relaunch. Anything
        // else is a transient drop (sleep/wake, network) → auto-reconnect and
        // reattach to the still-running backend session.
        endBoot();
        if (e.code === EXIT_CODE) { setConn('exited'); return; }
        setConn('closed');
        if (!closedByUs) {
          retry = setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 1.7, 15_000);
        }
      };
      ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
    };
    // Manual restart: clear the dead run's screen so the content probe watches
    // the new process paint, not leftovers.
    reconnectRef.current = () => { if (retry) clearTimeout(retry); retryDelay = 1200; try { term.reset(); } catch { /* ignore */ } connect(); };

    // Report the pane's preferred size without locally fitting its terminal.
    // Only the current controller's preference changes the canonical grid;
    // watchers retain theirs for a future claim.
    let resyncTimer: ReturnType<typeof setTimeout> | null = null;
    const requestSize = () => {
      const box = hostRef.current;
      if (!box || box.clientWidth < 40 || box.clientHeight < 40) return;
      try {
        const d = fit.proposeDimensions();
        // Zoom is local presentation, not PTY geometry. Normalize the measured
        // cells back to the 13px canonical font before sending a preference.
        const scale = (Number(term.options.fontSize) || 13) / 13;
        const cols = d ? Math.max(1, Math.floor(d.cols * scale)) : 0;
        const rows = d ? Math.max(1, Math.floor(d.rows * scale)) : 0;
        if (cols > 0 && rows > 0) send({ t: 'r', cols, rows });
      } catch { /* layout not ready */ }
    };
    // ResizeObserver fires every frame while a window is dragged or the sidebar
    // animates. Ask once, when it stops.
    const resync = () => {
      if (resyncTimer) clearTimeout(resyncTimer);
      resyncTimer = setTimeout(() => { resyncTimer = null; requestSize(); }, 80);
    };
    const onReturn = () => resync();
    const onVisible = () => { if (!document.hidden) onReturn(); };
    // Typing means the user sees enough to interact — drop the boot cover.
    // Real keystrokes only (onKey): onData ALSO fires for xterm's automatic
    // replies to the TUI's terminal queries (DA/CPR), which arrive instantly
    // on attach and must not count as "the user typed".
    const keySub = term.onKey(() => { claimControl(); endBoot(); });
    // Watchers render output but do not answer terminal queries. This prevents
    // N browser emulators from injecting N DA/CPR responses into one PTY.
    const dataSub = term.onData((d) => {
      if (controllerRef.current) send({ t: 'i', d });
    });
    const ro = new ResizeObserver(resync);
    ro.observe(hostRef.current!);
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onVisible);

    // Touch scrolling prefers browser-retained history. At the live bottom an
    // app that tracks the mouse receives SGR wheel events from the controller.
    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0].clientY; };
    const onTouchMove = (e: TouchEvent) => {
      if (touchY == null) return;
      const y = e.touches[0].clientY;
      const dy = y - touchY;
      const steps = Math.trunc(dy / 24); // ~one wheel notch per 24px of drag
      if (steps !== 0) {
        touchY = y;
        let tracking = false;
        try { tracking = ((term as unknown as { modes?: { mouseTrackingMode?: string } }).modes?.mouseTrackingMode ?? 'none') !== 'none'; } catch { /* older xterm */ }
        const btn = steps > 0 ? 64 : 65; // drag down reveals earlier output = wheel up
        for (let i = 0; i < Math.abs(steps); i++) {
          const inHistory = term.buffer.active.viewportY < term.buffer.active.baseY;
          if (tracking && !inHistory) {
            claimControl();
            send({ t: 'i', d: `\x1b[<${btn};${Math.max(1, Math.floor(term.cols / 2))};${Math.max(1, Math.floor(term.rows / 2))}M` });
          }
          else term.scrollLines(steps > 0 ? -1 : 1);
        }
      }
      if (Math.abs(dy) > 4) e.preventDefault(); // keep the page from rubber-banding
    };
    const onTouchEnd = () => { touchY = null; };
    host.addEventListener('touchstart', onTouchStart, { passive: true });
    host.addEventListener('touchmove', onTouchMove, { passive: false });
    host.addEventListener('touchend', onTouchEnd);

    connect();

    return () => {
      closedByUs = true;
      if (retry) clearTimeout(retry);
      if (bootTimer) clearTimeout(bootTimer);
      if (bootCheck) clearTimeout(bootCheck);
      if (resyncTimer) clearTimeout(resyncTimer);
      cancelAnimationFrame(layoutFrame);
      ro.disconnect();
      host.removeEventListener('pointerdown', onPointerDown, true);
      host.removeEventListener('paste', onPaste, true);
      document.removeEventListener('copy', onCopy, true);
      host.removeEventListener('touchstart', onTouchStart);
      host.removeEventListener('touchmove', onTouchMove);
      host.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onVisible);
      dataSub.dispose();
      keySub.dispose();
      selSub.dispose();
      try { ws?.close(); } catch { /* ignore */ }
      term.dispose();
      termRef.current = null;
      localLayoutRef.current = () => {};
    };
  }, [session.id]);

  // Switch theme live without tearing down the terminal / connection.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[theme];
  }, [theme]);

  // Zoom changes only this viewer. The canonical terminal rows/columns stay
  // fixed, and the host becomes a two-dimensional viewport when cells grow.
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    t.options.fontSize = Math.round((13 * zoom) / 100);
    localLayoutRef.current();
  }, [zoom]);

  // Move keyboard focus into the terminal whenever this pane becomes the active
  // one (e.g. selected from the sidebar, or newly created).
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => termRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [active]);

  // Focused panes tint toward THEIR agent's brand color, not the app accent.
  const tint = cli?.color;
  const pathLabel = workspaceLabel(session.path);
  return (
    <div
      className={`slot${focused ? ' focused' : ''}`}
      style={focused && tint ? { borderColor: `color-mix(in srgb, ${tint} 45%, var(--border))` } : undefined}
      onMouseDown={() => onFocus?.()}
    >
      {/* preventDefault so clicking the (non-focusable) header keeps keyboard
          focus in the terminal instead of the browser blurring it — except when
          the header doubles as a drag handle, where it would block dragstart. */}
      <div
        className={`pane-head${dragId ? ' draggable' : ''}`}
        style={focused && tint ? { background: `color-mix(in srgb, ${tint} 8%, var(--panel))` } : undefined}
        draggable={!!dragId}
        onDragStart={dragId ? (e) => { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; onDragActive?.(true); } : undefined}
        onDragEnd={dragId ? () => onDragActive?.(false) : undefined}
        onMouseDown={(e) => { if (!dragId) e.preventDefault(); onFocus?.(); termRef.current?.focus(); }}
      >
        <div className="ph-left">
          <Logo cli={session.cli} size={16} tint={tint} />
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
          <span className="ph-title" title={`${pathLabel} · double-click to rename`} onDoubleClick={() => { setDraft(session.name); setEditing(true); }}>{session.name}</span>
        )}
        <div className="ph-right">
          {viewers > 1 && (
            <span className={`ph-role${controller ? ' controller' : ''}`} title={controller ? 'This pane controls terminal input and size' : 'Interact with the terminal to take control'}>
              {controller ? `${viewers} viewers` : 'watching'}
            </span>
          )}
          <span className="ph-path" title={pathLabel}>{pathLabel}</span>
          <button className="mini-btn ph-close" title="Close" onClick={(e) => { e.stopPropagation(); onClose(); }}><CloseGlyph /></button>
        </div>
      </div>
      <div className="term-host">
        <div className="term-fill" ref={hostRef} />
      </div>
      {isMobile && conn === 'connected' && (
        // Control keys the phone keyboard lacks — needed for TUI menus (model
        // pickers, etc.). preventDefault keeps terminal focus so the keyboard
        // stays up; the send also refocuses the terminal.
        <div className="term-keybar mono" onPointerDown={(e) => e.preventDefault()}>
          {([
            ['esc', '\x1b'], ['tab', '\t'],
            ['←', '\x1b[D'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['→', '\x1b[C'],
            ['⏎', '\r'], ['^C', '\x03'],
          ] as [string, string][]).map(([label, seq]) => (
            <button
              key={label}
              className="tk-btn"
              onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); sendKeyRef.current(seq); termRef.current?.focus(); }}
            >{label}</button>
          ))}
          {/* Unlike the key buttons this must NOT preventDefault: the clipboard
              read needs a real click gesture. stopPropagation keeps the bar's
              own preventDefault (which preserves terminal focus) off this one. */}
          <button
            className="tk-btn tk-paste"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); requestPaste(); }}
          >paste</button>
        </div>
      )}
      {pasteOpen && (
        // Reached when the clipboard read was blocked (cross-origin iframe) or
        // came back empty. The textarea is the whole point: long-press inside it
        // and the OS offers Paste, which fires a `paste` event we can read.
        <div className="term-paste" onPointerDown={(e) => e.stopPropagation()}>
          <textarea
            className="tp-input mono"
            autoFocus
            rows={1}
            // The instruction lives IN the field, because the field IS the
            // target and a separate hint line only raised the question "below
            // what?". Focusing it makes iOS/Android offer Paste on their own
            // (that callout is what usually gets tapped); long-press is the
            // manual backup when they don't.
            placeholder="tap Paste — or long-press here"
            onPaste={(e) => {
              const text = e.clipboardData.getData('text/plain');
              if (text) { e.preventDefault(); commitPaste(text); }
            }}
            // Typed text (or a paste some browsers deliver as plain input) still
            // needs a way out; Enter sends, Shift+Enter keeps the newline.
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setPasteOpen(false); termRef.current?.focus(); }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitPaste((e.target as HTMLTextAreaElement).value);
              }
            }}
          />
          <button className="tp-x" onClick={() => { setPasteOpen(false); termRef.current?.focus(); }}>cancel</button>
        </div>
      )}
      {booting && conn !== 'exited' && (
        <div className="term-boot mono">
          {conn === 'connecting' ? 'connecting' : `starting ${cli?.label || session.cli}`}<span className="et-cursor" />
        </div>
      )}
      {conn === 'exited' && (
        <div className="term-exit mono">
          <div className="tx-row">
            <span>{cli?.label || session.cli} stopped · output preserved</span>
            <button
              className="tx-btn"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); reconnectRef.current(); }}
            ><RefreshGlyph /> restart</button>
          </div>
        </div>
      )}
    </div>
  );
}
