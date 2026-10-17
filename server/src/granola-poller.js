// Only outbound HTTP over the credential proxy's Unix socket. Never read a key.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {privateFile,hash,policyStamp} from './session-event-policy.js';
export const PROXY_SOCKET='/run/thomas-api-proxy/proxy.sock';
const stamp=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v));
export function proxyGet(query,{socketPath=PROXY_SOCKET,timeout=25000}={}){
 const q=new URLSearchParams(query);
 for(const k of q.keys())if(!['created_after','updated_after','page_size','cursor'].includes(k))throw new Error('invalid-query');
 return new Promise((resolve,reject)=>{
  let timer;const req=http.request({socketPath,path:'/granola/v1/notes?'+q,method:'GET',headers:{Accept:'application/json'}},res=>{
   const chunks=[];let size=0;
   res.on('data',chunk=>{size+=chunk.length;if(size>2097152)req.destroy(new Error('response-too-large'));else chunks.push(chunk);});
   res.on('aborted',()=>reject(new Error('response-incomplete')));
   res.on('error',()=>reject(new Error('proxy-unavailable')));
   res.on('end',()=>{
    clearTimeout(timer);
    if(res.statusCode!==200){const error=new Error('proxy-status-'+res.statusCode);error.status=res.statusCode;
     const retry=res.headers['retry-after'];const seconds=/^\d+$/.test(retry||'')?Number(retry):(Date.parse(retry)-Date.now())/1000;
     error.retryAfter=Number.isFinite(seconds)?Math.max(30,Math.min(86400,seconds)):null;
     // A disabled provider is an access/configuration fault, not transient network trouble.
     try{const body=JSON.parse(Buffer.concat(chunks));if(body?.error?.code==='provider_disabled')error.disabled=true;}catch{}
     reject(error);return;
    }
    try{resolve(JSON.parse(Buffer.concat(chunks)));}catch{reject(new Error('invalid-json'));}
   });
  });
  req.on('error',()=>{clearTimeout(timer);reject(new Error('proxy-unavailable'));});
  timer=setTimeout(()=>req.destroy(new Error('deadline')),timeout);timer.unref();req.end();
 });
}
export class GranolaPoller {
 constructor({dir,sources,events,request=proxyGet,now=Date.now}){
  Object.assign(this,{dir,sources,events,request,now});this.running=false;
  fs.mkdirSync(dir,{recursive:true,mode:0o700});const st=fs.lstatSync(dir);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077))throw new Error('unsafe-poll-state');
 }
 file(id){return path.join(this.dir,hash(id)+'.json');}
 load(source){try{
   const state=JSON.parse(privateFile(this.file(source.id),null));
   if(state.version!==1||state.id!==source.id||!stamp(state.activatedAt)||!Number.isFinite(state.nextAt)||!Number.isInteger(state.failures))throw new Error('invalid-state');
   return state;
  }catch(e){if(e.code!=='ENOENT')throw e;return {version:1,id:source.id,activatedAt:new Date(this.now()).toISOString(),watermark:null,lastFull:0,nextAt:0,failures:0,status:'initializing'};}
 }
 save(state){const dest=this.file(state.id),tmp=dest+'.'+randomUUID()+'.tmp';let fd;
  try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(state));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(tmp,dest);fd=fs.openSync(this.dir,'r');fs.fsyncSync(fd);}
  finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch{}}
 }
 current(source){const latest=this.sources().get(source.id);if(!latest?.enabled||policyStamp(latest)!==policyStamp(source))throw new Error('source-changed');}
 async poll(source){
  let state=this.load(source);const policy=policyStamp(source);
  if(state.policy!==policy){state.policy=policy;state.failures=0;state.status='ready';state.nextAt=0;}
  if(state.status==='blocked'||this.now()<state.nextAt)return;
  const started=this.now();const full=!state.watermark||started-state.lastFull>=3600000;
  // Persist the activation cutoff before any I/O, so a crash never expands history.
  this.save(state);
  try{
   let cursor=null,done=false;const cursors=new Set(),notes=new Map();
   for(let page=0;page<20;page++){
    const query={created_after:state.activatedAt,page_size:'30'};
    if(!full)query.updated_after=new Date(Math.max(Date.parse(state.activatedAt),Date.parse(state.watermark)-300000)).toISOString();
    if(cursor)query.cursor=cursor;
    const data=await this.request(query);this.current(source);
    if(!data||!Array.isArray(data.notes)||data.notes.length>30||typeof data.hasMore!=='boolean')throw new Error('invalid-page');
    for(const n of data.notes){
     if(!n||!/^not_[A-Za-z0-9]{14}$/.test(n.id)||!stamp(n.created_at)||!stamp(n.updated_at)||!n.owner||typeof n.owner.email!=='string'
       ||!(n.deleted_at===null||stamp(n.deleted_at)))throw new Error('invalid-note');
     if(Date.parse(n.created_at)>this.now()+300000||Date.parse(n.updated_at)>this.now()+300000)throw new Error('future-note');
     if(n.owner.email.toLowerCase()===source.ownerEmail.toLowerCase()&&n.deleted_at===null&&Date.parse(n.created_at)>=Date.parse(state.activatedAt))notes.set(n.id,n);
    }
    if(!data.hasMore){done=true;break;}
    if(typeof data.cursor!=='string'||!data.cursor||data.cursor.length>4096||/[\x00-\x1f\x7f]/.test(data.cursor)||cursors.has(data.cursor))throw new Error('invalid-cursor');
    cursor=data.cursor;cursors.add(cursor);
   }
   if(!done)throw new Error('page-budget');
   this.current(source);
   // Jobs reach stable storage before checkpoint advances. Replay dedupes by note ID.
   for(const n of notes.values())this.events.enqueue(source.id,{id:n.id,type:'note.ready',resourceId:n.id,occurredAt:n.updated_at,createdAt:n.created_at,activatedAt:state.activatedAt});
   state.watermark=new Date(started).toISOString();if(full)state.lastFull=started;
   state.status='ready';state.reason=null;state.lastSuccessAt=new Date(this.now()).toISOString();state.failures=0;state.lastCount=notes.size;
   state.nextAt=Math.max(started+30000,this.now()+1000);this.save(state);
  }catch(e){
   state.failures++;state.status=[401,403].includes(e.status)||e.disabled?'blocked':'backoff';
   state.reason=e.message==='source-changed'?'source-changed':e.status?'proxy-status-'+e.status:'poll-failed';
   const delay=e.retryAfter?e.retryAfter*1000:Math.min(1800000,30000*2**Math.min(state.failures,6));
   state.nextAt=this.now()+delay;this.save(state);
  }
 }
 async tick(){if(this.running)return;this.running=true;try{for(const source of this.sources().values())if(source.enabled)await this.poll(source);}finally{this.running=false;}}
 status(){return [...this.sources().values()].map(s=>{let state;try{state=this.load(s);}catch{return {id:s.id,enabled:s.enabled,status:'state-unavailable'};}
  return {id:s.id,enabled:s.enabled,status:s.enabled?state.status:'disabled',reason:state.reason||null,activatedAt:state.watermark?state.activatedAt:null,lastSuccessAt:state.lastSuccessAt||null,nextAt:state.nextAt||null};});}
 start(){this.tick().catch(()=>{});this.timer=setInterval(()=>this.tick().catch(()=>{}),1000);this.timer.unref();}
 stop(){clearInterval(this.timer);}
}
