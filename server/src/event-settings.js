import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {ApiError} from './api-errors.js';
import {privateFile,loadSources,hash} from './session-event-policy.js';
import {validWorkflow,WORKFLOW_PRESETS} from './event-workflows.js';
const unavailable=()=>new ApiError(503,'event-source-settings-unavailable','Event configuration is unavailable.');
export class EventSettings {
 constructor({file,workspaces,getSession=()=>null}){Object.assign(this,{file,workspaces,getSession});}
 read(){
  if(!this.file)return null;
  try {const raw=privateFile(this.file,this.workspaces);loadSources(this.file,this.workspaces);return {raw,config:JSON.parse(raw),revision:hash(raw)};}
  catch{throw unavailable();}
 }
 view(){
  const data=this.read();
  return {configured:Boolean(data),revision:data?.revision||null,presets:WORKFLOW_PRESETS,sources:(data?.config.sources||[]).map(s=>({
   id:s.id,provider:s.provider,enabled:s.enabled,revision:s.revision||0,
   sessionId:s.target?.sessionId||null,sessionName:this.getSession(s.target?.sessionId)?.name||s.target?.sessionId||'Unconfigured destination',
   workflow:s.workflow,
  }))};
 }
 update(id,body){
  if(!body||Object.keys(body).sort().join(',')!=='revision,workflow'||typeof body.revision!=='string'||!validWorkflow(body.workflow))
   throw new ApiError(400,'invalid-input','Choose a valid workflow and instructions (up to 12000 characters).');
  const data=this.read();if(!data)throw unavailable();
  if(data.revision!==body.revision)throw new ApiError(409,'event-source-settings-conflict','Settings changed elsewhere. Reload before saving.');
  const source=data.config.sources.find(s=>s.id===id);if(!source)throw new ApiError(404,'not-found','Event source not found.');
  source.workflow={...body.workflow};source.revision=(source.revision||0)+1;
  // This endpoint cannot change the destination, polling frequency or
  // source enablement. New policy revision invalidates old pending events.
  const tmp=this.file+'.'+randomUUID()+'.tmp';let fd;
  try {
   fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(data.config,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
   loadSources(tmp,this.workspaces);
   if(hash(privateFile(this.file,this.workspaces))!==data.revision)throw new ApiError(409,'event-source-settings-conflict','Settings changed elsewhere. Reload before saving.');
   fs.renameSync(tmp,this.file);fd=fs.openSync(path.dirname(this.file),'r');fs.fsyncSync(fd);
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch{}}
  return this.view();
 }
}
export function mountEventSettings(api,settings,{writable=()=>{}}={}){
 api.get('/api/event-sources/settings',(_req,res)=>res.json(settings.view()));
 api.put('/api/event-sources/:id/workflow',(req,res)=>{
  if(req.headers['x-am-origin']!=='operator'||req.query.from||req.body?.from)throw new ApiError(403,'operator-required','Change event-source workflows in operator Settings.');
  writable();res.json(settings.update(req.params.id,req.body));
 });
}
