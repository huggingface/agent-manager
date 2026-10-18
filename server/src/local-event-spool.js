// Local same-UID producers only; no HTTP ingress and no agent impersonation.
import fs from 'node:fs';
import path from 'node:path';
import {privateFile,policyStamp} from './session-event-policy.js';
const filename=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/;
export class LocalEventSpool {
 constructor({sources,events,workspaces}){Object.assign(this,{sources,events,workspaces});this.states=new Map();}
 directory(source){
  const dir=source.inbox,st=fs.lstatSync(dir);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077)||fs.realpathSync(dir)!==dir)throw Error('unsafe-inbox');
  if(this.workspaces){const rel=path.relative(fs.realpathSync(this.workspaces),dir);if(!rel||(!rel.startsWith('../')&&rel!=='..'&&!path.isAbsolute(rel)))throw Error('workspace-inbox');}
  return dir;
 }
 tick(){
  for(const source of this.sources().values()){
   if(source.provider!=='local-monitor'||!source.enabled)continue;
   try{
    const dir=this.directory(source),names=fs.readdirSync(dir);
    if(names.length>200)throw Error('inbox-budget');
    let blocked=false;
    for(const name of names){
     if(!filename.test(name)){if(!name.endsWith('.tmp'))blocked=true;continue;}
     try{
      const file=path.join(dir,name),raw=privateFile(file,null,4096),event=JSON.parse(raw);
      if(name!==event.id+'.json')throw Error('event-id');
      const current=this.sources().get(source.id);
      if(!current?.enabled||policyStamp(current)!==policyStamp(source))throw Error('source-changed');
      // Import durably before unlink. A crash between the two is a safe replay.
      this.events.enqueue(source.id,event);
      // Same-UID producers must publish atomically and never replace a UUID.
      // Refuse deleting a replaced file, even though its original is now durable.
      this.directory(source);
      if(privateFile(file,null,4096)!==raw)throw Error('event-changed');
      fs.unlinkSync(file);const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
     }catch{blocked=true;}
    }
    this.states.set(source.id,blocked?'blocked':'ready');
   }catch{this.states.set(source.id,'blocked');}
  }
 }
 status(){return [...this.sources().values()].filter(s=>s.provider==='local-monitor').map(s=>({id:s.id,enabled:s.enabled,status:s.enabled?(this.states.get(s.id)||'initializing'):'disabled'}));}
 start(){this.tick();this.timer=setInterval(()=>{try{this.tick();}catch{}},3000);this.timer.unref();}
 stop(){clearInterval(this.timer);}
}
