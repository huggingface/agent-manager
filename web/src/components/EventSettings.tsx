import {useEffect,useState} from 'react';
import * as api from '../api';
export default function EventSettings(){
 const [data,setData]=useState<api.EventSettingsData|null>(null),[error,setError]=useState('');
 const [selected,setSelected]=useState(''),[workflow,setWorkflow]=useState<api.EventWorkflow|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const choose=(d:api.EventSettingsData,id:string)=>{const source=d.sources.find(s=>s.id===id)||d.sources[0];setData(d);setSelected(source?.id||'');setWorkflow(source?.workflow||null);};
 const load=()=>{setError('');void api.getEventSettings().then(d=>choose(d,selected)).catch(e=>setError(e.message));};
 useEffect(()=>{load();},[]);
 const source=data?.sources.find(s=>s.id===selected);
 const save=async()=>{if(!workflow||!data?.revision)return;setBusy(true);setError('');setMessage('');
  try{const next=await api.saveEventWorkflow(selected,data.revision,workflow);choose(next,selected);setMessage('Saved. New events use these instructions. Previously queued events under the old policy are not replayed.');}
  catch(e){setError((e as Error).message+' Your edits are still here. Reload to inspect server settings before trying again.');}
  finally{setBusy(false);}
 };
 return <div className="event-source-settings">
  <p className="s-help">Choose what happens when an new meeting reaches a session. Saving instructions does not start the detector.</p>
  {error&&<p role="alert">{error}</p>}
  {!data&&!error&&<p>Loading…</p>}
  {data&&!data.configured&&<p>No event-source source is installed yet. The local proxy and a destination must be configured first.</p>}
  {data&&source&&workflow&&<>
   <label>Source <select value={selected} disabled={busy} onChange={e=>{choose(data,e.target.value);setMessage('');setError('');}}>{data.sources.map(s=><option key={s.id} value={s.id}>{s.id} · {s.provider}</option>)}</select></label>
   <p>Destination: <strong>{source.sessionName}</strong><br/>Source: <strong>{source.enabled?'Enabled locally — check detector status':'Inactive'}</strong></p>
   <label>Start from a template <select value="" disabled={busy} onChange={e=>{const p=data.presets.find(p=>p.id===e.target.value);if(p){setWorkflow({mode:p.mode,instructions:p.instructions});setMessage('');}}}><option value="" disabled>Choose a template…</option>{data.presets.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
   <label>Allowed actions <select value={workflow.mode} disabled={busy} onChange={e=>setWorkflow({...workflow,mode:e.target.value as api.EventWorkflow['mode']})}>
    <option value="research">Research and report only</option><option value="drafts">Research + unsent Gmail/Beeper drafts</option><option value="drafts-calendar">Research + drafts + personal calendar events</option></select></label>
   <label>Instructions<textarea rows={18} maxLength={12000} disabled={busy} value={workflow.instructions} onChange={e=>setWorkflow({...workflow,instructions:e.target.value})} /></label>
   <p className="s-help">No messages are sent. Calendar events have no guests. The selected actions remain subject to connector access; unavailable actions are reported as blocked. Drafts already present are preserved.</p>
   <button disabled={busy||!workflow.instructions.trim()} onClick={()=>void save()}>{busy?'Saving…':'Save instructions'}</button>
  </>}
  <button disabled={busy} onClick={load}>Reload saved settings</button>
  {message&&<p role="status">{message}</p>}
 </div>;
}
