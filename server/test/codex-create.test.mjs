import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {CodexCreation,CodexCreationClient,sharedCreationEnabled} from '../src/codex-create.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-create-unit-'));test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
function fixture(){
 const cwd=fs.mkdtempSync(path.join(root,'work-')),threadId=randomUUID(),calls=[];
 const client={close(){},async call(method,params){calls.push(method);if(method==='thread/name/set')throw Error('fixture naming failure');return {thread:{id:threadId,cwd}};}};
 const creator=new CodexCreation({root:cwd,dir:path.join(cwd,'receipts'),enabled:()=>true,endpoint:()=>({id:'fixture'}),connect:async()=>client,nextName:()=> 'Task',store:{},bindings:{},input:{},isRunning:()=>false});
 return {creator,client,cwd,calls,threadId,request:{requestId:randomUUID(),name:'Test'}};
}
test('creation is gated by both pilot and creation flag',()=>{
 const a=process.env.AM_CODEX_BINDINGS_PILOT,b=process.env.AM_CODEX_SHARED_CREATE;
 try{for(const [pilot,create,yes] of [['0','0',false],['1','0',false],['0','1',false],['1','1',true]]){process.env.AM_CODEX_BINDINGS_PILOT=pilot;process.env.AM_CODEX_SHARED_CREATE=create;assert.equal(sharedCreationEnabled(),yes);}}
 finally{if(a===undefined)delete process.env.AM_CODEX_BINDINGS_PILOT;else process.env.AM_CODEX_BINDINGS_PILOT=a;if(b===undefined)delete process.env.AM_CODEX_SHARED_CREATE;else process.env.AM_CODEX_SHARED_CREATE=b;}
});
test('workspace escape, missing path, disabled, cancellation: no native creation',async()=>{
 for(const mode of ['escape','missing','disabled','cancel']){const f=fixture(),ac=new AbortController();if(mode==='escape')f.request.path='..';if(mode==='missing')f.request.path='missing';if(mode==='disabled')f.creator.enabled=()=>false;if(mode==='cancel')ac.abort();await assert.rejects(f.creator.create(f.request,{signal:ac.signal}));assert.equal(f.calls.length,0);}
});
test('failed naming retries only the exact recorded native identity',async()=>{
 const f=fixture();await assert.rejects(f.creator.create(f.request),/naming failure/);
 assert.equal(f.creator.read(f.request.requestId).threadId,f.threadId);
 await assert.rejects(f.creator.create(f.request),/naming failure/);assert.equal(f.calls.filter(x=>x==='thread/start').length,1);
 await assert.rejects(f.creator.create({...f.request,name:'changed'}),e=>e.code==='codex-creation-conflict');
});
test('disk failure before creation sends no RPC; failure after ACK never re-creates',async()=>{
 for(const first of [true,false]){const f=fixture(),write=f.creator.write.bind(f.creator);f.creator.write=(id,rec,initial)=>{if(!!initial===first)throw Error('disk fixture');return write(id,rec,initial);};
 await assert.rejects(f.creator.create(f.request),/disk fixture/);assert.equal(f.calls.filter(x=>x==='thread/start').length,first?0:1);
 if(!first){f.creator.write=write;await assert.rejects(f.creator.create(f.request),e=>e.code==='codex-creation-uncertain');assert.equal(f.calls.filter(x=>x==='thread/start').length,1);}}
});
test('native creation client cannot change defaults or start model work',()=>{
 const c=Object.create(CodexCreationClient.prototype);c.cwd='/tmp/work';c.threadId=randomUUID();c.taskName='Task';
 assert.equal(c.allows('thread/start',{cwd:c.cwd,ephemeral:false}),true);
 for(const p of [{cwd:c.cwd,ephemeral:false,sandbox:'danger-full-access'},{cwd:'/other',ephemeral:false}])assert.equal(c.allows('thread/start',p),false);
 assert.equal(c.allows('thread/name/set',{threadId:c.threadId,name:'Task'}),true);
 assert.equal(c.allows('thread/name/set',{threadId:randomUUID(),name:'Task'}),false);
 for(const method of ['turn/start','thread/resume','thread/archive'])assert.equal(c.allows(method,{threadId:c.threadId}),false);
});
