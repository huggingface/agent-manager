import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-input-'));
process.env.DATA_DIR = root; process.env.AM_WORKSPACES_DIR = root;
const { CodexInput } = await import('../src/codex-input.js');
const { CodexBindings } = await import('../src/codex-bindings.js');
const { configuredEndpoint } = await import('../src/codex-context.js');
const { CodexInteractiveClient } = await import('../src/codex-interactive.js');
const socket = path.join(root, 'socket'); fs.writeFileSync(socket, 'fixture');
const endpoint = configuredEndpoint({ home: root, socket });
let n = 0;
function fixture() {
 const session = {id:'am',cli:'codex',path:'',sessionUuid:randomUUID(),codexSessionId:randomUUID(),codexSharedOnly:true};
 const bindings = new CodexBindings(path.join(root, `bindings-${++n}`));
 bindings.bind({session,threadId:session.codexSessionId,endpointId:endpoint.id,cwd:root,expectedRevision:0});
 const thread = {id:session.codexSessionId,cwd:root,status:{type:'idle'},canAcceptDirectInput:true};
 const turn = {id:'active-turn',status:'inProgress'};
 const calls=[], replies=[]; let locked=false, lost=false, connects=0;
 const client={endpoint,closed:false,requests:new Map(),items:new Map(),requestView(){return [...this.requests.values()];},
  async call(method,params){calls.push({method,params});if(method==='thread/turns/list')return {data:[turn]};if(method==='turn/interrupt')return {};if(['turn/start','thread/queue/add'].includes(method)){if(lost)throw Error('timeout');return method==='thread/queue/add'?{queuedSubmission:{id:'queued-fixture',clientUserMessageId:params.clientUserMessageId}}:{turn:{id:'turn-fixture'}};}return {thread};},
  close(){this.closed=true;},async answer(key,response){replies.push({key,response});this.requests.delete(key);}};
 const deps={getSession:()=>session,listSessions:()=>[session],bindings,endpoint:()=>endpoint,connect:async()=>{connects++;return client;},observe:async()=>client,
  owner:async()=>({state:'free',activeGoal:false,queuedInput:false}),receipts:path.join(root,`receipts-${n}`),enabled:()=>true,assertWritable:()=>{if(locked)throw Error('locked');}};
 return {session,thread,turn,client,calls,replies,deps,hub:new CodexInput(deps),connects:()=>connects,lock:()=>locked=true,lose:()=>lost=true};
}
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('exact UUID, unchanged settings, durable idempotency across retry and AM restart',async()=>{
 const f=fixture(), input={text:'Private fixture prompt',requestId:randomUUID()};
 const sent=await f.hub.send('am',input);assert.equal(sent.turnId,'turn-fixture');
 assert.deepEqual(f.calls.find(c=>c.method==='thread/resume').params,{threadId:f.thread.id,excludeTurns:true});
 assert.deepEqual(Object.keys(f.calls.find(c=>c.method==='turn/start').params).sort(),['clientUserMessageId','input','threadId']);
 await f.hub.send('am',input);await new CodexInput(f.deps).send('am',input);
 assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);
 assert.ok(!fs.readFileSync(path.join(f.deps.receipts,input.requestId+'.json'),'utf8').includes(input.text));
 await assert.rejects(f.hub.send('am',{...input,text:'changed'}),{code:'codex-request-conflict'});
});
test('unknown acknowledgement never replays, even after restart',async()=>{
 const f=fixture();f.lose();const input={text:'hello',requestId:randomUUID()};
 await assert.rejects(f.hub.send('am',input),{code:'codex-send-uncertain'});
 await assert.rejects(new CodexInput(f.deps).send('am',input),{code:'codex-send-uncertain'});
 assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);
});
test('busy task, lost binding, archive, privacy lock and aborted request cannot send',async()=>{
 for(const mutate of [f=>f.thread.status={type:'active'},f=>f.session.codexSessionId=randomUUID(),f=>f.session.archivedAt='today',f=>f.lock()]){
  const f=fixture();mutate(f);await assert.rejects(f.hub.send('am',{text:'hello',requestId:randomUUID()}));
  assert.equal(f.calls.filter(c=>c.method==='turn/start').length,0);
 }
 const f=fixture();await assert.rejects(f.hub.send('am',{text:'hello',requestId:randomUUID()},{signal:AbortSignal.abort()}));
 assert.equal(f.calls.filter(c=>c.method==='turn/start').length,0);
});
test('one connection for concurrent attach, and concurrent sends serialize',async()=>{
 const f=fixture();await Promise.all([f.hub.attach('am'),f.hub.attach('am')]);assert.equal(f.connects(),1);
 const replies=await Promise.allSettled([f.hub.send('am',{text:'one',requestId:randomUUID()}),f.hub.send('am',{text:'two',requestId:randomUUID()})]);
 assert.equal(replies.filter(r=>r.status==='fulfilled').length,1);
});
test('approval responses are exact, scoped and never broaden policy',async()=>{
 const f=fixture();await f.hub.attach('am');
 f.client.requests.set('q',{method:'item/commandExecution/requestApproval',params:{threadId:f.thread.id,availableDecisions:['accept','decline']}});
 await assert.rejects(f.hub.answer('am',{key:'q',decision:'acceptForSession'}));
 await f.hub.answer('am',{key:'q',decision:'accept'});assert.deepEqual(f.replies,[{key:'q',response:{decision:'accept'}}]);
 await assert.rejects(f.hub.answer('am',{key:'q',decision:'accept'}));
 f.client.requests.set('u',{method:'item/tool/requestUserInput',params:{threadId:f.thread.id,questions:[{id:'answer'}]}});
 await f.hub.answer('am',{key:'u',answers:{answer:'operator response'}});
 assert.deepEqual(JSON.parse(JSON.stringify(f.replies[1].response)),{answers:{answer:{answers:['operator response']}}});
 f.client.requests.set('locked',{method:'item/fileChange/requestApproval',params:{threadId:f.thread.id,grantRoot:root}});
 await assert.rejects(f.hub.answer('am',{key:'locked',decision:'accept'}));
 f.lock();await assert.rejects(f.hub.answer('am',{key:'locked',decision:'decline'}));
});
test('events isolate tasks and clear requests resolved elsewhere',()=>{
 const c=Object.create(CodexInteractiveClient.prototype);c.threadId='ours';
 c.receiveServerMessage({id:1,method:'item/tool/requestUserInput',params:{threadId:'other'}});assert.equal(c.requests,undefined);
 c.receiveServerMessage({id:1,method:'item/tool/requestUserInput',params:{threadId:'ours',turnId:'t'}});assert.equal(c.requests.size,1);
 c.receiveServerMessage({method:'serverRequest/resolved',params:{threadId:'other',requestId:1}});assert.equal(c.requests.size,1);
 c.receiveServerMessage({method:'serverRequest/resolved',params:{threadId:'ours',requestId:1}});assert.equal(c.requests.size,0);
 assert.equal(c.allows('turn/interrupt',{threadId:'ours'}),false);
 assert.equal(c.allows('thread/resume',{threadId:'ours',excludeTurns:true,approvalPolicy:'never'}),false);
});

test('interrupt verifies exact active turn and never stops or unloads a task', async () => {
 const f=fixture();f.thread.status={type:'active',activeFlags:[]};
 const result=await f.hub.interrupt('am',{turnId:f.turn.id});
 assert.deepEqual(result,{ok:true,requested:true,turnId:f.turn.id});
 assert.deepEqual(f.calls.filter(c=>c.method==='turn/interrupt'),[{method:'turn/interrupt',params:{threadId:f.thread.id,turnId:f.turn.id}}]);
 assert.ok(!f.calls.some(c=>['turn/start','thread/archive','thread/unsubscribe','process/kill'].includes(c.method)));
});
test('stale, idle, archived, cancelled and locked interruptions never reach the daemon', async () => {
 for (const mutate of [f=>f.turn.id='newer',f=>f.thread.status={type:'idle'},f=>f.session.archivedAt='now',f=>f.lock()]) {
  const f=fixture();f.thread.status={type:'active',activeFlags:[]};mutate(f);
  await assert.rejects(f.hub.interrupt('am',{turnId:'active-turn'}));
  assert.equal(f.calls.filter(c=>c.method==='turn/interrupt').length,0);
 }
 const f=fixture();f.thread.status={type:'active',activeFlags:[]};
 await assert.rejects(f.hub.interrupt('am',{turnId:f.turn.id},{signal:AbortSignal.abort()}),{code:'codex-interrupt-cancelled'});
 assert.equal(f.calls.filter(c=>c.method==='turn/interrupt').length,0);
});
test('binding is rechecked after reading active turn, and uncertain interrupts are not retried', async () => {
 const f=fixture();f.thread.status={type:'active',activeFlags:[]};const original=f.client.call.bind(f.client);
 f.client.call=async(method,params)=>{const result=await original(method,params);if(method==='thread/turns/list')f.session.codexSessionId=randomUUID();return result;};
 await assert.rejects(f.hub.interrupt('am',{turnId:f.turn.id}));assert.equal(f.calls.filter(c=>c.method==='turn/interrupt').length,0);
 const g=fixture();g.thread.status={type:'active',activeFlags:[]};const call=g.client.call.bind(g.client);
 g.client.call=async(method,params)=>{const result=await call(method,params);if(method==='turn/interrupt')throw Error('connection lost');return result;};
 await assert.rejects(g.hub.interrupt('am',{turnId:g.turn.id}),{code:'codex-interrupt-uncertain'});
 assert.equal(g.calls.filter(c=>c.method==='turn/interrupt').length,1);
});
test('archived task status remains observable without resuming it', async () => {
 const f=fixture();f.session.archivedAt='now';f.thread.status={type:'active',activeFlags:[]};
 const status=await f.hub.status('am');assert.equal(status.status,'working');assert.equal(status.activeTurnId,f.turn.id);
 assert.equal(f.calls.some(c=>c.method==='thread/resume'),false);
});

test('recovery refuses stale identity, archived tasks, locks, cancellation and concurrent attachment before native resume',async()=>{
 for(const mutate of [f=>f.session.archivedAt='now',f=>f.thread.status={type:'active'},f=>f.lock(),f=>f.hub.attaching.set('am',Promise.resolve()),f=>f.hub.recovery=async()=>{f.session.codexSessionId=randomUUID();return {key:'a'.repeat(64),settings:{params:{},expected:{}}};}]){
  const f=fixture();f.thread.status={type:'notLoaded'};f.hub.recovery=async()=>({key:'a'.repeat(64),settings:{params:{},expected:{}}});mutate(f);
  await assert.rejects(f.hub.reconnect('am',{recoveryKey:'a'.repeat(64)}));assert.equal(f.calls.some(c=>c.method==='thread/resume'),false);
 }
 const f=fixture();f.thread.status={type:'notLoaded'};f.hub.recovery=async()=>({key:'a'.repeat(64),settings:{params:{},expected:{}}});
 await assert.rejects(f.hub.reconnect('am',{recoveryKey:'a'.repeat(64)},{signal:AbortSignal.abort()}),{code:'codex-recovery-cancelled'});
 assert.equal(f.calls.some(c=>c.method==='thread/resume'),false);
});


test('input and subscription do not wait for display hydration',async()=>{
 const f=fixture();let hydrated=false;
 f.client.hydrate=async()=>{hydrated=true;throw Error('large display snapshot');};
 await f.hub.send('am',{text:'still sendable',requestId:randomUUID()});
 assert.equal(hydrated,false);assert.equal(f.client.closed,false);
 assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);
});

test('closed clients release capacity while live subscriptions and pending requests are preserved',async()=>{
 const hub=new CodexInput({enabled:()=>true});
 hub.context=id=>({stamp:id,threadId:id,endpoint});
 hub.metadata=async()=>({status:{type:'idle'},canAcceptDirectInput:true});hub.check=()=>{};
 hub.connect=async()=>({closed:false,requests:new Map(),call:async(_m,p)=>({thread:{id:p.threadId}}),close(){this.closed=true;}});
 for(let i=0;i<50;i++)await hub.attach('task'+i);
 await assert.rejects(hub.attach('extra'),{code:'codex-client-limit'});
 const retained=hub.clients.get('task0').client;
 retained.requests.set('approval',{key:'approval'});
 for(const [id,entry] of hub.clients)if(id!=='task0')entry.client.close();
 await hub.attach('new');assert.equal(hub.clients.size,2);
 assert.equal(hub.clients.get('task0').client,retained);
 assert.equal(retained.requests.size,1);assert.equal(retained.closed,false);
 // A global transport disconnect must also allow a completely new task.
 for(const entry of hub.clients.values())entry.client.close();
 await hub.attach('after-restart');assert.equal(hub.clients.size,1);
 assert.equal(hub.clients.has('after-restart'),true);
});


function withSender(f) {
 const source={id:'sender',name:'Reviewer',cli:'claude',sessionUuid:randomUUID()};
 f.hub.getSession=id=>id==='sender'?source:id==='am'?f.session:null;
 f.hub.listSessions=()=>[f.session,source];return source;
}
test('agent delivery uses the native queue with durable source-scoped receipts and no terminal/steering',async()=>{
 const f=fixture(),source=withSender(f),input={text:'Please review',requestId:randomUUID()};
 const first=await f.hub.sendFromAgent('am',input,'sender');
 assert.deepEqual(first,{ok:true,queued:true,queuedSubmissionId:'queued-fixture'});
 assert.equal((await f.hub.sendFromAgent('am',input,'sender')).repeated,true);
 const restarted=new CodexInput({...f.deps,getSession:f.hub.getSession,listSessions:f.hub.listSessions});
 assert.equal((await restarted.sendFromAgent('am',input,'sender')).repeated,true);
 const sent=f.calls.filter(c=>c.method==='thread/queue/add');assert.equal(sent.length,1);
 assert.ok(!f.calls.some(c=>['turn/start','turn/steer','turn/interrupt'].includes(c.method)));
 assert.match(sent[0].params.input[0].text,/\[message from Reviewer:\]/);
 assert.match(sent[0].params.input[0].text,/"amSessionId":"sender"/);
 assert.equal(f.hub.readReceipt(input.requestId).source.sessionUuid,source.sessionUuid);
 await assert.rejects(f.hub.sendFromAgent('am',{...input,text:'different'},'sender'),{code:'codex-request-conflict'});
 await assert.rejects(f.hub.send('am',{text:sent[0].params.input[0].text,requestId:input.requestId}),{code:'codex-request-conflict'});
});
test('authorized agent delivery restores an unloaded exact task before queueing once',async()=>{
 const f=fixture();withSender(f);f.thread.status={type:'notLoaded'};let recoveries=0;
 f.hub.status=async()=>({status:'unloaded',recoveryKey:'a'.repeat(64)});
 f.hub.reconnect=async(_id,{recoveryKey})=>{recoveries++;assert.equal(recoveryKey,'a'.repeat(64));f.thread.status={type:'idle'};f.client.closed=false;return {ok:true};};
 const input={text:'resume and deliver',requestId:randomUUID()};
 const result=await f.hub.sendFromAgent('am',input,'sender');
 assert.equal(recoveries,1);assert.equal(result.queued,true);
 assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,1);
 f.thread.status={type:'notLoaded'};
 assert.equal((await f.hub.sendFromAgent('am',input,'sender')).repeated,true);
 assert.equal(recoveries,1);assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,1);
});
test('agent auto-recovery refuses unreconstructible settings and ordinary sends remain manual',async()=>{
 const f=fixture();withSender(f);f.thread.status={type:'notLoaded'};
 f.hub.status=async()=>({status:'unloaded',recoveryKey:null,recoveryError:'exact settings unavailable'});
 await assert.rejects(f.hub.sendFromAgent('am',{text:'agent',requestId:randomUUID()},'sender'),{code:'codex-recovery-review'});
 await assert.rejects(f.hub.send('am',{text:'operator',requestId:randomUUID()}),{code:'codex-not-loaded'});
 assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,0);
});
test('lost recovery acknowledgement does not queue without verified restored settings',async()=>{
 const f=fixture();withSender(f);f.thread.status={type:'notLoaded'};
 f.hub.status=async()=>({status:'unloaded',recoveryKey:'a'.repeat(64)});
 f.hub.reconnect=async()=>{f.thread.status={type:'idle'};f.client.closed=false;const error=new Error('lost');error.code='codex-recovery-uncertain';throw error;};
 await assert.rejects(f.hub.sendFromAgent('am',{text:'once',requestId:randomUUID()},'sender'),{code:'codex-recovery-uncertain'});
 assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,0);
});
test('agent delivery rejects known active targets, stale senders, cancellation and uncertain retries',async()=>{
 for(const mode of ['active','archived','changed','cancelled']){
  const f=fixture(),source=withSender(f);const call=f.client.call.bind(f.client);
  if(mode==='active')f.thread.status={type:'active',activeFlags:[]};
  if(mode==='archived')source.archivedAt='now';
  if(mode==='changed')f.client.call=async(...args)=>{const result=await call(...args);source.sessionUuid=randomUUID();return result;};
  await assert.rejects(f.hub.sendFromAgent('am',{text:'hello',requestId:randomUUID()},'sender',{signal:mode==='cancelled'?AbortSignal.abort():undefined}));
  assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,0);
 }
 const f=fixture();withSender(f);f.lose();const input={text:'once',requestId:randomUUID()};
 await assert.rejects(f.hub.sendFromAgent('am',input,'sender'),{code:'codex-send-uncertain'});
 await assert.rejects(f.hub.sendFromAgent('am',input,'sender'),{code:'codex-send-uncertain'});
 assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,1);
 await assert.rejects(f.hub.sendFromAgent('am',{text:'self',requestId:randomUUID()},'am'),{code:'codex-self-message'});
});

test('reconnect never resumes a held writer, queued input or active goal',async()=>{
 for(const owner of [{state:'held',activeGoal:false,queuedInput:false},{state:'unknown'},{state:'free',activeGoal:true,queuedInput:false},{state:'free',activeGoal:false,queuedInput:true}]){
  const f=fixture();f.thread.status={type:'notLoaded'};f.hub.owner=async()=>owner;f.hub.recovery=async()=>({key:'a'.repeat(64),settings:{params:{},expected:{}}});
  await assert.rejects(f.hub.reconnect('am',{recoveryKey:'a'.repeat(64)}));assert.equal(f.calls.some(c=>c.method==='thread/resume'),false);
 }
});

test('invalid, cancelled or stale-source deliveries never inspect receipt paths or wake a task',async()=>{
 for(const mode of ['uuid','oversize','cancelled','source']) {
  const f=fixture();const sender=withSender(f);f.thread.status={type:'notLoaded'};
  f.hub.readReceipt=()=>{throw Error('receipt accessed before validation');};
  const input={text:mode==='oversize'?'x'.repeat(50000):'hello',requestId:mode==='uuid'?'../../outside':randomUUID()};
  const options=mode==='cancelled'?{signal:AbortSignal.abort()}:mode==='source'?{cancelled:()=>{sender.archivedAt='now';}}:{};
  await assert.rejects(f.hub.sendFromAgent('am',input,'sender',options),e=>['invalid-input','codex-send-cancelled','codex-sender-stale','codex-sender-archived'].includes(e.code));
  assert.equal(f.calls.length,0);
 }
});

test('sender is revalidated after writer inspection and before the actual recovery RPC',async()=>{
 const f=fixture(),source=withSender(f);f.thread.status={type:'notLoaded'};f.turn.status='completed';
 f.hub.recovery=async()=>({key:'a'.repeat(64),settings:{params:{},expected:{}}});
 f.hub.owner=async()=>{source.archivedAt='now';return {state:'free',activeGoal:false,queuedInput:false};};
 await assert.rejects(f.hub.sendFromAgent('am',{text:'hello',requestId:randomUUID()},'sender'),{code:'codex-sender-archived'});
 assert.equal(f.calls.filter(c=>['thread/resume','thread/queue/add'].includes(c.method)).length,0);
});

test('cached subscription to an unloaded task recovers, concurrent recovery never duplicates resume',async()=>{
 const f=fixture();withSender(f);await f.hub.attach('am');f.thread.status={type:'notLoaded'};f.turn.status='completed';
 let resumes=0;const call=f.client.call.bind(f.client);
 f.hub.recovery=async()=>({key:'a'.repeat(64),settings:{params:{model:'fixture-model'},expected:{model:'fixture-model'}}});
 f.client.call=async(method,params)=>{
  if(method==='thread/resume' && params.model){resumes++;f.thread.status={type:'idle'};f.client.closed=false;return {thread:f.thread,model:'fixture-model'};}
  return call(method,params);
 };
 const input={text:'once',requestId:randomUUID()};
 const results=await Promise.allSettled([f.hub.sendFromAgent('am',input,'sender'),f.hub.sendFromAgent('am',input,'sender')]);
 assert(results.some(r=>r.status==='fulfilled'));assert.equal(resumes,1);
 assert.equal(f.calls.filter(c=>c.method==='thread/queue/add').length,1);
 assert.equal((await f.hub.sendFromAgent('am',input,'sender')).repeated,true);
});


test('automatic recovery refuses a nonterminal last turn even on an unloaded task',async()=>{
 for(const status of ['inProgress','unknown-future-status']) {
  const f=fixture();withSender(f);f.thread.status={type:'notLoaded'};
  f.hub.status=async()=>({status:'unloaded',lastTurnStatus:status,recoveryKey:'a'.repeat(64)});
  await assert.rejects(f.hub.sendFromAgent('am',{text:'next task',requestId:randomUUID()},'sender'),{code:'codex-recovery-pending'});
  assert.equal(f.calls.some(c=>['thread/resume','thread/queue/add'].includes(c.method)),false);
 }
});
test('archived active native sender has distinct actionable refusal, deletion and stale binding stay refused',async()=>{
 const f=fixture();f.deps.getSession=id=>id==='am'?f.session:null;const hub=new CodexInput(f.deps);
 assert.equal(hub.agentSource('am').threadId,f.session.codexSessionId);
 f.session.archivedAt='2026-10-18T10:36:08.732Z';f.thread.status={type:'active'};
 assert.throws(()=>hub.agentSource('am'),e=>e.code==='codex-sender-archived'&&/Restore this same session/.test(e.message));
 assert.throws(()=>hub.agentSource('deleted'),{code:'codex-sender-stale'});
 delete f.session.archivedAt;f.session.sessionUuid=randomUUID();
 assert.throws(()=>hub.agentSource('am'),{code:'codex-binding-stale'});
 assert.equal(f.calls.length,0,'sender checks never resume, interrupt or send');
});

test('archived recipient is distinct from missing binding, remains observable, and restores on the same thread',async()=>{
 const f=fixture();const original=f.hub.context('am');f.session.archivedAt='2026-10-18T10:36:08Z';
 assert.throws(()=>f.hub.context('am'),e=>e.code==='codex-target-archived'&&/receiving.*archived/.test(e.message));
 assert.equal(f.hub.context('am',{allowArchived:true}).threadId,original.threadId);
 await assert.rejects(f.hub.send('am',{requestId:randomUUID(),text:'must not arrive'}),{code:'codex-target-archived'});
 assert.equal(f.calls.length,0);delete f.session.archivedAt;assert.equal(f.hub.context('am').stamp,original.stamp);
});

// The bindings file is AM's authority for which thread a session may address.
// An operator can remove a binding by editing the file (the refusal that names
// the file tells them to), and nothing in this process is told. Every path that
// sends, approves, interrupts or attributes must read the file, not a memory
// copy (issue #235 added one for the sidebar): this edits the file behind the
// hub's back, between steps and in the middle of a verification, and never
// touches the CodexBindings instance.
const unbindOnDisk = (f) => fs.writeFileSync(f.deps.bindings.file, JSON.stringify({ version: 1, bindings: [] }));
test('a binding removed from the file while the thread is being verified stops the send before turn/start', async () => {
 const f=fixture();const call=f.client.call.bind(f.client);
 f.client.call=async(method,params)=>{const r=await call(method,params);if(method==='thread/read')unbindOnDisk(f);return r;};
 await assert.rejects(f.hub.send('am',{text:'hello',requestId:randomUUID()}),{code:'codex-unmapped'});
 assert.equal(f.calls.filter(c=>c.method==='turn/start').length,0);
 assert.equal(f.calls.filter(c=>c.method==='thread/resume').length,0,'and before thread/resume: attach revalidates after thread/read too');
});
test('a binding that changes revision on disk between verification and submission is a stale binding, not a send', async () => {
 const f=fixture();const call=f.client.call.bind(f.client);
 // The same session, rebound to the same thread with a new revision, as a
 // repair by hand would leave it: the stamp changes, the send must not go.
 f.client.call=async(method,params)=>{const r=await call(method,params);
  if(method==='thread/read'){const file=JSON.parse(fs.readFileSync(f.deps.bindings.file,'utf8'));file.bindings[0].revision=2;fs.writeFileSync(f.deps.bindings.file,JSON.stringify(file));}
  return r;};
 await assert.rejects(f.hub.send('am',{text:'hello',requestId:randomUUID()}),{code:'codex-binding-stale'});
 assert.equal(f.calls.filter(c=>c.method==='turn/start').length,0);
});

// The roster's status badge (issue #235 step 4): a poll hands status() the
// roster's memory snapshot as `display`, and the whole status is built from it,
// binding and workspace included, so a poll never reads the bindings file or
// resolves a workspace path. That badge can describe a binding the file lost
// up to a few seconds ago; every decision keeps reading the file.
test('display status is built from the roster snapshot and never reads the bindings file; decisions still do', async () => {
 const f=fixture();const bindings=f.deps.bindings;
 let reads=0;const read=bindings.read.bind(bindings);bindings.read=(...a)=>{reads++;return read(...a);};
 const snapshot=bindings.snapshot();
 const shown=await f.hub.status('am',{display:snapshot});
 assert.equal(shown.status,'idle');assert.equal(reads,0,'the badge asked the snapshot');
 const checked=await f.hub.status('am');
 assert.equal(checked.status,'idle');assert.ok(reads>=2,'coordination asked the file, before and after its awaits');
 unbindOnDisk(f);const before=reads;
 assert.equal((await f.hub.status('am',{display:snapshot})).status,'idle','a stale snapshot still describes the badge');
 assert.equal(reads,before);
 await assert.rejects(f.hub.status('am'),{code:'codex-unmapped'});
 await assert.rejects(f.hub.send('am',{text:'hello',requestId:randomUUID()}),{code:'codex-unmapped'});
 await assert.rejects(f.hub.status('am',{display:bindings.snapshot()}),{code:'codex-unmapped'},'a snapshot taken after that file read knows too');
});

// One fixture per operation. A refusal re-reads the file, and read() stores what
// it saw in the memory copy, so a second call on the same fixture cannot tell a
// file read from a memory read.
const recoverable = (f) => { f.thread.status = { type: 'notLoaded' }; f.hub.recovery = async () => ({ key: 'a'.repeat(64), settings: { params: {}, expected: {} } }); };
for (const [name, prepare, run] of [
  ['send', () => {}, (f) => f.hub.send('am', { text: 'hello', requestId: randomUUID() })],
  ['approval', () => {}, (f) => f.hub.answer('am', { key: 'q', decision: 'accept' })],
  ['interrupt', (f) => { f.thread.status = { type: 'active', activeFlags: [] }; }, (f) => f.hub.interrupt('am', { turnId: f.turn.id })],
  ['status', () => {}, (f) => f.hub.status('am')],
  ['attribution', () => {}, async (f) => f.hub.agentSource('am')],
  ['agent delivery', (f) => { withSender(f); }, (f) => f.hub.sendFromAgent('am', { text: 'hello', requestId: randomUUID() }, 'sender')],
  ['reconnect', recoverable, (f) => f.hub.reconnect('am', { recoveryKey: 'a'.repeat(64) })],
]) test(`a binding removed by hand refuses ${name} while the memory copy still holds it`, async () => {
  const f = fixture(); await f.hub.attach('am');
  f.client.requests.set('q', { method: 'item/commandExecution/requestApproval', params: { threadId: f.thread.id, availableDecisions: ['accept', 'decline'] } });
  prepare(f);
  unbindOnDisk(f);
  assert.ok(f.deps.bindings.snapshot().forSession('am'), 'fixture: the memory copy still holds the binding');
  const before = f.calls.length;
  await assert.rejects(Promise.resolve().then(() => run(f)), { code: 'codex-unmapped' });
  assert.deepEqual(f.calls.slice(before).filter((c) => ['turn/start', 'turn/interrupt', 'thread/queue/add', 'thread/resume'].includes(c.method)), []);
  assert.deepEqual(f.replies, []);
});
// The Reader pane normally holds a client already. attach() then returns at
// once, and the only revalidation after thread/read is the caller's own.
const during = (f, method, edit) => { const call = f.client.call.bind(f.client);
  f.client.call = async (m, params) => { const r = await call(m, params); if (m === method) edit(f); return r; }; };
test('with a client already attached, a binding removed during the send\'s own thread/read stops the send', async () => {
  const f = fixture(); await f.hub.attach('am'); during(f, 'thread/read', unbindOnDisk);
  await assert.rejects(f.hub.send('am', { text: 'hello', requestId: randomUUID() }), { code: 'codex-unmapped' });
  assert.equal(f.calls.filter((c) => c.method === 'turn/start').length, 0);
});
test('a binding removed while the active turn is being read stops the interrupt', async () => {
  const f = fixture(); f.thread.status = { type: 'active', activeFlags: [] }; await f.hub.attach('am'); during(f, 'thread/turns/list', unbindOnDisk);
  await assert.rejects(f.hub.interrupt('am', { turnId: f.turn.id }), { code: 'codex-unmapped' });
  assert.equal(f.calls.filter((c) => c.method === 'turn/interrupt').length, 0);
});
test('a binding removed while thread/resume is in flight leaves no attached client', async () => {
  const f = fixture(); during(f, 'thread/resume', unbindOnDisk);
  await assert.rejects(f.hub.attach('am'), { code: 'codex-unmapped' });
  assert.equal(f.hub.clients.has('am'), false); assert.equal(f.client.closed, true);
});
test('a binding removed while coordination status is being observed is refused, not reported', async () => {
  const f = fixture(); during(f, 'thread/turns/list', unbindOnDisk);
  await assert.rejects(f.hub.status('am'), { code: 'codex-unmapped' });
});
test('a binding removed while reconnect reads settings or the owner never reaches thread/resume', async () => {
  for (const stage of ['settings', 'owner']) {
    const f = fixture(); f.thread.status = { type: 'notLoaded' };
    const plan = { key: 'a'.repeat(64), settings: { params: {}, expected: {} } };
    f.hub.recovery = async () => { if (stage === 'settings') unbindOnDisk(f); return plan; };
    f.hub.owner = async () => { if (stage === 'owner') unbindOnDisk(f); return { state: 'free', activeGoal: false, queuedInput: false }; };
    await assert.rejects(f.hub.reconnect('am', { recoveryKey: plan.key }), { code: 'codex-unmapped' }, stage);
    assert.equal(f.calls.some((c) => c.method === 'thread/resume'), false, stage);
  }
});
// `display` switches the workspace check off. Nothing else may.
test('a workspace that no longer resolves to the bound cwd refuses every decision; only the display badge takes the recorded cwd', async () => {
  const f = fixture(); const snapshot = f.deps.bindings.snapshot();
  f.session.path = path.basename(fs.mkdtempSync(path.join(root, 'moved-')));
  assert.equal((await f.hub.status('am', { display: snapshot })).status, 'idle');
  await assert.rejects(f.hub.status('am'), { code: 'codex-workspace-changed' });
  await assert.rejects(f.hub.send('am', { text: 'hello', requestId: randomUUID() }), { code: 'codex-workspace-changed' });
  assert.throws(() => f.hub.agentSource('am'), { code: 'codex-workspace-changed' });
  assert.equal(f.calls.filter((c) => c.method === 'turn/start').length, 0);
});
test('a thread the server reports in another directory is a different conversation, for decisions and for the badge', async () => {
  const f = fixture(); f.thread.cwd = fs.mkdtempSync(path.join(root, 'other-'));
  await assert.rejects(f.hub.send('am', { text: 'hello', requestId: randomUUID() }), { code: 'codex-thread-mismatch' });
  await assert.rejects(f.hub.status('am'), { code: 'codex-thread-mismatch' });
  await assert.rejects(f.hub.status('am', { display: f.deps.bindings.snapshot() }), { code: 'codex-thread-mismatch' });
  f.thread.cwd = path.join(root, 'does-not-exist');
  await assert.rejects(f.hub.status('am'));
  assert.equal(f.calls.filter((c) => c.method === 'turn/start').length, 0);
});
test('display status of an unloaded thread reads no bindings file, recovery lookup included', async () => {
  const f = fixture(); f.thread.status = { type: 'notLoaded' }; f.turn.status = 'completed';
  const bindings = f.deps.bindings; let reads = 0; const read = bindings.read.bind(bindings); bindings.read = (...a) => { reads++; return read(...a); };
  const shown = await f.hub.status('am', { display: bindings.snapshot() });
  assert.equal(shown.status, 'unloaded'); assert.equal(reads, 0, 'the recovery lookup asked the snapshot too');
});
test('a thread cwd that is a symlink to the workspace is the workspace', async () => {
  const f = fixture(); const link = path.join(root, `link-${randomUUID()}`); fs.symlinkSync(root, link); f.thread.cwd = link;
  assert.equal((await f.hub.status('am')).status, 'idle');
  assert.equal((await f.hub.send('am', { text: 'hello', requestId: randomUUID() })).turnId, 'turn-fixture');
});
// The shared fixture uses ONE directory as DATA_DIR, workspace root, workspace,
// Codex home and thread cwd, so a comparison against the wrong one of them passes.
test('the thread cwd is compared with the bound workspace, not with another configured directory', async () => {
  const f = fixture(); const ws = fs.mkdtempSync(path.join(root, 'ws-'));
  f.session.path = path.basename(ws);
  const bindings = new CodexBindings(path.join(root, `bindings-ws-${randomUUID()}`));
  bindings.bind({ session: f.session, threadId: f.session.codexSessionId, endpointId: endpoint.id, cwd: ws, expectedRevision: 0 });
  const hub = new CodexInput({ ...f.deps, bindings });
  f.thread.cwd = ws;
  assert.equal((await hub.status('am')).status, 'idle');
  assert.equal((await hub.status('am', { display: bindings.snapshot() })).status, 'idle');
  f.thread.cwd = root; // the Codex home and the workspace root, not this session's workspace
  await assert.rejects(hub.status('am'), { code: 'codex-thread-mismatch' });
  await assert.rejects(hub.status('am', { display: bindings.snapshot() }), { code: 'codex-thread-mismatch' });
});
// The generation counter in CodexBindings is what keeps the badge from acting
// on an OLDER image than a decision already read: status() runs existing(),
// which closes and forgets the live client when the stamps differ.
test('a re-read that lands after a decision read never makes the badge close the live client', async () => {
  const f = fixture(); let release; const gate = new Promise((r) => { release = r; });
  const file = path.join(root, `bindings-gated-${randomUUID()}`);
  const promises = { ...fs.promises, async open(target, flags) { const copy = `${target}.snapshot`; fs.copyFileSync(target, copy); await gate; return fs.promises.open(copy, flags); } };
  const bindings = new CodexBindings(file, new Proxy(fs, { get: (t, key) => (key === 'promises' ? promises : t[key]) }));
  bindings.bind({ session: f.session, threadId: f.session.codexSessionId, endpointId: endpoint.id, cwd: root, expectedRevision: 0 });
  const hub = new CodexInput({ ...f.deps, bindings });
  bindings.cache.at -= bindings.staleMs + 1; bindings.snapshot(); // a poll: the re-read starts, holding revision 1
  assert.ok(bindings.refreshing);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')); onDisk.bindings[0].revision = 2; fs.writeFileSync(file, JSON.stringify(onDisk)); // repaired by hand
  await hub.attach('am'); // a decision reads the file: the client is attached under revision 2
  f.client.requests.set('q', { method: 'item/commandExecution/requestApproval', params: { threadId: f.thread.id } });
  const pending = bindings.refreshing; release(); await pending; // the late answer (revision 1) arrives
  const shown = await hub.status('am', { display: bindings.snapshot() }); // the next poll
  assert.equal(shown.connected, true, 'the badge used the live client');
  assert.equal(f.client.closed, false, 'and did not close it'); assert.ok(hub.clients.has('am')); assert.equal(f.client.requests.size, 1);
});
