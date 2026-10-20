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
import pty from 'node-pty';
import { nativeFetch as fetch } from './native-client.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-codex-migration-'));
const home = path.join(root, 'home'), codexHome = path.join(root, 'codex'), data = path.join(root, 'data');
const cwd = path.join(data, 'workspaces', 'work'), socket = path.join(root, 's');
for (const dir of [home, codexHome, cwd]) fs.mkdirSync(dir, { recursive: true });
let baselineCalls=0, providerCalls=0, releaseResponse, holdExternal=false;
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
const original=cp.execFile; cp.execFile=(...args)=>{if(args[1]?.includes('--version')){queueMicrotask(()=>args.at(-1)(new Error('fixture')));return;}return original(...args);};cp.execFile[Symbol.for('nodejs.util.promisify.custom')]=original[Symbol.for('nodejs.util.promisify.custom')];syncBuiltinESMExports();`);
async function startAM() {
  am = startChild(process.execPath, ['--import', preload, 'src/index.js'], { cwd: process.cwd(), env: {
    ...env, CODEX_HOME: path.join(home, '.codex'), DATA_DIR: data, PORT: String(port), AM_CODEX_SHARED_SOCKET: proxySocket, AM_CODEX_SHARED_HOME: codexHome, AM_CODEX_BINDINGS_PILOT: '1', AM_CODEX_SHARED_CREATE:'1', AM_CODEX_MIGRATION:'1',
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

const proxySocket=socket;
async function waitFor(fn){for(let i=0;i<150;i++){const value=await fn();if(value)return value;await sleep(100);}throw Error('Migration fixture timeout');}
async function startDaemon(){if(fs.existsSync(socket))fs.unlinkSync(socket);daemon=startChild('codex',['app-server','--listen',`unix://${socket}`]);await waitFor(()=>fs.existsSync(socket));rpc=await connect();}
try {
 // Start with a real standalone TUI: app-server-created fixtures omit the
 // built-in collaboration prompt that legacy TUIs actually persist.
 let tuiOutput='';
 terminal=pty.spawn('codex',['--no-alt-screen','-C',cwd,'-s','read-only','-a','on-request','-c','approvals_reviewer="user"','-c','model_reasoning_effort="high"','PRESERVED_LEGACY_CONVERSATION'],{env,cols:100,rows:30,cwd});
 let tuiExited=false;terminal.onExit(()=>{tuiExited=true;});
 terminal.onData(d=>{tuiOutput+=d;if(d.includes('\x1b[6n'))terminal.write('\x1b[1;1R');if(d.includes('\x1b[c'))terminal.write('\x1b[?1;2c');});
 await waitFor(()=>providerCalls>=1&&/RECOVERY_RESPONSE_[0-9]+/.test(tuiOutput));
 const findRollout=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?findRollout(path.join(dir,e.name)):e.name.endsWith('.jsonl')?[path.join(dir,e.name)]:[]);
 const rollout=findRollout(path.join(codexHome,'sessions'))[0];
 const records=fs.readFileSync(rollout,'utf8').trim().split('\n').map(JSON.parse);
 const thread={id:records[0].payload.id};
 const saved=records.filter(r=>r.type==='turn_context').at(-1).payload;
 assert.equal(saved.collaboration_mode.settings.developer_instructions,fs.readFileSync(new URL('./default-collaboration-162.txt',import.meta.url),'utf8'));
 await sleep(600);terminal.write('/quit');await sleep(400);terminal.write('\r');await waitFor(()=>tuiExited);terminal=null;baselineCalls=providerCalls;
 await startDaemon();
 const originalHistory=await rpc.call('thread/turns/list',{threadId:thread.id,limit:50,itemsView:'full',sortDirection:'desc'});
 const {recoverySettings}=await import('../src/codex-recovery.js');
 const originalSettings=recoverySettings(saved,{modelProvider:'fixture'},cwd).expected;
 const legacy={id:'legacy-fixture',name:'Legacy fixture',cli:'codex',path:'work',sessionUuid:randomUUID(),codexSessionId:thread.id,everStarted:true,createdAt:new Date().toISOString()};
 fs.writeFileSync(path.join(data,'sessions.json'),JSON.stringify([legacy]));
 await startAM();
 const route='/api/sessions/'+legacy.id+'/codex/migration';
 const {CodexMigration}=await import('../src/codex-migrate.js');
 await new CodexMigration({store:{get:()=>legacy,list:()=>[legacy]},bindings:{forSession:()=>null},isRunning:()=>false,enabled:()=>true,root:path.join(data,'workspaces'),endpoint:()=>({socket:fs.realpathSync(socket),home:fs.realpathSync(codexHome),id:'fixture'})}).inspect(legacy.id);
 const preview=await call(route);assert.equal(preview.threadId,thread.id);assert.equal(preview.history.count,1);assert.ok(['free','absent'].includes(preview.owner.state));
 assert.equal((await call('/api/sessions'))[0].codexSharedOnly,undefined);assert.equal(providerCalls,baselineCalls,'preview sends no inference');
 const refused=await fetch(base+route,{method:'POST',headers:{'x-am-origin':'operator','content-type':'application/json'},body:JSON.stringify({key:'0'.repeat(64)})});assert.equal(refused.status,409);assert.equal((await refused.json()).code,'codex-migration-stale');
 const result=await call(route,{key:preview.key});assert.equal(result.ok,true);assert.equal(result.threadId,thread.id);
 const migrated=(await call('/api/sessions'))[0];assert.equal(migrated.codexSharedOnly,true);for(const k of ['id','sessionUuid','codexSessionId','name','path'])assert.equal(migrated[k],legacy[k]);
 const finalSettings=await rpc.call('thread/resume',{threadId:thread.id,excludeTurns:true});
 for(const k of ['model','modelProvider','approvalPolicy','approvalsReviewer','sandbox','cwd','reasoningEffort','serviceTier'])assert.deepEqual(finalSettings[k],originalSettings[k],k);
 assert.deepEqual((await rpc.call('thread/turns/list',{threadId:thread.id,limit:50,itemsView:'full',sortDirection:'desc'})).data,originalHistory.data);
 assert.equal((await call('/api/codex/context?threadId='+thread.id)).amSessionId,legacy.id);
 const bindings=fs.readFileSync(path.join(data,'codex-bindings.json'),'utf8');await stop(am);await startAM();
 assert.equal(fs.readFileSync(path.join(data,'codex-bindings.json'),'utf8'),bindings);assert.equal((await call('/api/sessions'))[0].terminalRunning,false);
 assert.equal((await call('/api/trace/'+legacy.id+'?tail=1&v=2')).interaction.canSend,true);assert.equal(providerCalls,baselineCalls);
 console.log(JSON.stringify({exactLegacyIdentity:true,previewReadOnly:true,staleKeyRefused:true,historyIdentical:true,settingsIdentical:true,durableGuard:true,amRestart:true,noTUI:true,externalInferenceCalls:0,providerCalls,baselineCalls,realStandaloneTUI:true}));
}finally{terminal?.kill();rpc?.close();for(const child of [...children].reverse())await stop(child);for(const release of [...heldResponses])release();provider.closeAllConnections();await new Promise(r=>provider.close(r));fs.rmSync(root,{recursive:true,force:true});}
