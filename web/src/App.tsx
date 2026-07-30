import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar';
import TerminalPane from './components/TerminalPane';
import FilesPane from './components/FilesPane';
import TracePane from './components/TracePane';
import RemotePane from './components/RemotePane';
import SettingsView from './components/SettingsView';
import NewSession from './components/NewSession';
import LayoutPicker from './components/LayoutPicker';
import ShareDialog from './components/ShareDialog';
import Logo from './components/Logo';
import Overview from './components/Overview';
import Locked from './components/Locked';
import Welcome from './components/Welcome';
import * as api from './api';
import type { Cli, GridSpec, MoveTarget, OverviewFilter, Session, Tree } from './types';
import { isPassive } from './types';
import { GridGlyph, ListGlyph } from './components/icons';

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
  // Session id whose share dialog is open (null = closed).
  const [shareId, setShareId] = useState<string | null>(null);
  // Imported traces already live on the Hub; sharing them means handing on
  // their original dataset link, not publishing a duplicate dataset.
  const [traceShare, setTraceShare] = useState<{ title: string; url: string } | null>(null);
  const showErr = (msg: string) => (e: unknown) => { console.error(msg, e); setToast(msg); window.setTimeout(() => setToast(null), 4000); };
  // Overview presentation: tiles (default) or the classic list.
  const [ovView, setOvViewRaw] = useState<'tiles' | 'list'>(() =>
    (localStorage.getItem('am-ov-view') === 'list' ? 'list' : 'tiles'));
  const setOvView = (v: 'tiles' | 'list') => { setOvViewRaw(v); localStorage.setItem('am-ov-view', v); };
  // Archiving: sessions quiet for longer than the configured window are hidden
  // from the sidebar and overview unless "archived" is checked. Derived, never
  // stored — flipping the setting instantly (un)archives.
  const [showArchived, setShowArchived] = useState(false);
  const [archiveAfter, setArchiveAfter] = useState<'week' | 'month' | 'never'>('month');
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

  // Track the visual viewport so the mobile layout can sit above the on-screen
  // keyboard (which shrinks visualViewport but not the layout viewport on iOS).
  // --vvh drives the mobile app height (see styles.css).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => { vv.removeEventListener('resize', apply); vv.removeEventListener('scroll', apply); };
  }, []);

  // Refresh info while locked so flipping the Space to Private unlocks the UI
  // without a manual reload (the server re-checks visibility every minute).
  useEffect(() => {
    api.getInfo().then(setInfo).catch(() => {});
    if (!info?.locked) return;
    const t = setInterval(() => api.getInfo().then(setInfo).catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, [info?.locked]);
  useEffect(() => { localStorage.setItem('am-zoom', String(zoom)); }, [zoom]);

  // Show the welcome once, when /api/info first loads: on first run (never seen)
  // or whenever demo mode is active (so the Space reads like a fresh install).
  // Fires once so dismissing it during a demo doesn't make it re-pop.
  const welcomeBoot = useRef(false);
  useEffect(() => {
    if (!info || welcomeBoot.current) return;
    welcomeBoot.current = true;
    if (!info.locked && (info.welcomeSeen === false || info.demoMode)) setShowWelcome(true);
  }, [info]);
  const dismissWelcome = () => {
    setShowWelcome(false);
    setInfo((i) => (i ? { ...i, welcomeSeen: true } : i));
    api.dismissWelcome().catch(() => {});
  };
  const openWelcome = () => { setSettingsOpen(false); setShowWelcome(true); };
  // Demo mode: hide current sessions from view (nothing is deleted). Toggling
  // off restores the full sidebar. Turning it on shows the welcome; off hides it.
  const toggleDemo = async () => {
    const next = !info?.demoMode;
    try {
      const r = await api.setDemo(next);
      setInfo((i) => (i ? { ...i, demoMode: r.active } : i));
      setSettingsOpen(false);
      await refresh();
      setShowWelcome(next);
    } catch (e) { showErr('Couldn’t toggle demo mode')(e); }
  };

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

  // Live per-session digests, polled CONTINUOUSLY in the background (not only
  // while the Overview is open) so opening it is instant. Faster cadence when
  // the Overview is the active view; slow heartbeat otherwise. `ages` (sidebar
  // clock) is derived from the same fetch. Payload-diffed to avoid needless
  // re-renders.
  const [meta, setMeta] = useState<Record<string, api.MetaSession>>({});
  const [metaReady, setMetaReady] = useState(false);
  const [ages, setAges] = useState<Record<string, number>>({});
  const overviewActiveRef = useRef(false);
  overviewActiveRef.current = activeRef === 'overview';
  useEffect(() => {
    let alive = true;
    let lastPayload = '';
    const load = () => api.getMeta()
      .then((r) => {
        if (!alive) return;
        setMetaReady(true);
        const payload = JSON.stringify(r.sessions);
        if (payload === lastPayload) return;
        lastPayload = payload;
        setMeta(Object.fromEntries(r.sessions.map((s) => [s.id, s])));
        setAges(Object.fromEntries(r.sessions.map((s) => [
          s.id, Math.max(s.digest?.lastAssistantTs || 0, s.digest?.lastPromptTs || 0),
        ])));
      })
      .catch(() => {});
    load();
    // One self-scheduling timer whose delay adapts to the active view, so we
    // never tear down / recreate the loop when navigating.
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (!document.hidden) load();
      t = setTimeout(tick, overviewActiveRef.current ? 1500 : 8000);
    };
    t = setTimeout(tick, 1500);
    return () => { alive = false; clearTimeout(t); };
  }, []);

  // Archive threshold from the operator config; refresh when settings closes
  // (that's where it's edited).
  useEffect(() => {
    if (settingsOpen) return;
    api.getConfig().then((c) => setArchiveAfter(c.archive?.after ?? 'month')).catch(() => {});
  }, [settingsOpen]);
  const archivedIds = useMemo(() => {
    const out = new Set<string>();
    if (archiveAfter === 'never') return out;
    const cut = Date.now() - (archiveAfter === 'week' ? 7 : 30) * 864e5;
    for (const s of tree.sessions) {
      // Shells and passive panels have no trace clock — never archive them.
      if (s.cli === 'shell' || isPassive(s.cli) || s.state === 'working') continue;
      const last = ages[s.id] || Date.parse(s.createdAt) || 0;
      if (last && last < cut) out.add(s.id);
    }
    return out;
  }, [tree.sessions, ages, archiveAfter]);

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
  // Quickstart: server boots the agent and types the prompt; we jump straight
  // to the new pane so you watch it happen.
  const quickStart = async (cli: string, prompt: string, name = '', path = '.') => {
    try {
      const s = await api.quickStart(cli, prompt, name, path);
      rememberPath(s.path);
      await refresh();
      setActiveRef(`s:${s.id}`);
    } catch (e) { showErr('Couldn’t quickstart the agent')(e); }
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
  // A remote agent has no process: "stopped" is a closed connection, so the
  // sidebar's stop/play pair disconnects and reconnects instead.
  const setRemotePaused = (id: string, paused: boolean) =>
    api.setRemotePaused(id, paused).then(refresh).catch(showErr(paused ? 'Couldn’t disconnect' : 'Couldn’t reconnect'));
  const deleteSession = (id: string) => api.deleteSession(id).then(() => { if (activeRef === `s:${id}`) setActiveRef(null); refresh(); }).catch(showErr('Couldn’t delete the agent'));
  const shareTrace = async (id: string) => {
    const pane = sessById[id];
    if (!pane || pane.cli !== 'trace') return;
    const source = pane.traceSource;
    // A local trace is only a view over its source session. Publish that source
    // through the normal redaction/access dialog instead of duplicating it.
    if (source?.kind === 'session' && sessById[source.ref]) {
      setShareId(source.ref);
      return;
    }
    try {
      // An imported trace is already a shared Hub dataset. Re-share its
      // provenance URL instead of creating a second, disconnected copy.
      const trace = await api.getTracePage(id, 0, 1);
      const url = trace.source?.url;
      if (!url) throw new Error('this trace has no shareable source link');
      setTraceShare({ title: pane.name, url });
    } catch (e) {
      showErr('Couldn’t share the trace')(e);
    }
  };
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
  // Read an agent's own transcript in a read-only trace pane. The pane is a
  // session record like any other (so it survives reload, tiles, and drag), and
  // it's REUSED per source — clicking Trace twice reopens the same pane instead
  // of littering the sidebar with duplicates.
  const openTrace = async (sid: string) => {
    const src = sessById[sid];
    if (!src) return;
    const existing = tree.sessions.find((p) => p.cli === 'trace' && p.traceSource?.kind === 'session' && p.traceSource.ref === sid);
    if (existing) { openSession(existing.id, tree.groups.find((g) => g.sessionIds.includes(existing.id))?.id); return; }
    try {
      // '.' = the workspaces root: a trace pane reads a transcript, so it owns no
      // folder and must not create one.
      const pane = await api.createSession(`Trace: ${src.name}`, 'trace', undefined, '.');
      await api.setTraceSource(pane.id, 'session', sid);
      await refresh();
      setActiveRef(`s:${pane.id}`);
      setPage(0);
      if (isMobile) setMobileStage(true);
    } catch (e) { showErr('Couldn’t open the trace')(e); }
  };
  // Someone shared a session as a Hub dataset: pull it down, then open a pane on
  // it. Errors propagate so the sidebar can show the server's own reason inline
  // (wrong id, no access, not a share) instead of a generic toast.
  const openSharedTrace = async (repo: string) => {
    const bundle = await api.importTraceBundle(repo);
    const existing = tree.sessions.find((p) => p.cli === 'trace' && p.traceSource?.kind === 'bundle' && p.traceSource.ref === bundle.ref);
    const label = bundle.manifest?.session?.name || bundle.repo.split('/').pop() || 'shared trace';
    const pane = existing || await api.createSession(`Trace: ${label}`, 'trace', undefined, '.');
    if (!existing) await api.setTraceSource(pane.id, 'bundle', bundle.ref);
    // A reused pane may carry a name from a source it no longer points at (the
    // source can be repointed). Correct it — but never overwrite a name the user
    // chose themselves, which is any name we didn't generate.
    else if (pane.name.startsWith('Trace: ') && pane.name !== `Trace: ${label}`) {
      await api.renameSession(pane.id, `Trace: ${label}`);
    }
    await refresh();
    setActiveRef(`s:${pane.id}`);
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
            ) : s.cli === 'remote' ? (
              <RemotePane
                session={s}
                zoom={zoom}
                focused={visibleSessions.length > 1 && s.id === focusedId}
                dragId={canDrag ? `p:${s.id}` : undefined}
                onDragActive={setPaneDrag}
                onFocus={() => setFocusedId(s.id)}
                onRename={(name) => renameSession(s.id, name)}
                onClose={() => closePane(s.id)}
              />
            ) : s.cli === 'trace' ? (
              <TracePane
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
                isMobile={isMobile}
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
        demoMode={!!info?.demoMode}
        onToggleDemo={toggleDemo}
      />
    );
  }

  return (
    <div className={`app${isMobile ? (mobileStage ? ' m-stage' : ' m-home') : ''}`}>
      {showWelcome && <Welcome onClose={dismissWelcome} />}
      {toast && <div className="toast mono" role="alert">{toast}</div>}
      {shareId && sessById[shareId] && (
        <ShareDialog
          session={sessById[shareId]}
          onClose={() => { setShareId(null); refresh(); }}
        />
      )}
      {traceShare && (
        <div className="welcome-backdrop" onClick={() => setTraceShare(null)}>
          <div className="welcome-card share-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="welcome-head">
              <div>
                <h2 style={{ margin: 0, fontSize: 16 }}>Share “{traceShare.title}”</h2>
                <p className="share-sub">This imported trace already has a Hub dataset. Share its original link.</p>
              </div>
            </div>
            <div className="share-linkrow">
              <input readOnly value={traceShare.url} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn-ghost" onClick={() => {
                navigator.clipboard?.writeText(traceShare.url).then(() => {
                  setToast('Trace link copied');
                  window.setTimeout(() => setToast(null), 2400);
                }).catch(() => {});
              }}>Copy</button>
            </div>
            <div className="share-actions">
              <button className="btn-ghost" onClick={() => setTraceShare(null)}>Close</button>
              <a className="btn-primary" href={traceShare.url} target="_blank" rel="noreferrer">Open dataset</a>
            </div>
          </div>
        </div>
      )}
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
        onShareSession={setShareId}
        onShareTrace={shareTrace}
        onTraceHandover={api.getTraceLocation}
        onOpenTrace={openTrace}
        onOpenSharedTrace={openSharedTrace}
        onNewGroup={newGroup}
        onRenameGroup={renameGroup}
        onRenameSession={renameSession}
        onDeleteGroup={deleteGroup}
        onSetRemotePaused={setRemotePaused}
        onStopSession={stopSession}
        onDeleteSession={deleteSession}
        onMove={doMove}
        onDragState={setSessionDrag}
        onOpenSettings={() => setSettingsOpen(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
        onQuickStart={quickStart}
        archived={archivedIds}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived((v) => !v)}
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
              view={ovView}
              archived={archivedIds}
              showArchived={showArchived}
              meta={meta}
              metaReady={metaReady}
              isMobile={isMobile}
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
          <div className="zoombar ov-bar">
            <div className="seg ov-seg">
              {(['all', 'waiting', 'working', 'quiet'] as OverviewFilter[]).map((f) => (
                <button key={f} className={ovFilter === f ? 'on' : ''} onClick={() => setOvFilter(f)}>
                  {f === 'waiting' ? 'done' : f === 'working' ? 'running' : f === 'quiet' ? 'stopped' : 'all'}
                </button>
              ))}
            </div>
            <div className="seg ov-seg ov-viewseg">
              <button className={ovView === 'tiles' ? 'on' : ''} title="Tiles" onClick={() => setOvView('tiles')}><GridGlyph /></button>
              <button className={ovView === 'list' ? 'on' : ''} title="List" onClick={() => setOvView('list')}><ListGlyph /></button>
            </div>
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
