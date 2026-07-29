import { useCallback, useEffect, useMemo, useState } from 'react';
import Panel from './Panel';
import { MARK_LABELS, MARK_ORDER, clearRuns, loadRuns, median, ms, saveRun } from './lab';
import type { Config, FitMode, PanelInfo, Run } from './lab';

function useHash() {
  const [hash, setHash] = useState(() => location.hash.replace(/^#\/?/, ''));
  useEffect(() => {
    const on = () => setHash(location.hash.replace(/^#\/?/, ''));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHash();
  const [config, setConfig] = useState<Config | null>(null);
  const [runs, setRuns] = useState<Run[]>(() => loadRuns());
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/panels')
      .then((r) => r.json())
      .then(setConfig)
      .catch((e) => setConfigError(String(e.message || e)));
  }, []);

  const onRun = useCallback((run: Run) => {
    saveRun(run);
    setRuns(loadRuns());
  }, []);

  if (configError) {
    return <div className="shell"><div className="card error">Could not reach the server: {configError}</div></div>;
  }
  if (!config) {
    return <div className="shell"><div className="boot">starting<span className="blink">▍</span></div></div>;
  }

  return hash === 'lab'
    ? <Lab config={config} onRun={onRun} />
    : <Landing config={config} runs={runs} onClear={() => { clearRuns(); setRuns([]); }} />;
}

// ---------- landing ----------

function Landing({ config, runs, onClear }: { config: Config; runs: Run[]; onClear: () => void }) {
  const byPanel = useMemo(() => {
    const out: Record<string, Run[]> = {};
    for (const r of runs) (out[r.panel] ||= []).push(r);
    return out;
  }, [runs]);

  return (
    <div className="shell">
      <header className="page-head">
        <h1>ghostty lab</h1>
        <p className="lede">
          Two Claude sessions, both preloaded as <code>the-gatherer</code>, running the same
          fixed {config.cols}×{config.rows} grid. The only difference is how a returning
          browser gets its screen back.
        </p>
      </header>

      <div className="paths">
        {config.panels.map((p) => (
          <div key={p.id} className={`card path path-${p.mode}`}>
            <div className="path-head">
              <span className="panel-badge">{p.mode === 'ghostty' ? 'B' : 'A'}</span>
              <strong>{p.label}</strong>
            </div>
            <div className="path-sub">{p.sub}</div>
            <ul className="foot-notes">{p.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </div>
        ))}
      </div>

      <div className="cta">
        <a className="btn primary" href="#/lab">open the lab</a>
        <span className="cta-hint">
          Then come back here. The sessions keep running, so every return trip is a fresh measurement.
        </span>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>attach timings</h2>
          {runs.length > 0 && <button className="btn ghost" onClick={onClear}>clear</button>}
        </div>
        {runs.length === 0 ? (
          <p className="muted">No runs yet. Open the lab, come back, repeat a few times.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>path</th>
                <th>runs</th>
                {MARK_ORDER.map((k) => <th key={k}>{MARK_LABELS[k]}</th>)}
              </tr>
            </thead>
            <tbody>
              {config.panels.map((p) => {
                const list = byPanel[p.id] || [];
                return (
                  <tr key={p.id}>
                    <td><span className="panel-badge sm">{p.mode === 'ghostty' ? 'B' : 'A'}</span> {p.label}</td>
                    <td className="num">{list.length}</td>
                    {MARK_ORDER.map((k) => (
                      <td key={k} className="num">
                        {ms(median(list.map((r) => r.marks[k]).filter((n): n is number => n !== undefined)))}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted small">
          Medians across your recorded attaches. "screen back" is the one that matters: how long
          from opening the lab until the session is readable again.
        </p>
      </section>

      <section className="card">
        <div className="card-head"><h2>what the server can see right now</h2></div>
        <p className="muted small">
          Nothing is attached from this page. This asks each path what is on its screen.
        </p>
        <div className="peeks">
          {config.panels.map((p) => <Peek key={p.id} panel={p} />)}
        </div>
      </section>

      <footer className="page-foot">
        <span>
          libghostty {config.ghostty.ok
            ? `${config.ghostty.ghosttyVersion} via ${config.ghostty.packageVersion} (${config.ghostty.platform}/${config.ghostty.arch})`
            : `unavailable — ${config.ghostty.error}`}
        </span>
        <span>tmux {config.tmux ? 'on' : 'off'}</span>
      </footer>
    </div>
  );
}

function Peek({ panel }: { panel: PanelInfo }) {
  const [data, setData] = useState<{ available: boolean; reason?: string; text?: string; ms?: number; lastByteAgeMs?: number | null } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch(`/api/panels/${panel.id}/peek`)
        .then((r) => r.json())
        .then((d) => { if (alive) setData(d); })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [panel.id]);

  return (
    <div className={`card peek peek-${panel.mode}`}>
      <div className="path-head">
        <span className="panel-badge sm">{panel.mode === 'ghostty' ? 'B' : 'A'}</span>
        <strong>{panel.label}</strong>
        {data?.available && <span className="peek-ms">read in {ms(data.ms)}</span>}
      </div>
      {!data ? (
        <div className="muted small">reading<span className="blink">▍</span></div>
      ) : data.available ? (
        <pre className="peek-text">{(data.text || '').replace(/\n{3,}/g, '\n\n').trim() || '(blank screen)'}</pre>
      ) : (
        <div className="peek-empty">{data.reason}</div>
      )}
    </div>
  );
}

// ---------- lab ----------

function Lab({ config, onRun }: { config: Config; onRun: (r: Run) => void }) {
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [fit, setFit] = useState<FitMode>('reflow');

  const send = async () => {
    const text = prompt.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await Promise.all(config.panels.map((p) =>
        fetch(`/api/panels/${p.id}/prompt`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        })));
      setPrompt('');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="shell lab">
      <header className="lab-head">
        <a className="btn ghost" href="#/">‹ back</a>
        <span className="lab-title">the-gatherer</span>
        <div className="seg" role="group" aria-label="grid mode">
          <button className={fit === 'reflow' ? 'on' : ''} onClick={() => setFit('reflow')}>
            reflow
          </button>
          <button className={fit === 'fixed' ? 'on' : ''} onClick={() => setFit('fixed')}>
            fixed grid
          </button>
        </div>
        <span className="lab-hint">
          {fit === 'reflow'
            ? 'drag the window edge: the grid follows and both PTYs resize'
            : 'grid pinned, font scales — the PTY is never resized'}
        </span>
      </header>

      <div className="panels">
        {config.panels.map((p) => (
          <Panel key={`${p.id}-${fit}`} panel={p} cols={config.cols} rows={config.rows} fit={fit} onRun={onRun} />
        ))}
      </div>

      <div className="promptbar">
        <span className="prompt-glyph">❯</span>
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
          placeholder="type a prompt to send to BOTH sessions…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button className="btn" onClick={() => void send()} disabled={sending || !prompt.trim()}>
          {sending ? 'sending…' : 'send to both'}
        </button>
      </div>
    </div>
  );
}
