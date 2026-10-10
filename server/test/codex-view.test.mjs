import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {CodexInteractiveClient} from '../src/codex-interactive.js';
import {liveView,requestView} from '../src/codex-view.js';
import {SessionRuntime} from '../src/session-runtime.js';
import {readTraceByPath} from '../src/traces.js';
function client(){const c=Object.create(CodexInteractiveClient.prototype);c.threadId='thread';return c;}
function emit(c,method,params){c.receiveServerMessage({method,params:{threadId:'thread',turnId:'turn',...params}});}
test('streamed reasoning, tool output and message use existing AM blocks, isolate threads',()=>{
 const c=client();emit(c,'turn/started',{turn:{id:'turn'}});
 emit(c,'item/started',{item:{id:'user',type:'userMessage',content:[{type:'text',text:'task'}]}});
 emit(c,'item/reasoning/summaryTextDelta',{itemId:'r',summaryIndex:0,delta:'First '});
 emit(c,'item/reasoning/summaryTextDelta',{itemId:'r',summaryIndex:0,delta:'step'});
 emit(c,'item/started',{item:{id:'call',type:'commandExecution',command:'printf hello',cwd:'/tmp'}});
 emit(c,'item/commandExecution/outputDelta',{itemId:'call',delta:'hello'});
 emit(c,'item/agentMessage/delta',{itemId:'answer',delta:'Answer'});
 emit(c,'item/agentMessage/delta',{threadId:'different',itemId:'bad',delta:'unrelated'});
 const v=liveView(c);assert.deepEqual(v.replaceTurnIds,['turn']);
 assert.deepEqual(v.turns.flatMap(t=>t.blocks.map(b=>b.type)),['text','thinking','tool_use','tool_result','text']);
 assert.equal(v.turns[1].blocks[0].text,'First step');assert.equal(v.turns[2].blocks[1].text,'hello');assert.ok(!JSON.stringify(v).includes('unrelated'));
 emit(c,'turn/completed',{turn:{id:'turn'}});assert.equal(liveView(c).turns.at(-1).kind,'final');
});
test('requests are presentation data, no raw protocol or automatic approval',()=>{
 const c=client();c.receiveServerMessage({id:12,method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn',command:'printf hello',availableDecisions:['accept','acceptForSession','decline']}});
 const r=requestView(c)[0];assert.equal(r.kind,'permission');assert.deepEqual(r.choices.map(c=>c.value),['accept','decline']);assert.equal('method' in r,false);assert.equal('rpcId' in r,false);assert.equal(c.requests.size,1);
});
test('existing transcript normalizer preserves native identity through final marker',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-native-id-'));const file=path.join(root,'rollout.jsonl');
 const row=(type,payload)=>JSON.stringify({timestamp:new Date().toISOString(),type,payload});
 fs.writeFileSync(file,[row('session_meta',{id:'fixture',cwd:root}),row('event_msg',{type:'task_started',turn_id:'native-turn'}),row('response_item',{type:'message',role:'user',content:[{text:'Question'}]}),row('response_item',{type:'function_call',call_id:'tool',name:'exec_command',arguments:'{}'}),row('response_item',{type:'message',role:'assistant',content:[{text:'Answer'}]}),row('event_msg',{type:'task_complete',turn_id:'native-turn',last_agent_message:'Answer'})].join('\n')+'\n');
 try{const page=await readTraceByPath(file,{window:{at:'tail',version:2}});assert.ok(page.turns.length>=3);assert.ok(page.turns.every(t=>t.nativeTurnId==='native-turn'));assert.ok(page.turns.some(t=>t.event?.type==='task-complete'));}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('adapter translates server state, settles live records and never selects by cwd',async()=>{
 const c=client();emit(c,'item/started',{item:{id:'a',type:'agentMessage',text:'working'}});
 const states=[];const runtime=new SessionRuntime({bindings:{forSession:id=>id==='s'?{}:null},codex:{attach:async id=>{states.push(id);return {client:c};},status:async()=>({status:'working'})}});
 const s={id:'s',cli:'codex'},page={turns:[],window:{atEnd:true}};
 const out=await runtime.trace(s,page);assert.equal(out.activity,'working');assert.equal(out.interaction.canSend,false);assert.equal(out.live.turns[0].blocks[0].text,'working');
 assert.equal(runtime.presentation(s).state,'working');assert.deepEqual(states,['s']);
 assert.equal(await runtime.trace({id:'legacy',cli:'codex'},page),page);
 emit(c,'turn/completed',{turn:{id:'turn'}});const settled=await runtime.trace(s,{...page,turns:[{nativeTurnId:'turn',event:{type:'task-complete'}}]});assert.equal(settled.live.turns.length,0);
});
