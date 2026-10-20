// Isolated HTTP/WebSocket regressions for shared coordination and bounded Reader catch-up.
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
let status='active',huge=false,approval=false,unavailable=false;
let fullReads=0;const approvals=[];
const calls=[];
wss.on('connection',ws=>ws.on('message',raw=>{
 const m=JSON.parse(raw);calls.push(m.method);
 if(m.method===undefined){approvals.push(m);return;}
 if(m.id===undefined)return;
 if(unavailable && m.method!=='initialize'){ws.send(JSON.stringify({id:m.id,error:{code:-32000,message:'fixture unavailable'}}));return;}
 if(m.method==='thread/turns/list'&&m.params.itemsView==='full')fullReads++;
 const thread={id:tid,cwd:work,path:rollout,status:{type:status,activeFlags:[]},canAcceptDirectInput:true};
 let result;
 if(m.method==='initialize')result={codexHome:home,userAgent:'fixture/0.162.1'};
 else if(m.method==='thread/turns/list')result={data:[{id:'test-turn',status:status==='active'?'inProgress':'completed',items:m.params.itemsView==='full'?[{id:'large-item',type:'commandExecution',command:'fixture',aggregatedOutput:huge?'x'.repeat(3*1024*1024):'small'}]:[]}]};
 else if(m.method==='turn/start')result={turn:{id:'sent-turn'}};
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

let child;
const request=async(route,body)=>{
 const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-am-origin':'operator'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 return {status:r.status,body:await r.json()};
};
try {
 child=spawn(process.execPath,['--import',preload,'src/index.js'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{PATH:process.env.PATH,HOME:home,DATA_DIR:data,PORT:String(port),AM_BIND_HOST:'127.0.0.1',PUBLIC_DIR:path.join(root,'public'),CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(home,'claude'),XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'share'),AM_REPIN_DIR:path.join(root,'repin'),AM_INPUT_REQUIRED_DIR:path.join(root,'input'),AM_BASHRC:'/nonexistent',AM_CODEX_SHARED_SOCKET:socket,AM_CODEX_SHARED_HOME:home,AM_CODEX_BINDINGS_PILOT:'1'},stdio:['ignore','pipe','pipe']});
 child.stdout.resume();child.stderr.resume();
 let ready=false;
 for(let i=0;i<100;i++){
  try{if((await request('/api/health')).status===200){ready=true;break;}}catch{}
  if(child.exitCode!==null)throw Error('AM fixture exited');
  await new Promise(r=>setTimeout(r,50));
 }
 assert.ok(ready,'isolated AM started');
 // No TUI exists. Both reads must use fresh native state, even on the first call.
 const wait=await request('/api/agents/fixture/wait?timeout=1&settle=0');
 assert.equal(wait.body.state,'working');assert.equal(wait.body.matched,false);assert.equal(wait.body.timedOut,true);
 assert.equal((await request('/api/agents/fixture/tail')).body.state,'working');
 // An observation failure must not turn into a successful stopped wait.
 unavailable=true;
 const unknown=await request('/api/agents/fixture/wait?timeout=1&settle=0');
 assert.equal(unknown.body.state,'unknown');assert.equal(unknown.body.matched,false);
 assert.equal((await request('/api/agents/fixture/tail')).body.state,'unknown');unavailable=false;
 // Waiting observes active -> idle and applies settling after the native transition.
 let transition;
 const started=Date.now();
 try {
  transition=setTimeout(()=>{status='idle';},300);
  const idle=await request('/api/agents/fixture/wait?timeout=7&settle=1');
  assert.equal(idle.body.state,'waiting');assert.equal(idle.body.matched,true);
  assert.ok(Date.now()-started>=1300,'idle must remain stable for the settling window');
 } finally {clearTimeout(transition);}
 assert.equal((await request('/api/agents/fixture/tail')).body.state,'waiting');
 // Reader first, then send: completed large history is never fetched in full.
 huge=true;
 const page=await request('/api/trace/fixture');assert.equal(page.status,200,JSON.stringify(page.body));
 assert.equal(page.body.interaction.canSend,true);assert.equal(fullReads,0);
 const large=await request('/api/sessions/fixture/input',{text:'follow up',requestId:randomUUID()});
 assert.equal(large.status,200,JSON.stringify(large.body));assert.equal(fullReads,0);
 assert.equal(calls.filter(x=>x==='turn/start').length,1);
 // Reconnect the Reader during a large active turn. Only the separate display
 // socket may exceed its bound; the subscription and approval must survive.
 for(const ws of wss.clients)ws.terminate();
 status='active';approval=true;
 const active=await request('/api/trace/fixture');assert.equal(active.status,200,JSON.stringify(active.body));
 assert.equal(fullReads,1);
 assert.deepEqual(active.body.live,{replaceTurnIds:[],turns:[]});
 assert.equal(active.body.interaction.requests.length,1);
 const again=await request('/api/trace/fixture');assert.equal(again.status,200);
 assert.equal(fullReads,1,'do not repeatedly download an oversized active snapshot');
 const key=active.body.interaction.requests[0].key;
 assert.equal(again.body.interaction.requests[0].key,key,'keep the subscribed connection and its request');
 const answer=await request('/api/sessions/fixture/answer',{key,decision:'decline'});assert.equal(answer.status,200);
 status='idle';approval=false;
 const after=await request('/api/sessions/fixture/input',{text:'after large snapshot',requestId:randomUUID()});
 assert.equal(after.status,200,JSON.stringify(after.body));
 assert.ok(approvals.some(r=>r.id===99&&r.result.decision==='decline'));
 assert.equal(calls.filter(x=>x==='turn/start').length,2);
 console.log('Shared HTTP regressions: fresh wait/tail, unknown state, active-to-idle settling, large completed input, bounded active snapshot fallback and preserved approval passed.');
}finally{
 if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}
 for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});
}
