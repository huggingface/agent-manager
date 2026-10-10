// am-test: manual — requires installed Codex and local sockets; isolated homes, no model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import WebSocket, {WebSocketServer} from 'ws';
import {pathToFileURL} from 'node:url';
import {build} from '../../web/node_modules/esbuild/lib/main.js';
import { nativeFetch as fetch } from './native-client.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-codex-creation-'));
const home = path.join(root, 'home'), codexHome = path.join(root, 'codex'), data = path.join(root, 'data');
const cwd = path.join(data, 'workspaces', 'work'), socket = path.join(root, 's');
for (const dir of [home, codexHome, cwd]) fs.mkdirSync(dir, { recursive: true });
let providerCalls=0, releaseResponse, holdExternal=false;
const heldResponses=new Set();
const provider=http.createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;JSON.parse(body);const n=++providerCalls;
 res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
 const send=(type,extra)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...extra})+'\n\n');
 const item={type:'message',id:'msg_'+n,role:'assistant',status:'completed',content:[{type:'output_text',text:'RECOVERY_RESPONSE_'+n,annotations:[]}]};
 send('response.created',{response:{id:'resp_'+n,status:'in_progress',output:[]}});
 send('response.output_item.added',{output_index:0,item:{...item,status:'in_progress'}});
 send('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text});
 if(holdExternal)await new Promise(r=>{const release=()=>{heldResponses.delete(release);r();};heldResponses.add(release);releaseResponse=release;});
 send('response.output_item.done',{output_index:0,item});
 send('response.completed',{response:{id:'resp_'+n,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
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
const children = new Set(); let rpc, terminal, am, daemon;
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
    ...env, CODEX_HOME: path.join(home, '.codex'), DATA_DIR: data, PORT: String(port), AM_CODEX_SHARED_SOCKET: proxySocket, AM_CODEX_SHARED_HOME: codexHome, AM_CODEX_BINDINGS_PILOT: '1', AM_CODEX_SHARED_CREATE:'1',
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
  const result = await response.json(); assert.ok([200,201].includes(response.status), response.status+' '+JSON.stringify(result)); return result;
}

// Drop a native creation acknowledgement after the server accepted it.
const proxySocket=path.join(root,'proxy');let loseCreationAck=false,createdIds=[];
const proxyHttp=http.createServer(),proxyWss=new WebSocketServer({server:proxyHttp});
proxyWss.on('connection',down=>{
 const up=new WebSocket('ws://localhost/',{createConnection:()=>net.connect(socket)}),queue=[],starts=new Set();
 down.on('message',raw=>{const m=JSON.parse(raw);if(m.method==='thread/start')starts.add(m.id);if(up.readyState===WebSocket.OPEN)up.send(raw.toString());else queue.push(raw);});
 up.on('open',()=>{for(const raw of queue)up.send(raw.toString());});
 up.on('message',raw=>{const m=JSON.parse(raw);if(starts.has(m.id)&&m.result?.thread){createdIds.push(m.result.thread.id);starts.delete(m.id);if(loseCreationAck){loseCreationAck=false;down.close();up.close();return;}}if(down.readyState===WebSocket.OPEN)down.send(raw.toString());});
 down.on('close',()=>up.close());up.on('close',()=>down.close());up.on('error',()=>down.close());down.on('error',()=>up.close());
});
await new Promise(r=>proxyHttp.listen(proxySocket,r));fs.chmodSync(proxySocket,0o600);
async function waitFor(fn){for(let i=0;i<150;i++){const value=await fn();if(value)return value;await sleep(100);}throw Error('Creation fixture timed out');}
try {
 daemon=startChild('codex',['app-server','--listen',`unix://${socket}`]);await waitFor(()=>fs.existsSync(socket));rpc=await connect();
 fs.writeFileSync(path.join(data,'sessions.json'),'[]');await startAM();
 const request={cli:'codex',name:'Empty shared fixture',path:'work',requestId:randomUUID()};
 const made=await call('/api/sessions',request);assert.equal(made.codexSharedOnly,true);assert.equal(made.terminalRunning,false);
 const id=made.codexSessionId,bindings=fs.readFileSync(path.join(data,'codex-bindings.json'),'utf8');
 assert.equal((await call('/api/codex/context?threadId='+id)).amSessionId,made.id);
 const view=()=>call('/api/trace/'+made.id+'?tail=1&v=2');
 const empty=await view();assert.equal(empty.turns.length,0);assert.equal(empty.interaction.canSend,true);assert.equal(providerCalls,0);
 assert.equal((await call('/api/sessions',request)).id,made.id);
 await stop(am);await startAM();assert.equal((await call('/api/sessions',request)).id,made.id);assert.equal(providerCalls,0);
 assert.equal(fs.readFileSync(path.join(data,'codex-bindings.json'),'utf8'),bindings);
 await call('/api/sessions/'+made.id+'/input',{text:'FIRST_EXPLICIT_PROMPT',requestId:randomUUID()});await waitFor(async()=>(await view()).interaction.canSend);
 // Use the actual Reader store against AM while a separate native client
 // represents Codex Remote. Both clients write the same exact thread.
 const storeFile=path.join(root,'reader-store.mjs');
 await build({entryPoints:[path.resolve('../web/src/lib/readerStore.ts')],outfile:storeFile,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {ReaderStore}=await import(pathToFileURL(storeFile));
 const reader=new ReaderStore({window:async req=>call('/api/trace/'+made.id+'?v=2&'+(req.at==='tail'?'tail=1':req.at+'='+req.cursor)+(req.generation?'&generation='+encodeURIComponent(req.generation):'')),summary:async()=>({})});
 await reader.loadNewer();
 holdExternal=true;releaseResponse=null;
 await rpc.call('turn/start',{threadId:id,input:[{type:'text',text:'PHONE_SECOND_PROMPT'}]});
 await waitFor(()=>releaseResponse);await reader.loadNewer();
 assert.deepEqual(reader.getSnapshot().turns.filter(t=>t.role==='user').map(t=>t.blocks[0].text),['FIRST_EXPLICIT_PROMPT','PHONE_SECOND_PROMPT']);
 releaseResponse();holdExternal=false;await waitFor(async()=>(await view()).interaction.canSend);
 await call('/api/sessions/'+made.id+'/input',{text:'READER_THIRD_PROMPT',requestId:randomUUID()});
 await waitFor(async()=>(await view()).interaction.canSend);await reader.loadNewer();
 const expected=['FIRST_EXPLICIT_PROMPT','PHONE_SECOND_PROMPT','READER_THIRD_PROMPT'];
 assert.deepEqual(reader.getSnapshot().turns.filter(t=>t.role==='user').map(t=>t.blocks[0].text),expected);
 await reader.loadNewer();assert.deepEqual(reader.getSnapshot().turns.filter(t=>t.role==='user').map(t=>t.blocks[0].text),expected);
 const quick={cli:'codex',name:'Quick shared fixture',path:'work',prompt:'QUICKSTART_PROMPT',requestId:randomUUID()};
 const started=await call('/api/sessions',quick);assert.equal(started.codexSharedOnly,true);
 await waitFor(async()=>(await call('/api/trace/'+started.id+'?tail=1&v=2')).interaction.canSend);
 const calls=providerCalls;assert.equal((await call('/api/sessions',quick)).id,started.id);assert.equal(providerCalls,calls);
 assert.equal((await call('/api/sessions')).length,2);assert.equal((await call('/api/sessions')).some(s=>s.terminalRunning),false);
 const ambiguous={cli:'codex',name:'Lost creation acknowledgement',path:'work',prompt:'MUST_NOT_RUN',requestId:randomUUID()};
 loseCreationAck=true;
 async function refused(){const res=await fetch(base+'/api/sessions',{method:'POST',headers:{'x-am-origin':'operator','content-type':'application/json'},body:JSON.stringify(ambiguous)});assert.equal(res.status,409);assert.equal((await res.json()).code,'codex-creation-uncertain');}
 const beforeCount=createdIds.length,beforeCalls=providerCalls;
 await refused();assert.equal(createdIds.length,beforeCount+1);
 await refused();await stop(am);await startAM();await refused();
 assert.equal(createdIds.length,beforeCount+1);assert.equal(providerCalls,beforeCalls);assert.equal((await call('/api/sessions')).length,2);
 console.log(JSON.stringify({remoteReaderOrder:true,uncertainCreationNoRetry:true,emptyCreation:true,emptyReader:true,durableName:true,exactMapping:true,retrySameIdentity:true,amRestart:true,firstPrompt:true,quickStartOnce:true,noTUI:true,externalInferenceCalls:0,providerCalls}));
}finally{rpc?.close();for(const child of [...children].reverse())await stop(child);for(const release of [...heldResponses])release();provider.closeAllConnections();await new Promise(r=>provider.close(r));for(const ws of proxyWss.clients)ws.terminate();await new Promise(r=>proxyWss.close(r));await new Promise(r=>proxyHttp.close(r));fs.rmSync(root,{recursive:true,force:true});}
