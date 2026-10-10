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
import WebSocket from 'ws';
import { nativeFetch as fetch, NativeWebSocket } from './native-client.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-shared-pilot-'));
const home = path.join(root, 'home'), codexHome = path.join(root, 'codex'), data = path.join(root, 'data');
const cwd = path.join(data, 'workspaces', 'work'), socket = path.join(root, 's');
for (const dir of [home, codexHome, cwd]) fs.mkdirSync(dir, { recursive: true });
let providerCalls=0, toolRequested=false, releaseResponse, imageReceived=false;
const provider=http.createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 const input=JSON.parse(body);providerCalls++;imageReceived ||= JSON.stringify(input.input).includes('input_image');
 const wantsApproval=JSON.stringify(input.input).includes('READER_APPROVAL_FIXTURE');
 const commandTool=(input.tools||[]).find(t=>t.name==='exec_command');
 let item;
 if(wantsApproval&&!toolRequested&&commandTool){
  toolRequested=true;item={type:'function_call',id:'fc_'+providerCalls,call_id:'call_fixture',name:'exec_command',arguments:JSON.stringify({cmd:'printf reader-approval-command',sandbox_permissions:'require_escalated',justification:'Isolated Reader approval fixture'})};
 }else item={type:'message',id:'msg_'+providerCalls,role:'assistant',status:'completed',content:[{type:'output_text',text:wantsApproval?'READER_APPROVAL_FINISHED':'READER_REPLY_OK',annotations:[]}]};
 res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
 const send=(type,extra)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...extra})+'\n\n');
 send('response.created',{response:{id:'resp_'+providerCalls,status:'in_progress',output:[]}});
 if(providerCalls===1){
  send('response.output_item.added',{output_index:0,item:{id:'reasoning_fixture',type:'reasoning',summary:[]}});
  send('response.reasoning_summary_part.added',{item_id:'reasoning_fixture',output_index:0,summary_index:0,part:{type:'summary_text',text:''}});
  send('response.reasoning_summary_text.delta',{item_id:'reasoning_fixture',output_index:0,summary_index:0,delta:'LIVE_REASONING_FIXTURE'});
  send('response.output_item.done',{output_index:0,item:{id:'reasoning_fixture',type:'reasoning',summary:[{type:'summary_text',text:'LIVE_REASONING_FIXTURE'}]}});
 }
 send('response.output_item.added',{output_index:0,item:{...item,status:'in_progress'}});
 if(item.type==='message')send('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text});
 if(providerCalls===1)await new Promise(r=>releaseResponse=r);
 send('response.output_item.done',{output_index:0,item});
 send('response.completed',{response:{id:'resp_'+providerCalls,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
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
  return { call, shell, ws, init, close: () => ws.terminate() };
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
try {
  daemon = startChild('codex', ['app-server', '--listen', `unix://${socket}`]);
  for (let i = 0; !fs.existsSync(socket) && i < 100; i++) { assert.equal(daemon.exitCode, null); await sleep(50); }
  rpc = await connect();
  const {thread}=await rpc.call('thread/start',{cwd,sandbox:'read-only',approvalPolicy:'on-request',approvalsReviewer:'user'});
  await rpc.shell(thread.id,'printf reader-fixture-seed');
  const originalSettings=await rpc.call('thread/resume',{threadId:thread.id,excludeTurns:true});
  fs.writeFileSync(path.join(data,'sessions.json'),'[]');await startAM();
  const {session}=await call('/api/codex/import',{threadId:thread.id});const prefix='/api/sessions/'+session.id;
  const view=()=>call('/api/trace/'+session.id+'?tail=1&v=2');
  await view();
  const input={text:'READER_HELLO_FIXTURE',requestId:randomUUID()};
  const sent=await call(prefix+'/input',input);assert.ok(sent.turnId);assert.equal((await call(prefix+'/input',input)).repeated,true);
  async function waitFor(fn){for(let i=0;i<160;i++){const v=await fn();if(v)return v;await sleep(100);}throw Error('Condition timed out');}
  const streaming=await waitFor(async()=>{const s=await view();return JSON.stringify(s.live).includes('READER_REPLY_OK')&&s;});
  assert.ok(streaming.live.turns.some(t=>t.blocks.some(b=>b.type==='thinking'&&b.text==='LIVE_REASONING_FIXTURE')));
  assert.equal(streaming.activity,'working');assert.equal(streaming.interaction.canSend,false);
  assert.ok(streaming.live.turns.some(t=>t.role==='user'&&t.blocks.some(b=>b.text==='READER_HELLO_FIXTURE')));
  releaseResponse();
  await waitFor(async()=>{const s=await view();return s.interaction.canSend;});
  const trace=await call('/api/trace/'+session.id+'?tail=1&v=2');assert.ok(JSON.stringify(trace).includes('READER_REPLY_OK'));
  assert.equal(providerCalls,1,'retry must not generate twice');
  await call(prefix+'/input',{text:'READER_APPROVAL_FIXTURE',requestId:randomUUID()});
  const approval=await waitFor(async()=>{const s=await view();return s.interaction.requests.find(r=>r.kind==='permission');});
  const pendingView=await view();assert.ok([...pendingView.turns,...pendingView.live.turns].some(t=>t.blocks.some(b=>b.type==='tool_use'&&b.name==='exec_command')));
  assert.ok(toolRequested);assert.match(approval.details,/reader-approval-command/);
  await call(prefix+'/answer',{key:approval.key,decision:'accept'});
  await waitFor(async()=>{const s=await view();return s.interaction.canSend&&JSON.stringify(s).includes('READER_APPROVAL_FINISHED');});
  const upload=await fetch(base+prefix+'/attachments?name=pixel.png',{method:'POST',headers:{'x-am-origin':'operator','content-type':'image/png'},body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGNI6dlCU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULACD2kFvlDRtSAAAAAElFTkSuQmCC','base64')});
  const uploaded=await upload.json();assert.equal(upload.status,201,JSON.stringify(uploaded));
  const attachmentId=uploaded.attachment?.id||uploaded.id;assert.ok(attachmentId);
  await call(prefix+'/input',{text:'Image fixture',attachmentIds:[attachmentId],requestId:randomUUID()});
  await waitFor(async()=>{const s=await view();return s.interaction.canSend;});
  assert.ok(imageReceived,'uploaded image reaches model input');
  const after=await rpc.call('thread/resume',{threadId:thread.id,excludeTurns:true});
  for(const key of ['model','modelProvider','approvalPolicy','approvalsReviewer','sandbox','cwd'])assert.deepEqual(after[key],originalSettings[key],key+' changed');
  assert.equal((await call('/api/sessions')).find(s=>s.id===session.id).state,'waiting','Server state is independent of a TUI');
  assert.equal((await call('/api/sessions')).find(s=>s.id===session.id).terminalRunning,false);
  console.log(JSON.stringify({commonRoutes:true,liveReasoning:true,liveTools:true,imageUpload:true,readerTextRoundTrip:true,deduplicated:true,approvalInReader:true,settingsPreserved:true,noTUI:true,externalInferenceCalls:0,providerCalls}));
} finally {
  releaseResponse?.();
  terminal?.terminate(); rpc?.close();
  for (const child of [...children].reverse()) await stop(child);
  await new Promise(r=>provider.close(r));
  fs.rmSync(root, { recursive: true, force: true });
}
