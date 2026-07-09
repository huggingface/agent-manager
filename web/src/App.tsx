import { useCallback, useEffect, useMemo, useState } from 'react';
import Sidebar from './components/Sidebar';
import TerminalPane from './components/TerminalPane';
import FilesPane from './components/FilesPane';
import SettingsView from './components/SettingsView';
import NewSession from './components/NewSession';
import LayoutPicker from './components/LayoutPicker';
import Logo from './components/Logo';
import Overview from './components/Overview';
import Locked from './components/Locked';
import Welcome from './components/Welcome';
import * as api from './api';
import type { Cli, GridSpec, MoveTarget, OverviewFilter, Session, Tree } from './types';

// Phone-sized viewport: the app becomes two full-screen views (list ⇄ pane).
function useIsMobile() {
  const [m, setM] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)');
    const h = (e: MediaQueryListEvent) => setM(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return m;
}

// Auto layout: the grid grows to fit however many agents the group has.
function autoGrid(n: number): GridSpec {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  return { cols: 3, rows: 3 };
}

type SettingsPage = 'general' | 'usage' | 'skills';
const ROOT_PATH = '.';
const normalizePath = (p?: string | null) => (p && p.trim() ? p : ROOT_PATH);

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
  // First-run welcome: null until /api/info loads; true when reopened manually.
  const [showWelcome, setShowWelcome] = useState(false);
  // Transient error toast for failed mutations (create/delete/move/…).
  const [toast, setToast] = useState<string | null>(null);
  const showErr = (msg: string) => (e: unknown) => { console.error(msg, e); setToast(msg); window.setTimeout(() => setToast(null), 4000); };
  const [zoom, setZoom] = useState<number>(() => {
    const z = parseInt(localStorage.getItem('am-zoom') || '100', 10);
    return Number.isFinite(z) ? z : 100;
  });
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.getInfo>> | null>(null);
  // Default location for the next agent = where the last one was created,
  // falling back to the workspaces root.
  const [lastPath, setLastPath] = useState(() => normalizePath(localStorage.getItem('am-last-path')));
  // Mobile navigation: false = the sidebar is the (full-screen) home view,
  // true = the selected session/group fills the screen. Desktop ignores this.
  const isMobile = useIsMobile();
  const [mobileStage, setMobileStage] = useState(false);
  const [ovFilter, setOvFilter] = useState<OverviewFilter>('all');
  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  const rememberPath = (p?: string | null) => {
    const next = normalizePath(p);
    setLastPath(next);
    localStorage.setItem('am-last-path', next);
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

  // Show the first-run welcome once /api/info reports it hasn't been seen.
  useEffect(() => {
    if (info && !info.locked && info.welcomeSeen === false) setShowWelcome(true);
  }, [info?.welcomeSeen, info?.locked]);
  const dismissWelcome = () => {
    setShowWelcome(false);
    setInfo((i) => (i ? { ...i, welcomeSeen: true } : i));
    api.dismissWelcome().catch(() => {});
  };
  const openWelcome = () => { setSettingsOpen(false); setShowWelcome(true); };

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

  // Last-activity ages for the sidebar clock column (from the trace digests;
  // low-frequency — the Overview does its own faster polling when open).
  const [ages, setAges] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    const load = () => api.getMeta()
      .then((r) => {
        if (!alive) return;
        setAges(Object.fromEntries(r.sessions.map((s) => [
          s.id, Math.max(s.digest?.lastAssistantTs || 0, s.digest?.lastPromptTs || 0),
        ])));
      })
      .catch(() => {});
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 20_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const cliMap = useMemo(() => Object.fromEntries(clis.map((c) => [c.id, c])), [clis]);
  const sessById = useMemo(() => Object.fromEntries(tree.sessions.map((s) => [s.id, s])), [tree.sessions]);
  const groupById = useMemo(() => Object.fromEntries(tree.groups.map((g) => [g.id, g])), [tree.groups]);

  // Keep a valid selection ('overview' is always valid).
  useEffect(() => {
    const ok = activeRef && (activeRef === 'overview'
      || (activeRef.startsWith('g:') ? groupById[activeRef.slice(2)] : sessById[activeRef.slice(2)]));
    if (!ok) setActiveRef(tree.order[0] ?? null);
  }, [tree.order, groupById, sessById, activeRef]);

  const activeGroup = activeRef?.startsWith('g:') ? groupById[activeRef.slice(2)] : null;
  const activeSingle = activeRef?.startsWith('s:') ? sessById[activeRef.slice(2)] : null;
  const groupSessions = useMemo(
    () => (activeGroup ? activeGroup.sessionIds.map((id) => sessById[id]).filter(Boolean) as Session[] : []),
    [activeGroup, sessById],
  );

  // Tile grid for the active group: the chosen layout, or auto (fit the count).
  // On mobile it's always a single pane — the chip strip switches between them.
  const grid: GridSpec = activeGroup && !isMobile ? (activeGroup.layout ?? autoGrid(groupSessions.length)) : { cols: 1, rows: 1 };
  const cap = grid.cols * grid.rows;
  const pageCount = Math.max(1, Math.ceil(groupSessions.length / cap));
  // Page resets happen explicitly in the navigation handlers (an effect on
  // activeRef would clobber openSession's "land on this agent's pane").
  const [pageRaw, setPage] = useState(0);
  const page = Math.min(pageRaw, pageCount - 1); // clamp when agents/layout change
  const pageSessions = activeGroup ? groupSessions.slice(page * cap, (page + 1) * cap) : [];

  const visibleSessions = activeGroup ? pageSessions : activeSingle ? [activeSingle] : [];
  const visibleIds = visibleSessions.map((s) => s.id).join(',');
  const showZoom = visibleSessions.length > 0;

  // Pane rearrangement (drag a pane header onto another tile).
  const [paneDrag, setPaneDrag] = useState(false);
  const [overTile, setOverTile] = useState<number | null>(null);
  // A sidebar row being dragged ("s:<id>" / "g:<id>") — the stage shows
  // per-cell drop targets for sessions instead of one big outline.
  const [sessionDrag, setSessionDrag] = useState<string | null>(null);
  const sessionDragActive = !!sessionDrag?.startsWith('s:');

  // Keep a focused pane within the visible set.
  useEffect(() => {
    const ids = visibleIds ? visibleIds.split(',') : [];
    if (!focusedId || !ids.includes(focusedId)) setFocusedId(ids[0] ?? null);
  }, [visibleIds, focusedId]);

  // actions
  const createSession = async (name: string, cli: string, path: string, groupId?: string) => {
    try {
      const s = await api.createSession(name, cli, groupId, path);
      rememberPath(s.path);
      await refresh();
      if (groupId) { setActiveRef(`g:${groupId}`); setFocusedId(s.id); }
      else setActiveRef(`s:${s.id}`);
    } catch (e) { showErr('Couldn’t create the agent')(e); }
  };
  // Creations land in an explicitly targeted group (the group's + button),
  // else the group you're currently looking at; loose otherwise.
  const newSession = (name: string, cli: string, path: string, groupId?: string) =>
    createSession(name, cli, path, groupId ?? activeGroup?.id);
  const newGroup = async (name: string, cart?: { cli: string; count: number }[], path = ROOT_PATH) => {
    try {
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
    } catch (e) { showErr('Couldn’t create the group')(e); }
  };
  const doMove = (ref: string, to: MoveTarget) => api.move(ref, to).then(refresh).catch(showErr('Couldn’t move that'));
  const renameGroup = (id: string, name: string) => api.renameGroup(id, name).then(refresh).catch(showErr('Couldn’t rename'));
  const renameSession = (id: string, name: string) => { if (name.trim()) api.renameSession(id, name.trim()).then(refresh).catch(showErr('Couldn’t rename')); };
  const deleteGroup = (id: string) => api.deleteGroup(id).then(() => { if (activeRef === `g:${id}`) setActiveRef(null); refresh(); }).catch(showErr('Couldn’t delete the group'));
  const stopSession = (id: string) => api.stopSession(id).then(refresh).catch(showErr('Couldn’t stop the agent'));
  const deleteSession = (id: string) => api.deleteSession(id).then(() => { if (activeRef === `s:${id}`) setActiveRef(null); refresh(); }).catch(showErr('Couldn’t delete the agent'));
  // Clicking a session: nested → open its group with that pane focused; loose → solo view.
  const openSession = (sid: string, groupId?: string) => {
    if (groupId) {
      setActiveRef(`g:${groupId}`);
      setFocusedId(sid);
      // Land on the page that actually contains this agent's pane.
      const g = groupById[groupId];
      const idx = g?.sessionIds.indexOf(sid) ?? -1;
      const gg = isMobile ? { cols: 1, rows: 1 } : (g?.layout ?? autoGrid(g?.sessionIds.length ?? 1));
      setPage(idx >= 0 ? Math.floor(idx / (gg.cols * gg.rows)) : 0);
    } else {
      setActiveRef(`s:${sid}`);
      setPage(0);
    }
    if (isMobile) setMobileStage(true);
  };
  const activate = (ref: string) => {
    setActiveRef(ref);
    setPage(0);
    if (isMobile) setMobileStage(true);
  };
  const closePane = (sid: string) => {
    // On mobile ✕ just returns to the list — never the desktop ungroup gesture.
    if (isMobile) { setMobileStage(false); return; }
    if (activeGroup) doMove(`s:${sid}`, { kind: 'after', ref: activeRef! });
    else setActiveRef(null);
  };
  const setLayout = async (l: GridSpec | null) => {
    if (!activeGroup) return;
    await api.updateGroup(activeGroup.id, { layout: l });
    refresh();
  };
  // Drop pane `paneId` on the tile showing position `targetIdx` (absolute index
  // into the group's order): occupied tile → swap places; empty tile → move to
  // the end.
  const movePane = async (paneId: string, targetIdx: number) => {
    if (!activeGroup) return;
    const ids = activeGroup.sessionIds.slice();
    const from = ids.indexOf(paneId);
    if (from < 0) return;
    const target = groupSessions[targetIdx];
    if (target && target.id !== paneId) {
      const ti = ids.indexOf(target.id);
      ids[from] = ids[ti];
      ids[ti] = paneId;
    } else if (!target) {
      ids.splice(from, 1);
      ids.push(paneId);
    } else return;
    await api.updateGroup(activeGroup.id, { sessionIds: ids });
    refresh();
  };

  const promptUser = info?.spaceId?.split('/')[0] || 'you';
  // Empty states speak the app's native language: a prompt, waiting.
  const EmptyPrompt = ({ path, hints }: { path: string; hints: string[] }) => (
    <div className="empty-term">
      <div className="et-prompt mono">
        <span className="et-user">{promptUser}</span>
        <span className="et-dim">/</span>
        <span className="et-path">{path}</span>
        <span className="et-dim"> $</span>
        <span className="et-cursor" />
      </div>
      {hints.map((h) => <p key={h} className="et-hint">{h}</p>)}
    </div>
  );

  const allowDrop = (e: React.DragEvent) => { if (paneDrag) return; e.preventDefault(); setDropMain(true); };
  const onDropMain = (e: React.DragEvent) => {
    e.preventDefault();
    const ref = e.dataTransfer.getData('text/plain');
    if (ref?.startsWith('s:') && activeGroup) doMove(ref, { kind: 'into', groupId: activeGroup.id });
    setDropMain(false);
  };

  // One grid cell. Empty cells become visible drop targets while a pane drags
  // (rearrange) or a sidebar session drags over the group (join at that spot).
  const tileDnd = (i: number, occupied: boolean) => ({
    onDragOver: (e: React.DragEvent) => {
      if (paneDrag || (sessionDragActive && !occupied)) { e.preventDefault(); e.stopPropagation(); setOverTile(i); }
    },
    onDragLeave: () => setOverTile((t) => (t === i ? null : t)),
    onDrop: (e: React.DragEvent) => {
      const d = e.dataTransfer.getData('text/plain');
      if (d.startsWith('p:')) { e.preventDefault(); e.stopPropagation(); movePane(d.slice(2), page * cap + i); }
      else if (d.startsWith('s:') && activeGroup) { e.preventDefault(); e.stopPropagation(); doMove(d, { kind: 'into', groupId: activeGroup.id }); }
      setOverTile(null);
    },
  });

  const renderTiles = (sessions: Session[], g: GridSpec) => {
    const slotCount = activeGroup ? g.cols * g.rows : sessions.length;
    const slots = Array.from({ length: slotCount }, (_, i) => sessions[i] ?? null);
    const canDrag = !!activeGroup && groupSessions.length > 1;
    // A sidebar session hovering a full grid still needs somewhere to land:
    // offer a ghost strip appended below the tiles.
    const ghost = sessionDragActive && !!activeGroup;
    return (
      <div
        className={`tiles${paneDrag ? ' pane-dragging' : ''}${sessionDragActive && activeGroup ? ' session-dragging' : ''}`}
        style={{ gridTemplateColumns: `repeat(${g.cols}, 1fr)`, gridTemplateRows: `repeat(${g.rows}, minmax(0, 1fr))` }}
        onDragOver={activeGroup ? allowDrop : undefined}
        onDragLeave={() => setDropMain(false)}
        onDrop={activeGroup ? onDropMain : undefined}
      >
        {slots.map((s, i) => (
          <div
            key={s ? s.id : `empty-${i}`}
            className={`tile${s ? '' : ' tile-empty'}${(paneDrag || sessionDragActive) && overTile === i ? ' tile-over' : ''}`}
            {...(activeGroup ? tileDnd(i, !!s) : {})}
          >
            {s && (s.cli === 'files' ? (
              <FilesPane
                session={s}
                zoom={zoom}
                focused={visibleSessions.length > 1 && s.id === focusedId}
                dragId={canDrag ? `p:${s.id}` : undefined}
                onDragActive={setPaneDrag}
                onFocus={() => setFocusedId(s.id)}
                onClose={() => closePane(s.id)}
              />
            ) : (
              <TerminalPane
                session={s}
                cli={cliMap[s.cli]}
                theme={theme}
                zoom={zoom}
                focused={visibleSessions.length > 1 && s.id === focusedId}
                active={s.id === focusedId}
                dragId={canDrag ? `p:${s.id}` : undefined}
                onDragActive={setPaneDrag}
                onFocus={() => setFocusedId(s.id)}
                onRename={(name) => renameSession(s.id, name)}
                onClose={() => closePane(s.id)}
              />
            ))}
          </div>
        ))}
        {ghost && (
          <div
            className={`tile tile-ghost${overTile === slots.length ? ' tile-over' : ''}`}
            {...tileDnd(slots.length, false)}
          >
            drop to add to {activeGroup!.name}
          </div>
        )}
      </div>
    );
  };

  if (info?.locked) return <Locked spaceId={info.spaceId} reason={info.lockReason} bucket={info.lockBucket} />;

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
        onShowWelcome={openWelcome}
      />
    );
  }

  return (
    <div className={`app${isMobile ? (mobileStage ? ' m-stage' : ' m-home') : ''}`}>
      {showWelcome && <Welcome onClose={dismissWelcome} />}
      {toast && <div className="toast mono" role="alert">{toast}</div>}
      <Sidebar
        clis={clis}
        tree={tree}
        activeRef={activeRef}
        focusedId={focusedId}
        defaultPath={lastPath}
        ages={ages}
        onActivate={activate}
        onOpenSession={openSession}
        onNewSession={newSession}
        onNewGroup={newGroup}
        onRenameGroup={renameGroup}
        onRenameSession={renameSession}
        onDeleteGroup={deleteGroup}
        onStopSession={stopSession}
        onDeleteSession={deleteSession}
        onMove={doMove}
        onDragState={setSessionDrag}
        onOpenSettings={() => setSettingsOpen(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <div className="main">
        {isMobile && mobileStage && (
          <div className="mbar">
            <button className="icon-btn mback" onClick={() => setMobileStage(false)} title="Back to list">‹</button>
            {activeGroup ? (
              <div className="mchips">
                {groupSessions.map((s, i) => (
                  <button key={s.id} className={`mchip${i === page ? ' on' : ''}`} title={s.name} onClick={() => setPage(i)}>
                    <Logo cli={s.cli} size={13} tint={cliMap[s.cli]?.color} />
                    <span className={`status ${s.state}`} />
                  </button>
                ))}
              </div>
            ) : (
              <span className="mtitle mono">{activeRef === 'overview' ? 'Overview' : activeSingle?.name}</span>
            )}
          </div>
        )}
        <div className="stage">
          {activeRef === 'overview' ? (
            <Overview
              clis={clis}
              tree={tree}
              filter={ovFilter}
              onOpen={(sid) => {
                const g = tree.groups.find((x) => x.sessionIds.includes(sid));
                openSession(sid, g?.id);
              }}
            />
          ) : activeGroup ? (
            groupSessions.length === 0 ? (
              <div
                className={`empty-group${dropMain ? ' drop-over' : ''}`}
                onDragOver={allowDrop}
                onDragLeave={() => setDropMain(false)}
                onDrop={onDropMain}
              >
                <div className="empty-card">
                  <EmptyPrompt path={activeGroup.name} hints={['create an agent here, or drag one in from the sidebar']} />
                  <NewSession clis={clis} sessions={tree.sessions} defaultPath={lastPath} onCreate={newSession} />
                  <div className="dropline">drop an agent here to add it to this group</div>
                </div>
              </div>
            ) : renderTiles(pageSessions, grid)
          ) : activeSingle ? (
            renderTiles([activeSingle], { cols: 1, rows: 1 })
          ) : (
            <div className="empty-group">
              <EmptyPrompt
                path="workspaces"
                hints={['create an agent or a group from the sidebar', 'drag an agent onto another to group them']}
              />
            </div>
          )}
        </div>
        {activeRef === 'overview' && (
          <div className="zoombar">
            <div className="seg ov-seg">
              {(['all', 'waiting', 'working', 'quiet'] as OverviewFilter[]).map((f) => (
                <button key={f} className={ovFilter === f ? 'on' : ''} onClick={() => setOvFilter(f)}>
                  {f === 'waiting' ? 'your turn' : f}
                </button>
              ))}
            </div>
            <span className="spacer" />
          </div>
        )}
        {showZoom && (
          <div className="zoombar">
            {!isMobile && activeGroup && groupSessions.length > 0 && (
              <LayoutPicker grid={grid} isAuto={!activeGroup.layout} onPick={setLayout} />
            )}
            {!isMobile && activeGroup && pageCount > 1 && (
              <span className="pager">
                <button className="zbtn" title="Previous panes" disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
                <span className="plbl mono">{page + 1}/{pageCount}</span>
                <button className="zbtn" title="Next panes" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>›</button>
              </span>
            )}
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
