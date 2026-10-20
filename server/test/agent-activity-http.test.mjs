// Read-only inventory against an isolated AM and fake native daemon; no inference.
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
const now=Date.now(),tid=randomUUID(),oldTid=randomUUID(),archTid=randomUUID();
const mk=(id,threadId)=>({id,name:id,cli:'codex',path:'a',sessionUuid:randomUUID(),codexSessionId:threadId,codexSharedOnly:true,createdAt:new Date(now).toISOString()});
const session=mk('imported',tid),old=mk('old',oldTid),arch={...mk('archived',archTid),archivedAt:new Date(now).toISOString()};
fs.writeFileSync(path.join(data,'sessions.json'),JSON.stringify([session,old,arch]));
fs.writeFileSync(path.join(data,'groups.json'),JSON.stringify([{id:'g',name:'Research',sessionIds:['imported','old','archived']}]));
const files=new Map();
const message=(role,text,time)=>({type:'response_item',timestamp:new Date(time).toISOString(),payload:{type:'message',role,content:[{type:role==='user'?'input_text':'output_text',text}]}});
for(const [thread,time]of [[tid,now-60000],[oldTid,now-10*864e5],[archTid,now-120000]]){
 const file=path.join(home,'sessions','rollout-'+thread+'.jsonl');files.set(thread,file);
 fs.writeFileSync(file,[{type:'session_meta',timestamp:new Date(now).toISOString(),payload:{id:thread,cwd:work}},message('user','question',time-10000),message('assistant','answer',time),{type:'event_msg',timestamp:new Date(now).toISOString(),payload:{type:'token_count'}}].map(JSON.stringify).join('\n')+'\n');
}
const rollout=files.get(tid),sourceThread=tid;
// A recent exchange outside the display tail must remain visible in filters.
fs.appendFileSync(rollout,JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'x'.repeat(13*1024*1024)}})+'\n');
const server=http.createServer(),wss=new WebSocketServer({server});
let unavailable=false;const calls=[];
wss.on('connection',ws=>ws.on('message',raw=>{
 const m=JSON.parse(raw);calls.push(m.method);if(m.id===undefined)return;
 let result;
 if(m.method==='initialize')result={codexHome:home,userAgent:'fixture/0.162.1'};
 else if(unavailable){ws.send(JSON.stringify({id:m.id,error:{code:-32000,message:'fixture unavailable'}}));return;}
 else if(m.method==='thread/read')result={thread:{id:m.params.threadId,cwd:work,path:files.get(m.params.threadId),status:{type:'idle'},parentThreadId:null,canAcceptDirectInput:true}};
 else if(m.method==='thread/turns/list')result={data:[]};
 else throw Error('inventory must never attach or send: '+m.method);
 ws.send(JSON.stringify({id:m.id,result}));
}));
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve)});fs.chmodSync(socket,0o600);
const binding=new CodexBindings(path.join(data,'codex-bindings.json'));
for(const item of [session,old,arch])binding.bind({session:item,threadId:item.codexSessionId,endpointId:endpointIdentity({socket,home}),cwd:work,expectedRevision:0});
const free=net.createServer().listen(0,'127.0.0.1');await once(free,'listening');const port=free.address().port;await new Promise(r=>free.close(r));
const base=`http://127.0.0.1:${port}`;
const preload=path.join(root,'preload.mjs');
fs.writeFileSync(preload,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const orig=cp.execFile;cp.execFile=(...a)=>{if(a[1]?.includes('--version')){queueMicrotask(()=>a.at(-1)(new Error('fixture')));return;}return orig(...a)};syncBuiltinESMExports();globalThis.fetch=async()=>new Response(JSON.stringify({private:true}),{status:200});`);


const bin=path.join(root,'bin');fs.mkdirSync(bin);
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

 const all=(await request('/api/agents?include_archived=true')).body;
 assert.ok(all.agents,JSON.stringify(all));
 assert.equal(all.agents.length,3);
 const row=all.agents.find(r=>r.id==='imported');
 assert.equal(row.lastActivityAt,new Date(now-60000).toISOString());
 assert.equal(row.lastPromptAt,new Date(now-70000).toISOString());
 assert.equal(row.lastAnswerAt,new Date(now-60000).toISOString());
 assert.equal(row.activityKind,'answer');assert.equal(row.trace.path,rollout);assert.equal(row.activityError,null);
 assert.equal(row.state,'waiting');assert.ok(!session.codexRollout);
 const filtered=(await request('/api/agents?active_within_minutes=5760&include_archived=true&limit=200')).body;
 assert.deepEqual(filtered.agents.map(r=>r.id).sort(),['archived','imported']);
 assert.deepEqual((await request('/api/agents?active_within_minutes=5760&cli=codex&state=waiting&sort=recent_conversation&limit=1')).body.agents.map(r=>r.id),['imported']);
 assert.equal((await request('/api/agents?group=missing')).body.agents.length,0);
 assert.deepEqual((await request('/api/agents?group=research&active_within_minutes=5760&include_archived=true&sort=recent_conversation&limit=1')).body.agents.map(r=>r.id),['imported']);
 for(const query of ['limit=bad','include_archived=yes','sort=wrong','state=no','cli=wrong','active_within_minutes=-1','unsupported=true'])assert.equal((await request('/api/agents?'+query)).status,400,query);
 const one=(await request('/api/agents/imported')).body;assert.equal(one.lastActivityAt,row.lastActivityAt);
 // A new prompt must retain the date of the previous answer while summary clears it.
 const next=now+1000;fs.appendFileSync(rollout,JSON.stringify(message('user','new prompt',next))+'\n');
 let changed;
 for(let i=0;i<50;i++){changed=(await request('/api/agents/imported')).body;if(changed.lastPromptAt===new Date(next).toISOString())break;await new Promise(r=>setTimeout(r,250));}
 assert.equal(changed.lastPromptAt,new Date(next).toISOString());assert.equal(changed.lastAnswerAt,row.lastAnswerAt);assert.equal(changed.lastAnswer,null);
 // Oversized records surface uncertainty even when a time filter hides rows.
 fs.appendFileSync(rollout,JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'x'.repeat(17*1024*1024)}})+'\n');
 let incomplete;
 for(let i=0;i<50;i++){incomplete=(await request('/api/agents?active_within_minutes=0')).body;if(incomplete.activityErrors.some(e=>e.id==='imported'))break;await new Promise(r=>setTimeout(r,250));}
 assert.ok(incomplete.activityErrors.some(e=>e.id==='imported'&&e.code==='activity-incomplete'));
 unavailable=true;
 const failed=(await request('/api/agents?active_within_minutes=5760&include_archived=true')).body;
 assert.equal(failed.agents.length,0);assert.equal(failed.activityErrors.length,3);
 const lost=(await request('/api/agents/imported')).body;assert.equal(lost.trace,null);assert.equal(lost.lastActivityAt,null);assert.equal(lost.state,'unknown');
 assert.ok(!calls.some(m=>['thread/resume','turn/start','thread/queue/add'].includes(m)));
 console.log('Activity HTTP: imported shared history, exchange timestamps, freshness, filters, validation and unavailable-source errors passed; no native mutation.');
}finally{
 if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}
 for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});
}
