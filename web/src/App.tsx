import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar';
import type { QuickStartAttachmentOptions } from './components/Sidebar';
import TerminalPane from './components/TerminalPane';
import FilesPane from './components/FilesPane';
import TracePane from './components/TracePane';
import RemotePane from './components/RemotePane';
import SettingsView from './components/SettingsView';
import NewSession from './components/NewSession';
import LayoutPicker from './components/LayoutPicker';
import ShareDialog from './components/ShareDialog';
import StateLogo from './components/StateLogo';
import Overview from './components/Overview';
import Locked from './components/Locked';
import BackupBanner from './components/BackupBanner';
import Welcome from './components/Welcome';
import * as api from './api';
import type { Cli, GridSpec, MoveTarget, OverviewChip, OverviewSort, Session, Tree } from './types';
import { onPaneMode, readPaneMode, writePaneMode } from './lib/paneMode';
import { hiddenSessionIds } from './lib/overviewHidden';
import { useReaderBatch } from './lib/readerBatch';
import { paneOwnsBack } from './lib/mobileBack';
import { isPassive, isRemote, isShareable } from './types';
import { EyeGlyph, EyeOffGlyph, GridGlyph, ListGlyph, SortGlyph } from './components/icons';

// `?vvdebug=1` — a phone has no devtools, and the keyboard layout is a guess
// when the app is embedded cross-origin. Read once: it never changes mid-run,
// and lazily imported so a debug surface is not part of the shipped bundle.
const VV_DEBUG = new URLSearchParams(location.search).has('vvdebug');
const ViewportDebug = lazy(() => import('./components/ViewportDebug'));

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

type SettingsPage = 'general' | 'usage' | 'skills' | 'cron' | 'apilog';
const ROOT_PATH = '.';
const WARM_TERMINAL_LIMIT = 12;
const normalizePath = (p?: string | null) => (p && p.trim() ? p : ROOT_PATH);
// The Overview's filter chips. The label IS the chip, so there is no second
// display string that can drift from the value; the tooltips carry the rest.
// `started` is the union of the two before it, not a fifth state of its own —
// see chipBuckets in types.ts.
const OV_CHIPS: { chip: OverviewChip; title: string }[] = [
  { chip: 'all', title: 'Every agent' },
  { chip: 'done', title: 'Answered and waiting on you' },
  { chip: 'running', title: 'Working right now' },
  { chip: 'started', title: 'Anything still up — running or waiting on you' },
  { chip: 'stopped', title: 'Not running' },
];

function initialTheme(): 'light' | 'dark' {
  const stored = readStored('am-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Where you left off. A phone evicts a backgrounded tab, and the Hub embeds the
// Space in an iframe it rebuilds on every visit — so "coming back" is almost
// always a cold mount, not a resume. Without this, the restored app has no
// selection and mobile opens on the sidebar list, however deep in an agent you
// were. The URL can't carry it (the Hub controls the iframe's src), so it has
// to be storage.
//
// Storage can be denied outright — private mode, or a third-party iframe under
// cross-site tracking prevention (the Hub embeds this Space in exactly such an
// iframe). Reading it then THROWS rather than returning null, so every access in
// this file goes through these two: a raw localStorage call in a useState
// initializer took the whole app down to its error boundary — "Something broke in
// the UI" — for a preference as incidental as which zoom you last used. A
// "don't remember" fallback, never a crash, so both sides swallow.
const readStored = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};
const writeStored = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch { /* storage denied — the selection just won't survive a reload */ }
};

export default function App() {
  const [clis, setClis] = useState<Cli[]>([]);
  const [tree, setTree] = useState<Tree>({ order: [], groups: [], sessions: [], hidden: [] });
  // Restored from the last visit, then re-validated against the tree once it
  // loads (the agent may be long gone). focusedId comes back too, so a group
  // reopens on the pane you were actually reading rather than its first.
  const [activeRef, setActiveRef] = useState<string | null>(() => readStored('am-active-ref'));
  const [focusedId, setFocusedId] = useState<string | null>(() => readStored('am-focused-id'));
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
    (readStored('am-ov-view') === 'list' ? 'list' : 'tiles'));
  const setOvView = (v: 'tiles' | 'list') => { setOvViewRaw(v); writeStored('am-ov-view', v); };
  // Overview order: the tree's own arrangement (default) or ranked by a
  // timestamp. A view preference like the two above it — per browser, and it
  // survives a reload, because re-picking your order on every visit is the
  // thing that makes a sort control feel like a toy.
  const [ovSort, setOvSortRaw] = useState<OverviewSort>(() => {
    const s = readStored('am-ov-sort');
    return s === 'prompt' || s === 'answer' ? s : 'manual';
  });
  const setOvSort = (v: OverviewSort) => { setOvSortRaw(v); writeStored('am-ov-sort', v); };
  // Archiving takes two roads into the same view, and they are not the same
  // thing. The operator archives a session deliberately (`archivedAt` on the
  // record, server-side, and the agent is stopped); separately, a session quiet
  // for longer than the configured window is hidden the way it always was —
  // derived, so flipping the setting instantly (un)archives it again.
  // Both are hidden unless "archived" is checked. Only the stored one can be
  // deleted, which is why the two sets stay distinguishable below.
  const [showArchived, setShowArchived] = useState(false);
  // A trace pane asking to be continued in a new agent. The prefilled create
  // panel belongs to the sidebar, so the request is passed there and cleared
  // once it has been picked up.
  const [handoverFor, setHandoverFor] = useState<string | null>(null);
  const [archiveAfter, setArchiveAfter] = useState<'week' | 'month' | 'never'>('month');
  // Hiding a group from the Overview is a standing choice and lives on the server
  // (tree.hidden). REVEALING it is a glance, so that half stays here and resets on
  // reload — otherwise "show hidden" becomes a mode you forget you left on, and
  // hiding reads as broken.
  const [showHidden, setShowHidden] = useState(false);
  // How every pane is read — the terminal itself, or reader mode over the same
  // session. App-wide, like zoom, and remembered the same way.
  const [paneMode, setPaneMode] = useState(readPaneMode);
  // Which continuous appearance of a visible batch has let its focused reader
  // paint. The activation key below changes across page/group/hide transitions.
  const [readerReadyFor, setReaderReadyFor] = useState('');
  useEffect(() => onPaneMode(setPaneMode), []);
  const showPaneMode = (m: 'terminal' | 'reader') => { setPaneMode(m); writePaneMode(m); };
  const [zoom, setZoom] = useState<number>(() => {
    const z = parseInt(readStored('am-zoom') || '100', 10);
    return Number.isFinite(z) ? z : 100;
  });
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.getInfo>> | null>(null);
  // Default location for the next agent = where the last one was created,
  // falling back to the workspaces root.
  const [lastPath, setLastPath] = useState(() => normalizePath(readStored('am-last-path')));
  // Mobile navigation: false = the sidebar is the (full-screen) home view,
  // true = the selected session/group fills the screen. Desktop ignores this.
  const isMobile = useIsMobile();
  const [mobileStage, setMobileStage] = useState(() => readStored('am-mobile-stage') === '1');
  // Which chip the Overview's bottom bar is on. A chip is coarser than a bucket
  // (`started` = waiting or working) — see chipBuckets in types.ts. Not persisted,
  // unlike the sort beside it: "show me only the stopped ones" is a thing you do
  // for a moment, not a standing preference.
  const [ovChip, setOvChip] = useState<OverviewChip>('all');
  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  const rememberPath = (p?: string | null) => {
    const next = normalizePath(p);
    setLastPath(next);
    writeStored('am-last-path', next);
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeStored('am-theme', theme);
  }, [theme]);

  // Write the selection through on every change rather than on unload: a phone
  // killing a backgrounded tab does not reliably run unload handlers.
  useEffect(() => { writeStored('am-active-ref', activeRef); }, [activeRef]);
  useEffect(() => { writeStored('am-focused-id', focusedId); }, [focusedId]);
  useEffect(() => { writeStored('am-mobile-stage', mobileStage ? '1' : '0'); }, [mobileStage]);

  // Track the visual viewport so the mobile layout can sit above the on-screen
  // keyboard (which shrinks visualViewport but not the layout viewport on iOS).
  // The CSS variables pin the app to that viewport's exact rectangle.
  //
  // Where there is no signal — the Hub page embeds the app in a cross-origin
  // iframe, and mobile Safari leaves that child viewport unchanged when its
  // keyboard opens — the app reports the viewport it can see and stops there.
  // It does not estimate one. Nothing here knows how tall a keyboard is, and
  // the browser that does already scrolls a focused field into view.
  useEffect(() => {
    const vv = window.visualViewport;
    type VirtualKeyboardLike = EventTarget & { boundingRect?: DOMRectReadOnly };
    const keyboard = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardLike }).virtualKeyboard;
    type ViewportBaseline = {
      width: number;
      height: number;
      top: number;
      innerHeight: number;
    };
    const root = document.documentElement;
    const keyboardSignalThreshold = 80;
    // The viewport as it was before a field took focus — the only thing left
    // that needs remembering, because a keyboard is detected as the SHRINK from
    // it (hasKeyboardGeometry), not as an absolute height. Since the estimate
    // was deleted this feeds no layout at all: its one consumer is the
    // keyboardLayout label, which only ?vvdebug=1 reads.
    let focusBaseline: ViewportBaseline | null = null;

    const acceptsKeyboardInput = (target: Element | null): target is HTMLElement => {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled;
      if (!(target instanceof HTMLInputElement) || target.readOnly || target.disabled) return false;
      return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']
        .includes(target.type);
    };
    const captureViewport = (): ViewportBaseline => ({
      width: vv?.width ?? document.documentElement.clientWidth,
      height: vv?.height ?? window.innerHeight,
      top: vv?.offsetTop ?? 0,
      innerHeight: window.innerHeight,
    });
    const hasKeyboardGeometry = () => {
      if (!focusBaseline) return false;
      const keyboardHeight = keyboard?.boundingRect?.height ?? 0;
      const visualHeight = vv?.height ?? window.innerHeight;
      const visualShrink = focusBaseline.height - visualHeight;
      const layoutShrink = focusBaseline.innerHeight - window.innerHeight;
      return keyboardHeight >= keyboardSignalThreshold
        || visualShrink >= keyboardSignalThreshold
        || layoutShrink >= keyboardSignalThreshold;
    };
    const apply = () => {
      const keyboardRect = keyboard?.boundingRect;
      const left = vv?.offsetLeft ?? 0;
      const top = vv?.offsetTop ?? 0;
      const width = vv?.width ?? document.documentElement.clientWidth;
      let height = vv?.height ?? window.innerHeight;
      // Chromium can expose keyboard geometry even when an embedded document's
      // visual viewport is unchanged. Never grow the visual viewport from it;
      // only clip an actually overlapping keyboard.
      if (keyboardRect && keyboardRect.height > 0 && keyboardRect.top > top) {
        height = Math.min(height, keyboardRect.top - top);
      }
      // When the browser reports no keyboard geometry — a cross-origin frame on
      // mobile Safari, which the Hub page is — the app does NOT invent a height.
      // It used to assume a keyboard ate 46% and shrink to fit, and a guess that
      // is wrong in the safe direction is still wrong: the abandoned strip does
      // not stay hidden behind the keyboard, because the browser scroll-reveals
      // a focused field and drags it back into view. That strip is the blank
      // band under the reader's composer.
      //
      // What replaces it is the PARENT page's scroll, not ours: measured at
      // 390x844, every box in this document — html, body, #root, .app, .main,
      // .term-host, .pane-reader, .cxv — has a scroll range of exactly 0, so a
      // scroll-into-view in here moves nothing. The reveal is entirely the
      // embedder's, and this document's job is to not fight it by resizing
      // itself against a keyboard it cannot see.
      //
      // Nothing below sizes anything: with the estimate gone, keyboardLayout is
      // a label for ?vvdebug=1 to read. No CSS matches it.
      if (hasKeyboardGeometry()) root.dataset.keyboardLayout = 'browser-geometry';
      else delete root.dataset.keyboardLayout;
      root.style.setProperty('--vvw', `${Math.round(width)}px`);
      root.style.setProperty('--vvh', `${Math.round(height)}px`);
      root.style.setProperty('--vv-top', `${Math.round(top)}px`);
      root.style.setProperty('--vv-left', `${Math.round(left)}px`);
    };

    // WebKit may dispatch the keyboard viewport event before offsetTop has its
    // final value, then correct the property without another event. Re-read at
    // the end of the event turn and while the focus animation settles.
    const settleTimers = new Set<ReturnType<typeof setTimeout>>();
    const focusTimers = new Set<ReturnType<typeof setTimeout>>();
    const onViewportChange = () => {
      apply();
      for (const timer of settleTimers) clearTimeout(timer);
      settleTimers.clear();
      // One delayed read is still racy: WebKit can update offsetTop immediately
      // after it fires. Sample the short animation tail without depending on a
      // second browser event.
      for (const delay of [50, 150, 300, 500]) {
        const timer = setTimeout(() => { settleTimers.delete(timer); apply(); }, delay);
        settleTimers.add(timer);
      }
    };
    const stabilizeFocus = () => {
      for (const timer of focusTimers) clearTimeout(timer);
      focusTimers.clear();
      for (const delay of [0, 50, 150, 300, 500, 800]) {
        const timer = setTimeout(() => { focusTimers.delete(timer); apply(); }, delay);
        focusTimers.add(timer);
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      // Only when there is no baseline yet: tapping from one field straight to
      // another keeps the keyboard up, and re-reading here would take the
      // shrunk viewport as the "before" — after which the shrink measures zero
      // and a keyboard that is plainly up reads as absent. focusout clears it
      // when focus really leaves, so this stays fresh without being re-taken.
      if (acceptsKeyboardInput(target) && !focusBaseline) focusBaseline = captureViewport();
      stabilizeFocus();
    };
    const onFocusOut = () => {
      const timer = setTimeout(() => {
        focusTimers.delete(timer);
        if (!acceptsKeyboardInput(document.activeElement)) {
          focusBaseline = null;
          apply();
        }
      }, 0);
      focusTimers.add(timer);
    };
    const onOrientationChange = () => {
      if (acceptsKeyboardInput(document.activeElement)) focusBaseline = captureViewport();
      stabilizeFocus();
    };
    apply();
    vv?.addEventListener('resize', onViewportChange);
    vv?.addEventListener('scroll', onViewportChange);
    vv?.addEventListener('scrollend', onViewportChange);
    keyboard?.addEventListener('geometrychange', onViewportChange);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onOrientationChange);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      for (const timer of settleTimers) clearTimeout(timer);
      for (const timer of focusTimers) clearTimeout(timer);
      vv?.removeEventListener('resize', onViewportChange);
      vv?.removeEventListener('scroll', onViewportChange);
      vv?.removeEventListener('scrollend', onViewportChange);
      keyboard?.removeEventListener('geometrychange', onViewportChange);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('orientationchange', onOrientationChange);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      root.style.removeProperty('--vvw');
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--vv-top');
      root.style.removeProperty('--vv-left');
      delete root.dataset.keyboardLayout;
    };
  }, []);

  // Refresh info while locked so flipping the Space to Private unlocks the UI
  // without a manual reload (the server re-checks visibility every minute).
  useEffect(() => {
    api.getInfo().then(setInfo).catch(() => {});
    if (!info?.locked) return;
    const t = setInterval(() => api.getInfo().then(setInfo).catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, [info?.locked]);
  useEffect(() => { writeStored('am-zoom', String(zoom)); }, [zoom]);

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

  // treeLoaded gates the selection check below: until the first tree actually
  // arrives, "your agent isn't in this tree" only means the tree is still empty.
  const [treeLoaded, setTreeLoaded] = useState(false);
  const refresh = useCallback(async () => {
    try { setTree(await api.getTree()); setTreeLoaded(true); } catch { /* offline */ }
  }, []);

  // Hide/unhide a group (or one agent) in the Overview. Optimistic, because the
  // tree poll is up to 2.5s away and a control that does nothing for two seconds
  // reads as broken; the server's own list replaces this on the next poll.
  const toggleOverviewHidden = (ref: string, hide: boolean) => {
    setTree((t) => {
      const next = new Set(t.hidden);
      if (hide) next.add(ref); else next.delete(ref);
      return { ...t, hidden: [...next] };
    });
    api.setOverviewHidden(ref, hide).then(refresh).catch(showErr('could not change what the overview shows'));
  };

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
  // Road one: the operator said so. The server holds it, so it survives a
  // reload and means the same thing on every device.
  const retiredIds = useMemo(
    () => new Set(tree.sessions.filter((s) => s.archivedAt).map((s) => s.id)),
    [tree.sessions],
  );
  // Road two: quiet for longer than the window. Unchanged, and still derived —
  // it is a statement about the clock, so it has to be recomputed against the
  // clock rather than written down once.
  const quietIds = useMemo(() => {
    const out = new Set<string>();
    if (archiveAfter === 'never') return out;
    const cut = Date.now() - (archiveAfter === 'week' ? 7 : 30) * 864e5;
    for (const s of tree.sessions) {
      // Shells and passive panels have no trace clock — never archive them.
      if (s.cli === 'shell' || isPassive(s.cli) || s.state === 'working') continue;
      if (s.archivedAt) continue;                       // already on road one
      const last = ages[s.id] || Date.parse(s.createdAt) || 0;
      if (last && last < cut) out.add(s.id);
    }
    return out;
  }, [tree.sessions, ages, archiveAfter]);
  // What the sidebar and overview leave out of the working list.
  const archivedIds = useMemo(
    () => new Set([...retiredIds, ...quietIds]),
    [retiredIds, quietIds],
  );

  // What the operator hid from the Overview, as refs (`g:<id>` / `s:<id>`). The
  // server owns the list; this is just the shape the sidebar wants for a lookup.
  const hiddenRefs = useMemo(() => new Set(tree.hidden), [tree.hidden]);
  // The bar's button counts AGENTS, not refs: "1 hidden" for a six-agent group
  // would understate what is missing from the feed.
  const hiddenCount = useMemo(() => hiddenSessionIds(tree).size, [tree]);

  const cliMap = useMemo(() => Object.fromEntries(clis.map((c) => [c.id, c])), [clis]);
  const sessById = useMemo(() => Object.fromEntries(tree.sessions.map((s) => [s.id, s])), [tree.sessions]);
  const groupById = useMemo(() => Object.fromEntries(tree.groups.map((g) => [g.id, g])), [tree.groups]);
  // Which group an agent belongs to, by name — the one fact a pane header needs
  // to title itself. It rides the tree poll, so renaming a group or dragging an
  // agent into another one retitles its pane on the next refresh, with no
  // reload and nothing to keep in sync by hand.
  const groupNameOf = useMemo(() => {
    const m: Record<string, string> = {};
    for (const g of tree.groups) for (const id of g.sessionIds) m[id] = g.name;
    return m;
  }, [tree.groups]);

  // Keep a valid selection ('overview' is always valid). Waits for the first
  // tree: running against the empty initial one would discard a restored
  // selection as "missing" a beat before the agents arrive.
  useEffect(() => {
    if (!treeLoaded) return;
    const ok = activeRef && (activeRef === 'overview'
      || (activeRef.startsWith('g:') ? groupById[activeRef.slice(2)] : sessById[activeRef.slice(2)]));
    if (!ok) {
      setActiveRef('overview');
      // The remembered agent is gone (deleted, or a different Space). Land on
      // the list rather than full-screening whichever agent happens to be first.
      setMobileStage(false);
    }
  }, [tree.order, groupById, sessById, activeRef, treeLoaded]);

  const activeGroup = activeRef?.startsWith('g:') ? groupById[activeRef.slice(2)] : null;
  const activeSingle = activeRef?.startsWith('s:') ? sessById[activeRef.slice(2)] : null;
  const groupSessions = useMemo(
    () => (activeGroup ? activeGroup.sessionIds.map((id) => sessById[id]).filter(Boolean) as Session[] : []),
    [activeGroup, sessById],
  );

  // A staged agent carries its own way back, in its header left of the logo, and
  // the bar above it goes away with the row it cost. See mobileBack.ts for which
  // surfaces still need the bar and why.
  const ownsBack = paneOwnsBack({
    isMobile, staged: mobileStage, inGroup: !!activeGroup, cli: activeSingle?.cli,
  });

  // Tile grid for the active group: the chosen layout, or auto (fit the count).
  // On mobile it's always a single pane — the chip strip switches between them.
  const grid: GridSpec = activeGroup && !isMobile ? (activeGroup.layout ?? autoGrid(groupSessions.length)) : { cols: 1, rows: 1 };
  const cap = grid.cols * grid.rows;
  const pageCount = Math.max(1, Math.ceil(groupSessions.length / cap));
  // Page resets happen explicitly in the navigation handlers (an effect on
  // activeRef would clobber openSession's "land on this agent's pane").
  const [pageRaw, setPage] = useState(0);
  const page = Math.min(pageRaw, pageCount - 1); // clamp when agents/layout change
  // Restoring a group has to restore its page too: mobile shows one pane per
  // page, so the remembered pane would otherwise sit behind page 0. Fires once,
  // on the first loaded tree — a standing effect would be exactly the activeRef
  // clobber the note above warns about.
  //
  // It reads the remembered pane from a ref, NOT from focusedId, because
  // focusedId does not survive to here: "keep a focused pane within the visible
  // set" below runs on the mount commit, when the tree is still empty and the
  // visible set with it, and nulls focusedId — which the write-through then
  // erases from storage. The ref is out of that effect's reach. Restoring the
  // page puts the remembered pane in the visible set, and that same effect then
  // focuses it (on mobile the page IS the pane, so it lands exactly).
  const restoredFocus = useRef(readStored('am-focused-id'));
  const pageRestored = useRef(false);
  useEffect(() => {
    if (pageRestored.current || !treeLoaded) return;
    pageRestored.current = true;
    const want = restoredFocus.current;
    if (!activeGroup || !want) return;
    const idx = activeGroup.sessionIds.indexOf(want);
    if (idx < 0) return; // remembered a pane this group no longer has
    setPage(Math.floor(idx / cap));
    setFocusedId(want);
  }, [treeLoaded, activeGroup, cap]);
  const pageSessions = activeGroup ? groupSessions.slice(page * cap, (page + 1) * cap) : [];

  const visibleSessions = activeGroup ? pageSessions : activeSingle ? [activeSingle] : [];
  const visibleIds = visibleSessions.map((s) => s.id).join(',');
  const showZoom = visibleSessions.length > 0;

  // Keep a small working set of terminal panes alive across navigation. The
  // backend session already survives a viewer disconnect; retaining xterm and
  // its socket as well makes switching back genuinely instant and preserves the
  // exact local scroll/selection state. This is deliberately bounded: mounting
  // every session would start stopped agents and turn a large sidebar into many
  // live WebSockets and 20k-line browser buffers.
  const visibleTerminalIds = (settingsOpen || (isMobile && !mobileStage) ? [] : visibleSessions)
    .filter((s) => !isPassive(s.cli) && !isRemote(s.cli))
    .map((s) => s.id);
  const visibleTerminalKey = visibleTerminalIds.join(',');
  const readerLeadId = focusedId && visibleTerminalIds.includes(focusedId)
    ? focusedId : visibleTerminalIds[0] || null;
  // A batch is one continuous on-screen appearance, not merely a set of ids:
  // opening Settings/mobile home unmounts readers, so returning to the same ids
  // must gate them again. Focus only chooses the leader and does not change it.
  const readerBatch = useReaderBatch(paneMode === 'reader' ? visibleTerminalKey : '');
  const readerFollowersReady = readerReadyFor === readerBatch;
  const sessionIdsKey = tree.sessions.map((s) => s.id).join(',');
  const [warmTerminalIds, setWarmTerminalIds] = useState<string[]>([]);
  useEffect(() => {
    const valid = new Set(tree.sessions
      .filter((s) => !isPassive(s.cli) && !isRemote(s.cli))
      .map((s) => s.id));
    setWarmTerminalIds((previous) => {
      const next = [...visibleTerminalIds, ...previous]
        .filter((id, i, all) => valid.has(id) && all.indexOf(id) === i)
        .slice(0, Math.max(WARM_TERMINAL_LIMIT, visibleTerminalIds.length));
      return next.length === previous.length && next.every((id, i) => id === previous[i])
        ? previous : next;
    });
  // Stable string keys avoid running this state update on every tree poll.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTerminalKey, sessionIdsKey]);
  // Include newly selected panes on the navigation render itself; the effect
  // above retains them for later renders and applies the LRU bound.
  const retainedTerminalIds = [...visibleTerminalIds, ...warmTerminalIds]
    .filter((id, i, all) => !!sessById[id] && all.indexOf(id) === i)
    .slice(0, Math.max(WARM_TERMINAL_LIMIT, visibleTerminalIds.length));

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
  const prepareQuickStart = async (cli: string, name = '', path = '.') => {
    const created = await api.createSession(name, cli, undefined, path);
    rememberPath(created.path);
    await refresh();
    return created;
  };
  const abandonQuickStart = async (id: string) => {
    try {
      await api.discardUnstartedSession(id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // A target the operator deliberately opened is no longer placeholder
      // state. The conditional DELETE makes that decision atomically server-side.
      if (detail.includes('session has already started') || detail === 'not found') return;
      console.error('Couldn’t discard the unstarted agent', error);
      setToast(`Couldn’t discard the unstarted agent: ${detail}`);
      window.setTimeout(() => setToast(null), 5000);
      throw error;
    } finally {
      await refresh();
    }
  };
  const quickStart = async (cli: string, prompt: string, name = '', path = '.', attachmentOptions?: QuickStartAttachmentOptions) => {
    try {
      let sessionId: string;
      let sessionPath: string | null = path;
      if (attachmentOptions && (attachmentOptions.sessionId || attachmentOptions.attachments.length)) {
        if (attachmentOptions.sessionId) {
          sessionId = attachmentOptions.sessionId;
        } else {
          // Defensive fallback for a submit racing the target-creation render.
          // Normal attachment uploads create this stopped target immediately.
          const created = await prepareQuickStart(cli, name, path);
          sessionId = created.id;
          sessionPath = created.path;
          attachmentOptions.onSessionCreated(created.id);
        }
        if (attachmentOptions.attachments.some((attachment) => !attachment.attachment)) {
          throw new Error('Wait for every file to finish uploading, or retry/remove the failed file.');
        }
        await api.sendInput(sessionId, prompt,
          attachmentOptions.attachments.map((attachment) => attachment.attachment!.id));
      } else {
        const created = await api.quickStart(cli, prompt, name, path);
        sessionId = created.id;
        sessionPath = created.path;
      }
      rememberPath(sessionPath);
      await refresh();
      setActiveRef(`s:${sessionId}`);
    } catch (e) {
      // Quickstart owns a persistent inline recovery state (including the
      // stopped session created before an upload), so a second generic toast
      // obscures the useful error and makes one failure look like two.
      console.error('Couldn’t quickstart the agent', e);
      throw e;
    }
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
  // Merging two agents, or dropping one into a group, changes what the pane you
  // are looking at IS — it is now part of a grid. Follow it there rather than
  // leaving you on a single view of a session that has moved.
  const doMove = (ref: string, to: MoveTarget) => api.move(ref, to)
    .then(async () => {
      const next = await api.getTree().catch(() => null);
      if (!next) return refresh();
      setTree(next);
      const watching = activeRef?.startsWith('s:') ? activeRef.slice(2) : null;
      if (!watching) return undefined;
      const home = next.groups.find((g) => g.sessionIds.includes(watching));
      if (home) setActiveRef(`g:${home.id}`);
      return undefined;
    })
    .catch(showErr('Couldn’t move that'));
  const renameGroup = (id: string, name: string) => api.renameGroup(id, name).then(refresh).catch(showErr('Couldn’t rename'));
  const renameSession = (id: string, name: string) => { if (name.trim()) api.renameSession(id, name.trim()).then(refresh).catch(showErr('Couldn’t rename')); };
  const deleteGroup = (id: string) => api.deleteGroup(id).then(() => { if (activeRef === `g:${id}`) setActiveRef(null); refresh(); }).catch(showErr('Couldn’t delete the group'));
  // Archiving stops the agent server-side, so there is no separate stop call
  // left in the UI — `api.stopSession` stays for the archive route's own use
  // and for anything that needs to end a process without filing it away.
  const archiveSession = (id: string) => api.archiveSession(id)
    .then(() => { if (activeRef === `s:${id}`) setActiveRef(null); closePane(id); refresh(); })
    .catch(showErr('Couldn’t archive that agent'));
  const unarchiveSession = (id: string) => api.unarchiveSession(id).then(refresh)
    .catch(showErr('Couldn’t restore that agent'));
  // A remote agent has no process: "stopped" is a closed connection, so the
  // sidebar's stop/play pair disconnects and reconnects instead.
  const setRemotePaused = (id: string, paused: boolean) =>
    api.setRemotePaused(id, paused).then(refresh).catch(showErr(paused ? 'Couldn’t disconnect' : 'Couldn’t reconnect'));
  // The server refuses to delete anything that has not been archived, and says
  // so in words worth passing on — a generic toast here would leave the reader
  // guessing at a rule the UI is meant to be teaching.
  const deleteSession = (id: string) => api.deleteSession(id)
    .then(() => { if (activeRef === `s:${id}`) setActiveRef(null); refresh(); })
    .catch((e: unknown) => showErr(e instanceof Error && e.message ? e.message : 'Couldn’t delete the agent')(e));
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
    const slotStyle = (i: number) => ({
      gridColumn: (i % g.cols) + 1,
      gridRow: Math.floor(i / g.cols) + 1,
    });
    const slotByTerminal = new Map(slots
      .map((s, i) => [s, i] as const)
      .filter(([s]) => s && !isPassive(s.cli) && !isRemote(s.cli))
      .map(([s, i]) => [s!.id, i]));
    const deckVisible = !settingsOpen && sessions.length > 0 && (!isMobile || mobileStage);
    // A sidebar session hovering a full grid still needs somewhere to land:
    // offer a ghost strip appended below the tiles.
    const ghost = sessionDragActive && !!activeGroup;
    return (
      <div
        className={`tiles pane-deck${sessions.length ? '' : ' deck-hidden'}${paneDrag ? ' pane-dragging' : ''}${sessionDragActive && activeGroup ? ' session-dragging' : ''}`}
        style={{ gridTemplateColumns: `repeat(${g.cols}, 1fr)`, gridTemplateRows: `repeat(${g.rows}, minmax(0, 1fr))` }}
        onDragOver={activeGroup ? allowDrop : undefined}
        onDragLeave={() => setDropMain(false)}
        onDrop={activeGroup ? onDropMain : undefined}
      >
        {retainedTerminalIds.map((id) => {
          const s = sessById[id];
          if (!s) return null;
          const slot = slotByTerminal.get(id);
          const shown = slot !== undefined;
          return (
            <div
              key={`terminal-${id}`}
              className={`tile tile-terminal${shown ? '' : ' tile-cached'}`}
              style={shown ? slotStyle(slot) : undefined}
              {...(shown && activeGroup ? tileDnd(slot, true) : {})}
            >
              <TerminalPane
                session={s}
                onShare={isShareable(s.cli) ? () => setShareId(s.id) : undefined}
                cli={cliMap[s.cli]}
                theme={theme}
                zoom={zoom}
                mode={paneMode}
                readerEnabled={shown && deckVisible && (id === readerLeadId || readerFollowersReady)}
                onReaderReady={id === readerLeadId ? () => setReaderReadyFor(readerBatch) : undefined}
                readerReadyKey={readerBatch}
                groupName={groupNameOf[s.id]}
                focused={shown && sessions.length > 1 && s.id === focusedId}
                visible={shown && deckVisible}
                active={shown && deckVisible && s.id === focusedId}
                dragId={shown && canDrag ? `p:${s.id}` : undefined}
                isMobile={isMobile}
                onBack={ownsBack ? () => setMobileStage(false) : undefined}
                onDragActive={setPaneDrag}
                onFocus={() => setFocusedId(s.id)}
                onRename={(name) => renameSession(s.id, name)}
                onClose={() => closePane(s.id)}
              />
            </div>
          );
        })}
        {slots.map((s, i) => (s && !isPassive(s.cli) && !isRemote(s.cli) ? null : (
          <div
            key={s ? `passive-${s.id}` : `empty-${i}`}
            className={`tile${s ? '' : ' tile-empty'}${(paneDrag || sessionDragActive) && overTile === i ? ' tile-over' : ''}`}
            style={slotStyle(i)}
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
                groupName={groupNameOf[s.id]}
                focused={visibleSessions.length > 1 && s.id === focusedId}
                dragId={canDrag ? `p:${s.id}` : undefined}
                onBack={ownsBack ? () => setMobileStage(false) : undefined}
                onDragActive={setPaneDrag}
                onFocus={() => setFocusedId(s.id)}
                onRename={(name) => renameSession(s.id, name)}
                onClose={() => closePane(s.id)}
              />
            ) : (
              <TracePane
                session={s}
                // A trace pane follows its SOURCE session: whether that agent is
                // still writing decides how hard this pane looks for new turns.
                sourceLive={(() => {
                  const ref = s.traceSource?.kind === 'session' ? s.traceSource.ref : null;
                  return ref ? sessById[ref]?.state === 'working' : false;
                })()}
                zoom={zoom}
                focused={visibleSessions.length > 1 && s.id === focusedId}
                dragId={canDrag ? `p:${s.id}` : undefined}
                onDragActive={setPaneDrag}
                onFocus={() => setFocusedId(s.id)}
                onShare={() => shareTrace(s.id)}
                // The prefilled create panel lives in the sidebar, so the
                // request travels there rather than the panel moving here.
                onHandover={() => setHandoverFor(s.id)}
                onClose={() => closePane(s.id)}
              />
            ))}
          </div>
        )))}
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

  return (
    <>
      {settingsOpen && (
      <SettingsView
        page={settingsPage}
        onPage={setSettingsPage}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        onToggleTheme={toggleTheme}
        clis={clis}
        info={info}
        onShowWelcome={openWelcome}
        onOpenSharedTrace={openSharedTrace}
        demoMode={!!info?.demoMode}
        onToggleDemo={toggleDemo}
      />
      )}
    {/* Outside .app: it reports where .app was put. That does not make it
        immune — it is fixed too, so a displaced fixed subtree would carry it
        along — but the history it keeps still shows the displacement happening. */}
    {VV_DEBUG && <Suspense fallback={null}><ViewportDebug /></Suspense>}
    <div className={`app${settingsOpen ? ' app-suspended' : ''}${isMobile ? (mobileStage ? ' m-stage' : ' m-home') : ''}`}>
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
        onTraceHandover={api.getTraceLocation}
        handoverFor={handoverFor}
        onHandoverHandled={() => setHandoverFor(null)}
        onNewGroup={newGroup}
        onRenameGroup={renameGroup}
        onRenameSession={renameSession}
        onDeleteGroup={deleteGroup}
        onSetRemotePaused={setRemotePaused}
        onArchiveSession={archiveSession}
        onUnarchiveSession={unarchiveSession}
        onDeleteSession={deleteSession}
        onMove={doMove}
        onDragState={setSessionDrag}
        onOpenSettings={() => setSettingsOpen(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
        onQuickStart={quickStart}
        onPrepareQuickStart={prepareQuickStart}
        onAbandonQuickStart={abandonQuickStart}
        archived={archivedIds}
        retired={retiredIds}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived((v) => !v)}
        overviewHidden={hiddenRefs}
        onToggleOverviewHidden={toggleOverviewHidden}
      />

      <div className="main">
        {isMobile && mobileStage && !ownsBack && (
          <div className="mbar">
            <button className="icon-btn mback" onClick={() => setMobileStage(false)} title="Back to list">‹</button>
            {activeGroup ? (
              <div className="mchips">
                {groupSessions.map((s, i) => (
                  <button key={s.id} className={`mchip${i === page ? ' on' : ''}`} title={s.name} onClick={() => setPage(i)}>
                    <StateLogo cli={s.cli} state={s.state} size={13} tint={cliMap[s.cli]?.color} />
                  </button>
                ))}
              </div>
            ) : (
              <span className="mtitle mono">{activeRef === 'overview' ? 'Overview' : activeSingle?.name}</span>
            )}
          </div>
        )}
        {/* Visible where you already are, on every view. Rides on /api/info,
            which is polled every 15s, so no new request for the normal case. */}
        <BackupBanner health={info?.backup} onOpenSettings={() => { setSettingsPage('general'); setSettingsOpen(true); }} />
        <div className="stage">
          {renderTiles(
            isMobile && !mobileStage
              ? []
              : activeGroup && groupSessions.length > 0
              ? pageSessions
              : activeSingle ? [activeSingle] : [],
            activeGroup && groupSessions.length > 0 ? grid : { cols: 1, rows: 1 },
          )}
          {activeRef === 'overview' ? (
            <Overview
              clis={clis}
              tree={tree}
              chip={ovChip}
              sort={ovSort}
              view={ovView}
              archived={archivedIds}
              showArchived={showArchived}
              showHidden={showHidden}
              meta={meta}
              metaReady={metaReady}
              isMobile={isMobile}
              onOpen={(sid) => {
                const g = tree.groups.find((x) => x.sessionIds.includes(sid));
                openSession(sid, g?.id);
              }}
            />
          ) : activeGroup && groupSessions.length === 0 ? (
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
          ) : !activeGroup && !activeSingle ? (
            <div className="empty-group">
              <EmptyPrompt
                path="workspaces"
                hints={['create an agent or a group from the sidebar', 'drag an agent onto another to group them']}
              />
            </div>
          ) : null}
        </div>
        {activeRef === 'overview' && (
          <div className="zoombar ov-bar">
            <div className="seg ov-seg">
              {OV_CHIPS.map(({ chip, title }) => (
                <button key={chip} className={ovChip === chip ? 'on' : ''} title={title}
                  onClick={() => setOvChip(chip)}>{chip}</button>
              ))}
            </div>
            {/* Sort, independent of the filter beside it: one says WHICH agents
                you are looking at, the other WHERE each one is in the feed.
                The glyph sits OUTSIDE the segment: inside it read as a fourth,
                permanently-disabled option. */}
            <span className="ov-sortmark" aria-hidden="true" title="Order"><SortGlyph /></span>
            <div className="seg ov-seg ov-sortseg">
              <button className={ovSort === 'manual' ? 'on' : ''} title="Your own order — the sidebar's groups and arrangement"
                onClick={() => setOvSort('manual')}>manual</button>
              <button className={ovSort === 'prompt' ? 'on' : ''} title="Newest message from you first"
                onClick={() => setOvSort('prompt')}>prompt</button>
              <button className={ovSort === 'answer' ? 'on' : ''} title="Newest reply from an agent first"
                onClick={() => setOvSort('answer')}>answer</button>
            </div>
            <div className="seg ov-seg ov-viewseg">
              <button className={ovView === 'tiles' ? 'on' : ''} title="Tiles" onClick={() => setOvView('tiles')}><GridGlyph /></button>
              <button className={ovView === 'list' ? 'on' : ''} title="List" onClick={() => setOvView('list')}><ListGlyph /></button>
            </div>
            {/* The way back. It appears only once something IS hidden, so the bar
                costs nothing until you use the feature — and it counts groups and
                agents, never "1 waiting", because being told about the group you
                hid is the thing you were trying to stop. */}
            {hiddenCount > 0 && (
              <button className={`zbtn ov-hidebtn${showHidden ? ' on' : ''}`}
                title={showHidden ? 'Hide them again' : 'Show what you hid from the overview'}
                onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? <EyeGlyph /> : <EyeOffGlyph />}
                <span className="mono">{hiddenCount} hidden</span>
              </button>
            )}
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
            {/* Reader mode sits with zoom because it is the same kind of
                setting: how you are looking at everything, not what any one
                pane is. The content is identical either way — this is form. */}
            <span className="seg modebar">
              <button className={paneMode === 'terminal' ? 'on' : ''} title="The terminal itself"
                onClick={() => showPaneMode('terminal')}>terminal</button>
              <button className={paneMode === 'reader' ? 'on' : ''} title="Reader mode — the same session, laid out"
                onClick={() => showPaneMode('reader')}>reader</button>
            </span>
            <button className="zbtn" title="Zoom out" onClick={() => setZoom((z) => Math.max(50, z - 10))}>−</button>
            <button className="zlvl" title="Reset to 100%" onClick={() => setZoom(100)}>{zoom}%</button>
            <button className="zbtn" title="Zoom in" onClick={() => setZoom((z) => Math.min(200, z + 10))}>+</button>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
