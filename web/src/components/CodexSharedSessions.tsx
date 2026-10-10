import { useEffect, useRef, useState } from 'react';
import { codexSharedSnapshot, importCodexTask, type CodexSharedSnapshot } from '../api';

const labels = {
  working: 'Working', 'needs-input': 'Needs your input', idle: 'Ready',
  unloaded: 'Saved · not loaded', error: 'Task error', unknown: 'State unknown',
};

// Manual inspection; importing only adds a view of an existing shared thread.
// It never releases a writer or sends input to a task.
export default function CodexSharedSessions() {
  const [snapshot, setSnapshot] = useState<CodexSharedSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState('');
  const generation = useRef(0);
  const pending = useRef(false);
  useEffect(() => () => { generation.current++; }, []);
  const inspect = async (cursor?: string | null) => {
    if (pending.current) return;
    pending.current = true;
    const mine = ++generation.current;
    setBusy(true); setError('');
    try {
      const result = await codexSharedSnapshot(cursor);
      if (mine !== generation.current) return;
      // Every page is its own fresh snapshot; do not mix different observation times.
      setSnapshot(result);
    } catch {
      if (mine !== generation.current) return;
      setSnapshot(null);
      setError('Server unavailable or incompatible. Task state is unknown; existing sessions are unchanged.');
    } finally {
      pending.current = false;
      if (mine === generation.current) setBusy(false);
    }
  };
  const add = async (threadId: string) => {
    if (importing) return;
    setImporting(threadId); setImportMessage('');
    try {
      const { session } = await importCodexTask(threadId);
      setImportMessage(`Added ${session.name}. Open it from the session list to continue the same conversation.`);
      setSnapshot((current) => current && ({ ...current, tasks: current.tasks.map((task) => task.id === threadId
        ? { ...task, amSessions: [{ id: session.id, name: session.name }] } : task) }));
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : 'Could not add this task. No task was started or interrupted.');
    } finally { setImporting(null); }
  };
  return (
    <section aria-label="Codex multi-device preview" className="codex-shared-preview">
      <div className="setting-row">
        <div>
          <div className="s-label">Codex multi-device preview</div>
          <div className="s-help">Inspect tasks on a configured shared server. This preview does not move or interrupt sessions.</div>
        </div>
        <button className="btn-ghost" disabled={busy || !!importing} onClick={() => void inspect()}>
          {busy ? 'Checking…' : 'Check server'}
        </button>
      </div>
      <div role="status" aria-live="polite">
        {error && <p className="s-help">{error}</p>}
        {importMessage && <p className="s-help">{importMessage}</p>}
        {snapshot?.connection === 'not-configured' && <p className="s-help">No shared server is configured for this preview.</p>}
        {snapshot?.connection === 'connected' && <>
          <p className="s-help">Connected{snapshot.serverVersion ? ` · Codex ${snapshot.serverVersion}` : ''}
            {' · '}Checked {new Date(snapshot.observedAt).toLocaleTimeString()}. Refresh to update task states.</p>
          <p className="s-help">Default shared creation is not enabled: cross-device approvals and task lifecycle checks are still pending.</p>
          {!snapshot.tasks.length && <p className="s-help">No tasks on this page.</p>}
          <ul className="codex-shared-tasks">
            {snapshot.tasks.map((task) => <li key={task.id}>
              <strong>{task.name || task.amSessions[0]?.name || 'Untitled task'}</strong>
              {' — '}{labels[task.status]}
              {task.amSessions.length > 0 && <div className="s-help">AM: {task.amSessions.map((s) => s.name).join(', ')}</div>}
              {snapshot.importEnabled && task.status === 'idle' && <button className="btn-ghost"
                disabled={!!importing || busy} onClick={() => void add(task.id)}>
                {importing === task.id ? 'Adding…' : 'Add to AM'}
              </button>}
              <details><summary>Task details</summary>
                <div className="mono">{task.id}</div>
                {task.cwd && <div>{task.cwd}</div>}
              </details>
            </li>)}
          </ul>
          {snapshot.nextCursor && <button className="btn-ghost" disabled={busy}
            onClick={() => void inspect(snapshot.nextCursor)}>Next page</button>}
        </>}
      </div>
    </section>
  );
}
