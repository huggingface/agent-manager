import { useCallback, useEffect, useMemo, useState } from 'react';
import Sidebar from './components/Sidebar';
import TerminalPane from './components/TerminalPane';
import FilesPane from './components/FilesPane';
import SettingsView from './components/SettingsView';
import NewSession from './components/NewSession';
import Locked from './components/Locked';
import * as api from './api';
import type { Cli, MoveTarget, Session, Tree } from './types';

type SettingsPage = 'general' | 'usage' | 'skills';

function initialTheme(): 'light' | 'dark' {
  const stored = localStorage.getItem('am-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function App() {
  const [clis, setClis] = useState<Cli[]>([]);
  const [tree, setTree] = useState<Tree>({ order: [], groups: [], sessions: [] });
  const [activeRef, setActiveRef] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(initialTheme);
  const [dropMain, setDropMain] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('general');
  const [zoom, setZoom] = useState<number>(() => {
    const z = parseInt(localStorage.getItem('am-zoom') || '100', 10);
    return Number.isFinite(z) ? z : 100;
  });
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.getInfo>> | null>(null);
  // Default location for the next agent = where the last one was created.
  const [lastPath, setLastPath] = useState(() => localStorage.getItem('am-last-path') || '');
  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  const rememberPath = (p?: string | null) => {
    if (p) { setLastPath(p); localStorage.setItem('am-last-path', p); }
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('am-theme', theme);
  }, [theme]);

  // Refresh info while locked so flipping the Space to Private unlocks the UI
  // without a manual reload (the server re-checks visibility every minute).
  useEffect(() => {
    api.getInfo().then(setInfo).catch(() => {});
    if (!info?.locked) return;
    const t = setInterval(() => api.getInfo().then(setInfo).catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, [info?.locked]);
  useEffect(() => { localStorage.setItem('am-zoom', String(zoom)); }, [zoom]);

  const refresh = useCallback(async () => {
    try { setTree(await api.getTree()); } catch { /* offline */ }
  }, []);

  useEffect(() => {
    api.getClis().then(setClis).catch(() => {});
    refresh();
    // Skip polling while the tab is hidden; catch up immediately on return.
    const t = setInterval(() => { if (!document.hidden) refresh(); }, 2500);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh]);

  const cliMap = useMemo(() => Object.fromEntries(clis.map((c) => [c.id, c])), [clis]);
  const sessById = useMemo(() => Object.fromEntries(tree.sessions.map((s) => [s.id, s])), [tree.sessions]);
  const groupById = useMemo(() => Object.fromEntries(tree.groups.map((g) => [g.id, g])), [tree.groups]);

  // Keep a valid selection.
  useEffect(() => {
    const ok = activeRef && (activeRef.startsWith('g:') ? groupById[activeRef.slice(2)] : sessById[activeRef.slice(2)]);
    if (!ok) setActiveRef(tree.order[0] ?? null);
  }, [tree.order, groupById, sessById, activeRef]);

  const activeGroup = activeRef?.startsWith('g:') ? groupById[activeRef.slice(2)] : null;
  const activeSingle = activeRef?.startsWith('s:') ? sessById[activeRef.slice(2)] : null;
  const groupSessions = useMemo(
    () => (activeGroup ? activeGroup.sessionIds.map((id) => sessById[id]).filter(Boolean) as Session[] : []),
    [activeGroup, sessById],
  );
  const visibleSessions = activeGroup ? groupSessions : activeSingle ? [activeSingle] : [];
  const visibleIds = visibleSessions.map((s) => s.id).join(',');
  const showZoom = visibleSessions.length > 0;

  // Keep a focused pane within the visible set.
  useEffect(() => {
    const ids = visibleIds ? visibleIds.split(',') : [];
    if (!focusedId || !ids.includes(focusedId)) setFocusedId(ids[0] ?? null);
  }, [visibleIds, focusedId]);

  // actions
  const newSession = async (name: string, cli: string, path: string) => {
    const s = await api.createSession(name, cli, activeGroup?.id, path);
    rememberPath(s.path);
    await refresh();
    setActiveRef(`s:${s.id}`);
  };
  const newGroup = async (name: string, cart?: { cli: string; count: number }[], path = '') => {
    const g = await api.createGroup(name);
    for (const { cli, count } of cart || []) {
      const base = cliMap[cli]?.label || cli;
      for (let i = 0; i < count; i++) {
        const s = await api.createSession(count > 1 ? `${base} ${i + 1}` : base, cli, g.id, path);
        rememberPath(s.path);
      }
    }
    await refresh();
    setActiveRef(`g:${g.id}`);
  };
  const doMove = async (ref: string, to: MoveTarget) => { await api.move(ref, to); refresh(); };
  const renameGroup = async (id: string, name: string) => { await api.renameGroup(id, name); refresh(); };
  const renameSession = async (id: string, name: string) => { if (name.trim()) await api.renameSession(id, name.trim()); refresh(); };
  const deleteGroup = async (id: string) => { await api.deleteGroup(id); if (activeRef === `g:${id}`) setActiveRef(null); refresh(); };
  const stopSession = async (id: string) => { await api.stopSession(id); refresh(); };
  const deleteSession = async (id: string) => { await api.deleteSession(id); if (activeRef === `s:${id}`) setActiveRef(null); refresh(); };
  // Clicking a session: nested → open its group with that pane focused; loose → solo view.
  const openSession = (sid: string, groupId?: string) => {
    if (groupId) { setActiveRef(`g:${groupId}`); setFocusedId(sid); }
    else setActiveRef(`s:${sid}`);
  };
  const closePane = (sid: string) => {
    if (activeGroup) doMove(`s:${sid}`, { kind: 'after', ref: activeRef! });
    else setActiveRef(null);
  };

  const allowDrop = (e: React.DragEvent) => { e.preventDefault(); setDropMain(true); };
  const onDropMain = (e: React.DragEvent) => {
    e.preventDefault();
    const ref = e.dataTransfer.getData('text/plain');
    if (ref?.startsWith('s:') && activeGroup) doMove(ref, { kind: 'into', groupId: activeGroup.id });
    setDropMain(false);
  };

  const renderTiles = (sessions: Session[]) => (
    <div
      className={`tiles${dropMain ? ' drop-over' : ''}`}
      style={{ gridTemplateColumns: sessions.length <= 1 ? '1fr' : '1fr 1fr' }}
      onDragOver={activeGroup ? allowDrop : undefined}
      onDragLeave={() => setDropMain(false)}
      onDrop={activeGroup ? onDropMain : undefined}
    >
      {sessions.map((s) => (s.cli === 'files' ? (
        <FilesPane
          key={s.id}
          session={s}
          zoom={zoom}
          focused={sessions.length > 1 && s.id === focusedId}
          onFocus={() => setFocusedId(s.id)}
          onClose={() => closePane(s.id)}
        />
      ) : (
        <TerminalPane
          key={s.id}
          session={s}
          cli={cliMap[s.cli]}
          theme={theme}
          zoom={zoom}
          focused={sessions.length > 1 && s.id === focusedId}
          active={s.id === focusedId}
          onFocus={() => setFocusedId(s.id)}
          onRename={(name) => renameSession(s.id, name)}
          onClose={() => closePane(s.id)}
        />
      )))}
    </div>
  );

  if (info?.locked) return <Locked spaceId={info.spaceId} />;

  if (settingsOpen) {
    return (
      <SettingsView
        page={settingsPage}
        onPage={setSettingsPage}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        onToggleTheme={toggleTheme}
        clis={clis}
        info={info}
      />
    );
  }

  return (
    <div className="app">
      <Sidebar
        clis={clis}
        tree={tree}
        activeRef={activeRef}
        focusedId={focusedId}
        defaultPath={lastPath}
        onActivate={setActiveRef}
        onOpenSession={openSession}
        onNewSession={newSession}
        onNewGroup={newGroup}
        onRenameGroup={renameGroup}
        onRenameSession={renameSession}
        onDeleteGroup={deleteGroup}
        onStopSession={stopSession}
        onDeleteSession={deleteSession}
        onMove={doMove}
        onOpenSettings={() => setSettingsOpen(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <div className="main">
        <div className="stage">
          {activeGroup ? (
            groupSessions.length === 0 ? (
              <div
                className={`empty-group${dropMain ? ' drop-over' : ''}`}
                onDragOver={allowDrop}
                onDragLeave={() => setDropMain(false)}
                onDrop={onDropMain}
              >
                <div className="empty-card">
                  <h2>{activeGroup.name}</h2>
                  <p>Create an agent here, or drag one in from the sidebar.</p>
                  <NewSession clis={clis} sessions={tree.sessions} defaultPath={lastPath} onCreate={newSession} />
                  <div className="dropline">⤓ drop an agent to add it to this group</div>
                </div>
              </div>
            ) : renderTiles(groupSessions)
          ) : activeSingle ? (
            renderTiles([activeSingle])
          ) : (
            <div className="empty-group">
              <div className="empty-card">
                <h2>Welcome to Agent Manager</h2>
                <p>Add an agent or a group from the sidebar. Drag an agent onto another to group them.</p>
              </div>
            </div>
          )}
        </div>
        {showZoom && (
          <div className="zoombar">
            <span className="spacer" />
            <button className="zbtn" title="Zoom out" onClick={() => setZoom((z) => Math.max(50, z - 10))}>−</button>
            <button className="zlvl" title="Reset to 100%" onClick={() => setZoom(100)}>{zoom}%</button>
            <button className="zbtn" title="Zoom in" onClick={() => setZoom((z) => Math.min(200, z + 10))}>+</button>
          </div>
        )}
      </div>
    </div>
  );
}
