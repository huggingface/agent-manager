import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { CTRL, FONT_STACK, MARK_LABELS, MARK_ORDER, THEME, ms } from './lab';
import type { FitMode, Marks, PanelInfo, ResizeStat, Run, ServerInfo } from './lab';

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
  onData(cb: (d: string) => void): unknown;
  onResize(cb: (size: { cols: number; rows: number }) => void): unknown;
  loadAddon(addon: Addon): void;
  dispose(): void;
  focus?(): void;
  hasMouseTracking?(): boolean;
  hasBracketedPaste?(): boolean;
  onBell?: (cb: () => void) => unknown;
};

// How long the output has to go quiet before a resize counts as settled.
const SETTLE_QUIET_MS = 300;
const REFLOW_FONT_SIZE = 13;

type Props = {
  panel: PanelInfo;
  cols: number;
  rows: number;
  fit: FitMode;
  onRun: (run: Run) => void;
};

export default function Panel({ panel, cols, rows, fit, onRun }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useState<Marks>({});
  const [status, setStatus] = useState('opening');
  const [overlay, setOverlay] = useState<string | null>(null);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [signals, setSignals] = useState<{ mouse?: boolean; paste?: boolean; bells: number }>({ bells: 0 });
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  const [viewers, setViewers] = useState<{ count: number; shared: boolean } | null>(null);
  const [resize, setResize] = useState<ResizeStat | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    const queue: string[] = [];

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
        // In fixed mode the grid is the constant and the font adapts to it.
        if (fit === 'fixed') fitFontToWidth(c);
      } finally {
        // resize() fires onResize synchronously; release after that has run so
        // conforming can't be mistaken for a user-driven resize request.
        setTimeout(() => { conforming = false; }, 0);
      }
      setSize({ cols: c, rows: r });
    };

    // --- resize measurement -------------------------------------------------
    // A resize is "smooth" if the repaint it triggers is small and settles fast,
    // so both are timed from the moment the new size goes out.
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
      if (ws.readyState !== 1) return;
      const to = `${nextCols}×${nextRows}`;
      if (pending?.timer) clearTimeout(pending.timer);
      pending = { at: performance.now(), from, to, bytes: 0, timer: null };
      ws.send(`${CTRL}${JSON.stringify({ type: 'resize', cols: nextCols, rows: nextRows })}`);
      setSize({ cols: nextCols, rows: nextRows });
      noteOutput(0); // arm the quiet timer even if nothing repaints
    };

    // --- socket -------------------------------------------------------------

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

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/${panel.id}`);

    ws.onopen = () => { mark('ws'); setStatus('attached'); };

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
          // The server already knows the screen, so it can hand over a rendered
          // preview that paints before the renderer exists. The classic path has
          // nothing to offer here.
          if (frame.html) { setOverlay(frame.html); mark('preview'); }
          // Replayed bytes rebuild styled scrollback; the repaint that follows is
          // the authority for the visible screen.
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

    ws.onerror = () => setStatus('socket error');
    ws.onclose = (ev) => {
      if (disposed) return;
      setStatus(ev.code === 4000 ? 'session exited' : 'disconnected');
    };

    // --- engine -------------------------------------------------------------
    // In fixed mode the grid is pinned and the font scales to it, so the PTY is
    // never resized. In reflow mode the font is pinned and the grid follows the
    // container, which is what production does and what actually exercises reflow.
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

      created.onData((d) => { if (ws.readyState === 1) ws.send(d); });
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
        // Each engine measures its own cell metrics, so let its own fit addon
        // decide what to ASK for rather than imposing one guess on both.
        let last = `${created.cols}×${created.rows}`;
        created.onResize(({ cols: c, rows: r }) => {
          // Conforming to the server is not a user resize; echoing it back would
          // ping-pong the grid between devices forever.
          if (conforming) return;
          sendResize(c, r, last);
          last = `${c}×${r}`;
        });
        try { fitter.fit(); } catch {}
        setSize({ cols: created.cols, rows: created.rows });
        // fit() only emits onResize when the size actually changed, so state the
        // starting request explicitly.
        sendResize(created.cols, created.rows, last);
        setResize(null);

        const observer = new ResizeObserver(() => {
          if (debounce) clearTimeout(debounce);
          debounce = window.setTimeout(() => { try { fitter?.fit(); } catch {} }, 80);
        });
        observer.observe(host);
        pollers.push(observer as unknown as number);
      } else {
        // Fixed grid: never request a size, just keep the font filling the panel.
        setSize({ cols: created.cols, rows: created.rows });
        fitFontToWidth(created.cols);
        // Rescaling the font changes what is drawn inside the box; only react to
        // the box itself actually changing width, or this chases its own tail.
        let lastWidth = host.clientWidth;
        const observer = new ResizeObserver(() => {
          if (host.clientWidth === lastWidth) return;
          lastWidth = host.clientWidth;
          if (debounce) clearTimeout(debounce);
          debounce = window.setTimeout(() => { if (engine) fitFontToWidth(engine.cols); }, 80);
        });
        observer.observe(host);
        pollers.push(observer as unknown as number);
      }

      // A grid frame that landed before the engine existed still applies.
      if (pendingGrid) { const g = pendingGrid; pendingGrid = null; conform(g.cols, g.rows); }

      flush();
    }).catch((err) => {
      setError(String(err && err.message ? err.message : err));
      setStatus('engine failed');
    });

    return () => {
      disposed = true;
      if (pending?.timer) clearTimeout(pending.timer);
      for (const p of pollers) {
        if (typeof p === 'number') clearInterval(p);
        else (p as unknown as ResizeObserver).disconnect();
      }
      try { ws.close(); } catch {}
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
