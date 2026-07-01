import { useState } from 'react';
import type { Cli } from '../types';
import * as api from '../api';
import SkillsEditor from './SkillsEditor';
import UsagePanel from './UsagePanel';

type Page = 'general' | 'usage' | 'skills';
const PAGES: { id: Page; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'usage', label: 'Usage' },
  { id: 'skills', label: 'Skills' },
];

interface Info { dataDir?: string; home?: string; spaceId?: string | null; spaceHost?: string | null; tmux?: boolean; canRelaunch?: boolean; }

export default function SettingsView({
  page, onPage, onClose, theme, onToggleTheme, clis, info,
}: {
  page: Page;
  onPage: (p: Page) => void;
  onClose: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  clis: Cli[];
  info: Info | null;
}) {
  const [relaunch, setRelaunch] = useState<{ busy?: boolean; msg?: string; confirm?: boolean }>({});
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
    <div className="app">
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
              <button className="btn-ghost" onClick={onToggleTheme}>{theme === 'dark' ? '☾ Dark' : '☀ Light'}</button>
            </div>

            <h3>Agents</h3>
            <div className="s-help">A coloured dot means the agent is configured and ready. Log in once inside a session (or set a key as a Space secret) — credentials persist on the bucket across restarts and all sessions.</div>
            <div className="agent-grid">
              {clis.filter((c) => c.id !== 'shell' && c.id !== 'files').map((c) => {
                const ready = c.available && c.ready;
                return (
                  <div key={c.id} className="agent-chip">
                    <span
                      className="status"
                      style={ready
                        ? { background: c.color, boxShadow: `0 0 6px ${c.color}` }
                        : { background: 'var(--muted)', opacity: 0.4 }}
                    />
                    <span>{c.label}</span>
                    {c.available && c.version && <span className="s-muted mono chip-ver">v{c.version}</span>}
                    <span className="s-muted chip-state">{!c.available ? 'unavailable' : ready ? 'ready' : 'needs setup'}</span>
                  </div>
                );
              })}
            </div>

            <div className="setting-row" style={{ marginTop: 12 }}>
              <div>
                <div className="s-label">Update CLIs</div>
                <div className="s-help">Factory-reboots the Space to reinstall every CLI at its latest version and relaunch. Sessions survive on the bucket.</div>
              </div>
              {relaunch.confirm ? (
                <span className="confirm-del">
                  <span className="s-muted">Rebuild now?</span>
                  <button className="btn-primary" disabled={relaunch.busy} onClick={doRelaunch}>{relaunch.busy ? '…' : 'Relaunch'}</button>
                  <button className="btn-ghost" onClick={() => setRelaunch({})}>Cancel</button>
                </span>
              ) : (
                <button className="btn-ghost" onClick={() => setRelaunch({ confirm: true })}>↻ Relaunch &amp; update</button>
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
