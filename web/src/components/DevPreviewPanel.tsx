// Settings → Preview, on a dev-preview Space only. Pick an open PR (or several,
// merged onto main in the order picked), switch, watch it build, roll back.
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api';

type Status = Awaited<ReturnType<typeof api.getDevPreviewStatus>>;
type Prs = Awaited<ReturnType<typeof api.getDevPreviewPrs>>;

const short = (sha?: string | null) => (sha ? sha.slice(0, 7) : '');
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export default function DevPreviewPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [offline, setOffline] = useState(false);
  const [prs, setPrs] = useState<Prs | null>(null);
  const [picked, setPicked] = useState<api.DevPreviewPr[]>([]);
  const [manual, setManual] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  // Set when THIS tab started a switch: once the server comes back on the new
  // build, reload so the UI is the new build's too.
  const awaiting = useRef<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.getDevPreviewStatus();
      setStatus(s);
      setOffline(false);
      if (awaiting.current !== null && s.running.id !== awaiting.current && s.job?.state !== 'running' && !s.restartPending) location.reload();
    } catch { setOffline(true); }
  }, []);
  const loadPrs = useCallback(async () => {
    setPrs(null);
    try { setPrs(await api.getDevPreviewPrs()); } catch (e) { setPrs({ ok: false, error: (e as Error).message }); }
  }, []);

  useEffect(() => { loadStatus(); loadPrs(); }, [loadStatus, loadPrs]);
  const busy = status?.job?.state === 'running' || !!status?.restartPending || offline || status?.supervised === false;
  useEffect(() => {
    const t = setInterval(loadStatus, busy ? 1500 : 10_000);
    return () => clearInterval(t);
  }, [busy, loadStatus]);

  const toggle = (p: api.DevPreviewPr) => setPicked((cur) => (
    cur.some((q) => q.number === p.number) ? cur.filter((q) => q.number !== p.number) : [...cur, p]
  ));
  const move = (i: number, d: -1 | 1) => setPicked((cur) => {
    const next = [...cur];
    const j = i + d;
    if (j < 0 || j >= next.length) return cur;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const addManual = () => {
    const n = Number(manual.trim().replace(/^#/, ''));
    if (!Number.isSafeInteger(n) || n < 1) { setErr('A PR number is a positive whole number.'); return; }
    setErr(null);
    setManual('');
    if (!picked.some((p) => p.number === n)) setPicked([...picked, prs?.prs?.find((p) => p.number === n) || { number: n, sha: '' }]);
  };

  const doSwitch = async () => {
    setErr(null);
    try {
      awaiting.current = status?.running.id ?? null;
      await api.switchDevPreview(picked.map((p) => (p.sha ? { number: p.number, sha: p.sha } : { number: p.number })));
      await loadStatus();
    } catch (e) { awaiting.current = null; setErr((e as Error).message); }
  };
  const doRollback = async () => {
    setErr(null);
    try {
      awaiting.current = status?.running.id ?? null;
      await api.rollbackDevPreview();
      await loadStatus();
    } catch (e) { awaiting.current = null; setErr((e as Error).message); }
  };

  const run = status?.running;
  const job = status?.job;
  return (
    <div className="devpv-panel">
      <section className="devpv-card">
        <div className="devpv-row">
          <span className="devpv-k">Running</span>
          <span data-testid="dev-preview-running">
            {!run ? '…' : run.kind === 'main' ? <b>main (the image build)</b> : (
              <>
                {run.prs.map((p, i) => <span key={p.number}>{i ? ' + ' : ''}<b>#{p.number}</b> <span className="mono">{short(p.sha)}</span></span>)}
                {run.base ? <> on main <span className="mono">{short(run.base)}</span></> : null}
              </>
            )}
          </span>
        </div>
        {offline ? <div className="devpv-row devpv-dim">The server is restarting…</div> : null}
        {status?.restartPending && !offline ? <div className="devpv-row devpv-dim">Restarting into this build; the server answering now is still the previous one.</div> : null}
        {status?.crashed ? (
          <div className="devpv-row devpv-warn">The last preview exited right after starting and was rolled back to main ({status.crashed.detail}).</div>
        ) : null}
        {!status?.supervised && status ? (
          <div className="devpv-row devpv-warn">Not running under the entrypoint supervisor, so switching is off: the server could not restart into a new build.</div>
        ) : null}
        <div className="devpv-actions">
          <button className="btn-ghost" disabled={busy || run?.kind === 'main'} onClick={doRollback}>Roll back to main</button>
        </div>
      </section>

      {job ? (
        <section className="devpv-card" data-testid="dev-preview-job">
          <div className="devpv-row">
            <span className="devpv-k">Last {job.kind}</span>
            <span>
              <b className={`devpv-state ${job.state}`}>{job.state === 'running' ? `${job.step}…` : job.state}</b>
              {job.finishedAt ? <span className="devpv-dim"> in {secs(job.finishedAt - job.startedAt)}</span> : null}
              {job.restarting ? <span className="devpv-dim"> · restarting the server</span> : null}
            </span>
          </div>
          {job.steps.length ? (
            <div className="devpv-steps">{job.steps.map((s, i) => <span key={i}>{s.name} <span className="mono">{secs(s.ms)}</span></span>)}</div>
          ) : null}
          {job.error ? <div className="devpv-row devpv-err">{job.error}</div> : null}
          {job.rebuild?.length ? (
            <div className="devpv-row">
              <div>
                <b>Needs a full rebuild.</b> These are build inputs a switch cannot replace:
                <ul className="devpv-files">{job.rebuild.map((r) => <li key={r.file}><span className="mono">{r.file}</span> <span className="devpv-dim">— {r.why}</span></li>)}</ul>
              </div>
            </div>
          ) : null}
          {job.conflict?.files.length ? (
            <div className="devpv-row">
              <div>
                <b>#{job.conflict.pr} conflicts with {job.conflict.onto}</b> in:
                <ul className="devpv-files">{job.conflict.files.map((f) => <li key={f} className="mono">{f}</li>)}</ul>
              </div>
            </div>
          ) : null}
          <button className="devpv-link" onClick={() => setShowLog(!showLog)}>{showLog ? 'hide' : 'show'} log</button>
          {showLog ? <pre className="devpv-log mono">{(status?.log || []).join('\n')}</pre> : null}
        </section>
      ) : null}

      <section className="devpv-card">
        <div className="devpv-row">
          <span className="devpv-k">Open PRs</span>
          <span className="devpv-dim">
            {prs?.main?.sha ? <>main is <span className="mono">{short(prs.main.sha)}</span> · </> : null}
            <button className="devpv-link" onClick={loadPrs}>refresh</button>
          </span>
        </div>
        {!prs ? <div className="devpv-dim">Loading…</div> : !prs.ok ? (
          <div className="devpv-err">Could not list PRs: {prs.error}. You can still add one by number below.</div>
        ) : (
          <ul className="devpv-prs">
            {(prs.prs || []).map((p) => {
              const at = picked.findIndex((q) => q.number === p.number);
              return (
                <li key={p.number}>
                  <label>
                    <input type="checkbox" checked={at >= 0} onChange={() => toggle(p)} disabled={busy} />
                    <span className="devpv-order">{at >= 0 ? at + 1 : ''}</span>
                    <b>#{p.number}</b> <span className="devpv-title">{p.title}</span>
                    <span className="devpv-dim"> {p.author} · <span className="mono">{short(p.sha)}</span>{p.draft ? ' · draft' : ''}</span>
                  </label>
                </li>
              );
            })}
            {prs.prs?.length === 0 ? <li className="devpv-dim">No open PRs.</li> : null}
          </ul>
        )}
        <div className="devpv-actions">
          <input className="devpv-input" placeholder="PR number" inputMode="numeric" value={manual}
            onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addManual(); }} />
          <button className="btn-ghost" onClick={addManual} disabled={busy || !manual.trim()}>Add</button>
        </div>
      </section>

      <section className="devpv-card">
        <div className="devpv-row"><span className="devpv-k">Selection</span><span className="devpv-dim">merged onto main in this order</span></div>
        {picked.length === 0 ? <div className="devpv-dim">Tick one or more PRs above.</div> : (
          <ol className="devpv-stack">
            {picked.map((p, i) => (
              <li key={p.number}>
                <b>#{p.number}</b> {p.sha ? <span className="mono">{short(p.sha)}</span> : <span className="devpv-dim">current head</span>}
                <span className="devpv-title"> {p.title || ''}</span>
                <span className="devpv-move">
                  <button className="icon-btn" title="Earlier" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button className="icon-btn" title="Later" disabled={i === picked.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button className="icon-btn" title="Remove" onClick={() => setPicked(picked.filter((q) => q.number !== p.number))}>×</button>
                </span>
              </li>
            ))}
          </ol>
        )}
        {err ? <div className="devpv-err">{err}</div> : null}
        <div className="devpv-actions">
          <button className="btn-primary" disabled={busy || picked.length === 0} onClick={doSwitch} data-testid="dev-preview-switch">
            Switch to {picked.length > 1 ? `these ${picked.length} PRs` : 'this PR'}
          </button>
        </div>
      </section>
    </div>
  );
}
