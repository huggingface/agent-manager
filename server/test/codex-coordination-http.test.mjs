// Isolated end-to-end attribution/import/spawn/delivery; fake Claude and Codex, no inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';
import {nativeFetch as fetch} from './native-client.mjs';
import {CodexBindings,endpointIdentity} from '../src/codex-bindings.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-review160-')),data=path.join(root,'data'),home=path.join(root,'home'),work=path.join(data,'workspaces','a'),socket=path.join(root,'s');
for(const d of [home,work,path.join(home,'sessions')])fs.mkdirSync(d,{recursive:true});
const tid=randomUUID(),session={id:'fixture',name:'Review fixture',cli:'codex',path:'a',sessionUuid:randomUUID(),codexSessionId:tid,codexSharedOnly:true,everStarted:true,createdAt:new Date().toISOString()};
fs.writeFileSync(path.join(data,'sessions.json'),JSON.stringify([session]));
const rollout=path.join(home,'sessions','rollout.jsonl');
fs.writeFileSync(rollout,JSON.stringify({type:'session_meta',timestamp:new Date().toISOString(),payload:{id:tid,cwd:work}})+'\n');
const server=http.createServer(),wss=new WebSocketServer({server});
const sourceThread=randomUUID();let status='idle',huge=false,approval=false,unavailable=false;
const queue=[];
let fullReads=0;const approvals=[];
const calls=[];
wss.on('connection',ws=>ws.on('message',raw=>{
 const m=JSON.parse(raw);calls.push(m.method);
 if(m.method===undefined){approvals.push(m);return;}
 if(m.id===undefined)return;
 if(unavailable && m.method!=='initialize'){ws.send(JSON.stringify({id:m.id,error:{code:-32000,message:'fixture unavailable'}}));return;}
 if(m.method==='thread/turns/list'&&m.params.itemsView==='full')fullReads++;
 const thread={id:m.params?.threadId||tid,name:m.params?.threadId===sourceThread?'Phone fixture':'Destination fixture',cwd:work,path:rollout,status:{type:m.params?.threadId===sourceThread?'active':status,activeFlags:[]},canAcceptDirectInput:true,parentThreadId:null,forkedFromId:null};
 let result;
 if(m.method==='initialize')result={codexHome:home,userAgent:'fixture/0.162.1'};
 else if(m.method==='thread/turns/list')result={data:[{id:'test-turn',status:status==='active'?'inProgress':'completed',items:m.params.itemsView==='full'?[{id:'large-item',type:'commandExecution',command:'fixture',aggregatedOutput:huge?'x'.repeat(3*1024*1024):'small'}]:[]}]};
 else if(m.method==='thread/queue/add'){queue.push(m.params);result={queuedSubmission:{id:'queued-'+queue.length,clientUserMessageId:m.params.clientUserMessageId}};}
 else if(m.method==='turn/start')throw Error('agent messages must not steer via turn/start');
 else result={thread};
 ws.send(JSON.stringify({id:m.id,result}));
 if(approval&&m.method==='thread/resume')ws.send(JSON.stringify({id:99,method:'item/commandExecution/requestApproval',params:{threadId:tid,turnId:'test-turn',command:'fixture',availableDecisions:['accept','decline']}}));
}));
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});fs.chmodSync(socket,0o600);
const binding=new CodexBindings(path.join(data,'codex-bindings.json'));
binding.bind({session,threadId:tid,endpointId:endpointIdentity({socket,home}),cwd:work,expectedRevision:0});
const free=net.createServer().listen(0,'127.0.0.1');await once(free,'listening');const port=free.address().port;await new Promise(r=>free.close(r));
const base=`http://127.0.0.1:${port}`;
const preload=path.join(root,'preload.mjs');
fs.writeFileSync(preload,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const orig=cp.execFile;cp.execFile=(...a)=>{if(a[1]?.includes('--version')){queueMicrotask(()=>a.at(-1)(new Error('fixture')));return;}return orig(...a)};syncBuiltinESMExports();globalThis.fetch=async()=>new Response(JSON.stringify({private:true}),{status:200});`);


const bin=path.join(root,'bin'),claudeLog=path.join(root,'claude-invocations.jsonl');fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin,'claude'),`#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(claudeLog)},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()})+String.fromCharCode(10));
`,{mode:0o700});
fs.writeFileSync(path.join(home,'.bash_profile'),`export PATH='${bin}':"$PATH"\n`);
let child;
const request=async(route,body,origin)=>{
 const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(origin?{'x-am-origin':origin}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 return {status:r.status,body:await r.json()};
};
try {
 child=spawn(process.execPath,['--import',preload,'src/index.js'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{PATH:bin+path.delimiter+process.env.PATH,HOME:home,DATA_DIR:data,PORT:String(port),AM_BIND_HOST:'127.0.0.1',PUBLIC_DIR:path.join(root,'public'),CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(home,'claude'),XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'share'),AM_REPIN_DIR:path.join(root,'repin'),AM_INPUT_REQUIRED_DIR:path.join(root,'input'),AM_BASHRC:'/nonexistent',AM_CODEX_SHARED_SOCKET:socket,AM_CODEX_SHARED_HOME:home,AM_CODEX_BINDINGS_PILOT:'1'},stdio:['ignore','pipe','pipe']});
 child.stdout.resume();child.stderr.resume();let ready=false;
 for(let i=0;i<100;i++){
  try{if((await request('/api/health')).status===200){ready=true;break;}}catch{}
  if(child.exitCode!==null)throw Error('AM fixture exited');await new Promise(r=>setTimeout(r,50));
 }
 assert.ok(ready);
 assert.equal((await request('/api/codex/context?threadId='+sourceThread)).body.code,'codex-unmapped');
 const nativeOrigin='codex-thread:'+sourceThread;
 assert.equal((await request('/api/agents?cli=claude',{prompt:'must not start'},nativeOrigin)).body.code,'unknown-origin');
 assert.equal((await request('/api/codex/import',{threadId:tid},nativeOrigin)).body.code,'unknown-origin');
 const imported=await request('/api/codex/import',{threadId:sourceThread},nativeOrigin);
 assert.equal(imported.status,200,JSON.stringify(imported.body));
 const source=imported.body.session;
 assert.equal(imported.body.context.threadId,sourceThread);
 assert.equal((await request('/api/codex/import',{threadId:sourceThread},nativeOrigin)).body.session.id,source.id);
 assert.ok(!calls.includes('thread/resume'),'import is metadata-only even for an active source');
 const childResult=await request('/api/agents?cli=claude&name=Reviewer&from='+source.id,{prompt:'REVIEWER_COORDINATION_FIXTURE'},source.id);
 assert.equal(childResult.status,201,JSON.stringify(childResult.body));
 assert.equal(childResult.body.path,source.path);
 for(let i=0;!fs.existsSync(claudeLog)&&i<80;i++)await new Promise(r=>setTimeout(r,50));
 assert.ok(fs.existsSync(claudeLog),'fake Claude actually launched');
 const spawned=JSON.parse(fs.readFileSync(claudeLog,'utf8').trim().split('\n').at(-1));
 assert.equal(spawned.cwd,work);assert.ok(spawned.argv.some(a=>a.includes('[message from Phone fixture:]')&&a.includes('REVIEWER_COORDINATION_FIXTURE')));
 const route='/api/agents/fixture/prompt?from='+source.id;
 assert.equal((await request(route,{text:'no id'},source.id)).body.code,'invalid-input');
 const requestId=randomUUID(),message={text:'ATTRIBUTED_COORDINATION_REPORT',requestId};
 const delivered=await request(route,message,source.id);assert.equal(delivered.status,200,JSON.stringify(delivered.body));
 assert.equal(delivered.body.queued,true);assert.equal(delivered.body.queuedSubmissionId,'queued-1');
 assert.equal((await request(route,message,source.id)).body.repeated,true);assert.equal(queue.length,1);
 assert.match(queue[0].input[0].text,/message from Phone fixture:/);
 assert.ok(queue[0].input[0].text.includes(source.id)&&queue[0].input[0].text.includes(sourceThread));
 assert.equal((await request(route,{...message,text:'changed'},source.id)).body.code,'codex-request-conflict');
 status='active';assert.equal((await request(route,{text:'must not interrupt',requestId:randomUUID()},source.id)).body.code,'codex-task-busy');
 assert.equal(queue.length,1);
 // Background connectors send text/plain with a durable UUID header, not JSON.
 status='idle';
 const plainId=randomUUID(),plainText='OPAQUE_JOB_WAKEUP';
 const sendPlain=()=>fetch(base+route,{method:'POST',headers:{'content-type':'text/plain','x-am-message-id':plainId},body:plainText,signal:AbortSignal.timeout(10000)});
 const plain=await sendPlain();assert.equal(plain.status,200);
 const receipt=await plain.json();assert.equal(receipt.queued,true);assert.equal(receipt.queuedSubmissionId,'queued-2');
 const replay=await sendPlain();assert.equal(replay.status,200);assert.equal((await replay.json()).repeated,true);
 assert.equal(queue.length,2);assert.equal(queue[1].clientUserMessageId,plainId);
 assert.ok(queue[1].input[0].text.includes(source.id)&&queue[1].input[0].text.includes(plainText));
 const operations=(await request('/api/operations?limit=100')).body.operations;
 assert.ok(operations.some(o=>o.path==='/api/codex/import'&&o.origin?.id===nativeOrigin&&o.status===200));
 assert.ok(operations.some(o=>o.path==='/api/agents'&&o.origin?.id===source.id&&o.status===201));
 assert.ok(operations.some(o=>o.path==='/api/agents/fixture/prompt'&&o.origin?.id===source.id&&o.target?.id==='fixture'&&o.status===200));
 const sessions=(await request('/api/sessions')).body;
 assert.equal(sessions.find(s=>s.id===source.id).terminalRunning,false);
 assert.equal(sessions.find(s=>s.id==='fixture').terminalRunning,false);
 assert.ok(!calls.some(m=>['turn/start','turn/steer','turn/interrupt'].includes(m)));
 console.log('Coordination HTTP: active native self-import, exact attribution, fake Claude spawn in source workspace, native queue delivery, duplicate/conflict protection and active-target refusal passed.');
}finally{
 if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}
 for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});
}
