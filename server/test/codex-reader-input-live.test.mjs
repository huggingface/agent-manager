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
import headless from '@xterm/headless';
import { nativeFetch as fetch, NativeWebSocket } from './native-client.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-shared-pilot-'));
const home = path.join(root, 'home'), codexHome = path.join(root, 'codex'), data = path.join(root, 'data');
const cwd = path.join(data, 'workspaces', 'work'), socket = path.join(root, 's');
for (const dir of [home, codexHome, cwd]) fs.mkdirSync(dir, { recursive: true });
let providerCalls=0, toolRequested=false, releaseResponse, imageReceived=false, holdExternal=false, emitFollowup;
let scenario = null, scenarioToolSent = false, questionAnswerReceived = false;
let identityCommand, identityOutput;
const providerEvents = [];
const heldResponses = new Set();
const provider=http.createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 const input=JSON.parse(body);providerCalls++;const callNumber=providerCalls;providerEvents.push({event:'start',callNumber,scenario,toolCount:input.tools?.length||0});imageReceived ||= JSON.stringify(input.input).includes('input_image');
 const wantsApproval=JSON.stringify(input.input).includes('READER_APPROVAL_FIXTURE');
 const commandTool=(input.tools||[]).find(t=>t.name==='exec_command');
 let item;
 if (scenario === 'question' && !scenarioToolSent) {
  const tool = (input.tools || []).find(t => t.name === 'request_user_input');
  assert.ok(tool, 'plan mode exposes request_user_input');
  scenarioToolSent = true;
  item = {type:'function_call', id:'fc_'+callNumber, call_id:'call_question', name:tool.name,
   arguments:JSON.stringify({questions:[{id:'choice',header:'Fixture',question:'Which fixture should continue?',
    options:[{label:'First',description:'Use the first fixture'},{label:'Second',description:'Use the second fixture'}]}]})};
 } else if (scenario === 'approval-external' && !scenarioToolSent) {
  assert.ok(commandTool);
  scenarioToolSent = true;
  item = {type:'function_call', id:'fc_'+callNumber, call_id:'call_external_approval', name:commandTool.name,
   arguments:JSON.stringify({cmd:'printf external-approval-command',sandbox_permissions:'require_escalated',justification:'Isolated cross-client approval fixture'})};
 } else if (scenario === 'identity' && !scenarioToolSent) {
  assert.ok(commandTool);
  scenarioToolSent = true;
  item = {type:'function_call',id:'fc_'+callNumber,call_id:'call_identity',name:commandTool.name,
   arguments:JSON.stringify({cmd:identityCommand,sandbox_permissions:'require_escalated',justification:'Resolve isolated AM identity from a native model tool'})};
 } else if (scenario) {
  if (scenario === 'identity') identityOutput = (input.input || []).findLast(i => i.type === 'function_call_output')?.output;
  if (scenario === 'question') {
   const output = (input.input || []).findLast(i => i.type === 'function_call_output' && i.call_id === 'call_question')?.output;
   questionAnswerReceived = typeof output === 'string' && output.includes('Second');
  }
  item = {type:'message',id:'msg_'+callNumber,role:'assistant',status:'completed',
   content:[{type:'output_text',text:'SCENARIO_FINISHED',annotations:[]}]};
 } else if(wantsApproval&&!toolRequested&&commandTool){
  toolRequested=true;item={type:'function_call',id:'fc_'+callNumber,call_id:'call_fixture',name:'exec_command',arguments:JSON.stringify({cmd:'printf reader-approval-command',sandbox_permissions:'require_escalated',justification:'Isolated Reader approval fixture'})};
 }else item={type:'message',id:'msg_'+callNumber,role:'assistant',status:'completed',content:[{type:'output_text',text:wantsApproval?'READER_APPROVAL_FINISHED':'READER_REPLY_OK',annotations:[]}]};
 res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
 const send=(type,extra)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...extra})+'\n\n');
 send('response.created',{response:{id:'resp_'+callNumber,status:'in_progress',output:[]}});
 if(callNumber===1){
  send('response.output_item.added',{output_index:0,item:{id:'reasoning_fixture',type:'reasoning',summary:[]}});
  send('response.reasoning_summary_part.added',{item_id:'reasoning_fixture',output_index:0,summary_index:0,part:{type:'summary_text',text:''}});
  send('response.reasoning_summary_text.delta',{item_id:'reasoning_fixture',output_index:0,summary_index:0,delta:'LIVE_REASONING_FIXTURE'});
  send('response.output_item.done',{output_index:0,item:{id:'reasoning_fixture',type:'reasoning',summary:[{type:'summary_text',text:'LIVE_REASONING_FIXTURE'}]}});
 }
 send('response.output_item.added',{output_index:0,item:{...item,status:'in_progress'}});
 if(item.type==='message')send('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text});
 if(holdExternal && commandTool && item.type === 'message')emitFollowup=()=>{item.content[0].text+=' LIVE_AFTER_ATTACH';send('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:' LIVE_AFTER_ATTACH'});};
 // The TUI can generate a title concurrently (a request with no tools).
 // Do not let that auxiliary call steal the real turn's release handle.
 // Response IDs are local to each request for the same reason.
 if(callNumber===1||(holdExternal && commandTool && item.type === 'message'))await new Promise(r=>{const release=()=>{heldResponses.delete(release);providerEvents.push({event:'release',callNumber});r();};heldResponses.add(release);releaseResponse=release;});
 send('response.output_item.done',{output_index:0,item});
 send('response.completed',{response:{id:'resp_'+callNumber,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();providerEvents.push({event:'end',callNumber});
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
  async function waitFor(fn) {
    for (let i = 0; i < 160; i++) {
      const value = await fn();
      if (value) return value;
      await sleep(100);
    }
    const state = await view();
    const recent = await rpc.call('thread/turns/list', {
      threadId:thread.id,limit:2,itemsView:'full',sortDirection:'desc',
    });
    throw Error('Condition timed out: '+JSON.stringify({
      activity:state.activity,interaction:state.interaction,
      providerCalls,scenario,holdExternal,providerEvents,
      native:recent.data.map(t => ({id:t.id,status:t.status,
        items:t.items.map(i => ({id:i.id,type:i.type,status:i.status}))})),
    }));
  }

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
  // A question issued by a model tool in another client must be answerable
  // through the same Reader controls, without changing that client's settings.
  scenario = 'question'; scenarioToolSent = false;
  await rpc.call('turn/start', {threadId:thread.id,input:[{type:'text',text:'QUESTION_FIXTURE'}],
    collaborationMode:{mode:'plan',settings:{model:'fixture',reasoning_effort:null,developer_instructions:null}}});
  const question = await waitFor(async () => (await view()).interaction.requests.find(r => r.kind === 'question'));
  assert.equal(question.questions[0].id, 'choice');
  assert.deepEqual(question.questions[0].options.map(o => o.label), ['First','Second']);
  await call(prefix+'/answer', {key:question.key,answers:{choice:'Second'}});
  await waitFor(async () => (await view()).interaction.canSend);
  assert.ok(questionAnswerReceived, 'the model receives the Reader answer');
  scenario = null;

  // Conversely, resolve a Reader-visible approval in the external client.
  // Hold the following response open: turn completion must not be the thing
  // that clears the old approval, and a stale Reader click must be rejected.
  scenario = 'approval-external'; scenarioToolSent = false;
  let externalRequest;
  const watchApproval = msg => {
    if (msg.method === 'item/commandExecution/requestApproval' && msg.params?.threadId === thread.id) externalRequest = msg;
  };
  rpc.events.add(watchApproval);
  await rpc.call('turn/start', {threadId:thread.id,input:[{type:'text',text:'EXTERNAL_APPROVAL_FIXTURE'}],
    collaborationMode:{mode:'default',settings:{model:'fixture',reasoning_effort:null,developer_instructions:null}}});
  const sharedApproval = await waitFor(async () => (await view()).interaction.requests.find(r => r.kind === 'permission'));
  await waitFor(async () => externalRequest);
  holdExternal = true; releaseResponse = null;
  rpc.ws.send(JSON.stringify({id:externalRequest.id,result:{decision:'accept'}}));
  await waitFor(async () => releaseResponse);
  const resolvedElsewhere = await waitFor(async () => {
    const s = await view(); return !s.interaction.requests.length && s;
  });
  assert.equal(resolvedElsewhere.activity, 'working');
  const staleReply = await fetch(base+prefix+'/answer', {method:'POST',
    headers:{'x-am-origin':'operator','content-type':'application/json'},
    body:JSON.stringify({key:sharedApproval.key,decision:'accept'})});
  assert.equal(staleReply.status, 409);
  assert.equal((await staleReply.json()).code, 'codex-request-stale');
  const busyReply = await fetch(base+prefix+'/input', {method:'POST',
    headers:{'x-am-origin':'operator','content-type':'application/json'},
    body:JSON.stringify({text:'MUST_NOT_QUEUE',requestId:randomUUID()})});
  assert.equal(busyReply.status, 409);
  assert.equal((await busyReply.json()).code, 'codex-task-busy');
  releaseResponse(); holdExternal = false;
  await waitFor(async () => (await view()).interaction.canSend);
  rpc.events.delete(watchApproval); scenario = null;

  // Verify attribution inside a real model tool, not only thread/shellCommand.
  // This is a read-only lookup against this fixture's AM and requires no AM_ID.
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  identityCommand = [process.execPath,path.resolve('../scripts/am-codex-context.mjs'),
    '--base-url',base,'resolve'].map(quote).join(' ');
  scenario = 'identity'; scenarioToolSent = false;
  await rpc.call('turn/start', {threadId:thread.id,input:[{type:'text',text:'NATIVE_IDENTITY_FIXTURE'}]});
  const identityApproval = await waitFor(async () => (await view()).interaction.requests.find(r => r.kind === 'permission'));
  assert.ok(identityApproval.details.includes('am-codex-context.mjs'));
  await call(prefix+'/answer', {key:identityApproval.key,decision:'accept'});
  await waitFor(async () => (await view()).interaction.canSend);
  for (const value of [session.id,thread.id,cwd]) assert.ok(identityOutput?.includes(value), 'model tool resolves exact context: '+identityOutput);
  scenario = null;

  // Work starts outside AM's Reader client, as it does from a TUI or Remote.
  // A warm Reader resumes from its byte cursor, not from a new tail window.
  const idlePage=await view();const cursor=idlePage.window.end;
  holdExternal=true;releaseResponse=null;
  await rpc.call('turn/start',{threadId:thread.id,input:[{type:'text',text:'EXTERNAL_CLIENT_FIXTURE'}]});
  await waitFor(async()=>releaseResponse);
  const external=await waitFor(async()=>{const s=await call('/api/trace/'+session.id+'?after='+cursor+'&v=2');return JSON.stringify(s.live).includes('READER_APPROVAL_FINISHED')&&s;});
  assert.equal(external.activity,'working','external turn activity is current');
  assert.equal(external.interaction.canSend,false);
  assert.ok(JSON.stringify(external).includes('EXTERNAL_CLIENT_FIXTURE'),'external prompt is visible');
  assert.ok(JSON.stringify(external.live).includes('READER_APPROVAL_FINISHED'),'external streamed answer is visible');
  releaseResponse();holdExternal=false;
  await waitFor(async()=>{const s=await view();return s.interaction.canSend;});
  // Restart only the disposable AM fixture: attach midway through another
  // client's turn, without replaying its input.
  await stop(am);await startAM();holdExternal=true;releaseResponse=null;
  await rpc.call('turn/start',{threadId:thread.id,input:[{type:'text',text:'COLD_EXTERNAL_FIXTURE'}]});
  await waitFor(async()=>releaseResponse);
  const coldExternal=await view();
  assert.equal(coldExternal.activity,'working');
  assert.ok(JSON.stringify(coldExternal).includes('COLD_EXTERNAL_FIXTURE'));
  assert.equal(coldExternal.interaction.error,null);
  // Codex's paginated history contains persisted items, not a replay of every
  // earlier text delta. Verify the newly attached reader receives subsequent
  // live output, then the full final item (without issuing another turn).
  emitFollowup();
  await waitFor(async()=>JSON.stringify((await view()).live).includes('LIVE_AFTER_ATTACH'));
  releaseResponse();holdExternal=false;
  await waitFor(async()=>{const s=await view();return s.interaction.canSend;});
  assert.equal((await call('/api/sessions')).find(s=>s.id===session.id).terminalRunning,false,'Reader alone never starts a TUI');
  // Finally exercise actual TUI input and close ONLY its browser transport,
  // exactly as a Terminal -> Reader switch does. No Ctrl-C or task interruption.
  const tuiCursor=(await view()).window.end;
  terminal=new NativeWebSocket(base.replace('http:','ws:')+'/ws?session='+session.id+'&cols=120&rows=34');
  const terminalEmulator = new headless.Terminal({cols:120,rows:34,allowProposedApi:true});
  terminalEmulator.onData(d => { if (terminal.readyState === 1) terminal.send(JSON.stringify({t:'i',d})); });
  let tuiOutput='';terminal.on('message',raw=>{
    const text=raw.toString();
    if (text.startsWith('\x00\x00AM:')) return;
    tuiOutput+=text; terminalEmulator.write(text);
  });
  await once(terminal,'open');
  await waitFor(async()=>tuiOutput.includes('COLD_EXTERNAL_FIXTURE'));
  holdExternal=true;releaseResponse=null;
  terminal.send(JSON.stringify({t:'i',d:'TUI_HANDOFF_FIXTURE'}));await sleep(100);
  terminal.send(JSON.stringify({t:'i',d:'\r'}));
  await waitFor(async()=>releaseResponse);terminal.close();
  const tuiView=await waitFor(async()=>{const s=await call('/api/trace/'+session.id+'?after='+tuiCursor+'&v=2');return JSON.stringify(s.live).includes('TUI_HANDOFF_FIXTURE')&&s;});
  assert.equal(tuiView.activity,'working');assert.equal(tuiView.interaction.canSend,false);
  releaseResponse();holdExternal=false;
  await waitFor(async()=>{const s=await view();return s.interaction.canSend;});
  const after=await rpc.call('thread/resume',{threadId:thread.id,excludeTurns:true});
  for(const key of ['model','modelProvider','approvalPolicy','approvalsReviewer','sandbox','cwd'])assert.deepEqual(after[key],originalSettings[key],key+' changed');
  terminalEmulator.dispose();
  assert.equal((await call('/api/sessions')).find(s=>s.id===session.id).state,'waiting','Server state is independent of a TUI');
  assert.equal((await call('/api/sessions')).find(s=>s.id===session.id).terminalRunning,true,'closing the view leaves the TUI intact');
  console.log(JSON.stringify({commonRoutes:true,externalClientTurn:true,coldAttachDuringWork:true,liveReasoning:true,liveTools:true,imageUpload:true,readerTextRoundTrip:true,deduplicated:true,approvalInReader:true,modelQuestionInReader:true,nativeModelToolAttribution:true,approvalResolvedElsewhere:true,staleAnswerRejected:true,busyExternalTurnRejectsInput:true,settingsPreserved:true,readerNeverStartsTUI:true,terminalHandoff:true,externalInferenceCalls:0,providerCalls,auxiliaryCalls:providerEvents.filter(e=>e.event==='start'&&e.toolCount===0).length}));
} finally {
  for (const release of heldResponses) release();
  terminal?.terminate(); rpc?.close();
  for (const child of [...children].reverse()) await stop(child);
  await new Promise(r=>provider.close(r));
  fs.rmSync(root, { recursive: true, force: true });
}
