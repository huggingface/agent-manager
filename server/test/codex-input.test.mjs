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
 const calls=[], replies=[]; let locked=false, lost=false, connects=0;
 const client={endpoint,closed:false,requests:new Map(),items:new Map(),requestView(){return [...this.requests.values()];},
  async call(method,params){calls.push({method,params});if(method==='turn/start'){if(lost)throw Error('timeout');return {turn:{id:'turn-fixture'}};}return {thread};},
  close(){this.closed=true;},async answer(key,response){replies.push({key,response});this.requests.delete(key);}};
 const deps={getSession:()=>session,listSessions:()=>[session],bindings,endpoint:()=>endpoint,connect:async()=>{connects++;return client;},observe:async()=>client,
  receipts:path.join(root,`receipts-${n}`),enabled:()=>true,assertWritable:()=>{if(locked)throw Error('locked');}};
 return {session,thread,client,calls,replies,deps,hub:new CodexInput(deps),connects:()=>connects,lock:()=>locked=true,lose:()=>lost=true};
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
