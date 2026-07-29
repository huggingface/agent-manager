import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { CTRL, FONT_STACK, MARK_LABELS, MARK_ORDER, THEME, ms } from './lab';
import type { FitMode, Marks, PanelInfo, PanelState, ResizeStat, Run, ServerInfo } from './lab';

// Engines load on demand so the landing page stays light and so the cost of
// each one shows up in the numbers. ghostty-web inlines ~400KB of wasm, which is
// exactly the kind of thing worth measuring rather than guessing about.
let xtermMod: Promise<typeof import('@xterm/xterm')> | null = null;
let xtermFitMod: Promise<typeof import('@xterm/addon-fit')> | null = null;
let ghosttyMod: Promise<typeof import('ghostty-web')> | null = null;

function loadXterm() {
  if (!xtermMod) xtermMod = import('@xterm/xterm');
  if (!xtermFitMod) xtermFitMod = import('@xterm/addon-fit');
  return Promise.all([xtermMod, xtermFitMod]);
}

function loadGhostty() {
  if (!ghosttyMod) {
    ghosttyMod = import('ghostty-web').then(async (m) => {
      await m.init();
      return m;
    });
  }
  return ghosttyMod;
}

type Addon = { activate(t: unknown): void; dispose(): void };
type Fitter = Addon & { fit(): void };

type Engine = {
  cols: number;
  rows: number;
  open(el: HTMLElement): void;
  write(data: string, cb?: () => void): void;
  resize(cols: number, rows: number): void;
  scrollLines(amount: number): void;
  onData(cb: (d: string) => void): unknown;
  onResize(cb: (size: { cols: number; rows: number }) => void): unknown;
  loadAddon(addon: Addon): void;
  dispose(): void;
  focus?(): void;
  hasMouseTracking?(): boolean;
  hasBracketedPaste?(): boolean;
  onBell?: (cb: () => void) => unknown;
};

// Server close codes. A real process exit must NOT auto-reconnect, or we would
// respawn the agent in a loop and trample an in-progress login.
const EXIT_CODE = 4000;
const FAILED_CODE = 4001;

const SETTLE_QUIET_MS = 300;
const REFLOW_FONT_SIZE = 13;
const TOUCH_PX_PER_NOTCH = 24;

// Control keys a phone keyboard doesn't have, which agent TUIs need for menus.
const KEYBAR: [string, string][] = [
  ['esc', '\x1b'], ['tab', '\t'],
  ['←', '\x1b[D'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['→', '\x1b[C'],
  ['⏎', '\r'], ['^C', '\x03'],
];

type Props = {
  panel: PanelInfo;
  cols: number;
  rows: number;
  fit: FitMode;
  state?: PanelState;
  onRun: (run: Run) => void;
};

export default function Panel({ panel, cols, rows, fit, state, onRun }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sendKeyRef = useRef<(d: string) => void>(() => {});
  const [marks, setMarks] = useState<Marks>({});
  const [status, setStatus] = useState('opening');
  const [overlay, setOverlay] = useState<string | null>(null);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [signals, setSignals] = useState<{ mouse?: boolean; paste?: boolean; bells: number }>({ bells: 0 });
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  const [viewers, setViewers] = useState<{ count: number; shared: boolean } | null>(null);
  const [resize, setResize] = useState<ResizeStat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touch] = useState(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);

  // Held in a ref so a re-rendered parent can't retrigger the effect and
  // silently re-attach the panel mid-measurement.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const t0 = performance.now();
    const collected: Marks = {};
    const pollers: number[] = [];
    const observers: ResizeObserver[] = [];
    let reported = false;
    let serverInfo: ServerInfo | null = null;

    const mark = (key: string) => {
      if (collected[key] !== undefined) return;
      collected[key] = performance.now() - t0;
      setMarks({ ...collected });
      if (key === 'paint' && !reported) {
        reported = true;
        onRunRef.current({ at: Date.now(), panel: panel.id, marks: { ...collected }, server: serverInfo ?? undefined });
      }
    };

    let disposed = false;
    let engine: Engine | null = null;
    let fitter: Fitter | null = null;
    let ws: WebSocket | null = null;
    const queue: string[] = [];

    const send = (d: string) => { if (ws && ws.readyState === 1) ws.send(d); };
    sendKeyRef.current = (d) => { send(d); engine?.focus?.(); };

    // --- conforming to the server's grid ------------------------------------
    // The server owns the grid; a client may request a size but never imposes
    // one. Without this a second device resizes the PTY and the first keeps
    // rendering into its old geometry, which is what "distorted" looks like.
    let conforming = false;
    let pendingGrid: { cols: number; rows: number } | null = null;

    const setFontSize = (n: number) => {
      const e = engine as unknown as { renderer?: { setFontSize(n: number): void }; options?: { fontSize: number } } | null;
      if (!e) return;
      if (e.renderer?.setFontSize) e.renderer.setFontSize(n); // ghostty-web
      else if (e.options) e.options.fontSize = n; // xterm.js
    };

    const fitFontToWidth = (gridCols: number) => {
      const w = host.clientWidth || 640;
      setFontSize(Math.max(6, Math.min(28, Math.floor(w / (gridCols * 0.62)))));
    };

    const conform = (c: number, r: number) => {
      if (!engine) { pendingGrid = { cols: c, rows: r }; return; }
      conforming = true;
      try {
        if (engine.cols !== c || engine.rows !== r) engine.resize(c, r);
        if (fit === 'fixed') fitFontToWidth(c);
      } finally {
        setTimeout(() => { conforming = false; }, 0);
      }
      setSize({ cols: c, rows: r });
    };

    // --- resize measurement -------------------------------------------------
    let pending: { at: number; from: string; to: string; bytes: number; timer: number | null } | null = null;

    const noteOutput = (len: number) => {
      if (!pending) return;
      pending.bytes += len;
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = window.setTimeout(() => {
        if (!pending) return;
        setResize({ from: pending.from, to: pending.to, settleMs: performance.now() - pending.at - SETTLE_QUIET_MS, bytes: pending.bytes });
        pending = null;
      }, SETTLE_QUIET_MS);
    };

    const sendResize = (nextCols: number, nextRows: number, from: string) => {
      if (!ws || ws.readyState !== 1) return;
      if (pending?.timer) clearTimeout(pending.timer);
      pending = { at: performance.now(), from, to: `${nextCols}×${nextRows}`, bytes: 0, timer: null };
      send(`${CTRL}${JSON.stringify({ type: 'resize', cols: nextCols, rows: nextRows })}`);
      setSize({ cols: nextCols, rows: nextRows });
      noteOutput(0);
    };

    const flush = () => {
      if (!engine || !queue.length) return;
      const data = queue.join('');
      queue.length = 0;
      engine.write(data, () => {
        mark('paint');
        setStatus('live');
        setOverlay(null);
      });
    };

    // --- connection, with backoff ------------------------------------------
    let retry: number | null = null;
    let retryDelay = 1200;
    let closedByUs = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws/${panel.id}`);

      ws.onopen = () => {
        mark('ws');
        setStatus('attached');
        retryDelay = 1200; // a successful connection resets the backoff
        if (fitter && engine) sendResize(engine.cols, engine.rows, `${engine.cols}×${engine.rows}`);
      };

      ws.onmessage = (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : '';
        if (data.startsWith(CTRL)) {
          let frame: any;
          try { frame = JSON.parse(data.slice(CTRL.length)); } catch { return; }
          if (frame.type === 'error') { setError(frame.message); setStatus('failed'); return; }
          if (frame.type === 'grid') {
            setViewers({ count: frame.viewers, shared: frame.shared });
            conform(frame.cols, frame.rows);
            return;
          }
          if (frame.type === 'restore') {
            mark('first');
            serverInfo = frame.server;
            setServer(frame.server);
            if (frame.html) { setOverlay(frame.html); mark('preview'); }
            conform(frame.cols, frame.rows);
            queue.push((frame.replay || '') + frame.ansi);
            flush();
          }
          return;
        }
        mark('first');
        noteOutput(data.length);
        queue.push(data);
        flush();
      };

      ws.onerror = () => { try { ws?.close(); } catch {} };

      ws.onclose = (ev) => {
        if (disposed || closedByUs) return;
        // A real exit or a hard server-side failure is terminal: retrying would
        // respawn the agent in a loop.
        if (ev.code === EXIT_CODE) { setStatus('session exited'); return; }
        if (ev.code === FAILED_CODE) { setStatus('failed'); return; }
        setStatus(`reconnecting in ${(retryDelay / 1000).toFixed(1)}s`);
        retry = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 1.7, 15_000);
      };
    };

    connect();

    // --- engine -------------------------------------------------------------
    const reflow = fit === 'reflow';
    const width = host.clientWidth || 640;
    const fontSize = reflow ? REFLOW_FONT_SIZE : Math.max(7, Math.min(15, Math.floor(width / (cols * 0.62))));
    const options = { cols, rows, fontSize, fontFamily: FONT_STACK, theme: THEME, scrollback: 5000, cursorBlink: true };

    const boot: Promise<{ engine: Engine; fitter: Fitter | null }> = panel.mode === 'ghostty'
      ? loadGhostty().then((m) => ({
          engine: new m.Terminal(options) as unknown as Engine,
          fitter: reflow ? (new m.FitAddon() as unknown as Fitter) : null,
        }))
      : loadXterm().then(([m, fitMod]) => ({
          engine: new m.Terminal(options) as unknown as Engine,
          fitter: reflow ? (new fitMod.FitAddon() as unknown as Fitter) : null,
        }));

    boot.then(({ engine: created, fitter: createdFitter }) => {
      if (disposed) { created.dispose(); return; }
      engine = created;
      fitter = createdFitter;
      created.open(host);
      mark('engine');

      created.onData((d) => send(d));
      if (created.onBell) created.onBell(() => setSignals((s) => ({ ...s, bells: s.bells + 1 })));

      if (created.hasMouseTracking || created.hasBracketedPaste) {
        pollers.push(window.setInterval(() => {
          setSignals((s) => ({
            ...s,
            mouse: created.hasMouseTracking ? created.hasMouseTracking() : undefined,
            paste: created.hasBracketedPaste ? created.hasBracketedPaste() : undefined,
          }));
        }, 1000));
      }

      let debounce: number | null = null;

      if (fitter) {
        created.loadAddon(fitter);
        let last = `${created.cols}×${created.rows}`;
        created.onResize(({ cols: c, rows: r }) => {
          if (conforming) return; // conforming is not a user resize
          sendResize(c, r, last);
          last = `${c}×${r}`;
        });
        try { fitter.fit(); } catch {}
        setSize({ cols: created.cols, rows: created.rows });
        sendResize(created.cols, created.rows, last);
        setResize(null);

        const observer = new ResizeObserver(() => {
          if (debounce) clearTimeout(debounce);
          debounce = window.setTimeout(() => { try { fitter?.fit(); } catch {} }, 80);
        });
        observer.observe(host);
        observers.push(observer);
      } else {
        setSize({ cols: created.cols, rows: created.rows });
        fitFontToWidth(created.cols);
        // Rescaling the font changes what is drawn inside the box; only react to
        // the box itself changing width, or this chases its own tail.
        let lastWidth = host.clientWidth;
        const observer = new ResizeObserver(() => {
          if (host.clientWidth === lastWidth) return;
          lastWidth = host.clientWidth;
          if (debounce) clearTimeout(debounce);
          debounce = window.setTimeout(() => { if (engine) fitFontToWidth(engine.cols); }, 80);
        });
        observer.observe(host);
        observers.push(observer);
      }

      if (pendingGrid) { const g = pendingGrid; pendingGrid = null; conform(g.cols, g.rows); }
      flush();
    }).catch((err) => {
      setError(String(err && err.message ? err.message : err));
      setStatus('engine failed');
    });

    // --- touch scrolling ----------------------------------------------------
    // Neither renderer translates finger drags: xterm ignores touch for apps
    // that grabbed the mouse, and ghostty-web only listens for `wheel`, which
    // phones never emit for a drag. So convert drags into wheel notches here.
    //
    // Whether to scroll locally or forward the wheel depends on the app, and
    // this is where holding the grid pays off: with no tmux in the way,
    // hasMouseTracking() reports what the AGENT wants rather than tmux's
    // permanent yes, so a normal-buffer agent scrolls the local scrollback.
    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0].clientY; };
    const onTouchMove = (e: TouchEvent) => {
      if (touchY == null || !engine) return;
      const y = e.touches[0].clientY;
      const dy = y - touchY;
      const steps = Math.trunc(dy / TOUCH_PX_PER_NOTCH);
      if (steps !== 0) {
        touchY = y;
        const tracking = engine.hasMouseTracking
          ? engine.hasMouseTracking()
          : ((engine as unknown as { modes?: { mouseTrackingMode?: string } }).modes?.mouseTrackingMode ?? 'none') !== 'none';
        const btn = steps > 0 ? 64 : 65; // dragging down reveals earlier output
        const col = Math.max(1, Math.floor(engine.cols / 2));
        const row = Math.max(1, Math.floor(engine.rows / 2));
        for (let i = 0; i < Math.abs(steps); i++) {
          if (tracking) send(`\x1b[<${btn};${col};${row}M`);
          else engine.scrollLines(steps > 0 ? -1 : 1);
        }
      }
      if (Math.abs(dy) > 4) e.preventDefault(); // stop the page rubber-banding
    };
    const onTouchEnd = () => { touchY = null; };
    host.addEventListener('touchstart', onTouchStart, { passive: true });
    host.addEventListener('touchmove', onTouchMove, { passive: false });
    host.addEventListener('touchend', onTouchEnd);

    return () => {
      disposed = true;
      closedByUs = true;
      if (retry) clearTimeout(retry);
      if (pending?.timer) clearTimeout(pending.timer);
      for (const p of pollers) clearInterval(p);
      for (const o of observers) o.disconnect();
      host.removeEventListener('touchstart', onTouchStart);
      host.removeEventListener('touchmove', onTouchMove);
      host.removeEventListener('touchend', onTouchEnd);
      try { ws?.close(); } catch {}
      try { fitter?.dispose(); } catch {}
      try { engine?.dispose(); } catch {}
    };
  }, [panel.id, panel.mode, cols, rows, fit]);

  const badge = panel.mode === 'ghostty' ? 'B' : 'A';

  return (
    <section className={`panel panel-${panel.mode}`}>
      <header className="panel-head">
        <span className="panel-badge">{badge}</span>
        <div className="panel-title">
          <strong>{panel.label}</strong>
          <span className="panel-sub">{panel.sub}</span>
        </div>
        {size && (
          <span className={`panel-size${viewers?.shared ? ' shared' : ''}`}>
            {size.cols}×{size.rows}
            {viewers && viewers.count > 1 && ` · ${viewers.count} viewers`}
            {viewers?.shared && ' · grid shared'}
          </span>
        )}
        <span className={`panel-status s-${status.replace(/\s+/g, '-')}`}>{status}</span>
      </header>

      <div className="panel-stage">
        <div className="panel-term" ref={hostRef} />
        {overlay && (
          <div className="panel-overlay" aria-hidden>
            <div className="overlay-tag">server-rendered snapshot</div>
            <div className="overlay-body" dangerouslySetInnerHTML={{ __html: overlay }} />
          </div>
        )}
        {error && <div className="panel-error">{error}</div>}
      </div>

      {touch && (
        // preventDefault keeps terminal focus so the on-screen keyboard stays up.
        <div className="term-keybar" onPointerDown={(e) => e.preventDefault()}>
          {KEYBAR.map(([label, seq]) => (
            <button
              key={label}
              className="tk-btn"
              onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); sendKeyRef.current(seq); }}
            >{label}</button>
          ))}
        </div>
      )}

      <div className="panel-marks">
        {MARK_ORDER.map((key) => {
          const value = marks[key];
          const na = value === undefined;
          return (
            <div key={key} className={`mark${na ? ' mark-na' : ''}`}>
              <span className="mark-k">{MARK_LABELS[key]}</span>
              <span className="mark-v">{na ? (key === 'preview' ? 'n/a' : '·') : ms(value)}</span>
            </div>
          );
        })}
      </div>

      <div className="panel-foot">
        {state && (
          <div className="foot-row">
            <span className="foot-k">agent state</span>
            <span className="foot-v">
              <span className={`sdot s-${state.state}`} /> {state.state}
              {' · via '}{state.method}
              {' · read '}{state.readMs < 0.01 ? '<0.01' : state.readMs}ms
              {state.bells ? ` · ${state.bells} bells` : ''}
            </span>
          </div>
        )}
        <div className="foot-row">
          <span className="foot-k">last resize</span>
          <span className="foot-v">
            {resize
              ? `${resize.from} → ${resize.to} · settled in ${ms(Math.max(0, resize.settleMs))} · ${(resize.bytes / 1024).toFixed(1)}KB repaint`
              : 'drag the window edge to measure'}
          </span>
        </div>
        <div className="foot-row">
          <span className="foot-k">terminal modes</span>
          <span className="foot-v">
            {signals.mouse === undefined && signals.paste === undefined
              ? 'not exposed by this renderer'
              : `mouse ${signals.mouse ? 'on' : 'off'} · bracketed paste ${signals.paste ? 'on' : 'off'} · bells ${signals.bells}`}
          </span>
        </div>
        {server ? (
          <div className="foot-row">
            <span className="foot-k">restore</span>
            <span className="foot-v">
              snapshot {ms(server.snapshotMs)} · {(server.ansiBytes / 1024).toFixed(1)}KB repaint
              {' + '}{(server.replayBytes / 1024).toFixed(0)}KB styled scrollback
              {server.replayTruncated && ' (capped)'}
            </span>
          </div>
        ) : (
          <div className="foot-row">
            <span className="foot-k">restore</span>
            <span className="foot-v">tmux redraw · no scrollback in the browser</span>
          </div>
        )}
        <ul className="foot-notes">
          {panel.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      </div>
    </section>
  );
}
