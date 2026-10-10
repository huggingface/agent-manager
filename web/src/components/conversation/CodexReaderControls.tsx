import { useEffect, useRef, useState } from 'react';
import * as api from '../../api';
import { writePaneMode } from '../../lib/paneMode';

function Request({ sessionId, request, refresh }: { sessionId: string; request: api.CodexReaderRequest; refresh: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const p = request.params;
  const command = request.method === 'item/commandExecution/requestApproval';
  const files = request.method === 'item/fileChange/requestApproval';
  const permissions = request.method === 'item/permissions/requestApproval';
  const question = request.method === 'item/tool/requestUserInput';
  const allowed = command ? (p.availableDecisions || ['accept', 'decline']).filter((v: unknown) => ['accept', 'decline'].includes(String(v)))
    : files ? (p.grantRoot || !request.item?.changes ? ['decline'] : ['accept', 'decline']) : permissions ? ['accept', 'decline'] : [];
  const answer = async (response: {decision?: string; answers?: Record<string, string>}) => {
    setBusy(true); setError('');
    try { await api.answerCodexRequest(sessionId, request.key, response); refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not answer. Refresh and check the request.'); }
    finally { setBusy(false); }
  };
  return <section className="codex-reader-request" aria-label="Codex request">
    <strong>{question ? 'Codex needs your answer' : 'Codex needs approval'}</strong>
    {question ? (p.questions || []).map((q: any) => <div key={q.id} style={{display:'block',marginTop:8}}>
      {q.question}
      {!!q.options?.length && <div>{q.options.map((o: any) => <button key={o.label} className="cxv-mini" disabled={busy} title={o.description}
        onClick={() => setAnswers(a => ({...a, [q.id]:o.label}))}>{o.label}</button>)}</div>}
      <input aria-label={q.question} type={q.isSecret ? 'password' : 'text'} autoComplete="off" value={answers[q.id] || ''}
        onChange={e => setAnswers(a => ({...a,[q.id]:e.target.value}))} disabled={busy} style={{width:'100%',boxSizing:'border-box'}} />
    </div>) : <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:220,overflow:'auto'}}>{JSON.stringify({
      ...(p.reason ? {reason:p.reason}:{}), ...(command ? {command:p.command,kind:p.kind,cwd:p.cwd,network:p.networkApprovalContext,permissions:p.additionalPermissions}:{}),
      ...(files ? {changes:request.item?.changes,grantRoot:p.grantRoot}:{}), ...(permissions ? {permissions:p.permissions,cwd:p.cwd}:{}),
      ...(!command && !files && !permissions ? {request:request.method}:{}),
    }, null, 2)}</pre>}
    {question && <button className="cxv-mini" disabled={busy || !(p.questions || []).every((q: any) => answers[q.id]?.trim())} onClick={() => void answer({answers})}>Submit answers</button>}
    {allowed.includes('accept') && <button className="cxv-mini" disabled={busy} onClick={() => void answer({decision:'accept'})}>Approve once</button>}
    {allowed.includes('decline') && <button className="cxv-mini" disabled={busy} onClick={() => void answer({decision:'decline'})}>Deny</button>}
    {!question && !allowed.includes('accept') && <button className="cxv-mini" onClick={() => writePaneMode('terminal')}>Review in Terminal</button>}
    {error && <div role="alert">{error}</div>}
  </section>;
}
export default function CodexReaderControls({ sessionId, paused, onState }: { sessionId: string; paused?: boolean; onState: (state: api.CodexReaderState | null) => void }) {
  const [state, setState] = useState<api.CodexReaderState | null>(null), [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false), [revision, setRevision] = useState(0);
  const report = useRef(onState); report.current = onState;
  useEffect(() => {
    if (paused) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>; const controller = new AbortController();
    const tick = async () => {
      try {
        if (document.visibilityState !== 'hidden') {
          const next = await api.getCodexReader(sessionId, controller.signal);
          if (!stopped) { setState(next); setError(''); report.current(next); }
        }
      } catch (e) { if (!stopped) { setError(e instanceof Error ? e.message : 'Connection unavailable'); report.current(null); } }
      finally { if (!stopped) timer = setTimeout(tick, 1500); }
    };
    void tick(); return () => { stopped = true; clearTimeout(timer); controller.abort(); report.current(null); };
  }, [sessionId, paused, revision]);
  const refresh = () => setRevision(v => v + 1);
  const connect = async () => {
    setConnecting(true);
    try { await api.connectCodexReader(sessionId); refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not connect.'); }
    finally { setConnecting(false); }
  };
  return <div className="codex-reader-controls" style={{flexShrink:0,maxHeight:'45%',overflow:'auto',padding:'6px 12px',borderTop:'1px solid var(--border)'}}>
    {error && <div role="alert">{error} <button className="cxv-mini" onClick={refresh}>Retry</button></div>}
    <div role="status">{!state ? 'Connecting to Codex…' : state.status === 'working' ? 'Codex is working…' : state.status === 'needs-input' ? 'Codex needs your input' : state.status === 'idle' ? 'Ready to reply' : 'Open this task in Terminal or Codex Remote first.'}</div>
    {state && !state.connected && <button className="cxv-mini" disabled={connecting} onClick={() => void connect()}>{connecting ? 'Connecting…' : 'Connect live requests'}</button>}
    {state?.requests.map(request => <Request key={request.key} sessionId={sessionId} request={request} refresh={refresh} />)}
    {state?.status === 'working' && state.liveText && <details><summary>Live response</summary><div style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{state.liveText}</div></details>}
    {state?.turnError && <div role="alert">{state.turnError}</div>}
  </div>;
}
