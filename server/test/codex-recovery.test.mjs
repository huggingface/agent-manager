import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {EventEmitter} from 'node:events';
import {recoverySettings,recoveryPlan,verifyRecovered} from '../src/codex-recovery.js';
import {CodexInteractiveClient} from '../src/codex-interactive.js';
const cwd='/tmp/work',thread={modelProvider:'fixture'};
function saved(){return {turn_id:'last-turn',cwd,model:'fixture-model',approval_policy:'on-request',approvals_reviewer:'user',
 collaboration_mode:{mode:'default',settings:{reasoning_effort:null,developer_instructions:null}},sandbox_policy:{type:'read-only'},
 permission_profile:{type:'managed',file_system:{type:'restricted',entries:[{path:{type:'special',value:{kind:'root'}},access:'read'}]},network:'restricted'}};}
test('recovery preserves the explicit restricted policy and rejects permission loss or unknown settings',()=>{
 const p=saved(),settings=recoverySettings(p,thread,cwd);
 assert.equal(settings.params.sandbox,'read-only');assert.equal(settings.params.model,'fixture-model');
 for(const change of [p=>p.sandbox_policy.type='danger-full-access',p=>p.permission_profile.file_system.entries.push({access:'none',path:{type:'path',path:'/private'}}),p=>p.permission_profile.network='enabled',p=>p.collaboration_mode.mode='plan',p=>p.cwd='/other',p=>p.disabled_plugin_ids=['plugin'],p=>p.approvals_reviewer='unknown',p=>p.sandbox_policy.future_permission=true]){
  const bad=saved();change(bad);assert.throws(()=>recoverySettings(bad,thread,cwd),e=>e.code==='codex-recovery-review');
 }
 verifyRecovered({...settings.expected,thread:{id:'same'}},settings,'same');
 assert.throws(()=>verifyRecovered({...settings.expected,sandbox:{type:'workspaceWrite'},thread:{id:'same'}},settings,'same'));
 assert.throws(()=>verifyRecovered({...settings.expected,thread:{id:'other'}},settings,'same'));
});
test('recovery uses the exact latest native context, never quoted content or an older turn',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-recovery-plan-')),file=path.join(root,'rollout.jsonl');
 try{
  const p=saved(),context={stamp:'binding',workdir:cwd};
  fs.writeFileSync(file,JSON.stringify({type:'turn_context',payload:p})+'\n'+JSON.stringify({type:'response_item',payload:{text:JSON.stringify({type:'turn_context',payload:{sandbox_policy:{type:'danger-full-access'}}})}})+'\n');
  const plan=await recoveryPlan(file,context,thread,{id:'last-turn'});assert.match(plan.key,/^[a-f0-9]{64}$/);
  assert.notEqual(plan.key,(await recoveryPlan(file,{...context,stamp:'other'},thread,{id:'last-turn'})).key);
  await assert.rejects(recoveryPlan(file,context,thread,{id:'newer-turn'}));
  fs.appendFileSync(file,'{"partial":');await assert.rejects(recoveryPlan(file,context,thread,{id:'last-turn'}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('the exact installed TUI Default mode is accepted, custom or modified prompts are not',()=>{
 const p=saved();
 p.collaboration_mode.settings.developer_instructions=fs.readFileSync(new URL('./default-collaboration-162.txt',import.meta.url),'utf8');
 assert.equal(recoverySettings(p,thread,cwd).params.model,p.model);
 for(const text of ['custom instructions',p.collaboration_mode.settings.developer_instructions+' ']){
  p.collaboration_mode.settings.developer_instructions=text;
  assert.throws(()=>recoverySettings(p,thread,cwd),e=>e.code==='codex-recovery-review');
 }
});
test('disconnected transport discards stale requests and live deltas; recovery RPC allowlist is one-shot',()=>{
 const ws=new EventEmitter();ws.terminate=()=>{};const c=new CodexInteractiveClient(ws);c.threadId='thread';
 c.receiveServerMessage({id:1,method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn'}});
 c.receiveServerMessage({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId:'item',delta:'partial'}});
 const params={threadId:'thread',excludeTurns:true,sandbox:'read-only'};
 assert.equal(!!c.allows('thread/resume',params),false);c.recoveryParams=params;assert.equal(c.allows('thread/resume',params),true);
 assert.equal(!!c.allows('thread/resume',{...params,sandbox:'danger-full-access'}),false);
 ws.emit('close');assert.equal(c.closed,true);assert.equal(c.requests.size,0);assert.equal(c.liveTurns.size,0);assert.equal(c.recoveryParams,null);
});

test('full access is preserved only with the exact saved disabled permission preset',()=>{
 const p={...saved(),sandbox_policy:{type:'danger-full-access'},permission_profile:{type:'disabled'},approval_policy:'never',effort:'medium'};
 const settings=recoverySettings(p,thread,cwd);assert.equal(settings.params.sandbox,'danger-full-access');assert.deepEqual(settings.expected.sandbox,{type:'dangerFullAccess'});
 assert.equal(settings.params.config.model_reasoning_effort,'medium');verifyRecovered({...settings.expected,thread:{id:'same'}},settings,'same');
 for(const profile of [undefined,{type:'managed'}, {...p.permission_profile,custom:true}])assert.throws(()=>recoverySettings({...p,permission_profile:profile},thread,cwd));
 assert.throws(()=>recoverySettings({...saved(),permission_profile:{type:'disabled'}},thread,cwd));
});

test('reviewed legacy Default mode is accepted without accepting arbitrary instructions',()=>{
 const p=saved();p.collaboration_mode.settings.developer_instructions=fs.readFileSync(new URL('./default-collaboration-legacy.txt',import.meta.url),'utf8');
 assert.equal(recoverySettings(p,thread,cwd).params.model,p.model);
 p.collaboration_mode.settings.developer_instructions+='x';assert.throws(()=>recoverySettings(p,thread,cwd));
});
test('native settings changed after the last turn cannot be rolled back by recovery',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-recovery-settings-')),file=path.join(root,'rollout.jsonl');
 try{
  const p=saved(),t={...thread,id:'native'},context={stamp:'binding',workdir:cwd};
  const a={model:p.model,model_provider_id:t.modelProvider,cwd,approval_policy:p.approval_policy,approvals_reviewer:p.approvals_reviewer,permission_profile:p.permission_profile,collaboration_mode:p.collaboration_mode,runtime_workspace_roots:[cwd],disabled_plugin_ids:[]};
  const write=()=>fs.writeFileSync(file,JSON.stringify({type:'turn_context',payload:p})+'\n'+JSON.stringify({type:'event_msg',payload:{type:'thread_settings_applied',thread_id:t.id,thread_settings:a}})+'\n');
  write();await recoveryPlan(file,context,t,{id:p.turn_id});
  a.permission_profile={type:'disabled'};write();await assert.rejects(recoveryPlan(file,context,t,{id:p.turn_id}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('cold empty native index can recover only a verified completed last turn',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-recovery-cold-')),file=path.join(root,'rollout.jsonl');
 try{
  const p=saved(),context={stamp:'binding',workdir:cwd},t={...thread,status:{type:'notLoaded'}};
  const records=[{type:'turn_context',payload:p},{type:'event_msg',payload:{type:'task_complete',turn_id:p.turn_id}}];
  const write=()=>fs.writeFileSync(file,records.map(x=>JSON.stringify(x)).join('\n')+'\n');
  write();const plan=await recoveryPlan(file,context,t,null);assert.equal(plan.key,(await recoveryPlan(file,context,t,{id:p.turn_id})).key);
  await assert.rejects(recoveryPlan(file,context,t,{id:'different'}));
  await assert.rejects(recoveryPlan(file,context,{...t,status:{type:'active'}},null));
  records.push({type:'event_msg',payload:{type:'task_started',turn_id:'new'}});write();await assert.rejects(recoveryPlan(file,context,t,null));
  records.pop();records[1]={type:'response_item',payload:{text:JSON.stringify({type:'task_complete',turn_id:p.turn_id})}};write();await assert.rejects(recoveryPlan(file,context,t,null));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
