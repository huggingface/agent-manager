import { useEffect, useMemo, useRef, useState } from 'react';
import type { Cli, MoveTarget, Group, Session, Tree } from '../types';
import { STATE_LABEL, REMOTE_STATE_LABEL, isPassive, isRemote, isShareable } from '../types';
import Logo from './Logo';
import NewSession from './NewSession';
import FolderPicker from './FolderPicker';
import Attachments from './Attachments';
import {
  attachmentFileError, filesFromTransfer, pendingAttachmentsFromFiles, revokePendingAttachments,
  transferMayContainFile, uploadPendingAttachments,
} from '../lib/attachments';
import type { PendingAttachment } from '../lib/attachments';
import { SlidersGlyph, SunGlyph, MoonGlyph, CloseGlyph, PencilGlyph, StopGlyph, PlayGlyph, GridGlyph, PlusGlyph, AmMark, ShareGlyph, HandoverGlyph, ListGlyph, EyeGlyph, EyeOffGlyph } from './icons';

import { dropZone, backgroundAnchor, isBackgroundTarget } from './sidebar-dnd';
import type { Zone, Kind } from './sidebar-dnd';

export interface QuickStartAttachmentOptions {
  sessionId: string | null;
  attachments: PendingAttachment[];
  onSessionCreated: (id: string) => void;
}

// Folded groups, remembered across reloads.
const COLLAPSED_KEY = 'am-collapsed';

const fmtAgo = (ts?: number) => {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
};

export default function Sidebar({
  clis, tree, activeRef, focusedId, defaultPath, ages,
  onActivate, onOpenSession, onNewSession, onNewGroup, onRenameGroup, onRenameSession, onDeleteGroup,
  onStopSession, onSetRemotePaused, onDeleteSession, onShareSession, onShareTrace, onTraceHandover, onOpenTrace, onMove, onDragState, onOpenSettings, theme, onToggleTheme, onQuickStart,
  onPrepareQuickStart,
  archived, showArchived, onToggleArchived,
  overviewHidden, onToggleOverviewHidden,
}: {
  clis: Cli[];
  tree: Tree;
  activeRef: string | null;
  focusedId: string | null;
  defaultPath: string;
  ages?: Record<string, number>; // session id -> last activity ts (ms)
  onActivate: (ref: string) => void;
  onOpenSession: (sessionId: string, groupId?: string) => void;
  onOpenSettings: () => void;
  onNewSession: (name: string, cli: string, path: string, groupId?: string) => void;
  onNewGroup: (name: string, cart?: { cli: string; count: number }[], path?: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onDeleteGroup: (id: string) => void;
  onStopSession: (id: string) => void;
  onSetRemotePaused: (id: string, paused: boolean) => void;
  onDeleteSession: (id: string) => void;
  onShareSession: (id: string) => void;
  onShareTrace: (id: string) => void;
  onTraceHandover: (id: string) => Promise<{ path: string; sessionId?: string | null }>;
  onOpenTrace: (id: string) => void;
  onMove: (ref: string, to: MoveTarget) => void;
  onDragState?: (ref: string | null) => void; // lets the stage offer per-tile drop targets
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onQuickStart: (cli: string, prompt: string, name?: string, path?: string, attachmentOptions?: QuickStartAttachmentOptions) => Promise<void>;
  onPrepareQuickStart: (cli: string, name?: string, path?: string) => Promise<Session>;
  archived: Set<string>;
  showArchived: boolean;
  onToggleArchived: () => void;
  // Refs hidden from the OVERVIEW. The sidebar keeps showing them — it is where
  // you hide a group and the only way back to one — so this only drives the
  // per-group button.
  overviewHidden: Set<string>;
  onToggleOverviewHidden: (ref: string, hidden: boolean) => void;
}) {
  const [panel, setPanel] = useState<'none' | 'create' | 'quick'>('none');
  const [quickMode, setQuickMode] = useState<'agent' | 'group'>('agent');
  const [quickCli, setQuickCli] = useState<string | null>(null);
  const [quickPrompt, setQuickPrompt] = useState('');
  const [quickMore, setQuickMore] = useState(false); // reveals name + folder
  const [quickName, setQuickName] = useState('');
  const [quickLoc, setQuickLoc] = useState('.');
  const [quickError, setQuickError] = useState<string | null>(null);
  const [quickImages, setQuickImages] = useState<PendingAttachment[]>([]);
  const quickImagesRef = useRef<PendingAttachment[]>([]);
  const [quickSessionId, setQuickSessionId] = useState<string | null>(null);
  const quickSessionIdRef = useRef<string | null>(null);
  const quickPrepareRef = useRef<Promise<Session> | null>(null);
  const quickGenerationRef = useRef(0);
  const [quickSending, setQuickSending] = useState(false);
  const [quickDrop, setQuickDrop] = useState(false);
  // When creation was launched from a group's + the new agent lands there.
  const [createTarget, setCreateTarget] = useState<string | null>(null);
  const [groupName, setGroupName] = useState('');
  const [groupLoc, setGroupLoc] = useState(defaultPath || '.');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [editRef, setEditRef] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  // Which groups are folded. Kept per browser (like the theme and the zoom):
  // it's how you've arranged THIS screen, and a phone and a desktop want
  // different answers.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
      return new Set(Array.isArray(saved) ? saved.filter((x): x is string => typeof x === 'string') : []);
    } catch { return new Set(); }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* private mode */ }
  }, [collapsed]);
  const [dragRef, setDragRef] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ ref: string; zone: Zone } | null>(null);

  const sessById = useMemo(() => Object.fromEntries(tree.sessions.map((s) => [s.id, s])), [tree.sessions]);
  const groupById = useMemo(() => Object.fromEntries(tree.groups.map((g) => [g.id, g])), [tree.groups]);
  const colorOf = useMemo(() => Object.fromEntries(clis.map((c) => [c.id, c.color])), [clis]);
  const quickFilesBlocked = quickImages.some((image) => !image.attachment);

  useEffect(() => { quickImagesRef.current = quickImages; }, [quickImages]);
  useEffect(() => () => revokePendingAttachments(quickImagesRef.current), []);

  const rememberQuickSession = (id: string | null) => {
    quickSessionIdRef.current = id;
    setQuickSessionId(id);
  };

  const updateQuickImage = (key: string, patch: Partial<PendingAttachment>) => {
    setQuickImages((current) => {
      const next = current.map((image) => image.key === key ? { ...image, ...patch } : image);
      quickImagesRef.current = next;
      return next;
    });
  };
  const prepareQuickTarget = async (generation: number) => {
    if (quickSessionIdRef.current) return quickSessionIdRef.current;
    if (!quickCli || isRemote(quickCli)) throw new Error('Choose a local agent before attaching files.');
    if (!quickPrepareRef.current) {
      quickPrepareRef.current = onPrepareQuickStart(
        quickCli, quickMore ? quickName.trim() : '', quickMore ? quickLoc : '.',
      );
    }
    const preparing = quickPrepareRef.current;
    try {
      const created = await preparing;
      if (generation === quickGenerationRef.current) rememberQuickSession(created.id);
      return created.id;
    } catch (error) {
      if (quickPrepareRef.current === preparing) quickPrepareRef.current = null;
      throw error;
    }
  };
  const startQuickUploads = (attachments: PendingAttachment[]) => {
    const uploadable = attachments.filter((attachment) => !attachmentFileError(attachment.file));
    if (!uploadable.length) return;
    const generation = quickGenerationRef.current;
    void (async () => {
      let sessionId: string;
      try {
        sessionId = await prepareQuickTarget(generation);
      } catch (error) {
        if (generation !== quickGenerationRef.current) return;
        const message = error instanceof Error ? error.message : 'Could not prepare an agent for this upload.';
        for (const attachment of uploadable) updateQuickImage(attachment.key, { status: 'error', error: message });
        setQuickError(message);
        return;
      }
      if (generation !== quickGenerationRef.current) return;
      setQuickError(null);
      await uploadPendingAttachments(sessionId, uploadable, updateQuickImage).catch(() => {
        // Each failed chip keeps the exact server or connection error and retry action.
      });
    })();
  };
  const addQuickImages = (files: File[]) => {
    if (quickSending) return;
    const next = pendingAttachmentsFromFiles(files, quickImagesRef.current.length);
    const merged = [...quickImagesRef.current, ...next.attachments];
    quickImagesRef.current = merged;
    setQuickImages(merged);
    setQuickError(next.error);
    startQuickUploads(next.attachments);
  };
  const removeQuickImage = (key: string) => {
    if (quickSending) return;
    setQuickImages((current) => {
      const removed = current.find((image) => image.key === key);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      const next = current.filter((image) => image.key !== key);
      quickImagesRef.current = next;
      return next;
    });
    setQuickError(null);
  };
  const retryQuickImage = (key: string) => {
    const image = quickImagesRef.current.find((item) => item.key === key);
    if (!image || quickSending) return;
    startQuickUploads([image]);
  };
  // A retry may reuse uploaded ids only while it still targets the same
  // server-created session. Changing its identity starts a fresh target.
  const resetQuickTarget = () => {
    quickGenerationRef.current += 1;
    quickPrepareRef.current = null;
    rememberQuickSession(null);
    setQuickImages((current) => {
      const next = current.map((image) => image.attachment
        ? { ...image, attachment: undefined, status: 'pending' as const, error: undefined }
        : image);
      quickImagesRef.current = next;
      return next;
    });
  };

  const clearDrag = () => { setDragRef(null); setDrop(null); onDragState?.(null); };
  // Archived sessions vanish from the tree unless the legend checkbox is on.
  const isHidden = (id: string) => !showArchived && archived.has(id);
  const bump = (id: string, d: number) => setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] || 0) + d) }));
  const closePanel = () => {
    if (panel === 'quick') {
      quickGenerationRef.current += 1;
      revokePendingAttachments(quickImagesRef.current);
      quickImagesRef.current = [];
      setQuickImages([]);
      quickPrepareRef.current = null;
      rememberQuickSession(null);
      setQuickSending(false);
      setQuickDrop(false);
    }
    setPanel('none'); setCreateTarget(null);
  };
  const openCreate = (target: string | null = null) => {
    setCreateTarget(target);
    setPanel('create');
  };
  // Quickstart: one harness pick + one prompt, agent launches in workspace/.
  // Every agent harness is shown; ones not installed here are greyed out.
  // "More options" adds a name + folder; the group tile flips to group creation.
  const quickable = clis.filter((c) => c.id !== 'shell' && !isPassive(c.id) && !isRemote(c.id));
  const remoteCli = clis.find((c) => isRemote(c.id)) || null;
  const openQuick = () => {
    quickGenerationRef.current += 1;
    setQuickError(null);
    setQuickName('');
    quickPrepareRef.current = null;
    rememberQuickSession(null);
    setQuickCli((q) => q ?? (quickable.find((c) => c.available && c.ready)?.id || quickable.find((c) => c.available)?.id || null));
    setQuickMode('agent');
    setQuickLoc(defaultPath || '.');
    setGroupLoc(defaultPath || '.');
    setPanel('quick');
  };
  const openHandover = async (s: Session) => {
    try {
      setQuickError(null);
      const loc = await onTraceHandover(s.id);
      const selected = quickable.find((c) => c.available && c.ready)
        || quickable.find((c) => c.available);
      setQuickCli(selected?.id || null);
      setQuickMode('agent');
      setQuickMore(false);
      setQuickName('');
      setQuickLoc(defaultPath || '.');
      setQuickPrompt(`In this session we will continue from the session traces at ${loc.path}${loc.sessionId ? ` (session ${loc.sessionId})` : ''}`);
      setPanel('quick');
    } catch (e) {
      setQuickError(e instanceof Error ? e.message : 'could not resolve that trace');
      setQuickMode('agent');
      setPanel('quick');
    }
  };
  const submitQuick = async () => {
    const p = quickPrompt.trim();
    if (!quickCli || quickSending) return;
    if (quickImagesRef.current.some((image) => !image.attachment)) return;
    // A remote agent names itself like any other agent when unnamed
    // (remote-agent-1, -2, …); its "location" is always its own message folder,
    // never the picker's.
    if (isRemote(quickCli)) {
      setQuickSending(true);
      try {
        await onQuickStart(quickCli, p, quickName.trim(), '.');
        setQuickPrompt(''); setQuickName(''); closePanel();
      } catch (error) {
        setQuickError(error instanceof Error ? error.message : 'could not create the remote agent');
      } finally { setQuickSending(false); }
      return;
    }
    if (!p && !quickImages.length && !quickMore) return; // the bare quick path needs a prompt or file
    setQuickSending(true);
    setQuickError(null);
    try {
      await onQuickStart(
        quickCli, p, quickMore ? quickName.trim() : '', quickMore ? quickLoc : '.',
        quickSessionId || quickImages.length ? {
          sessionId: quickSessionId,
          attachments: quickImages,
          onSessionCreated: rememberQuickSession,
        } : undefined,
      );
      setQuickPrompt('');
      setQuickName('');
      closePanel();
    } catch (error) {
      setQuickError(error instanceof Error ? error.message : 'could not quickstart the agent');
    } finally { setQuickSending(false); }
  };
  const submitGroup = () => {
    const items = Object.entries(cart).filter(([, n]) => n > 0).map(([cli, count]) => ({ cli, count }));
    onNewGroup(groupName.trim() || 'Group', items, groupLoc);
    setGroupName(''); setCart({}); closePanel();
  };
  const startEdit = (ref: string, name: string) => { setEditRef(ref); setEditName(name); };
  const commitEdit = () => {
    if (editRef) {
      const id = editRef.slice(2);
      if (editRef.startsWith('g:')) onRenameGroup(id, editName);
      else onRenameSession(id, editName);
    }
    setEditRef(null);
  };

  const zoneFor = (ref: string, kind: Kind, nested: boolean, rect: DOMRect, clientY: number): Zone | null =>
    dropZone({
      dragRef, ref, kind, nested, box: rect, clientY,
      isMember: kind === 'group' && !!dragRef && groupById[ref.slice(2)]?.sessionIds.includes(dragRef.slice(2)),
    });

  const applyDrop = (ref: string, kind: Kind, zone: Zone) => {
    const id = ref.slice(2);
    if (zone === 'on') {
      if (kind === 'group') onMove(dragRef!, { kind: 'into', groupId: id });
      else onMove(dragRef!, { kind: 'pair', sessionId: id });
    } else {
      onMove(dragRef!, { kind: zone, ref });
    }
    clearDrag();
  };

  // The tree's own background — the margins between frames, and the empty space
  // below the list. Without this there is no way to pull an agent out of a group
  // once every agent is in one: the top level would have no row left to aim at.
  const treeAnchor = (el: HTMLElement, clientY: number) => backgroundAnchor(
    Array.from(el.querySelectorAll<HTMLElement>(':scope > [data-ref]')).map((k) => ({ ref: k.dataset.ref!, box: k.getBoundingClientRect() })),
    dragRef,
    clientY,
  );
  const treeDnd = {
    onDragEnd: clearDrag,
    onDragLeave: (e: React.DragEvent) => { if (e.currentTarget === e.target) setDrop(null); },
    onDragOver: (e: React.DragEvent) => {
      // Only the background: anything over a row or a frame is theirs to answer.
      if (!dragRef || !isBackgroundTarget(e.target as HTMLElement, e.currentTarget)) return;
      const a = treeAnchor(e.currentTarget as HTMLElement, e.clientY);
      if (!a) return;
      e.preventDefault();
      setDrop(a);
    },
    onDrop: (e: React.DragEvent) => {
      if (!dragRef || !isBackgroundTarget(e.target as HTMLElement, e.currentTarget)) return;
      const a = treeAnchor(e.currentTarget as HTMLElement, e.clientY);
      if (!a) { clearDrag(); return; }
      e.preventDefault();
      onMove(dragRef, { kind: a.zone, ref: a.ref });
      clearDrag();
    },
  };

  // shared drag-and-drop wiring for any row or group frame
  const dndProps = (ref: string, kind: Kind, nested: boolean) => ({
    draggable: editRef !== ref,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('text/plain', ref); e.dataTransfer.effectAllowed = 'move'; setDragRef(ref); onDragState?.(ref); },
    onDragEnd: clearDrag,
    onDragOver: (e: React.DragEvent) => {
      const zone = zoneFor(ref, kind, nested, e.currentTarget.getBoundingClientRect(), e.clientY);
      if (!zone) return; // let it bubble — an enclosing frame may still take it
      e.preventDefault(); e.stopPropagation();
      setDrop({ ref, zone });
    },
    onDrop: (e: React.DragEvent) => {
      const zone = zoneFor(ref, kind, nested, e.currentTarget.getBoundingClientRect(), e.clientY);
      if (!zone) return;
      e.preventDefault(); e.stopPropagation();
      applyDrop(ref, kind, zone);
    },
    className: drop && drop.ref === ref ? ` drop-${drop.zone}` : '',
  });

  const SessionRow = (s: Session, groupId?: string) => {
    const ref = `s:${s.id}`;
    const nested = !!groupId;
    const dnd = dndProps(ref, 'session', nested);
    const editing = editRef === ref;
    // nested agents are highlighted as a whole group (see GroupBlock); loose ones individually
    const active = !nested && activeRef === ref;
    return (
      <div
        key={s.id}
        data-ref={ref}
        className={`row session${active ? ' active' : ''}${nested ? ' nested' : ''}${archived.has(s.id) ? ' archived' : ''}${dragRef === ref ? ' dragging' : ''}${dnd.className}`}
        draggable={dnd.draggable}
        onDragStart={dnd.onDragStart} onDragEnd={dnd.onDragEnd} onDragOver={dnd.onDragOver} onDrop={dnd.onDrop}
        onClick={() => onOpenSession(s.id, groupId)}
        onDoubleClick={(e) => { e.stopPropagation(); startEdit(ref, s.name); }}
        title={s.path ? `${s.name} · ${s.path}` : s.name}
      >
        {/* The same three lights, but for a remote agent they mean connection,
            not process: working / listening / not connected. */}
        <span className={`status ${s.state}`} title={(isRemote(s.cli) ? REMOTE_STATE_LABEL : STATE_LABEL)[s.state]} />
        <Logo cli={s.cli} size={12} tint={colorOf[s.cli]} />
        {editing ? (
          <input
            autoFocus className="rename" value={editName}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditRef(null); }}
          />
        ) : (
          <span className="name">{s.name}</span>
        )}
        <span className="age">{fmtAgo(ages?.[s.id])}</span>
        <span className="row-actions">
          {s.cli === 'trace' ? (
            <>
              <button className="mini-btn" title="Share this trace" onClick={(e) => { e.stopPropagation(); onShareTrace(s.id); }}><ShareGlyph /></button>
              <button className="mini-btn" title="Continue from this trace in a new agent" onClick={(e) => { e.stopPropagation(); openHandover(s); }}><HandoverGlyph /></button>
            </>
          ) : isRemote(s.cli) ? (
            // No process to kill: stop/play are disconnect/reconnect, and
            // "reconnect" must not try to open a terminal for this pane.
            s.remote?.paused
              ? <button className="mini-btn" title="Reconnect" onClick={(e) => { e.stopPropagation(); onSetRemotePaused(s.id, false); }}><PlayGlyph /></button>
              : <button className="mini-btn" title="Disconnect" onClick={(e) => { e.stopPropagation(); onSetRemotePaused(s.id, true); }}><StopGlyph /></button>
          ) : s.running
            ? <button className="mini-btn" title="Stop" onClick={(e) => { e.stopPropagation(); onStopSession(s.id); }}><StopGlyph /></button>
            : <button className="mini-btn" title="Start" onClick={(e) => { e.stopPropagation(); onOpenSession(s.id, groupId); }}><PlayGlyph /></button>}
          {isShareable(s.cli) && (
            <>
              <button className="mini-btn" title="Read this session's trace" onClick={(e) => { e.stopPropagation(); onOpenTrace(s.id); }}><ListGlyph /></button>
              <button className="mini-btn" title="Share this session" onClick={(e) => { e.stopPropagation(); onShareSession(s.id); }}><ShareGlyph /></button>
            </>
          )}
          <button className="mini-btn" title="Delete" onClick={(e) => { e.stopPropagation(); onDeleteSession(s.id); }}><CloseGlyph /></button>
        </span>
      </div>
    );
  };

  const GroupBlock = (g: Group) => {
    const ref = `g:${g.id}`;
    // The whole frame takes drops — its edges place a neighbour, its middle
    // takes an agent in. The name chip is only ~17px tall and no wider than the
    // name, far too small to be the group's only target.
    const dnd = dndProps(ref, 'group', false);
    const open = !collapsed.has(g.id);
    const editing = editRef === ref;
    const at = drop && drop.ref === ref ? drop.zone : null;
    // The chip rides *above* the frame, so it can't share the frame's geometry:
    // it simply reads as the group itself. An agent dropped on the name goes in;
    // a group dropped on it lands above.
    const headZone = (): Zone | null => {
      if (!dragRef || dragRef === ref) return null;
      if (dragRef.startsWith('g:')) return 'before';
      return g.sessionIds.includes(dragRef.slice(2)) ? null : 'on';
    };
    return (
      <div
        key={g.id}
        data-ref={ref}
        className={`group${activeRef === ref ? ' active' : ''}${!open ? ' closed' : ''}${at ? ` drop-${at === 'on' ? 'into' : at}` : ''}`}
        onDragOver={dnd.onDragOver} onDrop={dnd.onDrop} onDragEnd={dnd.onDragEnd}
      >
        {/* the group's name rides its frame — still the drag handle / click target */}
        <div
          className={`row group-head${dragRef === ref ? ' dragging' : ''}`}
          draggable={dnd.draggable}
          onDragStart={dnd.onDragStart} onDragEnd={dnd.onDragEnd}
          onDragOver={(e) => { const z = headZone(); if (!z) return; e.preventDefault(); e.stopPropagation(); setDrop({ ref, zone: z }); }}
          onDrop={(e) => { const z = headZone(); if (!z) return; e.preventDefault(); e.stopPropagation(); applyDrop(ref, 'group', z); }}
          onClick={() => onActivate(ref)}
          onDoubleClick={(e) => { e.stopPropagation(); startEdit(ref, g.name); }}
        >
          <button className="caret" onClick={(e) => { e.stopPropagation(); setCollapsed((c) => { const n = new Set(c); n.has(g.id) ? n.delete(g.id) : n.add(g.id); return n; }); }}>{open ? '▾' : '▸'}</button>
          {editing ? (
            <input
              autoFocus className="rename" value={editName}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditRef(null); }}
            />
          ) : (
            <>
              <span className="name">{g.name}</span>
              {!open && <span className="count">{g.sessionIds.length}</span>}
              {/* Hidden from the OVERVIEW, not from here: the sidebar row is
                  both where you hide a group and how you get back to it. */}
              {overviewHidden.has(ref) && <span className="ov-hidden-tag mono" title="Hidden from the overview">hidden</span>}
              <span className="row-actions">
                <button className="mini-btn" title={overviewHidden.has(ref) ? 'Show in the overview' : 'Hide from the overview'}
                  onClick={(e) => { e.stopPropagation(); onToggleOverviewHidden(ref, !overviewHidden.has(ref)); }}>
                  {overviewHidden.has(ref) ? <EyeOffGlyph /> : <EyeGlyph />}
                </button>
                <button className="mini-btn" title="Rename" onClick={(e) => { e.stopPropagation(); startEdit(ref, g.name); }}><PencilGlyph /></button>
                <button className="mini-btn" title="Delete group" onClick={(e) => { e.stopPropagation(); onDeleteGroup(g.id); }}><CloseGlyph /></button>
              </span>
            </>
          )}
        </div>
        <button className="g-add" title={`New agent in ${g.name}`} onClick={(e) => { e.stopPropagation(); openCreate(g.id); }}><PlusGlyph /></button>
        {open && g.sessionIds.map((sid) => sessById[sid]).filter(Boolean).filter((s) => !isHidden((s as Session).id)).map((s) => SessionRow(s as Session, g.id))}
        {open && g.sessionIds.length === 0 && <div className="empty-hint nested">Drag agents here</div>}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo">
          <AmMark className="am-mark" />
          <h1>Agent Manager</h1>
        </div>
        <div className="brand-actions">
          <button
            className={`icon-btn add-btn bolt-btn${panel === 'quick' ? ' on' : ''}`}
            onClick={() => (panel === 'quick' ? closePanel() : openQuick())}
            title="New agent or group"
          ><PlusGlyph /></button>
          <button className="icon-btn" onClick={onOpenSettings} title="Settings"><SlidersGlyph /></button>
          <button className="icon-btn" onClick={onToggleTheme} title="Toggle light / dark">{theme === 'dark' ? <MoonGlyph /> : <SunGlyph />}</button>
        </div>
      </div>

      {panel === 'quick' && (
        <div className="controls">
          <div
            className={`widget quick${quickDrop ? ' image-drop' : ''}`}
            onDragEnter={(event) => {
              if (!quickSending && quickMode === 'agent' && quickCli && !isRemote(quickCli) && transferMayContainFile(event.dataTransfer)) {
                event.preventDefault(); setQuickDrop(true);
              }
            }}
            onDragOver={(event) => {
              if (!quickSending && quickMode === 'agent' && quickCli && !isRemote(quickCli) && transferMayContainFile(event.dataTransfer)) {
                event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setQuickDrop(false); }}
            onDrop={(event) => {
              if (quickSending || quickMode !== 'agent' || !quickCli || isRemote(quickCli) || !transferMayContainFile(event.dataTransfer)) return;
              event.preventDefault(); event.stopPropagation(); setQuickDrop(false);
              addQuickImages(filesFromTransfer(event.dataTransfer));
            }}
          >
            <div className="quick-clis">
              {quickable.map((c) => (
                <button
                  key={c.id}
                  className={`quick-cli${quickMode === 'agent' && quickCli === c.id ? ' on' : ''}${c.available ? '' : ' off'}`}
                  title={c.available ? c.label : `${c.label} (not installed)`}
                  disabled={!c.available || quickSending || quickImages.length > 0}
                  style={quickMode === 'agent' && quickCli === c.id ? { borderColor: c.color } : undefined}
                  onClick={() => { setQuickMode('agent'); if (quickCli !== c.id) resetQuickTarget(); setQuickCli(c.id); }}
                ><Logo cli={c.id} size={14} /></button>
              ))}
              <span className="quick-sep" />
              <button
                className={`quick-cli quick-grp${quickMode === 'group' ? ' on' : ''}`}
                title="New group"
                disabled={quickSending || quickImages.length > 0}
                onClick={() => setQuickMode('group')}
              >
                <span className="grp-mini">
                  <Logo cli="claude" size={8} />
                  <Logo cli="codex" size={8} />
                  <Logo cli="hermes" size={8} />
                  <Logo cli="openclaw" size={8} />
                </span>
              </button>
              {remoteCli && (
                <button
                  className={`quick-cli${quickMode === 'agent' && quickCli === 'remote' ? ' on' : ''}`}
                  title="Remote agent — an agent on another machine"
                  disabled={quickSending || quickImages.length > 0}
                  style={quickMode === 'agent' && quickCli === 'remote' ? { borderColor: remoteCli.color } : undefined}
                  onClick={() => {
                    setQuickMode('agent'); setQuickCli('remote'); quickGenerationRef.current += 1;
                    quickPrepareRef.current = null; rememberQuickSession(null);
                    revokePendingAttachments(quickImagesRef.current); quickImagesRef.current = []; setQuickImages([]); setQuickError(null);
                  }}
                ><Logo cli="remote" size={14} /></button>
              )}
            </div>

            {quickMode === 'agent' ? (
              <>
                {quickError && <div className="open-trace-err" role="alert">{quickError}</div>}
                {quickError && quickSessionId && (
                  <div className="quick-recovery mono">
                    The agent was created. Retry will reuse it; delete it from the agent row if you want to start over.
                  </div>
                )}
                {!quickError && quickSessionId && quickImages.length > 0 && (
                  <div className="quick-recovery mono">
                    {quickImages.every((image) => !!image.attachment)
                      ? 'Files are uploaded to this stopped agent; launch will reuse them.'
                      : quickImages.some((image) => image.status === 'error')
                        ? 'A file needs attention before this stopped agent can launch.'
                        : 'Files are uploading to this stopped agent now; launch waits until they are ready.'}
                  </div>
                )}
                <textarea
                  autoFocus
                  rows={1}
                  className="quick-prompt"
                  placeholder={quickCli ? `prompt for ${clis.find((c) => c.id === quickCli)?.label ?? quickCli}…` : 'prompt…'}
                  value={quickPrompt}
                  disabled={quickSending}
                  onPaste={(event) => {
                    if (quickSending || !quickCli || isRemote(quickCli)) return;
                    const files = filesFromTransfer(event.clipboardData);
                    if (!files.length) return;
                    event.preventDefault(); addQuickImages(files);
                  }}
                  onChange={(e) => { setQuickPrompt(e.target.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`; }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitQuick(); }
                    if (e.key === 'Escape') closePanel();
                  }}
                />
                <Attachments
                  attachments={quickImages}
                  disabled={quickSending || !quickCli || isRemote(quickCli)}
                  showPicker={false}
                  onFiles={addQuickImages}
                  onRemove={removeQuickImage}
                  onRetry={retryQuickImage}
                />
                {quickMore && (
                  <>
                    <input
                      placeholder="Name (optional)"
                      value={quickName}
                      disabled={quickSending || quickImages.length > 0}
                      onChange={(e) => { resetQuickTarget(); setQuickName(e.target.value); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') submitQuick(); if (e.key === 'Escape') closePanel(); }}
                    />
                    <FolderPicker disabled={quickSending || quickImages.length > 0} value={quickLoc} onChange={(value) => { resetQuickTarget(); setQuickLoc(value); }} />
                    <div className="widget-actions">
                      <button className="btn-primary" onClick={submitQuick} disabled={quickSending || quickFilesBlocked}>{quickSending ? 'Starting…' : `Create${quickPrompt.trim() || quickImages.length ? ' & send' : ''}`}</button>
                      <button className="btn-ghost" onClick={closePanel} disabled={quickSending}>Cancel</button>
                    </div>
                  </>
                )}
                <div className="quick-foot">
                  <button className="quick-more" onClick={() => setQuickMore((v) => !v)} disabled={quickSending || quickImages.length > 0}>{quickMore ? '▴ less' : '▾ more options'}</button>
                  <span className="quick-hint mono">↵ launch · ⇧↵ newline</span>
                </div>
              </>
            ) : (
              <>
                <input autoFocus placeholder="Group name" value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitGroup(); if (e.key === 'Escape') closePanel(); }} />
                <FolderPicker value={groupLoc} onChange={setGroupLoc} />
                <div className="cart">
                  {/* every agent harness is offered; uninstalled ones are inert */}
                  {/* Shell and Files stay on offer — a group may legitimately want
                      one. Trace does not: a trace pane with no source shows nothing,
                      so it's only ever created from a session's Trace button. */}
                  {clis.filter((c) => (c.available || (c.id !== 'shell' && c.id !== 'files')) && c.id !== 'trace').map((c) => {
                    const n = cart[c.id] || 0;
                    return (
                      <div key={c.id} className={`cart-row${n > 0 ? ' has' : ''}${c.available ? '' : ' off'}`} title={c.available ? c.label : `${c.label} (not installed)`}>
                        <div className="stepper">
                          <button onClick={() => bump(c.id, -1)} disabled={n === 0} aria-label="Fewer">−</button>
                          <span className="stepper-n">{n}</span>
                          <button onClick={() => bump(c.id, 1)} disabled={!c.available} aria-label="More">+</button>
                        </div>
                        <Logo cli={c.id} size={13} />
                        <span className="cart-name">{c.label}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="widget-actions">
                  <button className="btn-primary" onClick={submitGroup}>Create group</button>
                  <button className="btn-ghost" onClick={() => { setCart({}); closePanel(); }}>Cancel</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* contextual creation into a specific group (a group row's + button) */}
      {panel === 'create' && (
        <div className="controls">
          {createTarget && groupById[createTarget] && (
            <div className="create-hint mono">into {groupById[createTarget].name}</div>
          )}
          <NewSession
            clis={clis}
            sessions={tree.sessions}
            defaultPath={defaultPath}
            onCreate={(n, c, p) => { onNewSession(n, c, p, createTarget ?? undefined); closePanel(); }}
            onCancel={closePanel}
          />
        </div>
      )}

      {/* Overview: pinned above the tree with the row anatomy (tile · name) so
          it reads as clickable. It used to carry an "N waiting" count in a
          right slot; the rows directly below already show each of those agents
          with its own state mark, so the number was a second, vaguer telling of
          what the list says exactly. */}
      <div className="ov-fixed">
        <div
          className={`row session ov-row${activeRef === 'overview' ? ' active' : ''}`}
          onClick={() => onActivate('overview')}
          title="All agents: digests, states, replies"
        >
          <span className="status ov-spacer" />
          <span className="ov-tile"><GridGlyph /></span>
          <span className="name">overview</span>
        </div>
      </div>

      <div className={`tree${dragRef ? ' dragging' : ''}`} {...treeDnd}>
        {tree.order.length === 0 && (
          <div className="empty-hint">Nothing yet. Add an agent with the + above.<br />Drag an agent onto another to group them.</div>
        )}
        {tree.order.map((ref) => {
          if (ref.startsWith('s:')) {
            const s = sessById[ref.slice(2)];
            return s && !isHidden(s.id) ? SessionRow(s) : null;
          }
          const g = groupById[ref.slice(2)];
          if (!g) return null;
          // A group whose AGENTS are all archived disappears with them — a
          // leftover shell/file viewer alone doesn't keep it on screen.
          // Groups with no agent members at all (pure utility) stay.
          const members = g.sessionIds.map((sid) => sessById[sid]).filter(Boolean) as Session[];
          const agents = members.filter((s) => s.cli !== 'shell' && !isPassive(s.cli));
          const anyVisible = agents.length === 0 || agents.some((s) => !isHidden(s.id));
          return anyVisible ? GroupBlock(g) : null;
        })}
        {!showArchived && archived.size > 0 && (
          <div className="arch-note">not showing {archived.size} archived session{archived.size === 1 ? '' : 's'}</div>
        )}
      </div>

      {/* Quick-add utilities: created instantly with a default name (double-
          click to rename afterwards). Both open at the workspaces root. */}
      <div className="quick-add">
        <button className="btn-ghost" title="New shell at the workspaces root" onClick={() => onNewSession('', 'shell', '.')}>
          <Logo cli="shell" size={14} /> Shell
        </button>
        <button className="btn-ghost" title="New file browser (whole workspace)" onClick={() => onNewSession('', 'files', '.')}>
          <Logo cli="files" size={14} /> Files
        </button>
      </div>

      <div className="legend">
        <span><span className="status working" /> working</span>
        <span><span className="status waiting" /> idle</span>
        <span><span className="status stopped" /> stopped</span>
        {archived.size > 0 && (
          <label className="legend-arch" title="Sessions with no activity beyond the archive window (Settings)">
            <input type="checkbox" checked={showArchived} onChange={onToggleArchived} />
            <span className="lbox" />
            archived
          </label>
        )}
      </div>
    </aside>
  );
}
