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

interface Info { dataDir?: string; home?: string; spaceId?: string | null; spaceHost?: string | null; tmux?: boolean; canRelaunch?: boolean; secrets?: string[]; }

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
  page, onPage, onClose, theme, onToggleTheme, clis, info, onShowWelcome,
}: {
  page: Page;
  onPage: (p: Page) => void;
  onClose: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  clis: Cli[];
  info: Info | null;
  onShowWelcome?: () => void;
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

            <h3>Space</h3>
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
