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
import { nativeFetch as fetch } from './native-client.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-codex-recovery-'));
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
    ...env, CODEX_HOME: path.join(home, '.codex'), DATA_DIR: data, PORT: String(port), AM_CODEX_SHARED_SOCKET: proxySocket, AM_CODEX_SHARED_HOME: codexHome, AM_CODEX_BINDINGS_PILOT: '1',
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
// Drop only the input acknowledgement to AM, while the real daemon accepts the
// turn. This proves durable no-replay across both daemon and AM crashes.
const proxySocket=path.join(root,'proxy');let loseAck=false;
const proxyHTTP=http.createServer(),proxyWS=new WebSocketServer({server:proxyHTTP});
proxyWS.on('connection',down=>{
 const up=new WebSocket('ws://localhost/',{createConnection:()=>net.connect(socket)}),queue=[],ignored=new Set();
 down.on('message',raw=>{const msg=JSON.parse(raw);if(loseAck&&msg.method==='turn/start')ignored.add(msg.id);if(up.readyState===WebSocket.OPEN)up.send(raw.toString());else queue.push(raw);});
 up.on('open',()=>{for(const raw of queue)up.send(raw.toString());});
 up.on('message',raw=>{const msg=JSON.parse(raw);if(!msg.method&&ignored.has(msg.id))return;if(down.readyState===WebSocket.OPEN)down.send(raw.toString());});
 up.on('close',()=>down.terminate());up.on('error',()=>down.terminate());down.on('close',()=>up.terminate());down.on('error',()=>up.terminate());
});
await new Promise(r=>proxyHTTP.listen(proxySocket,r));fs.chmodSync(proxySocket,0o600);
async function waitFor(fn){for(let i=0;i<150;i++){const result=await fn();if(result)return result;await sleep(100);}throw Error('Recovery fixture timed out');}
async function startDaemon(){
 if(fs.existsSync(socket))fs.unlinkSync(socket); // only our exited disposable daemon's socket
 daemon=startChild('codex',['app-server','--listen',`unix://${socket}`]);
 await waitFor(()=>fs.existsSync(socket));rpc=await connect();
}
async function crashDaemon(){const exit=once(daemon,'exit');daemon.kill('SIGKILL');await exit;rpc.close();for(const release of [...heldResponses])release();holdExternal=false;}
try {
 await startDaemon();
 const {thread}=await rpc.call('thread/start',{cwd,model:'fixture-custom',sandbox:'read-only',approvalPolicy:'on-request',approvalsReviewer:'user'});
 await rpc.shell(thread.id,'printf recovery-seed');
 const original=await rpc.call('thread/resume',{threadId:thread.id,excludeTurns:true});
 fs.writeFileSync(path.join(data,'sessions.json'),'[]');await startAM();
 const {session}=await call('/api/codex/import',{threadId:thread.id});
 const prefix='/api/sessions/'+session.id,view=()=>call('/api/trace/'+session.id+'?tail=1&v=2');await view();
 const bindings=fs.readFileSync(path.join(data,'codex-bindings.json'),'utf8');
 holdExternal=true;loseAck=true;
 const input={text:'CRASH_FIXTURE',requestId:randomUUID()};
 const pending=fetch(base+prefix+'/input',{method:'POST',headers:{'x-am-origin':'operator','content-type':'application/json'},body:JSON.stringify(input)});
 await waitFor(()=>releaseResponse);await view();await crashDaemon();
 const failure=await pending;assert.equal(failure.status,409);assert.equal((await failure.json()).code,'codex-send-uncertain');
 const saved=JSON.parse(fs.readFileSync(path.join(data,'codex-input-receipts',input.requestId+'.json'),'utf8'));assert.equal(saved.status,'sending');
 await waitFor(async()=>(await call('/api/sessions')).find(s=>s.id===session.id).state==='stopped');
 const unavailable=await fetch(base+'/api/trace/'+session.id+'?tail=1&v=2');assert.equal(unavailable.status,503);
 await stop(am);await startAM();await startDaemon();loseAck=false;
 const cold=(await rpc.call('thread/read',{threadId:thread.id,includeTurns:false})).thread;assert.equal(cold.status.type,'notLoaded');
 const summary=await rpc.call('thread/turns/list',{threadId:thread.id,limit:1,itemsView:'summary',sortDirection:'desc'});assert.equal(summary.data[0].status,'interrupted');
 const coldView=await view();assert.equal(coldView.interaction.canSend,false);assert.match(coldView.interaction.error,/interrupted/);
 const row=await waitFor(async()=>{const s=(await call('/api/sessions')).find(s=>s.id===session.id);return s.recoveryKey&&s;});
 assert.equal((await rpc.call('thread/read',{threadId:thread.id,includeTurns:false})).thread.status.type,'notLoaded','viewing does not resume');
 const callsBefore=providerCalls;
 const stale=await fetch(base+prefix+'/reconnect',{method:'POST',headers:{'x-am-origin':'operator','content-type':'application/json'},body:JSON.stringify({recoveryKey:'0'.repeat(64)})});assert.equal(stale.status,409);
 assert.equal((await rpc.call('thread/read',{threadId:thread.id,includeTurns:false})).thread.status.type,'notLoaded');
 const forbidden=await fetch(base+prefix+'/reconnect',{method:'POST',headers:{'x-am-origin':session.id,'content-type':'application/json'},body:JSON.stringify({recoveryKey:row.recoveryKey})});assert.equal(forbidden.status,403);
 await call(prefix+'/reconnect',{recoveryKey:row.recoveryKey});
 assert.equal(providerCalls,callsBefore,'recovery never starts inference');
 const restored=await rpc.call('thread/resume',{threadId:thread.id,excludeTurns:true});
 for(const key of ['model','modelProvider','approvalPolicy','approvalsReviewer','sandbox','cwd','reasoningEffort','serviceTier'])assert.deepEqual(restored[key],original[key],key);
 const recovered=await view();assert.equal(recovered.interaction.canSend,true);assert.match(recovered.interaction.error,/interrupted/);assert.ok(JSON.stringify(recovered).includes('recovery-seed'));
 const replay=await fetch(base+prefix+'/input',{method:'POST',headers:{'x-am-origin':'operator','content-type':'application/json'},body:JSON.stringify(input)});assert.equal(replay.status,409);assert.equal((await replay.json()).code,'codex-send-uncertain');assert.equal(providerCalls,callsBefore);
 assert.equal(fs.readFileSync(path.join(data,'codex-bindings.json'),'utf8'),bindings);
 releaseResponse=null;
 await call(prefix+'/input',{text:'EXPLICIT_NEXT_PROMPT',requestId:randomUUID()});
 await waitFor(async()=>(await view()).interaction.canSend);
 assert.equal((await view()).interaction.error,null);
 // Repeat with the other supported standard permission preset.
 const workspace=(await rpc.call('thread/start',{cwd,model:'fixture-workspace',sandbox:'workspace-write',approvalPolicy:'on-request',approvalsReviewer:'user'})).thread;
 await rpc.shell(workspace.id,'printf workspace-seed');
 const workspaceOriginal=await rpc.call('thread/resume',{threadId:workspace.id,excludeTurns:true});
 const wsSession=(await call('/api/codex/import',{threadId:workspace.id})).session;
 await call('/api/trace/'+wsSession.id+'?tail=1&v=2');
 // A real model turn persists native turn_context, unlike a user shell command.
 await call('/api/sessions/'+wsSession.id+'/input',{text:'WORKSPACE_SETTINGS_FIXTURE',requestId:randomUUID()});
 await waitFor(async()=>(await call('/api/trace/'+wsSession.id+'?tail=1&v=2')).interaction.canSend);
 await crashDaemon();await startDaemon();
 await call('/api/trace/'+wsSession.id+'?tail=1&v=2');
 const wsRow=await waitFor(async()=>{const s=(await call('/api/sessions')).find(s=>s.id===wsSession.id);return s.recoveryKey&&s;});
 await call('/api/sessions/'+wsSession.id+'/reconnect',{recoveryKey:wsRow.recoveryKey});
 const wsRestored=await rpc.call('thread/resume',{threadId:workspace.id,excludeTurns:true});
 for(const key of ['model','modelProvider','approvalPolicy','approvalsReviewer','sandbox','cwd','reasoningEffort','serviceTier'])assert.deepEqual(wsRestored[key],workspaceOriginal[key],key);
 const competing=await rpc.call('thread/resume',{threadId:workspace.id,excludeTurns:true,model:'other-fixture',sandbox:'read-only',approvalPolicy:'never'});
 for(const key of ['model','sandbox','approvalPolicy'])assert.deepEqual(competing[key],wsRestored[key], 'loaded resume must ignore '+key);
 console.log(JSON.stringify({loadedResumeDoesNotOverride:true,daemonCrash:true,amRestart:true,exactThread:true,settingsPreserved:true,readOnlyAndWorkspacePresets:true,interruptedNotCompleted:true,lostAcknowledgement:true,durableNoReplay:true,staleRecoveryRefused:true,operatorOnly:true,readDoesNotResume:true,explicitNewPromptWorks:true,externalInferenceCalls:0,providerCalls}));
} finally {
 for(const release of [...heldResponses])release();terminal?.terminate();rpc?.close();
 for(const child of [...children].reverse())await stop(child);
 for(const ws of proxyWS.clients)ws.terminate();await new Promise(r=>proxyWS.close(r));await new Promise(r=>proxyHTTP.close(r));
 provider.closeAllConnections();await new Promise(r=>provider.close(r));fs.rmSync(root,{recursive:true,force:true});
}
