// The part of Settings that is always there: the Back button, the title and the
// page tabs. Settings replaces the whole app while it is open (`.app-suspended`
// hides the fleet), so this shell has to stand on its own — the page bodies
// behind it are loaded on demand, and until they land the operator still sees
// where they are, can pick a page and can leave.
import type { ReactNode } from 'react';

export type SettingsPage = 'general' | 'usage' | 'skills' | 'cron' | 'apilog';
export const SETTINGS_PAGES: { id: SettingsPage; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'usage', label: 'Usage' },
  { id: 'skills', label: 'Skills' },
  { id: 'cron', label: 'Cron' },
  { id: 'apilog', label: 'API log' },
];

export default function SettingsShell({ page, onPage, onClose, children }: {
  page: SettingsPage;
  onPage: (p: SettingsPage) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="app settings">
      <aside className="sidebar">
        <div className="brand">
          <button className="icon-btn" onClick={onClose} title="Back">←</button>
          <h1 style={{ flex: 1, marginLeft: 4 }}>Settings</h1>
        </div>
        <div className="settings-nav">
          {SETTINGS_PAGES.map((p) => (
            <button key={p.id} className={`settings-navitem${page === p.id ? ' active' : ''}`} onClick={() => onPage(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      </aside>

      <div className="main settings-main">{children}</div>
    </div>
  );
}
