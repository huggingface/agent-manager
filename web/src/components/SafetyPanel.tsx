// Settings → Safety: the tool-call guard and what it saw.
//
// The guard is a safeagents proxy (github.com/huggingface/safeagents) between
// Claude Code and its model server; server/src/safeagents.js runs it. Three
// views over what it records:
//
//   flagged — the journal: every call that did not simply pass, with its full
//             arguments, the task it was made for and the findings. Kept on the
//             bucket, so it is the one to come back to.
//   live    — every call the proxy reviewed since it started, PASS included,
//             one per line. Gone on restart; it is for watching, not keeping.
//   proxy   — the proxy's own messages: start-up, upstream errors, exits.
//
// Arguments can carry secrets, so a flagged call's arguments stay folded until
// its row is opened.
import { Fragment, useCallback, useEffect, useState } from 'react';
import * as api from '../api';

type View = 'flagged' | 'live' | 'proxy';

const VERDICT_LABEL: Record<api.SafeAgentsVerdict, string> = {
  passed: 'PASS', suspicious: 'WARN', flagged: 'FLAG', blocked: 'BLOCK',
};
const VERDICT_CLASS: Record<api.SafeAgentsVerdict, string> = {
  passed: 'ok', suspicious: 'warn', flagged: 'warn', blocked: 'bad',
};
const STATE_LABEL: Record<api.SafeAgentsStatus['state'], string> = {
  off: 'off',
  starting: 'starting…',
  ready: 'running',
  draining: 'off — still forwarding for sessions launched while it was on',
  failed: 'not running',
  unavailable: 'not installed',
};
const MODES: { id: api.SafeAgentsMode; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'log-only', label: 'Log only' },
  { id: 'block', label: 'Block' },
];

const HHMMSS = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });
const WHEN = (ms: number) => new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** The one argument that says what a call does, as safeagents' own summary does. */
function summary(args: string): string {
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === 'object') {
      for (const key of ['command', 'cmd', 'url', 'query', 'file_path', 'path', 'pattern', 'code']) {
        if (typeof parsed[key] === 'string' && parsed[key]) return parsed[key];
      }
    }
  } catch {}
  return args;
}
const pretty = (args: string) => {
  try { return JSON.stringify(JSON.parse(args), null, 2); } catch { return args; }
};

export default function SafetyPanel() {
  const [data, setData] = useState<api.SafeAgentsView | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<View>('flagged');
  const [open, setOpen] = useState<number | null>(null);
  const [hosts, setHosts] = useState('');
  const [names, setNames] = useState<Map<string, string>>(new Map());

  const load = useCallback(() => api.getSafeAgents()
    .then((d) => { setData(d); setError(''); return d; })
    .catch(() => { setError('could not read the guard\'s state'); return null; }), []);
  useEffect(() => {
    void load().then((d) => { if (d) setHosts(d.config.allowHosts.join(', ')); });
    // The live list is the point of this page while it is open.
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    api.getTree().then((t) => setNames(new Map(t.sessions.map((s) => [s.id, s.name])))).catch(() => {});
  }, [data?.status.guarded.length]);

  const save = async (next: api.SafeAgentsConfig) => {
    if (!data) return;
    setSaving(true);
    try {
      const r = await api.setSafeAgentsConfig(next, data.rev);
      setData({ ...data, config: r.config, rev: r.rev, status: r.status });
      setHosts(r.config.allowHosts.join(', '));
      setError('');
    } catch (e) {
      const err = e as api.ApiError;
      setError(err.status === 409
        ? 'The setting was changed somewhere else — showing what is stored now.'
        : err.message || 'could not save');
      void load().then((d) => { if (d) setHosts(d.config.allowHosts.join(', ')); });
    } finally {
      setSaving(false);
    }
  };
  const saveHosts = () => {
    if (!data) return;
    const allowHosts = hosts.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (allowHosts.join(',') === data.config.allowHosts.join(',')) return;
    void save({ ...data.config, allowHosts });
  };

  if (!data) return <div className="al">{error ? <div className="s-warn">{error}</div> : <div className="s-muted">loading…</div>}</div>;
  const { status, config } = data;
  const counts = status.counts;
  const total = counts.passed + counts.suspicious + counts.flagged + counts.blocked;
  const guarded = status.guarded.map((id) => names.get(id) || id);

  return (
    <div className="al sg">
      <div className="setting-row">
        <div>
          <div className="s-label">Tool-call guard</div>
          <div className="s-help">
            <b>Log only</b> records the calls safeagents would block and lets them run. <b>Block</b> replaces
            them with a notice, so Claude Code never runs them. Start with Log only and watch the Flagged list
            for a while before you switch to Block.
          </div>
        </div>
        <div className="seg">
          {MODES.map((m) => (
            <button key={m.id} className={config.mode === m.id ? 'on' : ''} disabled={saving || !!data.readError}
              onClick={() => { if (config.mode !== m.id) void save({ ...config, mode: m.id }); }}>{m.label}</button>
          ))}
        </div>
      </div>

      <div className="s-help">
        Only <b>Claude Code</b> sessions go through the guard. Codex uses the Responses API, which safeagents does not
        check yet, and opencode and Hermes would need their own config files changed. A session picks the guard up
        when it launches, so restart a session that is already running to guard it. With a custom base URL, Claude Code
        turns off Remote Control and tool search.
      </div>

      <div className="sg-status">
        <span>proxy <b className={status.state === 'ready' ? 'sg-ok' : status.state === 'failed' || status.state === 'unavailable' ? 'sg-bad' : ''}>
          {saving ? 'applying…' : STATE_LABEL[status.state]}</b></span>
        {status.pid && <span>{status.listen} → {status.upstream}</span>}
        {status.pid && <span>pid {status.pid}</span>}
        {status.runningMode && status.state === 'ready' && <span>{status.runningMode}</span>}
        <span>{guarded.length} guarded session{guarded.length === 1 ? '' : 's'}{guarded.length ? `: ${guarded.join(', ')}` : ''}</span>
      </div>
      {status.error && <div className="s-warn">{status.error}{status.state === 'unavailable' ? ' — the image installs it; a local install needs `uv tool install git+https://github.com/huggingface/safeagents`.' : ''}</div>}
      {data.readError && <div className="s-warn">{data.readError} — nothing was changed, and saving is refused until it is repaired.</div>}
      {error && <div className="s-warn">{error}</div>}

      <div className="setting-row">
        <div>
          <div className="s-label">Extra allowed hosts</div>
          <div className="s-help">Hosts tool calls may reach even when the conversation never mentions them, subdomains
            included. Loopback, GitHub, PyPI, Hugging Face, npm and crates.io are always allowed.</div>
        </div>
        <input className="sg-hosts mono" value={hosts} placeholder="docs.rs, go.dev" disabled={saving}
          onChange={(e) => setHosts(e.target.value)} onBlur={saveHosts}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      </div>

      <div className="al-head">
        <span className="al-count">
          {total} call{total === 1 ? '' : 's'} since start · {counts.passed} pass · {counts.suspicious} warn · {counts.flagged} flag
          {counts.blocked > 0 ? <span className="al-fails"> · {counts.blocked} blocked</span> : ` · 0 blocked`}
        </span>
        <div className="seg al-view">
          <button className={view === 'flagged' ? 'on' : ''} onClick={() => setView('flagged')}>Flagged ({data.journal.length})</button>
          <button className={view === 'live' ? 'on' : ''} onClick={() => setView('live')}>Live</button>
          <button className={view === 'proxy' ? 'on' : ''} onClick={() => setView('proxy')}>Proxy log</button>
        </div>
        <button className="btn-ghost al-refresh" onClick={() => { void load(); }}>Refresh</button>
      </div>

      {view === 'flagged' && (
        <>
          {data.journalError && <div className="s-warn">could not read the journal — {data.journalError}</div>}
          <div className="al-tblwrap">
            <table className="al-tbl">
              <thead><tr><th>#</th><th>When</th><th>Verdict</th><th>Tool</th><th className="grow">Call</th><th>Why</th></tr></thead>
              <tbody>
                {data.journal.map((e) => (
                  <Fragment key={e.id}>
                    <tr className="sg-row" onClick={() => setOpen(open === e.id ? null : e.id)}>
                      <td className="al-time">{e.id}</td>
                      <td className="al-time">{WHEN(e.time * 1000)}</td>
                      <td className={`al-st ${VERDICT_CLASS[e.verdict]}`}>{VERDICT_LABEL[e.verdict]}</td>
                      <td>{e.tool}</td>
                      <td className="grow al-path">{summary(e.arguments)}</td>
                      <td className="al-pay">{e.reason || e.signals.map((s) => s.id).join(', ')}</td>
                    </tr>
                    {open === e.id && (
                      <tr className="sg-detail"><td colSpan={6}><JournalDetail entry={e} /></td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {!data.journal.length && !data.journalError && <div className="s-muted al-empty">No flagged calls yet.</div>}
        </>
      )}

      {view === 'live' && (
        <>
          <div className="al-tblwrap">
            <table className="al-tbl">
              <thead><tr><th>Time</th><th>Verdict</th><th>Tool</th><th className="grow">Call</th><th>Why</th></tr></thead>
              <tbody>
                {data.calls.map((c, i) => (
                  <tr key={`${c.at}-${i}`} className={c.journalId ? 'sg-row' : ''}
                    onClick={() => { if (c.journalId) { setOpen(c.journalId); setView('flagged'); } }}
                    title={c.journalId ? `Open flagged call #${c.journalId}` : undefined}>
                    <td className="al-time">{HHMMSS(c.at)}</td>
                    <td className={`al-st ${VERDICT_CLASS[c.verdict]}`}>{VERDICT_LABEL[c.verdict]}</td>
                    <td>{c.tool}</td>
                    <td className="grow al-path">{c.what}</td>
                    <td className="al-pay">{c.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.calls.length && <div className="s-muted al-empty">No calls since the proxy started.</div>}
        </>
      )}

      {view === 'proxy' && (
        <pre className="sg-log">{data.log.length
          ? data.log.map((l) => `${HHMMSS(l.at)}  ${l.text}`).join('\n')
          : 'Nothing logged yet.'}</pre>
      )}
    </div>
  );
}

function JournalDetail({ entry }: { entry: api.SafeAgentsJournalEntry }) {
  return (
    <div className="sg-card">
      <dl>
        <dt>verdict</dt><dd>{entry.verdict}{entry.reason ? ` — ${entry.reason}` : ''}</dd>
        {entry.model && <><dt>model</dt><dd className="mono">{entry.model}</dd></>}
        {entry.judge && <><dt>judge</dt><dd>{entry.judge}</dd></>}
        {entry.signals.map((s) => (
          <Fragment key={s.id}><dt>finding</dt><dd><span className="mono">{s.id}</span> ({s.severity}): {s.title}</dd></Fragment>
        ))}
        {entry.task && <><dt>task</dt><dd className="sg-task">{entry.task}</dd></>}
      </dl>
      <div className="s-label">arguments</div>
      <pre className="sg-args">{pretty(entry.arguments)}</pre>
    </div>
  );
}
