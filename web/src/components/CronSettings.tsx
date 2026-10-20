import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import * as api from '../api';
import type { Cli, Session } from '../types';
import Logo from './Logo';

type Preset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';
const EXCLUDED_CLIS = new Set(['shell', 'files', 'trace', 'remote']);
const DAYS = [
  { value: '1', short: 'Mon', label: 'Monday' }, { value: '2', short: 'Tue', label: 'Tuesday' },
  { value: '3', short: 'Wed', label: 'Wednesday' }, { value: '4', short: 'Thu', label: 'Thursday' },
  { value: '5', short: 'Fri', label: 'Friday' }, { value: '6', short: 'Sat', label: 'Saturday' },
  { value: '0', short: 'Sun', label: 'Sunday' },
];

const browserZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};
const agentFolder = (value: string) => {
  const readable = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (readable) return readable;
  if (!value) return '<agent-name>';
  let hash = 2_166_136_261;
  for (const character of value) hash = Math.imul(hash ^ (character.codePointAt(0) || 0), 16_777_619);
  return `agent-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};
const timeParts = (time: string) => {
  const [hour = '9', minute = '0'] = time.split(':');
  return { hour: String(Number(hour)), minute: String(Number(minute)) };
};
const cronFor = (preset: Preset, time: string, weekday: string, custom: string) => {
  const { hour, minute } = timeParts(time);
  if (preset === 'hourly') return '0 * * * *';
  if (preset === 'daily') return `${minute} ${hour} * * *`;
  if (preset === 'weekdays') return `${minute} ${hour} * * 1-5`;
  if (preset === 'weekly') return `${minute} ${hour} * * ${weekday}`;
  return custom.trim().replace(/\s+/g, ' ');
};
const fieldsForCron = (cron: string): { preset: Preset; time: string; weekday: string; custom: string } => {
  let match;
  if (cron === '0 * * * *') return { preset: 'hourly', time: '09:00', weekday: '1', custom: cron };
  if ((match = cron.match(/^(\d+) (\d+) \* \* 1-5$/))) {
    return { preset: 'weekdays', time: `${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}`, weekday: '1', custom: cron };
  }
  if ((match = cron.match(/^(\d+) (\d+) \* \* ([0-6])$/))) {
    return { preset: 'weekly', time: `${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}`, weekday: match[3], custom: cron };
  }
  if ((match = cron.match(/^(\d+) (\d+) \* \* \*$/))) {
    return { preset: 'daily', time: `${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}`, weekday: '1', custom: cron };
  }
  return { preset: 'custom', time: '09:00', weekday: '1', custom: cron };
};
const intervalName = (job: api.CronJob) => {
  const c = job.schedule.cron;
  let match;
  if (c === '0 * * * *') return 'hourly';
  if ((match = c.match(/^(\d+) (\d+) \* \* \*$/))) return `every day ${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}`;
  if ((match = c.match(/^(\d+) (\d+) \* \* 1-5$/))) return `weekdays ${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}`;
  if ((match = c.match(/^(\d+) (\d+) \* \* ([0-6])$/))) {
    const day = DAYS.find((candidate) => candidate.value === match[3])?.label || match[3];
    return `${day}s ${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}`;
  }
  return c;
};
const duration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
};
const when = (iso: string | null, zone: string, now: number) => {
  if (!iso) return '—';
  const value = Date.parse(iso);
  const delta = value - now;
  if (delta > 0 && delta < 60 * 60_000) return `in ${Math.max(1, Math.round(delta / 60_000))}m`;
  if (delta > 0 && delta < 24 * 60 * 60_000) return `in ${Math.max(1, Math.round(delta / 3_600_000))}h`;
  return compactWhen(iso, zone);
};
const compactWhen = (iso: string, zone: string) => {
  const value = Date.parse(iso);
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(value));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value || '';
    return `${part('day')} ${part('month')} ${part('hour')}:${part('minute')}`;
  } catch { return new Date(value).toISOString().slice(5, 16).replace('T', ' '); }
};

export default function CronSettings({ clis }: { clis: Cli[] }) {
  const agents = useMemo(() => clis.filter((cli) => !EXCLUDED_CLIS.has(cli.id)), [clis]);
  const [jobs, setJobs] = useState<api.CronJob[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(Date.now());
  const [editingId, setEditingId] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [jobName, setJobName] = useState('');
  const [agentName, setAgentName] = useState('');
  const [cli, setCli] = useState('');
  const [prompt, setPrompt] = useState('');
  const [preset, setPreset] = useState<Preset>('daily');
  const [time, setTime] = useState('09:00');
  const [weekday, setWeekday] = useState('1');
  const [custom, setCustom] = useState('0 9 * * *');
  const [tz, setTz] = useState(browserZone);
  const [runOnRestart, setRunOnRestart] = useState(true);

  const load = async () => {
    try {
      const [cronData, tree] = await Promise.all([api.getCrons(), api.getTree()]);
      setJobs(cronData.crons);
      setSessions(tree.sessions);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load cron jobs.');
    } finally { setLoading(false); }
  };
  useEffect(() => {
    load();
    const poll = window.setInterval(load, 15_000);
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { window.clearInterval(poll); window.clearInterval(clock); };
  }, []);
  useEffect(() => {
    if (!cli || !agents.some((agent) => agent.id === cli)) {
      setCli(agents.find((agent) => agent.available)?.id || '');
    }
  }, [agents, cli]);

  const scheduleCron = cronFor(preset, time, weekday, custom);
  const existing = sessions.find((session) => session.name === agentName.trim());
  const selected = agents.find((agent) => agent.id === cli);
  const reset = () => {
    setJobName(''); setAgentName(''); setPrompt(''); setPreset('daily'); setTime('09:00');
    setWeekday('1'); setCustom('0 9 * * *'); setTz(browserZone()); setRunOnRestart(true);
    setCli(agents.find((agent) => agent.available)?.id || ''); setEditingId(null); setMessage('');
  };
  const edit = (job: api.CronJob) => {
    const schedule = fieldsForCron(job.schedule.cron);
    setEditingId(job.id); setJobName(job.name); setAgentName(job.agent.name); setCli(job.agent.cli);
    setPrompt(job.prompt); setPreset(schedule.preset); setTime(schedule.time); setWeekday(schedule.weekday);
    setCustom(schedule.custom); setTz(job.schedule.tz); setRunOnRestart(job.runOnRestart); setMessage('');
    window.requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ block: 'start' });
      formRef.current?.querySelector<HTMLInputElement>('#cron-job-name')?.focus({ preventScroll: true });
    });
  };
  const editFromKeyboard = (event: KeyboardEvent<HTMLTableRowElement>, job: api.CronJob) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    edit(job);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!jobName.trim() || !agentName.trim() || !cli || !prompt.trim() || !scheduleCron) return;
    const draft: api.CronDraft = {
      name: jobName.trim(), agent: { name: agentName.trim(), cli }, prompt: prompt.trim(),
      schedule: { cron: scheduleCron, tz: tz.trim() }, runOnRestart,
    };
    setBusy('save'); setMessage('');
    try {
      if (editingId) await api.updateCron(editingId, draft);
      else await api.createCron(draft);
      reset();
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not ${editingId ? 'update' : 'create'} the job.`);
    } finally { setBusy(null); }
  };
  const act = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id); setMessage('');
    try {
      await action();
      await load();
      window.setTimeout(load, 750); // delivery may finish just after a 202 Run-now response
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The cron action failed.');
    } finally { setBusy(null); }
  };
  const zones = useMemo(() => {
    try {
      const withValues = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
      const values = withValues.supportedValuesOf?.('timeZone') || [];
      return values.includes('UTC') ? values : ['UTC', ...values];
    } catch { return ['UTC']; }
  }, []);

  return (
    <>
      <form className="cron-form" onSubmit={save} ref={formRef}>
        <label htmlFor="cron-job-name">Job name</label>
        <div>
          <input id="cron-job-name" value={jobName} onChange={(event) => setJobName(event.target.value)} placeholder="nightly deploy check" required />
          <p>Names the job in this list, the operations log, and failures. It is separate from the agent.</p>
        </div>

        <label htmlFor="cron-agent-name">Agent name</label>
        <div>
          <input id="cron-agent-name" value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="nightly-index" required />
          <p>{existing
            ? `Existing ${existing.name} session will be reused; its current ${existing.cli} type is kept.`
            : `Created on first fire in workspaces/${agentFolder(agentName)}. An existing exact name is reused.`}</p>
        </div>

        <span className="cron-label" id="cron-cli-label">Agent type</span>
        <div>
          <div className="cron-clis" role="group" aria-labelledby="cron-cli-label">
            {agents.map((agent) => (
              <button
                type="button" key={agent.id} className={cli === agent.id ? 'on' : ''}
                disabled={!agent.available} aria-pressed={cli === agent.id}
                title={agent.available ? agent.label : `${agent.label} is not installed on this Space`}
                onClick={() => setCli(agent.id)}
              >
                <Logo cli={agent.id} size={13} /> {agent.label}
              </button>
            ))}
          </div>
          <p>{selected?.available
            ? 'Used only if the named agent must be created.'
            : editingId && selected ? 'This saved type is unavailable here; updating preserves it.' : 'Unavailable agent types cannot be selected.'}</p>
        </div>

        <label htmlFor="cron-prompt">Prompt</label>
        <div>
          <textarea id="cron-prompt" rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Check last night’s deploy log…" required />
          <p>Sent as a normal prompt. The agent keeps its conversation history between runs.</p>
        </div>

        <span className="cron-label" id="cron-schedule-label">Schedule</span>
        <div>
          <div className="seg cron-presets" role="group" aria-labelledby="cron-schedule-label">
            {([
              ['hourly', 'Hourly'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'], ['custom', 'Custom cron'],
            ] as [Preset, string][]).map(([value, label]) => (
              <button type="button" key={value} className={preset === value ? 'on' : ''} aria-pressed={preset === value} onClick={() => setPreset(value)}>{label}</button>
            ))}
          </div>
          <div className="cron-schedule-fields">
            {preset !== 'hourly' && preset !== 'custom' && (
              <label>at <input type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></label>
            )}
            {preset === 'weekly' && (
              <label>on <select value={weekday} onChange={(event) => setWeekday(event.target.value)}>{DAYS.map((day) => <option value={day.value} key={day.value}>{day.label}</option>)}</select></label>
            )}
            {preset === 'custom' && (
              <label className="cron-expression">cron <input className="mono" value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="0 9 * * *" required /></label>
            )}
            <label className="cron-zone">timezone <input list="cron-timezones" value={tz} onChange={(event) => setTz(event.target.value)} required /></label>
            <datalist id="cron-timezones">{zones.map((zone) => <option value={zone} key={zone} />)}</datalist>
          </div>
          <p><span className="mono">{scheduleCron || '—'}</span> · stored with <span className="mono">{tz || 'timezone required'}</span>; missed fires while the Space is down are not replayed.</p>
        </div>

        <span className="cron-label" id="cron-restart-label">Run on restart</span>
        <div>
          <div className="seg" role="group" aria-labelledby="cron-restart-label">
            <button type="button" className={runOnRestart ? 'on' : ''} aria-pressed={runOnRestart} onClick={() => setRunOnRestart(true)}>Yes</button>
            <button type="button" className={!runOnRestart ? 'on' : ''} aria-pressed={!runOnRestart} onClick={() => setRunOnRestart(false)}>No</button>
          </div>
          <p>Runs once when the app comes back. This is a fresh fire, not catch-up.</p>
        </div>

        <div className="cron-form-actions">
          <button className="btn-primary" type="submit" disabled={busy === 'save' || !selected || (!editingId && !selected.available)}>
            {busy === 'save' ? (editingId ? 'Updating…' : 'Creating…') : (editingId ? 'Update job' : 'Create job')}
          </button>
          <button className="btn-ghost" type="button" onClick={reset}>Cancel</button>
        </div>
      </form>

      {message && <div className="s-warn cron-message" role="alert">{message}</div>}

      <h3>Scheduled jobs</h3>
      {loading ? <div className="s-muted">Loading…</div> : jobs.length === 0 ? (
        <div className="s-muted">No cron jobs yet.</div>
      ) : (
        <div className="table-scroll cron-table-wrap">
          <table className="cron-table">
            <colgroup>
              <col className="cron-col-job" /><col className="cron-col-agent" /><col className="cron-col-type" />
              <col className="cron-col-interval" /><col className="cron-col-state" /><col className="cron-col-next" />
              <col className="cron-col-last" /><col className="cron-col-actions" /><col className="cron-col-fill" />
            </colgroup>
            <thead><tr><th>Job</th><th>Agent</th><th>Type</th><th>Interval</th><th>State</th><th>Next</th><th>Last run</th><th>Actions</th><th className="cron-fill" aria-hidden="true" /></tr></thead>
            <tbody>{jobs.map((job) => {
              const type = clis.find((candidate) => candidate.id === job.agent.cli)?.label || job.agent.cli;
              const lastTitle = job.last
                ? [duration(job.last.durationMs), job.last.error].filter(Boolean).join(' · ')
                : '';
              return (
                <tr
                  key={job.id} className={editingId === job.id ? 'editing' : ''} tabIndex={0}
                  aria-selected={editingId === job.id}
                  onClick={() => edit(job)} onKeyDown={(event) => editFromKeyboard(event, job)}
                >
                  <td className="cron-name" title={job.name}>{job.name}</td>
                  <td className="cron-name" title={job.agent.name}>{job.agent.name}</td>
                  <td className="cron-type" aria-label={type} title={type}><Logo cli={job.agent.cli} size={14} /></td>
                  <td>{intervalName(job)}</td>
                  <td className={`cron-state ${job.state}`}>{job.state}</td>
                  <td className="cron-dim">{when(job.next, job.schedule.tz, now)}</td>
                  <td title={lastTitle}>{job.last ? <><span className={`cron-last ${job.last.status}`}>{job.last.status}</span> <span className="cron-dim">· {compactWhen(job.last.at, job.schedule.tz)}</span></> : <span className="cron-dim">—</span>}</td>
                  <td onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><span className="cron-actions">
                    <button className="btn-ghost" disabled={busy === job.id} onClick={() => act(job.id, () => api.runCron(job.id))}>Run now</button>
                    <button className="btn-ghost" disabled={busy === job.id} onClick={() => act(job.id, () => api.updateCron(job.id, { state: job.state === 'running' ? 'stopped' : 'running' }))}>{job.state === 'running' ? 'Stop' : 'Start'}</button>
                    <button className="btn-ghost danger" disabled={busy === job.id} onClick={() => act(job.id, async () => {
                      await api.deleteCron(job.id);
                      if (editingId === job.id) reset();
                    })}>Delete</button>
                  </span></td>
                  <td className="cron-fill" aria-hidden="true" />
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </>
  );
}
