import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {CodexMigration,MigrationClient,historyDigest} from '../src/codex-migrate.js';
import {recoverySettings} from '../src/codex-recovery.js';
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'am-migration-unit-')));test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
function fixture(){
 const dir=fs.mkdtempSync(path.join(root,'f-')),home=path.join(dir,'home'),cwd=path.join(dir,'work');fs.mkdirSync(path.join(home,'sessions'),{recursive:true});fs.mkdirSync(cwd);
 const tid=randomUUID(),file=path.join(home,'sessions','rollout.jsonl');
 const saved={turn_id:'t',cwd,model:'fixture',approval_policy:'on-request',approvals_reviewer:'user',effort:'high',collaboration_mode:{mode:'default',settings:{reasoning_effort:'high',developer_instructions:null}},sandbox_policy:{type:'read-only'},permission_profile:{type:'managed',file_system:{type:'restricted',entries:[{path:{type:'special',value:{kind:'root'}},access:'read'}]},network:'restricted'}};
 fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:tid,cwd}})+'\n'+JSON.stringify({type:'turn_context',payload:saved})+'\n');
 let session={id:'s',sessionUuid:randomUUID(),cli:'codex',name:'Legacy',path:'work',codexSessionId:tid};
 const facts={owner:{state:'free',activeGoal:false,queuedInput:false},running:false,thread:{id:tid,cwd,path:file,modelProvider:'fixture',status:{type:'notLoaded'}},turns:[{id:'t',status:'completed',items:[]}],calls:[],bindings:[],resumeFailure:false};
 const endpoint={id:'endpoint',home,socket:path.join(dir,'sock')};
 const client={endpoint,closed:false,close(){},async call(method){facts.calls.push(method);if(method==='thread/read')return {thread:facts.thread};if(method==='thread/turns/list')return {data:facts.turns};if(method==='thread/resume'){facts.thread.status={type:'idle'};facts.owner={state:'held',pid:100,startTicks:'123',daemon:true,activeGoal:false,queuedInput:false};if(facts.resumeFailure)throw Error('ACK lost');return {...recoverySettings(saved,facts.thread,cwd).expected,thread:facts.thread};}throw Error('Unexpected mutation');}};
 const store={get:()=>session,list:()=>[session],prepareCodexMigration:(id,m)=>{session={...session,codexSharedOnly:true,codexMigration:m};return session;}};
 const manager=new CodexMigration({store,bindings:{forSession:()=>facts.bindings[0]},isRunning:()=>facts.running,endpoint:()=>endpoint,connect:async()=>client,owner:async()=>facts.owner,root:dir,enabled:()=>true,bind:async req=>{facts.bindings.push(req);return req;}});
 return {manager,store,facts,saved,file};
}
test('preview is read-only; stale keys refused; apply preserves exact identities',async()=>{
 const f=fixture(),before=f.store.get(),plan=await f.manager.inspect('s');assert.equal(f.store.get(),before);assert.ok(!f.facts.calls.includes('thread/resume'));
 await assert.rejects(f.manager.apply('s','0'.repeat(64)),e=>e.code==='codex-migration-stale');assert.equal(f.store.get().codexSharedOnly,undefined);
 const result=await f.manager.apply('s',plan.key);assert.equal(result.threadId,before.codexSessionId);assert.equal(f.store.get().sessionUuid,before.sessionUuid);assert.equal(f.facts.bindings.length,1);assert.equal(f.store.get().codexSharedOnly,true);
});
test('TUI, unknown/held owner, goals, queued input and duplicate claims prevent resume',async()=>{
 for(const change of [f=>f.facts.running=true,f=>f.facts.owner={state:'unknown'},f=>f.facts.owner={state:'held',pid:123},f=>f.facts.owner.activeGoal=true,f=>f.facts.owner.queuedInput=true,f=>f.store.get().pendingPrompt='draft',f=>f.store.list=()=>[f.store.get(),{...f.store.get(),id:'other'}]]){const f=fixture();change(f);await assert.rejects(f.manager.inspect('s'));assert.ok(!f.facts.calls.includes('thread/resume'));}
});
test('guard persistence failure prevents all native mutations',async()=>{
 const f=fixture(),plan=await f.manager.inspect('s');f.store.prepareCodexMigration=()=>{throw Error('fsync failure');};
 await assert.rejects(f.manager.apply('s',plan.key),/fsync failure/);assert.ok(!f.facts.calls.includes('thread/resume'));assert.equal(f.facts.bindings.length,0);
});
test('lost ACK keeps guard; retry verifies same loaded task without model input',async()=>{
 const f=fixture(),plan=await f.manager.inspect('s');f.facts.resumeFailure=true;
 await assert.rejects(f.manager.apply('s',plan.key),e=>e.code==='codex-migration-uncertain');assert.equal(f.store.get().codexSharedOnly,true);assert.equal(f.facts.bindings.length,0);
 f.facts.resumeFailure=false;assert.equal((await f.manager.inspect('s')).key,plan.key);await f.manager.apply('s',plan.key);assert.equal(f.facts.bindings.length,1);
});
test('changed history invalidates preview before native mutation',async()=>{
 const f=fixture(),plan=await f.manager.inspect('s');f.facts.turns[0].items.push({type:'agentMessage',text:'changed'});
 await assert.rejects(f.manager.apply('s',plan.key),e=>e.code==='codex-migration-stale');assert.ok(!f.facts.calls.includes('thread/resume'));
});
test('full history pagination refuses duplicate and active turns',async()=>{
 const pages=[{data:[{id:'b',status:'completed'}],nextCursor:'next'},{data:[{id:'a',status:'completed'}]}];let i=0;
 assert.equal((await historyDigest({call:async()=>pages[i++]},'t')).count,2);
 await assert.rejects(historyDigest({call:async()=>({data:[{id:'x',status:'inProgress'}]})},'t'));
 await assert.rejects(historyDigest({call:async()=>({data:[{id:'x',status:'completed'}],nextCursor:'loop'})},'t'));
});
test('RPC allowlist excludes creation, input, interruption and arbitrary settings',()=>{
 const c=Object.create(MigrationClient.prototype);c.threadId='t';c.resumeParams={threadId:'t',excludeTurns:true};assert.equal(c.allows('thread/resume',c.resumeParams),true);
 for(const method of ['thread/start','turn/start','turn/interrupt'])assert.equal(!!c.allows(method,{threadId:'t'}),false);
 assert.equal(!!c.allows('thread/resume',{threadId:'t',sandbox:'danger-full-access'}),false);
});
test('new queued native work after the guard prevents resume',async()=>{
 const f=fixture(),plan=await f.manager.inspect('s'),prepare=f.store.prepareCodexMigration;
 f.store.prepareCodexMigration=(...args)=>{const s=prepare(...args);f.facts.owner.queuedInput=true;return s;};
 await assert.rejects(f.manager.apply('s',plan.key),e=>e.code==='codex-migration-pending');assert.ok(!f.facts.calls.includes('thread/resume'));assert.equal(f.store.get().codexSharedOnly,true);
});
test('failed binding retains launch protection and retries exact loaded task',async()=>{
 const f=fixture(),plan=await f.manager.inspect('s'),bind=f.manager.bind;f.manager.bind=async()=>{throw Error('binding disk error');};
 await assert.rejects(f.manager.apply('s',plan.key),/binding disk error/);assert.equal(f.store.get().codexSharedOnly,true);assert.equal(f.facts.bindings.length,0);
 f.manager.bind=bind;await f.manager.apply('s',plan.key);assert.equal(f.facts.bindings[0].threadId,plan.threadId);
});
