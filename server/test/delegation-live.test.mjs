// am-test: manual — requires explicit operator authorization and real model access.
// Run: AM_LIVE_DELEGATION_TEST=1 AM_LIVE_TEST_DIR=/absolute/isolated-dir node test/delegation-live.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
if(process.env.AM_LIVE_DELEGATION_TEST!=='1') { console.log('SKIP: authorized live-model test only'); process.exit(0); }
const root=process.env.AM_LIVE_TEST_DIR;
assert(root&&path.isAbsolute(root)&&!fs.existsSync(root),'Choose a NEW isolated directory');
const data=path.join(root,'data'), work=path.join(data,'workspaces','fixture');
fs.mkdirSync(work,{recursive:true});
fs.writeFileSync(path.join(work,'AGENTS.md'),'This is an authorized isolated delegation integration test. Do not contact agents, use external data, send messages, or edit files. Reply only as the test prompt requests.');
fs.writeFileSync(path.join(data,'sessions.json'),JSON.stringify([{id:'bootstrap',name:'Live test bootstrap',cli:'claude',path:'fixture',sessionUuid:randomUUID(),createdAt:new Date().toISOString()}]));
fs.writeFileSync(path.join(data,'am-config.json'),JSON.stringify({revive:{enabled:false}}));
const server=net.createServer().listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));
const base=`http://127.0.0.1:${port}`, evidence={startedAt:new Date().toISOString(),port,root};
const save=()=>fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(evidence,null,2));
const req=async(route,body)=>{const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','X-AM-Request':'1'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const v=await r.json();assert(r.ok,`${r.status} ${JSON.stringify(v)}`);return v;};
const env={PATH:process.env.PATH,HOME:process.env.HOME,USER:process.env.USER,TERM:'xterm-256color',DATA_DIR:data,PORT:String(port),AM_BIND_HOST:'127.0.0.1',AM_DISTRIBUTE_SKILLS:'0',AM_CODEX_BINDINGS_PILOT:'1',AM_CODEX_SHARED_CREATE:'1',AM_CODEX_SHARED_HOME:path.join(process.env.HOME,'.codex'),AM_CODEX_SHARED_SOCKET:path.join(process.env.HOME,'.codex/app-server-control/app-server-control.sock'),AM_REPIN_DIR:path.join(root,'repin'),AM_INPUT_REQUIRED_DIR:path.join(root,'input'),AM_BASHRC:'/nonexistent',PUBLIC_DIR:path.join(root,'public')};
let am;
async function start(){am=spawn(process.execPath,['src/index.js'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env,stdio:['ignore','pipe','pipe']});evidence.fixturePid=am.pid;const log=fs.createWriteStream(path.join(root,'am.log'),{flags:'a'});am.stdout.pipe(log);am.stderr.pipe(log);for(let n=0;n<100;n++){try{await req('/api/health');return;}catch{}assert.equal(am.exitCode,null);await new Promise(r=>setTimeout(r,100));}throw Error('AM startup timeout');}
async function stop(){if(am&&am.exitCode===null){const done=once(am,'exit');am.kill('SIGTERM');await done;}}
async function waitAnswer(id,marker){const until=Date.now()+180000;while(Date.now()<until){const row=await req('/api/agents/'+id);if(row.lastAnswer===marker&&row.state==='waiting')return row;await req('/api/agents/'+id+'/wait?timeout=10&settle=2');}throw Error('Timed out waiting for '+marker);}
try{
 await start();
 evidence.parent=await req('/api/agents?cli=codex&name=Delegation%20E2E%20Parent&from=bootstrap',{requestId:randomUUID(),prompt:'Isolated integration test. No tools, no research, no messages. Reply exactly PARENT_READY. If later you receive an AM delegation result in this same conversation, reply exactly CALLBACK_OBSERVED. Do not send a message or acknowledgement to any other agent.'});save();
 evidence.parentReady=await waitAnswer(evidence.parent.id,'PARENT_READY');console.log('Parent initial turn ended',evidence.parent.threadId);save();
 evidence.child=await req('/api/agents?cli=claude&name=Delegation%20E2E%20Claude&from='+evidence.parent.id,{prompt:'Isolated integration test. No tools, no research, no file edits, no external messages. Reply exactly CHILD_READY.'});save();
 evidence.childReady=await waitAnswer(evidence.child.id,'CHILD_READY');console.log('Real Claude ready');save();
 // Exercise the operator recovery workflow on this test session only.
 const originalTrace=fs.readFileSync(evidence.parentReady.trace.path);
 await req('/api/sessions/'+evidence.parent.id+'/archive?from=bootstrap',{});
 evidence.archivedMapping=await req('/api/codex/context?threadId='+evidence.parent.threadId);
 assert.equal(evidence.archivedMapping.messaging.allowed,false);
 evidence.archivedRefusals=[];
 for(const completion of [undefined,'notify']){
  const response=await fetch(base+'/api/agents/'+evidence.child.id+'/prompt?from='+evidence.parent.id,{method:'POST',headers:{'content-type':'application/json','X-AM-Request':'1'},body:JSON.stringify({requestId:randomUUID(),text:'MUST_NOT_BE_DELIVERED',...(completion?{completion}:{})}),signal:AbortSignal.timeout(15000)});
  const refusal=await response.json();assert.equal(response.status,409);assert.equal(refusal.code,'codex-sender-archived');evidence.archivedRefusals.push(refusal);
 }
 await req('/api/sessions/'+evidence.parent.id+'/unarchive?from=bootstrap',{});
 evidence.restoredMapping=await req('/api/codex/context?threadId='+evidence.parent.threadId);
 assert.equal(evidence.restoredMapping.amSessionId,evidence.parent.id);assert.equal(evidence.restoredMapping.threadId,evidence.parent.threadId);assert.equal(evidence.restoredMapping.messaging.allowed,true);
 assert(fs.readFileSync(evidence.parentReady.trace.path).subarray(0,originalTrace.length).equals(originalTrace),'Original conversation bytes preserved');
 evidence.ordinarySend=await req('/api/agents/'+evidence.child.id+'/prompt?from='+evidence.parent.id,{requestId:randomUUID(),text:'Isolated integration test. No tools or messages. Reply exactly ORDINARY_RECEIVED.'});
 assert.equal(evidence.ordinarySend.completionSubscribed,false);
 evidence.ordinaryAnswer=await waitAnswer(evidence.child.id,'ORDINARY_RECEIVED');save();console.log('Archive refusal, same-thread restore and ordinary delivery verified');
 const body={requestId:randomUUID(),text:'Isolated integration test. No tools, no research, no file edits, no external messages. Reply exactly CHILD_TASK_COMPLETE.',completion:'notify'};
 evidence.dispatch=await req('/api/agents/'+evidence.child.id+'/prompt?from='+evidence.parent.id,body);save();
 const id=evidence.dispatch.delegation.id;
 const until=Date.now()+180000;while(Date.now()<until){evidence.delegation=await req('/api/delegations/'+id+'?from='+evidence.parent.id);save();if(evidence.delegation.state==='delivered')break;await req('/api/agents/'+evidence.child.id+'/wait?timeout=10&settle=3');}
 assert.equal(evidence.delegation.state,'delivered',JSON.stringify(evidence.delegation));assert.equal(evidence.delegation.outcome,'completed');assert.equal(evidence.delegation.result,'CHILD_TASK_COMPLETE');
 evidence.parentCallback=await waitAnswer(evidence.parent.id,'CALLBACK_OBSERVED');save();
 evidence.retry=await req('/api/agents/'+evidence.child.id+'/prompt?from='+evidence.parent.id,body);
 // Restart ONLY the isolated AM after both model turns have ended; journal and receipts survive.
 await stop();await start();
 evidence.afterRestart=await req('/api/delegations/'+id+'?from='+evidence.parent.id);
 assert.equal(evidence.afterRestart.state,'delivered');
 evidence.retryAfterRestart=await req('/api/agents/'+evidence.child.id+'/prompt?from='+evidence.parent.id,body);
 const receipts=fs.readdirSync(path.join(data,'codex-input-receipts')).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(data,'codex-input-receipts',f))));
 const callbackReceipts=receipts.filter(r=>r.source?.id===evidence.child.id);
 assert.equal(callbackReceipts.length,1);assert.equal(callbackReceipts[0].session,evidence.parent.id);assert.equal(callbackReceipts[0].status,'accepted');
 const rows=fs.readFileSync(evidence.parentCallback.trace.path,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 const callbacks=rows.filter(r=>r.type==='response_item'&&r.payload?.role==='user'&&JSON.stringify(r.payload.content).includes('[AM delegation result '+id+']'));
 assert.equal(callbacks.length,1,'Exactly one user-visible completion in the exact parent transcript');
 assert.equal(rows.find(r=>r.type==='session_meta').payload.id,evidence.parent.threadId);
 const finals=rows.filter(r=>r.type==='response_item'&&r.payload?.role==='assistant'&&['final','final_answer'].includes(r.payload.phase));
 assert.equal(finals.filter(r=>JSON.stringify(r.payload.content).includes('CALLBACK_OBSERVED')).length,1);
 const audit=fs.readFileSync(path.join(data,'operations.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert(!audit.some(r=>JSON.stringify(r).includes('/api/notify')),'No device push');
 evidence.nativeAssertions={parentThreadId:evidence.parent.threadId,callbackCount:callbacks.length,callbackReceiptCount:callbackReceipts.length};
 evidence.receipts=receipts;
 evidence.finishedAt=new Date().toISOString();evidence.passed=true;save();console.log('PASS real shared-Codex / Claude completion and restart/retry; evidence '+root);
}catch(e){evidence.error=e.stack;save();throw e;}finally{await stop();}
