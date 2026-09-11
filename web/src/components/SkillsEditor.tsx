import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import type { SkillFile, SkillSnapshot, SkillResult } from '../api';
import { renderMarkdown } from '../lib/markdown';
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
  const [loaded, setLoaded] = useState<SkillSnapshot | null>(null);
  const selected = loaded?.name;
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [uploadText, setUploadText] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<SkillSnapshot | null>(null);
  const [staleConfirmation, setStaleConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SkillResult | null>(null);
  const [latest, setLatest] = useState<SkillSnapshot | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dirty = !!loaded && content !== loaded.content;
  const refresh = async () => setSkills(await api.listSkills());
  const run = async (action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(true);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { working.current = false; setBusy(false); }
  };
  useEffect(() => { run(refresh); }, []);
  useEffect(() => {
    if (confirmDel && !dialog.current?.open) dialog.current?.showModal();
    if (!confirmDel && dialog.current?.open) dialog.current.close();
  }, [confirmDel]);

  const open = (name: string) => run(async () => {
    const skill = await api.getSkill(name);
    setLatest(null); setLoaded(skill); setContent(skill.content); setMode('view'); setConfirmDel(null);
  });
  const showResult = (r: SkillResult) => {
    setResult(r);
    setError(r.ok ? '' : r.error || 'Operation incomplete. Review the remaining state and retry.');
  };
  const create = () => run(async () => {
    let name = newName.trim();
    if (!name) return;
    if (!name.includes('.')) name += '.md';
    const text = uploadText ?? `# ${name.replace(/\.[^.]+$/, '')}\n\n`;
    const r = await api.createSkill(name, text);
    showResult(r);
    if (r.skill) { setLoaded(r.skill); setContent(text); setMode('edit'); }
    // A partial create is now a managed pending save; retry via Save, not POST.
    if (r.skill) { setCreating(false); setNewName(''); setUploadText(null); }
    await refresh();
  });
  const upload = (file: File) => run(async () => {
    const text = await file.text();
    setUploadText(text); setNewName(file.name); setCreating(true);
    const r = await api.createSkill(file.name, text);
    showResult(r);
    if (r.skill) {
      setLoaded(r.skill); setContent(text); setMode(r.ok ? 'view' : 'edit');
      setCreating(false); setUploadText(null); setNewName('');
    }
    await refresh();
  });
  const save = () => run(async () => {
    if (!loaded) return;
    const r = await api.saveSkill(loaded.name, content, loaded.revision);
    showResult(r);
    if (r.skill) setLoaded(r.skill);
    if (r.ok) { setMode('view'); setLatest(null); }
    await refresh();
  });
  const prepareDelete = () => run(async () => {
    if (!loaded) return;
    setConfirmDel(await api.getSkill(loaded.name)); setStaleConfirmation(false);
  });
  const remove = () => run(async () => {
    if (!confirmDel || staleConfirmation) return;
    try {
      const r = await api.deleteSkill(confirmDel.name, confirmDel.revision);
      showResult(r);
      if (r.ok) { setLoaded(null); setContent(''); setConfirmDel(null); }
      else {
        setConfirmDel(r.skill); setLoaded(r.skill);
        if (!r.skill) setStaleConfirmation(true);
      }
      await refresh();
    } catch (e) { setStaleConfirmation(true); throw e; }
  });

  return (
    <div className="skills">
      <div className="skills-list">
        <div className="skills-actions">
          <button className="btn-ghost" disabled={busy || dirty} onClick={() => { setCreating((c) => !c); setUploadText(null); }}>+ New</button>
          <label className="btn-ghost upload-btn">Upload<input type="file" disabled={busy || dirty} hidden accept=".md,.markdown,.txt,text/*" onChange={(e) => { if (e.target.files?.[0]) upload(e.target.files[0]); e.target.value = ''; }} /></label>
        </div>
        {creating && (
          <div className="widget" style={{ margin: '0 0 8px' }}>
            <label>{uploadText !== null ? 'Upload as' : 'New skill name'}<input autoFocus disabled={busy} placeholder="name.md" value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') setCreating(false); }} /></label>
            <button className="btn-primary" disabled={busy || !newName.trim()} onClick={create}>Create</button>
            <button className="btn-ghost" disabled={busy} onClick={() => { setCreating(false); setUploadText(null); }}>Cancel</button>
          </div>
        )}
        {skills.length === 0 && <div className="s-help" style={{ padding: '8px 4px' }}>No skills yet. Create one or upload a markdown file.</div>}
        {skills.map((s) => (
          <button key={s.name} className={`skill-item${selected === s.name ? ' active' : ''}`} disabled={busy || dirty} onClick={() => open(s.name)}>
            <span className="name">{s.name}{s.pending ? ` (${s.pending} pending)` : ''}</span>
          </button>
        ))}
      </div>

      <div className="skills-editor">
        {loaded?.problem && <div className="skill-outcome" role="alert">{loaded.problem}</div>}
        {(error || result?.status === 'partial') && <div className="skill-outcome" role="alert">
          <p>{error}</p>
          {result?.status === 'partial' && <>
            <p>Source: {result.source}. Ownership record: {result.manifest}.</p>
            <ul>{result.targets.map((t) => <li key={t.path}><code>{t.path}</code>: {t.status}{t.error ? ` — ${t.error}` : ''}</li>)}</ul>
          </>}
          {loaded && <button className="btn-ghost" disabled={busy} onClick={() => run(async () => {
            const skill = await api.getSkill(loaded.name);
            setLoaded(skill); setLatest(skill);
          })}>Refresh revision (keep entered text)</button>}
          <button className="btn-ghost" onClick={() => { setError(''); setResult(null); }}>Dismiss</button>
        </div>}
        {latest && <details className="skill-outcome" open><summary>Current saved source — compare before saving your entered text</summary><pre>{latest.content}</pre></details>}
        {!selected ? (
          <div className="files-empty">Select a skill to view, or create a new one.</div>
        ) : (
          <>
            <div className="skills-toolbar">
              <span className="mono skill-title">{selected}</span>
              <span className="spacer" />
              <div className="seg">
                <button className={mode === 'view' ? 'on' : ''} disabled={busy} onClick={() => setMode('view')}>View</button>
                {/* Generated skills are derived from the Space configuration: the
                    server refuses edits and deletion, and the alert above says why. */}
                <button className={mode === 'edit' ? 'on' : ''} disabled={busy || loaded?.pending === 'delete' || loaded?.readOnly} title={loaded?.readOnly ? 'Generated skill — read-only' : undefined} onClick={() => setMode('edit')}>Edit</button>
              </div>
              {mode === 'edit' && !loaded?.readOnly && <button className="btn-primary" disabled={busy || loaded?.pending === 'delete'} onClick={save}>{loaded?.pending === 'write' ? 'Retry save' : 'Save'}</button>}
              {dirty && <button className="btn-ghost" disabled={busy} onClick={() => setContent(loaded?.content || '')}>Discard edits</button>}
              {!loaded?.readOnly && <button className="btn-ghost danger" title="Delete skill" disabled={busy || loaded?.pending === 'write' || !loaded?.managed} onClick={prepareDelete}><TrashGlyph /> Delete</button>}
            </div>
            {mode === 'view' ? (() => {
              const { meta, body } = parseFront(content);
              return (
                <div className="skill-view">
                  {meta && (meta.name || meta.description) && (
                    <div className="skill-meta">
                      {meta.name && (
                        <div className="skill-meta-row">
                          <span className="skill-meta-k">title</span>
                          <span className="skill-meta-v mono">{meta.name}</span>
                        </div>
                      )}
                      {meta.description && (
                        <div className="skill-meta-row">
                          <span className="skill-meta-k">description</span>
                          <span className="skill-meta-v">{meta.description}</span>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
                </div>
              );
            })() : (
              <textarea aria-label="Skill content" disabled={busy} className="skill-text" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
            )}
          </>
        )}
      </div>
      <dialog ref={dialog} className="skill-delete-dialog" aria-labelledby="skill-delete-title"
        onCancel={(e) => { e.preventDefault(); if (!working.current) setConfirmDel(null); }}>
        {confirmDel && <>
          <h2 id="skill-delete-title">Permanently delete {confirmDel.name}?</h2>
          <p>This permanently deletes the source and the managed files listed below. It cannot be undone.</p>
          <ul>{confirmDel.installations.map((t) => <li key={t.path}><code>{t.path}</code>{!t.exists ? ' (already absent)' : ''}{t.error ? ` — ${t.error}` : ''}</li>)}</ul>
          {!confirmDel.installations.length && <p>No managed installations. Only the source will be deleted.</p>}
          {error && <p role="alert">{error}</p>}
          {result?.status === 'partial' && <p>Source: {result.source}. Ownership record: {result.manifest}. Remaining installations are listed above.</p>}
          <div className="skill-delete-actions">
            <button autoFocus className="btn-ghost" disabled={busy} onClick={() => setConfirmDel(null)}>Cancel</button>
            {staleConfirmation
              ? <button className="btn-ghost" disabled={busy} onClick={prepareDelete}>Refresh confirmation</button>
              : <button className="btn-danger" disabled={busy} onClick={remove}>{busy ? 'Deleting…' : confirmDel.pending === 'delete' ? 'Retry permanent deletion' : 'Permanently delete'}</button>}
          </div>
        </>}
      </dialog>
    </div>
  );
}
