// am-test: manual — installed Codex and local deterministic provider; isolated homes, no external inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { nativeFetch as fetch } from './native-client.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-shared-pilot-'));
const home = path.join(root, 'home'), codexHome = path.join(root, 'codex'), data = path.join(root, 'data');
const cwd = path.join(data, 'workspaces', 'work'), socket = path.join(root, 's');
for (const dir of [home, codexHome, cwd]) fs.mkdirSync(dir, { recursive: true });
let providerCalls=0, releaseResponse, holdExternal=false;
const heldResponses=new Set();
const provider=http.createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 const input=JSON.parse(body),callNumber=++providerCalls;
 const item={type:'message',id:'msg_'+callNumber,role:'assistant',status:'completed',content:[{type:'output_text',text:'COORDINATION_REPLY',annotations:[]}]};
 res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
 const send=(type,extra)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...extra})+'\n\n');
 send('response.created',{response:{id:'resp_'+callNumber,status:'in_progress',output:[]}});
 send('response.output_item.added',{output_index:0,item:{...item,status:'in_progress'}});
 send('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text});
 if(callNumber===1||(holdExternal&&(input.tools||[]).some(t=>t.name==='exec_command')))await new Promise(r=>{
  const release=()=>{heldResponses.delete(release);r();};heldResponses.add(release);releaseResponse=release;
 });
 send('response.output_item.done',{output_index:0,item});
 send('response.completed',{response:{id:'resp_'+callNumber,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));
fs.writeFileSync(path.join(codexHome, 'config.toml'), `model="fixture"
model_provider="fixture"
[model_providers.fixture]
name="isolated fixture"
base_url="http://127.0.0.1:${provider.address().port}/v1"
wire_api="responses"
requires_openai_auth=false
supports_websockets=false
[projects.${JSON.stringify(cwd)}]
trust_level="trusted"
`);
const codexBin = process.env.PATH.split(path.delimiter).find((dir) => fs.existsSync(path.join(dir, 'codex')));
assert.ok(codexBin);
fs.writeFileSync(path.join(home, '.bash_profile'), `export PATH=${JSON.stringify(codexBin)}:"$PATH"\n`);
const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, TERM: 'xterm-256color', LANG: 'C.UTF-8' };
const children = new Set(); let rpc, am, daemon;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit'); child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await done; } finally { clearTimeout(force); children.delete(child); }
}
function startChild(cmd, args, extra = {}) {
  const child = spawn(cmd, args, { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...extra });
  children.add(child); child.stdout.resume(); child.stderr.resume(); return child;
}
async function connect() {
  const ws = new WebSocket('ws://localhost/', { createConnection: () => net.connect(socket) });
  await once(ws, 'open'); let seq = 0; const pending = new Map(), events = new Set();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.method) { for (const fn of events) fn(msg); return; }
    const p = pending.get(msg.id); if (!p) return;
    pending.delete(msg.id); clearTimeout(p.timer);
    if (msg.error) p.reject(new Error('Fixture RPC rejected: ' + p.method + ': ' + JSON.stringify(msg.error))); else p.resolve(msg.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer, method }); ws.send(JSON.stringify({ id, method, params }));
  });
  const init = await call('initialize', { clientInfo: { name: 'am_pilot_test', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized' })); assert.equal(init.codexHome, codexHome);
  const shell = async (threadId, command, onStart = () => {}) => {
    let output = '', finish, timer;
    const done = new Promise((resolve, reject) => { finish = resolve; timer = setTimeout(() => reject(new Error('Shell fixture timeout')), 15000); });
    const fn = (m) => {
      if (m.params?.threadId !== threadId) return;
      if (m.method === 'item/started' && m.params.item.type === 'commandExecution') onStart();
      if (m.method === 'item/completed' && m.params.item.type === 'commandExecution') output += m.params.item.aggregatedOutput || '';
      if (m.method === 'turn/completed') finish();
    };
    events.add(fn);
    try { await Promise.all([done, call('thread/shellCommand', { threadId, command, timeoutMs: 10000 })]); return output; }
    finally { clearTimeout(timer); events.delete(fn); }
  };
  return { call, shell, ws, init, events, close: () => ws.terminate() };
}
const free = net.createServer().listen(0, '127.0.0.1'); await once(free, 'listening');
const port = free.address().port; await new Promise((r) => free.close(r)); const base = `http://127.0.0.1:${port}`;
const preload = path.join(root, 'preload.mjs');
fs.writeFileSync(preload, `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
const original=cp.execFile; cp.execFile=(...args)=>{if(args[1]?.includes('--version')){queueMicrotask(()=>args.at(-1)(new Error('fixture')));return;}return original(...args);};syncBuiltinESMExports();`);
async function startAM() {
  am = startChild(process.execPath, ['--import', preload, 'src/index.js'], { cwd: process.cwd(), env: {
    ...env, CODEX_HOME: path.join(home, '.codex'), DATA_DIR: data, PORT: String(port), AM_CODEX_SHARED_SOCKET: socket, AM_CODEX_SHARED_HOME: codexHome, AM_CODEX_BINDINGS_PILOT: '1',
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'share'),
    AM_REPIN_DIR: path.join(root, 'repin'), AM_INPUT_REQUIRED_DIR: path.join(root, 'input'), AM_BASHRC: '/nonexistent',
  } });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    assert.equal(am.exitCode, null); await sleep(50);
  }
  throw new Error('AM startup timeout');
}
async function call(route, body) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-am-origin': 'operator', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
}
async function waitFor(fn) {
 for(let i=0;i<150;i++){const result=await fn();if(result)return result;await sleep(50);}
 throw Error('Coordination fixture timed out');
}
async function api(route,body,origin='operator') {
 const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-am-origin':origin},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}
try {
 daemon=startChild('codex',['app-server','--listen',`unix://${socket}`]);
 await waitFor(()=>fs.existsSync(socket));rpc=await connect();
 const source=(await rpc.call('thread/start',{cwd,sandbox:'read-only',approvalPolicy:'never'})).thread;
 const target=(await rpc.call('thread/start',{cwd,sandbox:'read-only',approvalPolicy:'never'})).thread;
 await rpc.shell(target.id,'printf coordination-seed');
 const sourceTurn=await rpc.call('turn/start',{threadId:source.id,input:[{type:'text',text:'SOURCE_REMAINS_ACTIVE'}]});
 await waitFor(()=>releaseResponse);const releaseSource=releaseResponse;
 const initialSettings=await rpc.call('thread/resume',{threadId:target.id,excludeTurns:true});
 fs.writeFileSync(path.join(data,'sessions.json'),'[]');await startAM();
 const {run}=await import('../../scripts/am-codex-context.mjs');
 let sourceId;
 await run(['--base-url',base,'import','--id-only'],{env:{CODEX_THREAD_ID:source.id,AM_ID:'wrong-neighbor'},print:v=>sourceId=v});
 assert.ok(sourceId);assert.equal((await rpc.call('thread/turns/list',{threadId:source.id,limit:1,itemsView:'summary',sortDirection:'desc'})).data[0].id,sourceTurn.turn.id);
 const imported=await api('/api/codex/import',{threadId:target.id});assert.equal(imported.status,200);
 const targetId=imported.body.session.id,route='/api/agents/'+targetId+'/prompt?from='+sourceId;
 const input={text:'REPORT_FROM_IMPORTED_SOURCE',requestId:randomUUID()};
 holdExternal=true;releaseResponse=null;
 const sent=await api(route,input,sourceId);assert.equal(sent.status,200,JSON.stringify(sent.body));assert.equal(sent.body.queued,true);
 await waitFor(()=>releaseResponse);const releaseTarget=releaseResponse;
 assert.equal((await api(route,input,sourceId)).body.repeated,true);
 const active=(await rpc.call('thread/turns/list',{threadId:target.id,limit:1,itemsView:'full',sortDirection:'desc'})).data[0];
 assert.equal(active.status,'inProgress');assert.ok(JSON.stringify(active.items).includes(sourceId)&&JSON.stringify(active.items).includes(source.id));
 const rejected=await api(route,{text:'DO_NOT_INTERRUPT',requestId:randomUUID()},sourceId);
 assert.equal(rejected.status,409);assert.equal(rejected.body.code,'codex-task-busy');
 assert.equal((await rpc.call('thread/turns/list',{threadId:target.id,limit:1,itemsView:'summary',sortDirection:'desc'})).data[0].id,active.id);
 releaseTarget();holdExternal=false;
 await waitFor(async()=>(await rpc.call('thread/read',{threadId:target.id,includeTurns:false})).thread.status.type==='idle');
 // The receipt survives AM restart while the source's native turn keeps running.
 await stop(am);await startAM();
 assert.equal((await api(route,input,sourceId)).body.repeated,true);
 assert.equal(providerCalls,2);
 const afterSettings=await rpc.call('thread/resume',{threadId:target.id,excludeTurns:true});
 for(const key of ['model','modelProvider','approvalPolicy','approvalsReviewer','sandbox','reasoningEffort'])assert.deepEqual(afterSettings[key],initialSettings[key]);
 // Verify the native primitive used by delivery in the cross-client race:
 // another client starts work immediately before our queue/add reaches Codex.
 holdExternal=true;releaseResponse=null;
 const external=await rpc.call('turn/start',{threadId:target.id,input:[{type:'text',text:'EXTERNAL_ACTIVE_TURN'}]});
 await waitFor(()=>releaseResponse);const releaseExternal=releaseResponse;
 const queued=await rpc.call('thread/queue/add',{threadId:target.id,clientUserMessageId:randomUUID(),input:[{type:'text',text:'SEPARATE_LATER_TURN'}]});
 const whileActive=(await rpc.call('thread/turns/list',{threadId:target.id,limit:1,itemsView:'full',sortDirection:'desc'})).data[0];
 assert.equal(whileActive.id,external.turn.id);assert.equal(whileActive.status,'inProgress');
 assert.ok(!JSON.stringify(whileActive.items).includes('SEPARATE_LATER_TURN'));
 assert.ok((await rpc.call('thread/queue/list',{threadId:target.id})).data.some(q=>q.id===queued.queuedSubmission.id));
 holdExternal=false;releaseExternal();
 await waitFor(async()=>{const turns=(await rpc.call('thread/turns/list',{threadId:target.id,limit:2,itemsView:'full',sortDirection:'desc'})).data;return turns[0]?.status==='completed'&&turns[0].id!==external.turn.id&&JSON.stringify(turns[0]).includes('SEPARATE_LATER_TURN');});
 releaseSource();await waitFor(async()=>(await rpc.call('thread/read',{threadId:source.id,includeTurns:false})).thread.status.type==='idle');
 console.log(JSON.stringify({activeSelfImport:true,exactSourceAttribution:true,nativeQueuedDelivery:true,busyTargetRefused:true,restartDeduplication:true,settingsPreserved:true,concurrentNativeTurnNotSteered:true,separateLaterTurn:true,externalInferenceCalls:0,providerCalls}));
} finally {
 for(const release of heldResponses)release();rpc?.close();
 for(const child of [...children].reverse())await stop(child);
 await new Promise(r=>provider.close(r));fs.rmSync(root,{recursive:true,force:true});
}
