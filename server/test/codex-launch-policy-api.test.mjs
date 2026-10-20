// Private AM and HOME; PTY creation is intercepted before any CLI can start.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {nativeFetch as fetch,NativeWebSocket} from './native-client.mjs';
const require=createRequire(import.meta.url),root=fs.mkdtempSync(path.join(os.tmpdir(),'am-launch-api-'));
const home=path.join(root,'home'),data=path.join(root,'data'),now=new Date().toISOString();
fs.mkdirSync(path.join(home,'.codex','sessions'),{recursive:true});fs.mkdirSync(data);
const thread='11111111-1111-4111-8111-111111111111',work=path.join(data,'workspaces','legacy');fs.mkdirSync(work,{recursive:true});
const legacy={id:'legacy',name:'Legacy task',cli:'codex',path:'legacy',sessionUuid:'22222222-2222-4222-8222-222222222222',codexSessionId:thread,everStarted:true,createdAt:now,lastInputAt:Date.now()};
const fresh={...legacy,id:'fresh',name:'Never started',sessionUuid:'33333333-3333-4333-8333-333333333333',codexSessionId:null,everStarted:false};
const sender={id:'sender',name:'sender',cli:'claude',path:'legacy',sessionUuid:'44444444-4444-4444-8444-444444444444',createdAt:now};
const sessionsFile=path.join(data,'sessions.json');fs.writeFileSync(sessionsFile,JSON.stringify([legacy,fresh,sender]));
const historyFile=path.join(home,'.codex','sessions',`rollout-${thread}.jsonl`);
legacy.codexRollout=historyFile;fs.writeFileSync(sessionsFile,JSON.stringify([legacy,fresh,sender]));
const history=[{type:'session_meta',timestamp:now,payload:{id:thread,cwd:work,source:'cli'}},{type:'event_msg',timestamp:now,payload:{type:'user_message',message:'ORIGINAL HISTORY'}}].map(JSON.stringify).join('\n')+'\n';fs.writeFileSync(historyFile,history);
fs.writeFileSync(path.join(data,'runstate.json'),JSON.stringify({at:now,sessions:{legacy:{running:true,cli:'codex',lastInputAt:Date.now()}}}));
fs.writeFileSync(path.join(data,'crons.json'),JSON.stringify([{id:'boot',name:'Boot legacy',agent:{name:legacy.name,cli:'codex'},prompt:'DO NOT RUN',schedule:{cron:'0 0 1 1 *',tz:'UTC'},runOnRestart:true,state:'running',createdAt:now,updatedAt:now}]));
const marker=path.join(root,'pty-attempts'),preload=path.join(root,'preload.cjs');
fs.writeFileSync(preload,`const fs=require('node:fs'),cp=require('node:child_process');
require(${JSON.stringify(require.resolve('node-pty'))}).spawn=()=>{fs.appendFileSync(${JSON.stringify(marker)},'PTY');throw Error('UNEXPECTED PTY SPAWN');};
const original=cp.execFile;cp.execFile=(...args)=>{if(args[1]?.includes('--version')){queueMicrotask(()=>args.at(-1)(null,'0.0.0 fixture'));return;}return original(...args);};require('node:module').syncBuiltinESMExports();`);
const free=net.createServer();free.listen(0,'127.0.0.1');await once(free,'listening');const port=free.address().port;await new Promise(r=>free.close(r));
const base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['--require',preload,path.resolve('src/index.js')],{cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:home,DATA_DIR:data,CODEX_HOME:path.join(home,'.codex'),PORT:String(port),AM_BIND_HOST:'127.0.0.1',AM_CODEX_BINDINGS_PILOT:'1',AM_CODEX_SHARED_CREATE:'0',AM_CODEX_SHARED_SOCKET:path.join(root,'unavailable'),AM_CODEX_SHARED_HOME:path.join(home,'.codex'),AM_REPIN_DIR:path.join(root,'repin'),AM_INPUT_REQUIRED_DIR:path.join(root,'input'),AM_BASHRC:'/nonexistent',CLAUDE_CONFIG_DIR:path.join(home,'.claude'),XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'share')},stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
async function waitFor(fn){for(let i=0;i<300;i++){if(await fn())return;assert.equal(child.exitCode,null,log);await new Promise(r=>setTimeout(r,50));}throw Error('Timed out\n'+log);}
async function api(route,body){const res=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-am-origin':'operator'},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,body:await res.json()};}
async function refused(route,body,code='codex-migration-required'){const r=await api(route,body);assert.equal(r.status,409,JSON.stringify(r));assert.equal(r.body.code,code);assert.equal(r.body.started,undefined);}
try {
 await waitFor(async()=>{try{return (await fetch(base+'/api/health')).ok;}catch{return false;}});
 await refused('/api/sessions/legacy/input',{text:'DO NOT RUN'});
 await refused('/api/sessions/fresh/input',{text:'DO NOT QUEUE'});
 await refused('/api/agents/legacy/prompt?from=sender',{text:'DO NOT RUN'});
 await refused('/api/sessions',{cli:'codex',name:'No replacement',path:'legacy',prompt:'DO NOT RUN'},'codex-shared-create-required');
 await refused('/api/agents?cli=codex&name=NoReplacement&from=sender',{prompt:'DO NOT RUN'},'codex-shared-create-required');
 await refused('/api/crons/boot/run',{});
 const newCron=await api('/api/crons',{name:'No new cron task',agent:{name:'Absent target',cli:'codex'},prompt:'DO NOT RUN',schedule:{cron:'0 0 1 1 *',tz:'UTC'}});
 assert.equal(newCron.status,201,JSON.stringify(newCron));await refused('/api/crons/'+newCron.body.id+'/run',{},'codex-shared-create-required');
 const ws=new NativeWebSocket(`ws://127.0.0.1:${port}/ws?session=legacy`);let output='';ws.on('message',d=>output+=d);await once(ws,'close');assert.match(output,/must be migrated/);
 const row=(await api('/api/sessions')).body.find(s=>s.id==='legacy');assert.equal(row.terminalRunning,false);assert.equal(row.codexMigrationRequired.threadId,thread);
 const reader=await api('/api/trace/legacy?tail=1&v=2');assert.equal(reader.status,200,JSON.stringify(reader));assert.equal(reader.body.interaction.canSend,false);assert.match(reader.body.interaction.error,/existing thread/);
 await waitFor(async()=>((await api('/api/crons')).body.crons.find(c=>c.id==='boot').last?.status)==='failed');
 await waitFor(()=>log.includes('codex-migration-required: unbound Codex sessions skipped'));
 assert.match(log,/codex-migration-required: unbound Codex sessions skipped/);
 const restarted=(await api('/api/crons')).body.crons.find(c=>c.id==='boot').last;
 assert.equal(restarted.trigger,'restart');assert.equal(restarted.code,'codex-migration-required');assert.equal(restarted.status,'failed');
 assert.equal(fs.existsSync(marker),false,'No PTY launch from any tested entry point');
 assert.equal(fs.readFileSync(historyFile,'utf8'),history,'History bytes preserved');
 const saved=JSON.parse(fs.readFileSync(sessionsFile,'utf8'));assert.equal(saved.length,3,'No replacement conversation');
 assert.deepEqual(saved.map(s=>[s.id,s.sessionUuid,s.codexSessionId]),[legacy,fresh,sender].map(s=>[s.id,s.sessionUuid,s.codexSessionId]));
 assert.ok(saved.every(s=>!s.pendingPrompt));assert.equal(fs.existsSync(path.join(data,'codex-bindings.json')),false);
 console.log('PASS: API/Reader/agent prompt/creation/crons/boot/websocket; zero PTYs, unchanged history and identities, no queued prompt or replacement.');
}finally{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}fs.rmSync(root,{recursive:true,force:true});}
