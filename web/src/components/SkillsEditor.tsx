import { useEffect, useState } from 'react';
import { marked } from 'marked';
import * as api from '../api';
import type { SkillFile } from '../api';
import { TrashGlyph } from './icons';

// Split YAML-ish frontmatter (name/description) from the markdown body.
function parseFront(md: string): { meta: Record<string, string> | null; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: null, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

export default function SkillsEditor() {
  const [skills, setSkills] = useState<SkillFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);

  const refresh = () => api.listSkills().then(setSkills).catch(() => {});
  useEffect(() => { refresh(); }, []);

  const open = async (name: string) => {
    const r = await api.getSkill(name);
    setSelected(name);
    setContent(r.content);
    setMode('view');
    setConfirmDel(false);
  };

  const create = async () => {
    let name = newName.trim();
    if (!name) return;
    if (!name.includes('.')) name += '.md';
    await api.saveSkill(name, `# ${name.replace(/\.[^.]+$/, '')}\n\n`);
    setCreating(false);
    setNewName('');
    await refresh();
    await open(name);
    setMode('edit');
  };

  const upload = async (file: File) => {
    const text = await file.text();
    await api.saveSkill(file.name, text);
    await refresh();
    await open(file.name);
  };

  const save = async () => {
    if (!selected) return;
    await api.saveSkill(selected, content);
    refresh();
    setMode('view');
  };

  const remove = async () => {
    if (!selected) return;
    await api.deleteSkill(selected);
    setSelected(null);
    setContent('');
    setConfirmDel(false);
    refresh();
  };

  return (
    <div className="skills">
      <div className="skills-list">
        <div className="skills-actions">
          <button className="btn-ghost" onClick={() => setCreating((c) => !c)}>+ New</button>
          <label className="btn-ghost upload-btn">Upload<input type="file" hidden accept=".md,.markdown,.txt,text/*" onChange={(e) => { if (e.target.files?.[0]) upload(e.target.files[0]); e.target.value = ''; }} /></label>
        </div>
        {creating && (
          <div className="widget" style={{ margin: '0 0 8px' }}>
            <input autoFocus placeholder="name.md" value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') setCreating(false); }} />
          </div>
        )}
        {skills.length === 0 && <div className="s-help" style={{ padding: '8px 4px' }}>No skills yet. Create one or upload a markdown file.</div>}
        {skills.map((s) => (
          <button key={s.name} className={`skill-item${selected === s.name ? ' active' : ''}`} onClick={() => open(s.name)}>
            <span className="name">{s.name}</span>
          </button>
        ))}
      </div>

      <div className="skills-editor">
        {!selected ? (
          <div className="files-empty">Select a skill to view, or create a new one.</div>
        ) : (
          <>
            <div className="skills-toolbar">
              <span className="mono skill-title">{selected}</span>
              <span className="spacer" />
              <div className="seg">
                <button className={mode === 'view' ? 'on' : ''} onClick={() => setMode('view')}>View</button>
                <button className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')}>Edit</button>
              </div>
              {mode === 'edit' && <button className="btn-primary" onClick={save}>Save</button>}
              {confirmDel ? (
                <span className="confirm-del">
                  <span className="s-muted">Delete from all agents?</span>
                  <button className="btn-danger" onClick={remove}>Delete</button>
                  <button className="btn-ghost" onClick={() => setConfirmDel(false)}>Cancel</button>
                </span>
              ) : (
                <button className="btn-ghost danger" title="Delete skill" onClick={() => setConfirmDel(true)}><TrashGlyph /> Delete</button>
              )}
            </div>
            {mode === 'view' ? (() => {
              const { meta, body } = parseFront(content);
              return (
                <div className="skill-view">
                  {meta && (meta.name || meta.description) && (
                    <div className="skill-meta">
                      {meta.name && <div className="skill-meta-name mono">{meta.name}</div>}
                      {meta.description && <div className="skill-meta-desc">{meta.description}</div>}
                    </div>
                  )}
                  <div className="markdown" dangerouslySetInnerHTML={{ __html: marked.parse(body) as string }} />
                </div>
              );
            })() : (
              <textarea className="skill-text" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
