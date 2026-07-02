import { useMemo, useState } from 'react';
import type { Cli, MoveTarget, Group, Session, Tree } from '../types';
import { STATE_LABEL } from '../types';
import Logo from './Logo';
import NewSession from './NewSession';
import FolderPicker from './FolderPicker';

type Zone = 'before' | 'after' | 'on';

export default function Sidebar({
  clis, tree, activeRef, focusedId, defaultPath,
  onActivate, onOpenSession, onNewSession, onNewGroup, onRenameGroup, onRenameSession, onDeleteGroup,
  onStopSession, onDeleteSession, onMove, onOpenSettings, theme, onToggleTheme,
}: {
  clis: Cli[];
  tree: Tree;
  activeRef: string | null;
  focusedId: string | null;
  defaultPath: string;
  onActivate: (ref: string) => void;
  onOpenSession: (sessionId: string, groupId?: string) => void;
  onOpenSettings: () => void;
  onNewSession: (name: string, cli: string, path: string) => void;
  onNewGroup: (name: string, cart?: { cli: string; count: number }[], path?: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onDeleteGroup: (id: string) => void;
  onStopSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onMove: (ref: string, to: MoveTarget) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}) {
  const [panel, setPanel] = useState<'none' | 'session' | 'group'>('none');
  const [groupName, setGroupName] = useState('');
  const [groupLoc, setGroupLoc] = useState(defaultPath);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [editRef, setEditRef] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragRef, setDragRef] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ ref: string; zone: Zone } | null>(null);

  const sessById = useMemo(() => Object.fromEntries(tree.sessions.map((s) => [s.id, s])), [tree.sessions]);
  const groupById = useMemo(() => Object.fromEntries(tree.groups.map((g) => [g.id, g])), [tree.groups]);

  const clearDrag = () => { setDragRef(null); setDrop(null); };
  const bump = (id: string, d: number) => setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] || 0) + d) }));
  const submitGroup = () => {
    const items = Object.entries(cart).filter(([, n]) => n > 0).map(([cli, count]) => ({ cli, count }));
    onNewGroup(groupName.trim() || 'Group', items, groupLoc);
    setGroupName(''); setCart({}); setPanel('none');
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
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('text/plain', ref); e.dataTransfer.effectAllowed = 'move'; setDragRef(ref); },
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
        className={`row session${active ? ' active' : ''}${nested ? ' nested' : ''}${dragRef === ref ? ' dragging' : ''}${dnd.className}`}
        draggable={dnd.draggable}
        onDragStart={dnd.onDragStart} onDragEnd={dnd.onDragEnd} onDragOver={dnd.onDragOver} onDrop={dnd.onDrop}
        onClick={() => onOpenSession(s.id, groupId)}
        onDoubleClick={(e) => { e.stopPropagation(); startEdit(ref, s.name); }}
        title={s.path ? `${s.name} · ${s.path}` : s.name}
      >
        <span className={`status ${s.state}`} title={STATE_LABEL[s.state]} />
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
        <Logo cli={s.cli} size={13} />
        <span className="row-actions">
          {s.running && <button className="mini-btn" title="Stop" onClick={(e) => { e.stopPropagation(); onStopSession(s.id); }}>■</button>}
          <button className="mini-btn" title="Delete" onClick={(e) => { e.stopPropagation(); onDeleteSession(s.id); }}>🗑</button>
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
      <div key={g.id} className={`group${activeRef === ref ? ' active' : ''}${drop && drop.ref === ref && drop.zone === 'on' ? ' drop-into' : ''}`}>
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
              <span className="count">{g.sessionIds.length}</span>
              <span className="row-actions">
                <button className="mini-btn" title="Rename" onClick={(e) => { e.stopPropagation(); startEdit(ref, g.name); }}>✎</button>
                <button className="mini-btn" title="Delete group" onClick={(e) => { e.stopPropagation(); onDeleteGroup(g.id); }}>🗑</button>
              </span>
            </>
          )}
        </div>
        {open && g.sessionIds.map((sid) => sessById[sid]).filter(Boolean).map((s) => SessionRow(s as Session, g.id))}
        {open && g.sessionIds.length === 0 && <div className="empty-hint nested">Drag agents here</div>}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo"><span className="dot" /><h1>Agent Manager</h1></div>
        <div className="brand-actions">
          <button className="icon-btn" onClick={onOpenSettings} title="Settings">⚙</button>
          <button className="icon-btn" onClick={onToggleTheme} title="Toggle light / dark">{theme === 'dark' ? '☾' : '☀'}</button>
        </div>
      </div>

      <div className="controls">
        <div className="add-row">
          <button className={`btn-ghost${panel === 'session' ? ' on' : ''}`} onClick={() => setPanel(panel === 'session' ? 'none' : 'session')}>+ Agent</button>
          <button className={`btn-ghost${panel === 'group' ? ' on' : ''}`} onClick={() => setPanel(panel === 'group' ? 'none' : 'group')}>+ Group</button>
        </div>
        {panel === 'session' && (
          <NewSession clis={clis} defaultPath={defaultPath} onCreate={(n, c, p) => { onNewSession(n, c, p); setPanel('none'); }} onCancel={() => setPanel('none')} />
        )}
        {panel === 'group' && (
          <div className="widget">
            <input autoFocus placeholder="Group name" value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitGroup(); if (e.key === 'Escape') setPanel('none'); }} />
            <FolderPicker value={groupLoc} autoLabel="new folder per agent (auto)" onChange={setGroupLoc} />
            <div className="cart">
              {clis.filter((c) => c.available).map((c) => {
                const n = cart[c.id] || 0;
                return (
                  <div key={c.id} className={`cart-row${n > 0 ? ' has' : ''}`}>
                    <div className="stepper">
                      <button onClick={() => bump(c.id, -1)} disabled={n === 0} aria-label="Fewer">−</button>
                      <span className="stepper-n">{n}</span>
                      <button onClick={() => bump(c.id, 1)} aria-label="More">+</button>
                    </div>
                    <Logo cli={c.id} size={16} />
                    <span className="cart-name">{c.label}</span>
                  </div>
                );
              })}
            </div>
            <div className="widget-actions">
              <button className="btn-primary" onClick={submitGroup}>Create group</button>
              <button className="btn-ghost" onClick={() => { setCart({}); setPanel('none'); }}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="tree" onDragEnd={clearDrag}>
        {tree.order.length === 0 && (
          <div className="empty-hint">Nothing yet. Add an agent or a group above.<br />Drag an agent onto another to group them.</div>
        )}
        {tree.order.map((ref) => (ref.startsWith('s:')
          ? (sessById[ref.slice(2)] ? SessionRow(sessById[ref.slice(2)]) : null)
          : (groupById[ref.slice(2)] ? GroupBlock(groupById[ref.slice(2)]) : null)))}
      </div>

      <div className="legend">
        <span><span className="status working" /> working</span>
        <span><span className="status waiting" /> your turn</span>
        <span><span className="status idle" /> idle</span>
        <span><span className="status stopped" /> stopped</span>
      </div>
    </aside>
  );
}
