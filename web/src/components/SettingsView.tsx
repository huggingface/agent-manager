import { useEffect, useState } from 'react';
import type { Cli } from '../types';
import * as api from '../api';
import SkillsEditor from './SkillsEditor';
import UsagePanel from './UsagePanel';
import { SunGlyph, MoonGlyph, RefreshGlyph, InfoGlyph } from './icons';
import Logo from './Logo';

type Page = 'general' | 'usage' | 'skills';
const PAGES: { id: Page; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'usage', label: 'Usage' },
  { id: 'skills', label: 'Skills' },
];

interface Info { dataDir?: string; home?: string; spaceId?: string | null; spaceHost?: string | null; tmux?: boolean; canRelaunch?: boolean; secrets?: string[]; bucketUnverified?: boolean; }

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

type PushState = 'checking' | 'unsupported' | 'framed' | 'denied' | 'off' | 'on' | 'busy';

// "Enable notifications" for THIS device: agents can then message the operator
// (only when explicitly asked to — see the environment skill).
function PushRow() {
  const [state, setState] = useState<PushState>('checking');
  const [note, setNote] = useState('');
  useEffect(() => {
    (async () => {
      // Inside the huggingface.co iframe the browser blocks notification
      // permission + push — only the Space's direct URL works.
      if (window.top !== window.self) return setState('framed');
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return setState('unsupported');
      if (Notification.permission === 'denied') return setState('denied');
      try {
        // `ready` can hang in odd contexts — don't leave the row stuck forever.
        const reg = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise<null>((r) => setTimeout(() => r(null), 4000)),
        ]);
        if (!reg) return setState('unsupported');
        setState((await reg.pushManager.getSubscription()) ? 'on' : 'off');
      } catch { setState('unsupported'); }
    })();
  }, []);

  const enable = async () => {
    setState('busy');
    setNote('');
    try {
      const reg = await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setState(perm === 'denied' ? 'denied' : 'off'); return; }
      const { publicKey } = await api.getPushKey();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      await api.subscribePush(sub);
      setState('on');
      setNote('This device will receive agent notifications.');
    } catch {
      setState('off');
      setNote('Could not subscribe — on iPhone, add the app to your Home Screen first.');
    }
    setTimeout(() => setNote(''), 6000);
  };

  const disable = async () => {
    setState('busy');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await api.unsubscribePush(sub.endpoint); await sub.unsubscribe(); }
    } catch { /* ignore */ }
    setState('off');
  };

  const test = async () => {
    setNote('');
    try {
      const r = await api.sendTestNotification();
      setNote(r.sent > 0 ? 'Sent — check your notifications.' : 'No delivery — is this device subscribed?');
    } catch { setNote('Failed to send.'); }
    setTimeout(() => setNote(''), 6000);
  };

  return (
    <>
      <div className="setting-row" style={{ marginTop: 12 }}>
        <div>
          <div className="s-label">Notifications</div>
          <div className="s-help">
            Agents can message this device when you explicitly ask them to ("notify me when the tests pass").
            On iPhone: add the app to your Home Screen first, then enable here.
          </div>
          {note && <div className="s-help" style={{ marginTop: 6 }}>{note}</div>}
        </div>
        {state === 'framed' ? (
          <a className="btn-ghost" href={window.location.href} target="_blank" rel="noreferrer">Open directly to enable ↗</a>
        ) : state === 'unsupported' ? (
          <span className="s-muted">not supported here</span>
        ) : state === 'denied' ? (
          <span className="s-muted">blocked in browser settings</span>
        ) : state === 'on' ? (
          <span className="confirm-del">
            <button className="btn-ghost" onClick={test}>Send test</button>
            <button className="btn-ghost" onClick={disable}>Disable</button>
          </span>
        ) : (
          <button className="btn-ghost" disabled={state === 'busy' || state === 'checking'} onClick={enable}>
            {state === 'busy' ? '…' : 'Enable on this device'}
          </button>
        )}
      </div>
    </>
  );
}

export default function SettingsView({
  page, onPage, onClose, theme, onToggleTheme, clis, info, onShowWelcome, demoMode, onToggleDemo,
}: {
  page: Page;
  onPage: (p: Page) => void;
  onClose: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  clis: Cli[];
  info: Info | null;
  onShowWelcome?: () => void;
  demoMode?: boolean;
  onToggleDemo?: () => void;
}) {
  const [relaunch, setRelaunch] = useState<{ busy?: boolean; msg?: string; confirm?: boolean }>({});
  const [secretKeys, setSecretKeys] = useState<string[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [savedNotes, setSavedNotes] = useState<Record<string, string>>({});
  const [secretsSaved, setSecretsSaved] = useState<'idle' | 'saving' | 'saved'>('idle');
  useEffect(() => {
    api.getSecrets().then((d) => { setSecretKeys(d.detected); setNotes(d.notes || {}); setSavedNotes(d.notes || {}); }).catch(() => {});
  }, []);
  const notesDirty = secretKeys.some((k) => (notes[k] || '') !== (savedNotes[k] || ''));
  // One-line textareas that grow with their content.
  const grow = (el: HTMLTextAreaElement) => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
  const growRef = (el: HTMLTextAreaElement | null) => { if (el) grow(el); };
  useEffect(() => {
    document.querySelectorAll<HTMLTextAreaElement>('textarea.secret-desc').forEach(grow);
  }, [secretKeys]);
  // Autosave: settle for a moment after the last keystroke, then persist.
  useEffect(() => {
    if (!notesDirty) return;
    const t = setTimeout(async () => {
      setSecretsSaved('saving');
      try { await api.saveSecrets(notes); setSavedNotes({ ...notes }); setSecretsSaved('saved'); setTimeout(() => setSecretsSaved('idle'), 1800); }
      catch { setSecretsSaved('idle'); }
    }, 900);
    return () => clearTimeout(t);
  }, [notes, notesDirty]);
  // Operator config (artifacts hub, jobs policy): load once, autosave on edit.
  const [cfg, setCfg] = useState<api.AmConfig | null>(null);
  const [savedCfg, setSavedCfg] = useState('');
  const [cfgSaved, setCfgSaved] = useState<'idle' | 'saving' | 'saved'>('idle');
  useEffect(() => {
    api.getConfig().then((c) => { setCfg(c); setSavedCfg(JSON.stringify(c)); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!cfg || JSON.stringify(cfg) === savedCfg) return;
    const t = setTimeout(async () => {
      setCfgSaved('saving');
      try {
        await api.saveConfig(cfg);
        setSavedCfg(JSON.stringify(cfg));
        setCfgSaved('saved');
        setTimeout(() => setCfgSaved('idle'), 1800);
      } catch { setCfgSaved('idle'); }
    }, 900);
    return () => clearTimeout(t);
  }, [cfg, savedCfg]);

  // Bucket backup: the copying happens in an HF Job, so the row reports what the
  // Hub says about the last one rather than anything we remember locally.
  const [bk, setBk] = useState<api.BackupStatus | null>(null);
  const [bkBusy, setBkBusy] = useState(false);
  const loadBackup = () => api.backupStatus().then(setBk).catch(() => {});
  useEffect(() => { loadBackup(); }, []);
  // Re-read after a save lands, so the interval and privacy dot stop disagreeing
  // with what was just chosen.
  useEffect(() => { if (cfgSaved === 'saved') loadBackup(); }, [cfgSaved]);
  const doBackup = async () => {
    setBkBusy(true);
    try { await api.runBackup(); } catch {}
    await loadBackup();
    setBkBusy(false);
  };

  // App self-update: version check on open, update on confirm.
  const [upd, setUpd] = useState<api.UpdateCheck | null>(null);
  const [updState, setUpdState] = useState<{ busy?: boolean; msg?: string; confirm?: boolean }>({});
  useEffect(() => { api.checkUpdate().then(setUpd).catch(() => {}); }, []);
  const doUpdate = async () => {
    setUpdState({ busy: true });
    try {
      const r = await api.runUpdate();
      if (r.ok && r.upToDate) setUpdState({ msg: 'Already up to date.' });
      else if (r.ok) setUpdState({ msg: 'Update pushed. The Space rebuilds now (1 to 2 min); reload once it is back.' });
      else if (r.reason === 'no-token') setUpdState({ msg: 'Add a write-scoped HF_TOKEN secret to the Space to enable updates.' });
      else setUpdState({ msg: `Update failed (${r.reason}).` });
    } catch { setUpdState({ msg: 'Request failed.' }); }
  };

  const doRelaunch = async () => {
    setRelaunch({ busy: true });
    try {
      const r = await api.relaunchSpace();
      if (r.ok) setRelaunch({ msg: 'Rebuilding — the Space will restart in ~1–2 min. Reload once it\'s back.' });
      else if (r.reason === 'no-token') setRelaunch({ msg: 'Add an HF_TOKEN secret (write access) to the Space to enable one-click relaunch, or use ⋮ → Factory reboot.' });
      else setRelaunch({ msg: `Couldn't relaunch (${r.reason}).` });
    } catch { setRelaunch({ msg: 'Request failed.' }); }
  };
  return (
    <div className="app settings">
      <aside className="sidebar">
        <div className="brand">
          <button className="icon-btn" onClick={onClose} title="Back">←</button>
          <h1 style={{ flex: 1, marginLeft: 4 }}>Settings</h1>
        </div>
        <div className="settings-nav">
          {PAGES.map((p) => (
            <button key={p.id} className={`settings-navitem${page === p.id ? ' active' : ''}`} onClick={() => onPage(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      </aside>

      <div className="main settings-main">
        {page === 'general' && (
          <div className="settings-page">
            <h2>General</h2>

            <div className="setting-row">
              <div><div className="s-label">Theme</div><div className="s-help">Defaults to your system setting.</div></div>
              <button className="btn-ghost" onClick={onToggleTheme}>{theme === 'dark' ? <><MoonGlyph /> Dark</> : <><SunGlyph /> Light</>}</button>
            </div>

            {onShowWelcome && (
              <div className="setting-row">
                <div><div className="s-label">Welcome guide</div><div className="s-help">A quick tour of how the tool works.</div></div>
                <button className="btn-ghost" onClick={onShowWelcome}>Show guide</button>
              </div>
            )}

            {onToggleDemo && (
              <div className="setting-row">
                <div>
                  <div className="s-label">Demo mode{demoMode && <span className="save-flag">on</span>}</div>
                  <div className="s-help">Hides your current sessions from the sidebar so the Space looks fresh. Nothing is deleted, logins and secrets stay valid, and anything you start while it's on stays visible. Turn it off to bring everything back.</div>
                </div>
                <button className={demoMode ? 'btn-primary' : 'btn-ghost'} onClick={onToggleDemo}>
                  {demoMode ? 'Deactivate demo mode' : 'Start demo mode'}
                </button>
              </div>
            )}

            <h3>Agents</h3>
            <div className="s-help">A coloured dot means the agent is configured and ready. Log in once inside a session (or set a key as a Space secret) — credentials persist on the bucket across restarts and all sessions.</div>
            <div className="agent-rows">
              {clis.filter((c) => c.id !== 'shell' && c.id !== 'files').map((c) => {
                const ready = c.available && c.ready;
                return (
                  <div key={c.id} className="agent-row">
                    <span
                      className="status"
                      style={ready
                        ? { background: c.color }
                        : { background: 'var(--muted)', opacity: 0.4 }}
                    />
                    <Logo cli={c.id} size={14} tint={c.color} />
                    <span className="ar-name">{c.label}</span>
                    <span className="spacer" />
                    {c.available && c.version && <span className="ar-ver mono">v{c.version}</span>}
                    <span className={`ar-state${ready ? ' ok' : ''}`}>{!c.available ? 'unavailable' : ready ? 'ready' : 'needs setup'}</span>
                    {/* fixed slot so version/state columns align across rows */}
                    <span className="ar-info">
                      {c.available && !ready && c.setup && (
                        <span className="tip" tabIndex={0} data-tip={c.setup}><InfoGlyph className="tip-i" /></span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>

            <h3>Secrets &amp; variables{secretsSaved !== 'idle' && <span className="save-flag">{secretsSaved === 'saving' ? 'saving…' : 'saved ✓'}</span>}</h3>
            <div className="s-help">Detected by diffing the runtime environment against a build-time snapshot — names only, never values. Describe what each is for (saved automatically); this publishes an <span className="mono">environment</span> skill so every agent knows what's available.</div>
            {secretKeys.length === 0 ? (
              <div className="s-muted" style={{ marginTop: 8 }}>None detected.</div>
            ) : (
              <div className="secret-list">
                {secretKeys.map((k) => (
                  <div key={k} className="secret-row">
                    <div className="secret-name mono">{k}</div>
                    <textarea
                      className="secret-desc"
                      placeholder="What is this used for?"
                      rows={1}
                      value={notes[k] || ''}
                      ref={growRef}
                      onChange={(e) => { setNotes((n) => ({ ...n, [k]: e.target.value })); grow(e.currentTarget); }}
                    />
                  </div>
                ))}
              </div>
            )}

            <h3>Agent output &amp; compute{cfgSaved !== 'idle' && <span className="save-flag">{cfgSaved === 'saving' ? 'saving…' : 'saved ✓'}</span>}</h3>
            <div className="s-help">Both policies are published to agents through the <span className="mono">environment</span> skill.</div>
            {cfg && (
              <>
                <div className="setting-row">
                  <div>
                    <div className="s-label">Web artifacts</div>
                    <div className="s-help">Agents render rich results (reports, dashboards, visualizations) as HTML pages and publish them to a central artifacts Space with an index and direct links per page.</div>
                  </div>
                  <span className="cfg-ctl">
                    <div className="seg cfg-seg">
                      <button className={cfg.artifacts.enabled ? 'on' : ''} onClick={() => setCfg({ ...cfg, artifacts: { ...cfg.artifacts, enabled: true } })}>on</button>
                      <button className={!cfg.artifacts.enabled ? 'on' : ''} onClick={() => setCfg({ ...cfg, artifacts: { ...cfg.artifacts, enabled: false } })}>off</button>
                    </div>
                  </span>
                </div>
                <div className={cfg.artifacts.enabled ? undefined : 'cfg-off'}>
                  <div className="setting-row">
                    <div>
                      <div className="s-label">Artifacts Space</div>
                      <div className="s-help">Created by the first agent that needs it.</div>
                    </div>
                    <span className="cfg-ctl">
                      <input
                        className="cfg-input mono"
                        placeholder={cfg.defaultArtifactsSpace || 'user/agent-artifacts'}
                        value={cfg.artifacts.space}
                        onChange={(e) => setCfg({ ...cfg, artifacts: { ...cfg.artifacts, space: e.target.value } })}
                      />
                    </span>
                  </div>
                  <div className="setting-row">
                    <div>
                      <div className="s-label">Default visibility</div>
                      <div className="s-help">Whether new artifact pages are visible to anyone with the link.</div>
                    </div>
                    <span className="cfg-ctl">
                      <div className="seg cfg-seg">
                        <button className={cfg.artifacts.visibility === 'public' ? 'on' : ''} onClick={() => setCfg({ ...cfg, artifacts: { ...cfg.artifacts, visibility: 'public' } })}>public</button>
                        <button className={cfg.artifacts.visibility === 'private' ? 'on' : ''} onClick={() => setCfg({ ...cfg, artifacts: { ...cfg.artifacts, visibility: 'private' } })}>private</button>
                      </div>
                    </span>
                  </div>
                </div>
                <div className="setting-row">
                  <div>
                    <div className="s-label">Ask before HF Jobs above</div>
                    <div className="s-help">Agents run expensive compute (GPU, long batch work) as HF Jobs. Above this estimated cost they must ask you first. 0 means always ask.</div>
                  </div>
                  <span className="cfg-ctl">
                    <span className="mono cfg-usd">$</span>
                    <input
                      className="cfg-input cfg-num mono"
                      type="number" min={0} step={1}
                      value={cfg.jobs.askAboveUsd}
                      onChange={(e) => setCfg({ ...cfg, jobs: { askAboveUsd: Math.max(0, Number(e.target.value) || 0) } })}
                    />
                  </span>
                </div>

                <div className="setting-row">
                  <div>
                    <div className="s-label">Back up the bucket</div>
                    <div className="s-help">
                      Copies your whole bucket — workspaces, history, saved logins — to private Hub storage:
                      a bucket you can restore from instantly, and a dataset that keeps version history.
                      The copy runs on the Hub as a Job, so it costs this Space nothing. Nothing is ever
                      deleted from your bucket.
                    </div>
                    {!bk?.hasToken && (
                      <div className="s-help" style={{ marginTop: 6 }}>
                        This needs a write-scoped <span className="mono">HF_TOKEN</span> Space secret —
                        without one there is no way to launch the Job or write to the Hub.
                      </div>
                    )}
                    {bk?.hasToken && cfg.backup.every !== 'never' && (
                      <div className="s-help" style={{ marginTop: 6 }}>
                        <span className="mono">{bk.mirror || bk.defaults.mirror}</span>
                        {bk.datasetPrivate === false
                          ? ' — NOT private, so backups are refused until you fix that'
                          : bk.datasetPrivate === true ? ' — private' : ' — created private on the first run'}
                        {bk.last && (
                          <>
                            {' · last run '}
                            {new Date(bk.last.at).toLocaleString()}
                            {bk.last.stage ? ` (${bk.last.stage.toLowerCase()})` : ''}
                          </>
                        )}
                        {bk.error && <> · <span style={{ color: 'var(--warn, #d97757)' }}>{bk.error}</span></>}
                      </div>
                    )}
                    {bk?.hasToken && cfg.backup.every !== 'never' && (
                      <button className="btn-ghost" style={{ marginTop: 8 }} disabled={bkBusy} onClick={doBackup}>
                        {bkBusy ? 'Launching…' : 'Back up now'}
                      </button>
                    )}
                  </div>
                  <span className="cfg-ctl">
                    <div className="seg cfg-seg">
                      {(['never', '1h', '3h', '24h'] as const).map((e) => (
                        <button
                          key={e}
                          className={cfg.backup.every === e ? 'on' : ''}
                          disabled={!bk?.hasToken && e !== 'never'}
                          onClick={() => setCfg({ ...cfg, backup: { ...cfg.backup, every: e } })}
                        >
                          {e === 'never' ? 'off' : e}
                        </button>
                      ))}
                    </div>
                  </span>
                </div>

                <div className="setting-row">
                  <div>
                    <div className="s-label">Archive inactive sessions</div>
                    <div className="s-help">Sessions with no activity beyond this window disappear from the sidebar and overview. Nothing is deleted; the "archived" checkbox in the sidebar brings them back.</div>
                  </div>
                  <span className="cfg-ctl">
                    <div className="seg cfg-seg">
                      {(['week', 'month', 'never'] as const).map((a) => (
                        <button key={a} className={cfg.archive.after === a ? 'on' : ''} onClick={() => setCfg({ ...cfg, archive: { after: a } })}>
                          {a === 'week' ? '1 week' : a === 'month' ? '1 month' : 'never'}
                        </button>
                      ))}
                    </div>
                  </span>
                </div>
              </>
            )}

            <PushRow />

            <div className="setting-row" style={{ marginTop: 12 }}>
              <div>
                <div className="s-label">Update CLIs</div>
                <div className="s-help">
                  Factory-reboots the Space to reinstall every CLI at its latest version and relaunch. Sessions survive on the bucket.
                </div>
                {!info?.canRelaunch && (
                  <div className="s-help" style={{ marginTop: 6 }}>
                    This button needs a write-scoped <span className="mono">HF_TOKEN</span> Space secret. Without one,
                    update manually: open your Space's <b>Settings</b> tab on Hugging Face and press{' '}
                    <b>Factory reboot</b> — same effect.
                  </div>
                )}
              </div>
              {!info?.canRelaunch ? (
                <button className="btn-ghost" disabled title="Add a write-scoped HF_TOKEN secret to the Space to enable"><RefreshGlyph /> Relaunch &amp; update</button>
              ) : relaunch.confirm ? (
                <span className="confirm-del">
                  <span className="s-muted">Rebuild now?</span>
                  <button className="btn-primary" disabled={relaunch.busy} onClick={doRelaunch}>{relaunch.busy ? '…' : 'Relaunch'}</button>
                  <button className="btn-ghost" onClick={() => setRelaunch({})}>Cancel</button>
                </span>
              ) : (
                <button className="btn-ghost" onClick={() => setRelaunch({ confirm: true })}><RefreshGlyph /> Relaunch &amp; update</button>
              )}
            </div>
            {relaunch.msg && <div className="s-help" style={{ marginTop: 6 }}>{relaunch.msg}</div>}

            <div className="setting-row">
              <div>
                <div className="s-label">Update Agent Manager</div>
                <div className="s-help">
                  Pulls the latest app version from{' '}
                  {upd?.sourceUrl
                    ? <a href={upd.sourceUrl} target="_blank" rel="noreferrer">{upd.source}</a>
                    : 'the upstream repo'}{' '}
                  into this Space and rebuilds. Your agents, logins, and files live on the bucket and are untouched.
                  {upd?.ok && !upd.behind && <> Currently up to date <span className="mono">({(upd.current || '').slice(0, 7)})</span>.</>}
                  {upd?.ok && upd.behind && <> Update available: <span className="mono">{(upd.current || '').slice(0, 7)} → {(upd.latest || '').slice(0, 7)}</span>.</>}
                </div>
              </div>
              {!upd?.ok || !upd.canUpdate ? (
                <button className="btn-ghost" disabled title="Needs a write-scoped HF_TOKEN Space secret"><RefreshGlyph /> Update app</button>
              ) : !upd.behind ? (
                <button className="btn-ghost" disabled><RefreshGlyph /> Up to date</button>
              ) : updState.confirm ? (
                <span className="confirm-del">
                  <span className="s-muted">Replace app code and rebuild?</span>
                  <button className="btn-primary" disabled={updState.busy} onClick={doUpdate}>{updState.busy ? '…' : 'Update'}</button>
                  <button className="btn-ghost" onClick={() => setUpdState({})}>Cancel</button>
                </span>
              ) : (
                <button className="btn-primary" onClick={() => setUpdState({ confirm: true })}><RefreshGlyph /> Update app</button>
              )}
            </div>
            {updState.msg && <div className="s-help" style={{ marginTop: 6 }}>{updState.msg}</div>}

            <h3>Space</h3>
            {info?.bucketUnverified && (
              <div className="s-warn">
                Can’t verify your storage bucket is private — without a write-scoped <span className="mono">HF_TOKEN</span> the
                app can’t discover which bucket is mounted. A public bucket exposes everything agents saved (including
                credentials). Double-check the bucket is <b>Private</b>, or add an <span className="mono">HF_TOKEN</span> secret to enable the automatic check.
              </div>
            )}
            <div className="kv">
              <div><span>Space</span><b>{info?.spaceId || '—'}</b></div>
              <div><span>Durable storage</span><b className="mono">{info?.dataDir || '—'}</b></div>
              <div><span>Home</span><b className="mono">{info?.home || '—'}</b></div>
              <div><span>tmux</span><b>{info?.tmux ? 'on' : 'off'}</b></div>
            </div>

          </div>
        )}

        {page === 'usage' && (
          <div className="settings-page wide">
            <h2>Usage</h2>
            <UsagePanel />
          </div>
        )}

        {page === 'skills' && (
          <div className="settings-page wide">
            <h2>Skills</h2>
            <p className="s-help">Reusable markdown/text skills. Saved skills are published as <span className="mono">SKILL.md</span> to every agent (Claude, Codex, Gemini, opencode, Hermes) and available in all new sessions. View renders markdown; Edit is plain text.</p>
            <SkillsEditor />
          </div>
        )}
      </div>
    </div>
  );
}
