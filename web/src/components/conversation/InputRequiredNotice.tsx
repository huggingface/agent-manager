import {useState} from 'react';
import type {InputRequired} from '../../types';
import {answerSessionRequest, type SessionRequest} from '../../api';
const detail=(kind:InputRequired['kind'])=>kind==='permission'?'permission prompt waiting in the terminal':kind==='question'?'question or choice menu waiting in the terminal':'confirmation dialog waiting in the terminal';
function Request({request,sessionId,onAnswered,onOpenTerminal}:{request:SessionRequest;sessionId:string;onAnswered?:()=>void;onOpenTerminal:()=>void}) {
 const [answers,setAnswers]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const submit=async(response:{decision?:string;answers?:Record<string,string>})=>{
  setBusy(true);setError('');try{await answerSessionRequest(sessionId,request.key,response);onAnswered?.();}
  catch(e){setError(e instanceof Error?e.message:'Could not answer. Refresh and retry.');}finally{setBusy(false);}
 };
 return <div className="input-required" role="status" style={{display:'block'}}>
  <span className="input-required-label">needs input</span>
  {request.details && <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:220,overflow:'auto'}}>{request.details}</pre>}
  {request.questions?.map(q=><div key={q.id} style={{marginTop:8}}><div>{q.text}</div>
   {q.options.map(o=><button key={o.label} title={o.description} disabled={busy} onClick={()=>setAnswers(a=>({...a,[q.id]:o.label}))}>{o.label}</button>)}
   <input aria-label={q.text} type={q.secret?'password':'text'} value={answers[q.id]||''} autoComplete="off" disabled={busy} onChange={e=>setAnswers(a=>({...a,[q.id]:e.target.value}))} style={{width:'100%',boxSizing:'border-box'}}/>
  </div>)}
  {request.questions && <button disabled={busy||!request.questions.every(q=>answers[q.id]?.trim())} onClick={()=>void submit({answers})}>Submit answers</button>}
  {request.choices.map(c=><button key={c.value} disabled={busy} onClick={()=>void submit({decision:c.value})}>{c.label}</button>)}
  {request.terminalFallback && <button onClick={onOpenTerminal}>open terminal</button>}
  {error && <div role="alert">{error}</div>}
 </div>;
}
export default function InputRequiredNotice({input,onOpenTerminal,requests,sessionId,onAnswered}:{input:InputRequired;onOpenTerminal:()=>void;requests?:SessionRequest[];sessionId?:string;onAnswered?:()=>void}) {
 if(requests?.length&&sessionId)return <>{requests.map(r=><Request key={r.key} request={r} sessionId={sessionId} onAnswered={onAnswered} onOpenTerminal={onOpenTerminal}/>)}</>;
 return <div className="input-required" role="status"><span className="input-required-mark" aria-hidden="true">!</span><span className="input-required-copy"><span className="input-required-label">needs input</span> · {detail(input.kind)}</span><button type="button" onClick={onOpenTerminal}>open terminal</button></div>;
}
