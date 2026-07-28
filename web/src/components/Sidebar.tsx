import { useMemo, useState } from 'react';
import type { Cli, MoveTarget, Group, Session, Tree } from '../types';
import { STATE_LABEL } from '../types';
import Logo from './Logo';
import NewSession from './NewSession';
import FolderPicker from './FolderPicker';
import { SlidersGlyph, SunGlyph, MoonGlyph, CloseGlyph, PencilGlyph, StopGlyph, PlayGlyph, GridGlyph, PlusGlyph, AmMark, ShareGlyph } from './icons';

type Zone = 'before' | 'after' | 'on';

// Harnesses whose traces the Hub renders natively, so a share ships the file
// verbatim (mirrors SHAREABLE_CLIS in server/src/share.js). The others need
// converters first, and a button that always fails is worse than no button.
const SHAREABLE_CLIS = ['claude', 'codex', 'hermes', 'opencode', 'openclaw'];

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
  onStopSession, onDeleteSession, onShareSession, onMove, onDragState, onOpenSettings, theme, onToggleTheme, onQuickStart,
  archived, showArchived, onToggleArchived,
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
  onDeleteSession: (id: string) => void;
  onShareSession: (id: string) => void;
  onMove: (ref: string, to: MoveTarget) => void;
  onDragState?: (ref: string | null) => void; // lets the stage offer per-tile drop targets
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onQuickStart: (cli: string, prompt: string, name?: string, path?: string) => void;
  archived: Set<string>;
  showArchived: boolean;
  onToggleArchived: () => void;
}) {
  const [panel, setPanel] = useState<'none' | 'create' | 'quick'>('none');
  const [quickMode, setQuickMode] = useState<'agent' | 'group'>('agent');
  const [quickCli, setQuickCli] = useState<string | null>(null);
  const [quickPrompt, setQuickPrompt] = useState('');
  const [quickMore, setQuickMore] = useState(false); // reveals name + folder
  const [quickName, setQuickName] = useState('');
  const [quickLoc, setQuickLoc] = useState('.');
  // When creation was launched from a group's + the new agent lands there.
  const [createTarget, setCreateTarget] = useState<string | null>(null);
  const [groupName, setGroupName] = useState('');
  const [groupLoc, setGroupLoc] = useState(defaultPath || '.');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [editRef, setEditRef] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragRef, setDragRef] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ ref: string; zone: Zone } | null>(null);

  const sessById = useMemo(() => Object.fromEntries(tree.sessions.map((s) => [s.id, s])), [tree.sessions]);
  const groupById = useMemo(() => Object.fromEntries(tree.groups.map((g) => [g.id, g])), [tree.groups]);
  const colorOf = useMemo(() => Object.fromEntries(clis.map((c) => [c.id, c.color])), [clis]);
  const waiting = tree.sessions.filter((s) => s.state === 'waiting').length;

  const clearDrag = () => { setDragRef(null); setDrop(null); onDragState?.(null); };
  // Archived sessions vanish from the tree unless the legend checkbox is on.
  const isHidden = (id: string) => !showArchived && archived.has(id);
  const bump = (id: string, d: number) => setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] || 0) + d) }));
  const closePanel = () => { setPanel('none'); setCreateTarget(null); };
  const openCreate = (target: string | null = null) => {
    setCreateTarget(target);
    setPanel('create');
  };
  // Quickstart: one harness pick + one prompt, agent launches in workspace/.
  // Every agent harness is shown; ones not installed here are greyed out.
  // "More options" adds a name + folder; the group tile flips to group creation.
  const quickable = clis.filter((c) => c.id !== 'shell' && c.id !== 'files');
  const openQuick = () => {
    setQuickCli((q) => q ?? (quickable.find((c) => c.available && c.ready)?.id || quickable.find((c) => c.available)?.id || null));
    setQuickMode('agent');
    setQuickLoc(defaultPath || '.');
    setGroupLoc(defaultPath || '.');
    setPanel('quick');
  };
  const submitQuick = () => {
    const p = quickPrompt.trim();
    if (!quickCli) return;
    if (!p && !quickMore) return; // the bare quick path needs a prompt
    onQuickStart(quickCli, p, quickMore ? quickName.trim() : '', quickMore ? quickLoc : '.');
    setQuickPrompt('');
    setQuickName('');
    closePanel();
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

  // shared drag-and-drop wiring for any row
  const dndProps = (ref: string, kind: 'group' | 'session', nested: boolean) => ({
    draggable: editRef !== ref,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('text/plain', ref); e.dataTransfer.effectAllowed = 'move'; setDragRef(ref); onDragState?.(ref); },
    onDragEnd: clearDrag,
    onDragOver: (e: React.DragEvent) => {
      if (!dragRef || dragRef === ref) return;
      const draggingGroup = dragRef.startsWith('g:');
      if (nested && draggingGroup) return; // can't nest a group
      e.preventDefault(); e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      const y = e.clientY - rect.top;
      let zone: Zone;
      if (draggingGroup) zone = y < rect.height / 2 ? 'before' : 'after';
      else { const th = rect.height / 3; zone = y < th ? 'before' : y > 2 * th ? 'after' : 'on'; }
      setDrop({ ref, zone });
    },
    onDrop: (e: React.DragEvent) => {
      if (!dragRef || dragRef === ref) { clearDrag(); return; }
      e.preventDefault(); e.stopPropagation();
      const zone = drop && drop.ref === ref ? drop.zone : 'after';
      const id = ref.slice(2);
      if (zone === 'on') {
        if (kind === 'group') onMove(dragRef, { kind: 'into', groupId: id });
        else onMove(dragRef, { kind: 'pair', sessionId: id });
      } else {
        onMove(dragRef, { kind: zone, ref });
      }
      clearDrag();
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
        className={`row session${active ? ' active' : ''}${nested ? ' nested' : ''}${archived.has(s.id) ? ' archived' : ''}${dragRef === ref ? ' dragging' : ''}${dnd.className}`}
        draggable={dnd.draggable}
        onDragStart={dnd.onDragStart} onDragEnd={dnd.onDragEnd} onDragOver={dnd.onDragOver} onDrop={dnd.onDrop}
        onClick={() => onOpenSession(s.id, groupId)}
        onDoubleClick={(e) => { e.stopPropagation(); startEdit(ref, s.name); }}
        title={s.path ? `${s.name} · ${s.path}` : s.name}
      >
        <span className={`status ${s.state}`} title={STATE_LABEL[s.state]} />
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
          {s.running
            ? <button className="mini-btn" title="Stop" onClick={(e) => { e.stopPropagation(); onStopSession(s.id); }}><StopGlyph /></button>
            : <button className="mini-btn" title="Start" onClick={(e) => { e.stopPropagation(); onOpenSession(s.id, groupId); }}><PlayGlyph /></button>}
          {SHAREABLE_CLIS.includes(s.cli) && (
            <button className="mini-btn" title="Share this session" onClick={(e) => { e.stopPropagation(); onShareSession(s.id); }}><ShareGlyph /></button>
          )}
          <button className="mini-btn" title="Delete" onClick={(e) => { e.stopPropagation(); onDeleteSession(s.id); }}><CloseGlyph /></button>
        </span>
      </div>
    );
  };

  const GroupBlock = (g: Group) => {
    const ref = `g:${g.id}`;
    const dnd = dndProps(ref, 'group', false);
    const open = !collapsed.has(g.id);
    const editing = editRef === ref;
    return (
      <div key={g.id} className={`group${activeRef === ref ? ' active' : ''}${!open ? ' closed' : ''}${drop && drop.ref === ref && drop.zone === 'on' ? ' drop-into' : ''}`}>
        {/* the group's name rides its frame — still the drag handle / click target */}
        <div
          className={`row group-head${dragRef === ref ? ' dragging' : ''}${dnd.className}`}
          draggable={dnd.draggable}
          onDragStart={dnd.onDragStart} onDragEnd={dnd.onDragEnd} onDragOver={dnd.onDragOver} onDrop={dnd.onDrop}
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
              <span className="row-actions">
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
          <div className="widget quick">
            <div className="quick-clis">
              {quickable.map((c) => (
                <button
                  key={c.id}
                  className={`quick-cli${quickMode === 'agent' && quickCli === c.id ? ' on' : ''}${c.available ? '' : ' off'}`}
                  title={c.available ? c.label : `${c.label} (not installed)`}
                  disabled={!c.available}
                  style={quickMode === 'agent' && quickCli === c.id ? { borderColor: c.color } : undefined}
                  onClick={() => { setQuickMode('agent'); setQuickCli(c.id); }}
                ><Logo cli={c.id} size={14} /></button>
              ))}
              <span className="quick-sep" />
              <button
                className={`quick-cli quick-grp${quickMode === 'group' ? ' on' : ''}`}
                title="New group"
                onClick={() => setQuickMode('group')}
              >
                <span className="grp-mini">
                  <Logo cli="claude" size={8} />
                  <Logo cli="codex" size={8} />
                  <Logo cli="hermes" size={8} />
                  <Logo cli="openclaw" size={8} />
                </span>
              </button>
            </div>

            {quickMode === 'agent' ? (
              <>
                <textarea
                  autoFocus
                  rows={1}
                  className="quick-prompt"
                  placeholder={quickCli ? `prompt for ${clis.find((c) => c.id === quickCli)?.label ?? quickCli}…` : 'prompt…'}
                  value={quickPrompt}
                  onChange={(e) => { setQuickPrompt(e.target.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`; }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitQuick(); }
                    if (e.key === 'Escape') closePanel();
                  }}
                />
                {quickMore && (
                  <>
                    <input
                      placeholder="Name (optional)"
                      value={quickName}
                      onChange={(e) => setQuickName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') submitQuick(); if (e.key === 'Escape') closePanel(); }}
                    />
                    <FolderPicker value={quickLoc} onChange={setQuickLoc} />
                    <div className="widget-actions">
                      <button className="btn-primary" onClick={submitQuick}>Create{quickPrompt.trim() ? ' & send' : ''}</button>
                      <button className="btn-ghost" onClick={closePanel}>Cancel</button>
                    </div>
                  </>
                )}
                <div className="quick-foot">
                  <button className="quick-more" onClick={() => setQuickMore((v) => !v)}>{quickMore ? '▴ less' : '▾ more options'}</button>
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
                  {clis.filter((c) => c.available || (c.id !== 'shell' && c.id !== 'files')).map((c) => {
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

      {/* Overview: pinned above the tree with the row anatomy (tile · name ·
          right slot) so it reads as clickable; the right slot counts agents
          waiting on you. */}
      <div className="ov-fixed">
        <div
          className={`row session ov-row${activeRef === 'overview' ? ' active' : ''}`}
          onClick={() => onActivate('overview')}
          title="All agents: digests, states, replies"
        >
          <span className="status ov-spacer" />
          <span className="ov-tile"><GridGlyph /></span>
          <span className="name">overview</span>
          {waiting > 0 && <span className="ov-wait">{waiting} waiting</span>}
        </div>
      </div>

      <div className="tree" onDragEnd={clearDrag}>
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
          const agents = members.filter((s) => s.cli !== 'shell' && s.cli !== 'files');
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
