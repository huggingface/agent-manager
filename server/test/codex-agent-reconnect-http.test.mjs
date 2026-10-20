// Isolated AM HTTP -> real recovery/owner checks -> fake Codex, never a model.
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import http from 'node:http';import net from 'node:net';import {once} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';import {WebSocketServer} from 'ws';
import {CodexBindings,endpointIdentity} from '../src/codex-bindings.js';
import {recoverySettings} from '../src/codex-recovery.js';import {nativeFetch as fetch} from './native-client.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-agent-reconnect-')),data=path.join(root,'data'),home=path.join(root,'home'),work=path.join(data,'workspaces','target'),socket=path.join(root,'native.sock');
for(const dir of [work,path.join(home,'sessions'),path.join(home,'thread-writer-locks')])fs.mkdirSync(dir,{recursive:true});
execFileSync('python3',['-c',`import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 db.execute('CREATE TABLE thread_goals(thread_id TEXT,status TEXT)')
 db.execute('CREATE TABLE queued_items(thread_id TEXT,queue_order INTEGER,payload_json TEXT)')`,path.join(home,'state.sqlite')]);
const tid=randomUUID(),turnId=randomUUID(),at=new Date().toISOString();
const target={id:'target',name:'Radar fixture',cli:'codex',path:'target',sessionUuid:randomUUID(),codexSessionId:tid,codexSharedOnly:true,createdAt:at};
const source={id:'source',name:'Scanner fixture',cli:'claude',path:'target',sessionUuid:randomUUID(),createdAt:at};
const worker={...target,id:'worker',name:'Delegate fixture',sessionUuid:randomUUID(),codexSessionId:randomUUID()};
fs.writeFileSync(path.join(data,'sessions.json'),JSON.stringify([target,source,worker]));
const saved={turn_id:turnId,cwd:work,model:'fixture-model',approval_policy:'on-request',approvals_reviewer:'auto_review',effort:'high',
 collaboration_mode:{mode:'default',settings:{reasoning_effort:'high',developer_instructions:null}},sandbox_policy:{type:'read-only'},
 permission_profile:{type:'managed',file_system:{type:'restricted',entries:[{path:{type:'special',value:{kind:'root'}},access:'read'}]},network:'restricted'}};
const rollout=path.join(home,'sessions',`rollout-${tid}.jsonl`);
fs.writeFileSync(rollout,[{type:'session_meta',timestamp:at,payload:{id:tid,cwd:work,source:'cli'}},{type:'turn_context',payload:saved},{type:'event_msg',payload:{type:'task_complete',turn_id:turnId}}].map(JSON.stringify).join('\n')+'\n');
const fingerprint=()=>createHash('sha256').update(fs.readFileSync(rollout)).digest('hex'),originalHash=fingerprint();
const thread={id:tid,cwd:work,path:rollout,modelProvider:'fixture',status:{type:'notLoaded'},canAcceptDirectInput:true,parentThreadId:null};
const workerRollout=path.join(home,'sessions',`rollout-${worker.codexSessionId}.jsonl`);fs.writeFileSync(workerRollout,fs.readFileSync(rollout,'utf8').replaceAll(tid,worker.codexSessionId));
const workerThread={...thread,id:worker.codexSessionId,path:workerRollout,status:{type:'idle'}};
const settings=recoverySettings(saved,thread,work),calls=[],native=http.createServer(),wss=new WebSocketServer({server:native});
wss.on('connection',ws=>ws.on('message',raw=>{
 const m=JSON.parse(raw);if(m.id===undefined)return;calls.push(m);let result;const selected=m.params?.threadId===workerThread.id?workerThread:thread;
 if(m.method==='initialize')result={codexHome:home,userAgent:'fixture/0.162.1'};
 else if(m.method==='thread/read')result={thread:selected};
 else if(m.method==='thread/turns/list')result={data:[{id:turnId,status:'completed',items:[]}]};
 else if(m.method==='thread/resume'){
  if(m.params.model){assert.deepEqual(m.params,{threadId:tid,excludeTurns:true,...settings.params});thread.status={type:'idle'};}
  result={thread:selected,...settings.expected};
 }else if(m.method==='thread/queue/add'){
  result={queuedSubmission:{id:'queued-'+m.params.clientUserMessageId,clientUserMessageId:m.params.clientUserMessageId}};
  if(selected===workerThread){
   const turn=randomUUID();fs.appendFileSync(workerRollout,[
    {type:'event_msg',payload:{type:'task_started',turn_id:turn}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:m.params.input[0].text}]}},
    {type:'turn_context',payload:{...saved,turn_id:turn}},
    {type:'response_item',payload:{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'The isolated review is ready.'}]}},
    {type:'event_msg',payload:{type:'task_complete',turn_id:turn}}
   ].map(JSON.stringify).join('\n')+'\n');
  }
 }
 else {ws.send(JSON.stringify({id:m.id,error:{code:-32000,message:'unsupported fixture RPC'}}));return;}
 ws.send(JSON.stringify({id:m.id,result}));
}));
await new Promise((resolve,reject)=>{native.once('error',reject);native.listen(socket,resolve);});fs.chmodSync(socket,0o600);
new CodexBindings(path.join(data,'codex-bindings.json')).bind({session:target,threadId:tid,endpointId:endpointIdentity({socket,home}),cwd:work,expectedRevision:0});
new CodexBindings(path.join(data,'codex-bindings.json')).bind({session:worker,threadId:worker.codexSessionId,endpointId:endpointIdentity({socket,home}),cwd:work,expectedRevision:0});
const free=net.createServer().listen(0,'127.0.0.1');await once(free,'listening');const port=free.address().port;await new Promise(r=>free.close(r));
const preload=path.join(root,'preload.mjs');
fs.writeFileSync(preload,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const orig=cp.execFile;cp.execFile=(...args)=>{if(args[1]?.includes('--version')){queueMicrotask(()=>args.at(-1)(new Error('fixture')));return;}return orig(...args);};syncBuiltinESMExports();`);
let child,log='';const base=`http://127.0.0.1:${port}`;
const request=async(route,body)=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','X-AM-Request':'1'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return {status:response.status,body:await response.json()};};
try {
 child=spawn(process.execPath,['--import',preload,'src/index.js'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{PATH:process.env.PATH,TMPDIR:root,HOME:home,DATA_DIR:data,PORT:String(port),AM_BIND_HOST:'127.0.0.1',PUBLIC_DIR:path.join(root,'public'),CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(home,'claude'),XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'share'),AM_REPIN_DIR:path.join(root,'repin'),AM_INPUT_REQUIRED_DIR:path.join(root,'input'),AM_BASHRC:'/nonexistent',AM_CODEX_SHARED_SOCKET:socket,AM_CODEX_SHARED_HOME:home,AM_CODEX_BINDINGS_PILOT:'1'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>log+=chunk);child.stderr.on('data',chunk=>log+=chunk);let ready=false;
 for(let i=0;i<150;i++){try{if((await request('/api/health')).status===200){ready=true;break;}}catch{}assert.equal(child.exitCode,null,log);await new Promise(r=>setTimeout(r,50));}assert(ready,log);
 assert.equal((await request('/api/sessions/target/reconnect?from=source',{recoveryKey:'a'.repeat(64)})).status,403);
 const delivery={requestId:randomUUID(),text:'Only this newly detected change.'};
 const result=await request('/api/agents/target/prompt?from=source',delivery);
 assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.queued,true);
 assert.equal(calls.filter(c=>c.method==='thread/resume'&&c.params.model).length,1);
 const sent=calls.filter(c=>c.method==='thread/queue/add');assert.equal(sent.length,1);
 assert.match(sent[0].params.input[0].text,/Scanner fixture/);assert.match(sent[0].params.input[0].text,/"amSessionId":"source"/);
 thread.status={type:'notLoaded'};
 const retry=await request('/api/agents/target/prompt?from=source',delivery);assert.equal(retry.body.repeated,true);
 assert.equal(calls.filter(c=>c.method==='thread/resume'&&c.params.model).length,1);assert.equal(calls.filter(c=>c.method==='thread/queue/add').length,1);
 assert(!calls.some(c=>['thread/start','turn/start','turn/steer','turn/interrupt'].includes(c.method)));
 assert.equal(fingerprint(),originalHash);assert.equal(JSON.parse(fs.readFileSync(path.join(data,'sessions.json'))).length,3);
 console.log('PASS: agent HTTP restores exact thread/settings, queues once, passive retry, UI guard retained, history preserved.');
 // The parent has ended its HTTP call and is unloaded. Completion is owned by
 // AM, not the original /wait caller. No model or real session participates.
 const task={requestId:randomUUID(),text:'Review the fixture.',completion:'notify'};
 const dispatched=await request('/api/agents/worker/prompt?from=target',task);
 assert.equal(dispatched.status,202,JSON.stringify(dispatched)+'\n'+log);
 assert.equal((await request(`/api/delegations/${task.requestId}?from=source`)).status,404);
 let followup;
 for(let i=0;i<100;i++){
  followup=await request(`/api/delegations/${task.requestId}?from=target`);
  if(followup.body.state==='delivered')break;
  await new Promise(r=>setTimeout(r,100));
 }
 assert.equal(followup.body.state,'delivered',JSON.stringify(followup));assert.equal(followup.body.outcome,'completed');
 assert.equal(followup.body.result,'The isolated review is ready.');
 const callbacks=calls.filter(c=>c.method==='thread/queue/add' && c.params.threadId===tid && c.params.input[0].text.includes('[AM delegation result'));
 assert.equal(callbacks.length,1);assert.match(callbacks[0].params.input[0].text,/"amSessionId":"worker"/);
 assert.equal(calls.filter(c=>c.method==='thread/resume'&&c.params.model).length,2,'unloaded parent recovered exactly once');
 const repeated=await request('/api/agents/worker/prompt?from=target',task);assert.equal(repeated.body.delegation.state,'delivered');
 assert.equal(calls.filter(c=>c.method==='thread/queue/add').length,3,'one ordinary delivery, one delegation, one follow-up');
 assert.equal(fingerprint(),originalHash,'fixture parent recovery does not rewrite original history');
 console.log('PASS: durable HTTP delegation completes exact exchange, recovers unloaded parent, one attributed callback, scoped reads and passive retry.');
 const cron=await request('/api/crons?from=target',{name:'Shared cron limit fixture',agent:{name:target.name,cli:'codex'},prompt:'Never delivered',schedule:{cron:'0 0 * * *',tz:'UTC'},state:'stopped'});
 assert.equal(cron.status,201,JSON.stringify(cron));
 const run=await request(`/api/crons/${cron.body.id}/run?from=target`,{});assert.equal(run.status,202,JSON.stringify(run));
 const jobs=await request('/api/crons');assert.equal(jobs.body.crons.find(j=>j.id===cron.body.id).last.code,'codex-shared-delivery-pending');
 assert.equal(calls.filter(c=>c.method==='thread/queue/add').length,3,'unsupported native cron never borrows an agent identity');
 console.log('PASS: native shared cron remains explicitly unsupported, no extra queue operation.');
 const mapping=await request('/api/codex/context?threadId='+tid);assert.equal(mapping.body.messaging.allowed,true);
 const observed=await request('/api/agents/worker/wait?timeout=1&settle=0');
 assert.equal(observed.body.completionSubscribed,false);assert.equal(observed.body.taskCorrelated,false);assert.match(observed.body.observationId,/^[a-f0-9-]{36}$/);assert(Number.isFinite(Date.parse(observed.body.observedAt)));
 assert.equal(result.body.completionSubscribed,false);assert.equal(dispatched.body.completionSubscribed,true);
 const archiveResult=await request('/api/sessions/target/archive?from=source',{});assert.equal(archiveResult.status,200,JSON.stringify(archiveResult));
 const archivedRecipient=await request('/api/agents/target/prompt?from=source',{requestId:randomUUID(),text:'must not arrive at archived recipient'});
 assert.equal(archivedRecipient.status,409);assert.equal(archivedRecipient.body.code,'codex-target-archived');
 const archivedContext=await request('/api/codex/context?threadId='+tid);
 assert.equal(archivedContext.status,200);assert.equal(archivedContext.body.messaging.allowed,false);assert.equal(archivedContext.body.messaging.code,'codex-sender-archived');
 const beforeRefusal=calls.filter(c=>c.method==='thread/queue/add').length;
 for(const destination of ['worker','source'])for(const completion of [undefined,'notify']){
  const rejected=await request('/api/agents/'+destination+'/prompt?from=target',{requestId:randomUUID(),text:'must not arrive',...(completion?{completion}:{})});
  assert.equal(rejected.status,409);assert.equal(rejected.body.code,'codex-sender-archived');assert.match(rejected.body.error,/Restore this same session/);
 }
 assert.equal(calls.filter(c=>c.method==='thread/queue/add').length,beforeRefusal);
 assert.equal((await request('/api/sessions/target/unarchive?from=source',{})).status,200);
 assert.equal((await request('/api/codex/context?threadId='+tid)).body.messaging.allowed,true);
 console.log('PASS: resolved sender lifecycle explicit; ordinary/subscribed sends reject archived parents before native/legacy effects.');




}finally{
 if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}
 for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>native.close(r));fs.rmSync(root,{recursive:true,force:true});
}
