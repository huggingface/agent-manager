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

test('federated delivery retains peer attribution through the actual native queue adapter',async()=>{
 const {amAdapter}=await import('../src/federation/adapter.js');
 const f=fixture();let committed=0;
 const adapter=amAdapter({getSession:id=>id==='am'?f.session:null,shared:()=>true,isLocked:()=>false,input:f.hub,listRows:async()=>[]});
 const message={id:randomUUID(),from:'laptop-agent',to:'am',text:'Review this change.'};
 const context={peer:'laptop',instance:'vps',epoch:randomUUID(),requestId:randomUUID(),beforeDispatch:()=>committed++,verify:()=>{}};
 assert.equal(await adapter.deliver(message,context),'accepted');assert.equal(committed,1);
 const calls=f.calls.filter(c=>['turn/start','thread/queue/add','turn/steer','turn/interrupt'].includes(c.method));
 assert.equal(calls.length,1);assert.equal(calls[0].method,'thread/queue/add');
 assert.match(calls[0].params.input[0].text,/peer-attested identity/);
 assert.match(calls[0].params.input[0].text,/"instance":"laptop"/);
 assert.match(calls[0].params.input[0].text,/"sessionId":"laptop-agent"/);
 assert.equal(calls[0].params.clientUserMessageId,context.requestId);
 const receipt=JSON.parse(fs.readFileSync(path.join(f.deps.receipts,context.requestId+'.json'),'utf8'));
 assert.equal(receipt.source.federation.messageId,message.id);assert.equal(receipt.status,'accepted');
 assert(!JSON.stringify(receipt).includes(message.text));
});
