// Explicit operator creation. Persist intent before RPC and identity before any
// prompt/TUI; an ambiguous thread/start is never retried or matched by recency.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ApiError} from './api-errors.js';
import {ObservationClient} from './codex-shared.js';
import {configuredEndpoint,contextForThread,bindExistingThread} from './codex-context.js';
import {validThreadId} from './codex-bindings.js';
import {DATA_DIR,WORKSPACES_DIR} from './config.js';
const fail=(code,message)=>new ApiError(409,code,message);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const sharedCreationEnabled=()=>process.env.AM_CODEX_BINDINGS_PILOT==='1'&&process.env.AM_CODEX_SHARED_CREATE==='1';
export class CodexCreationClient extends ObservationClient {
  allows(method,p){return super.allows(method,p)
    ||(method==='thread/start'&&p?.cwd===this.cwd&&p.ephemeral===false&&Object.keys(p).length===2)
    ||(method==='thread/name/set'&&p?.threadId===this.threadId&&p.name===this.taskName&&Object.keys(p).length===2);}
}
export class CodexCreation {
  constructor({store,bindings,input,isRunning,nextName,place,assertWritable=()=>{},
    endpoint=configuredEndpoint,connect=(...args)=>CodexCreationClient.connect(...args),
    dir=path.join(DATA_DIR,'codex-creation-receipts'),root=WORKSPACES_DIR,enabled=sharedCreationEnabled}) {
    Object.assign(this,{store,bindings,input,isRunning,nextName,place,assertWritable,endpoint,connect,dir,root,enabled});this.busy=new Set();
  }
  read(id){let fd;try{fd=fs.openSync(path.join(this.dir,id+'.json'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    if(fs.fstatSync(fd).size>32768)throw Error('Invalid creation receipt');return JSON.parse(fs.readFileSync(fd,'utf8'));
  }catch(e){if(e.code==='ENOENT')return null;throw e;}finally{if(fd!==undefined)fs.closeSync(fd);}}
  write(id,record,first=false){fs.mkdirSync(this.dir,{recursive:true,mode:0o700});const dest=path.join(this.dir,id+'.json'),tmp=first?dest:dest+'.'+randomUUID()+'.tmp';let fd;
    try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      if(!first)fs.renameSync(tmp,dest);fd=fs.openSync(this.dir,'r');fs.fsyncSync(fd);
    }finally{if(fd!==undefined)fs.closeSync(fd);if(!first)try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
  }
  async create({requestId,name='',path:relative='',groupId=null,prompt=''}, {signal}={}) {
    if(!this.enabled())throw fail('codex-creation-disabled','Shared creation is disabled.');
    if(!validThreadId(requestId)||typeof name!=='string'||name.length>160||typeof relative!=='string'
      ||typeof prompt!=='string'||prompt.length>50000||/[\x00-\x1f\x7f]/.test(name))throw new ApiError(400,'invalid-input','A unique requestId, task name, workspace and text prompt are required.');
    if(this.busy.has(requestId))throw fail('codex-creation-busy','This creation is already in progress. Keep this request and retry shortly.');
    this.busy.add(requestId);let client;
    try{
      const base=fs.realpathSync(this.root);let cwd;
      try{cwd=fs.realpathSync(path.resolve(base,relative||'.'));}
      catch(e){if(['ENOENT','ENOTDIR'].includes(e.code))throw new ApiError(400,'invalid-input','Choose an existing workspace inside this manager.');throw e;}
      if((cwd!==base&&!cwd.startsWith(base+path.sep))||!fs.statSync(cwd).isDirectory())throw new ApiError(400,'invalid-input','Choose an existing workspace inside this manager.');
      const endpoint=this.endpoint(),fingerprint=hash([name,relative,groupId,prompt,endpoint.id,cwd]);
      let record=this.read(requestId);
      if(record&&record.fingerprint!==fingerprint)throw fail('codex-creation-conflict','This creation ID belongs to different settings.');
      if(record?.status==='creating')throw fail('codex-creation-uncertain','Creation could not be confirmed. Do not create it again: inspect Shared Codex tasks and import its exact ID if it exists. No prompt was sent.');
      const check=()=>{this.assertWritable();if(signal?.aborted)throw fail('codex-creation-cancelled','Creation paused; no new message was submitted.');
        if(this.endpoint().id!==endpoint.id||fs.realpathSync(path.resolve(base,relative||'.'))!==cwd)throw fail('codex-creation-changed','The endpoint or workspace changed.');};
      if(!record){
        client=await this.connect(endpoint,{signal});client.cwd=cwd;check();
        record={version:1,fingerprint,status:'creating',name:name.trim()||this.nextName(),relative:path.relative(base,cwd),groupId,cwd,endpointId:endpoint.id,createdAt:new Date().toISOString()};
        this.write(requestId,record,true);
        let result;try{result=await client.call('thread/start',{cwd,ephemeral:false});}
        catch{throw fail('codex-creation-uncertain','Creation could not be confirmed. Inspect Shared Codex tasks before retrying; no prompt was sent.');}
        if(!validThreadId(result?.thread?.id)||result.thread.parentThreadId||result.thread.ephemeral||fs.realpathSync(result.thread.cwd)!==cwd)throw fail('codex-creation-uncertain','Codex returned an unexpected identity. No prompt was sent.');
        record={...record,status:'created',threadId:result.thread.id};this.write(requestId,record);
      }
      if(!validThreadId(record.threadId))throw fail('codex-creation-uncertain','The saved creation has no verified thread ID. No prompt was sent.');
      // Completed retries return the exact existing row, never create another.
      if(record.status==='complete'){
        const session=this.store.get(record.amId);if(!session)throw fail('codex-creation-missing','The original AM view was removed. No replacement was created.');
        const context=contextForThread(record.threadId,{sessions:this.store.list(),bindings:this.bindings,endpoint});
        if(context.amSessionId!==session.id)throw fail('codex-creation-changed','The original mapping changed. No replacement was created.');return session;
      }
      client??=await this.connect(endpoint,{signal});client.threadId=record.threadId;client.taskName=record.name;
      const {thread}=await client.call('thread/read',{threadId:record.threadId,includeTurns:false});
      if(thread?.id!==record.threadId||thread.parentThreadId||fs.realpathSync(thread.cwd)!==cwd)throw fail('codex-creation-changed','The original thread could not be verified.');
      check();
      if(record.status==='created'){
        // Naming materializes an empty thread without a model turn on 0.162.1.
        await client.call('thread/name/set',{threadId:record.threadId,name:record.name});
        record={...record,status:'named'};this.write(requestId,record);
      }
      let session=this.store.list().find(s=>s.cli==='codex'&&s.codexSessionId===record.threadId);
      if(!session){session=this.store.createCodexReference({name:record.name,path:record.relative,threadId:record.threadId});}
      if(!session.codexSharedOnly||session.archivedAt)throw fail('codex-creation-changed','The original view changed. No prompt was sent.');
      if(!this.bindings.forSession(session.id))await bindExistingThread({sessionId:session.id,threadId:record.threadId,expectedRevision:0},{getSession:this.store.get,sessions:this.store.list,isRunning:this.isRunning,bindings:this.bindings,config:endpoint,signal,beforeCommit:check});
      contextForThread(record.threadId,{sessions:this.store.list(),bindings:this.bindings,endpoint});check();
      if(!record.amId){this.place(session,record.groupId);record={...record,status:'bound',amId:session.id};this.write(requestId,record);}
      // The durable mapping exists before the first possible input or TUI.
      if(prompt.trim())await this.input.send(session.id,{text:prompt.trim(),requestId},{signal});
      else await this.input.attach(session.id);
      record={...record,status:'complete'};this.write(requestId,record);return session;
    }finally{client?.close();this.busy.delete(requestId);}
  }
}
