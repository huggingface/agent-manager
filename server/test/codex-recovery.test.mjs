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
