import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {Delegations,consumeEvidence,hash,traceCheckpoint} from '../src/delegations.js';
const input=text=>({type:'user',message:{content:text}});
const answer=(text='Review ready',reason='end_turn')=>({type:'assistant',message:{content:[{type:'text',text}],stop_reason:reason}});
function fixture(t,overrides={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-delegation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'trace.jsonl');fs.writeFileSync(file,JSON.stringify(answer('old answer'))+'\n');
 const state={parent:'working',target:'waiting'}, identities={parent:'p1',target:'t1'};let now=1000,dispatches=0,notifications=0,lock=false;
 const append=r=>fs.appendFileSync(file,JSON.stringify(r)+'\n');
 const options={dir:path.join(root,'journal'),identity:id=>identities[id],state:async id=>state[id],assertWritable:()=>{if(lock)throw Error('locked')},now:()=>now,
  prepare:async()=>({cli:'claude',expectedText:'placeholder',cursor:traceCheckpoint(file)}),
  dispatch:async(j,payload)=>{dispatches++;j.expectedHash=hash(payload);append(input(payload));},
  notify:async()=>{notifications++;return {ok:true,queued:true,queuedSubmissionId:'native-ack'}},...overrides};
 const create=()=>new Delegations(options);const d=create();
 return {d,create,options,file,state,identities,append,counts:()=>({dispatches,notifications}),time:n=>{now=n},lock:v=>{lock=v}};
}
async function start(f,id=randomUUID()){const result=await f.d.create('parent','target',{requestId:id,text:'review'});return result.id;}

test('exact exchange and terminal text, not waiting, old output, tool data or intermediate text',async t=>{
 const f=fixture(t);const id=await start(f);await f.d.tick();assert.equal(f.d.get(id,'parent').outcome,null);
 f.append({type:'user',message:{content:[{type:'tool_result',content:'end_turn: result ready'}]}});
 f.append(answer('Working on it','tool_use'));await f.d.tick();assert.equal(f.d.get(id,'parent').outcome,null);
 f.append(answer('The review is done'));await f.d.tick();assert.equal(f.d.get(id,'parent').outcome,'completed');assert.equal(f.counts().notifications,0);
 f.state.parent='waiting';await Promise.all([f.d.tick(),f.d.tick()]);assert.equal(f.counts().notifications,1);assert.equal(f.d.get(id,'parent').state,'delivered');
 await f.create().tick();assert.equal(f.counts().notifications,1);
});
test('retry idempotency and restart during initial dispatch never paste twice',async t=>{
 const f=fixture(t,{dispatch:async()=>{throw Error('lost ack')}});const id=await start(f);
 assert.equal(f.d.get(id,'parent').state,'dispatch-uncertain');
 await f.d.create('parent','target',{requestId:id,text:'review'});
 const resumed=f.create();await resumed.tick();assert.equal(resumed.get(id,'parent').state,'dispatch-uncertain');
 await assert.rejects(()=>resumed.create('parent','target',{requestId:id,text:'changed'}),{code:'delegation-conflict'});
});
test('notification crash retry uses the same receipt UUID, not a new callback',async t=>{
 const seen=[];const f=fixture(t,{notify:async j=>{seen.push(j.callbackId);return {ok:true,repeated:seen.length>1}}});
 const id=await start(f);f.append(answer());f.state.parent='waiting';await f.d.tick();
 const j=f.d.jobs.get(id);j.state='notifying';f.d.save(j);await f.create().tick();assert.equal(seen.length,2);assert.equal(seen[0],seen[1]);
});
test('uncertain notification acknowledgement is durable and never replayed',async t=>{
 let calls=0;const f=fixture(t,{notify:async()=>{calls++;throw Object.assign(Error(),{code:'codex-send-uncertain'})}});
 const id=await start(f);f.append(answer());f.state.parent='waiting';await f.d.tick();await f.create().tick();
 assert.equal(calls,1);assert.equal(f.d.get(id,'parent').state,'notification-uncertain');
});
test('blocked, failed, and displaced exchanges are not completed',async t=>{
 for(const [state,record,outcome] of [['input-required',null,'blocked'],['stopped',null,'failed'],['waiting',input('unrelated new prompt'),'uncertain']]){
  const f=fixture(t);const id=await start(f);f.state.target=state;if(record)f.append(record);await f.d.tick();assert.equal(f.d.get(id,'parent').outcome,outcome);
 }
});
test('privacy lock, expired or remapped parent and cancellation suppress wakeups',async t=>{
 for(const mode of ['lock','expired','remap','cancel']){
  const f=fixture(t);const id=await start(f);f.append(answer());f.state.parent='waiting';
  if(mode==='lock')f.lock(true);if(mode==='expired')f.time(90000000);if(mode==='remap')f.identities.parent='p2';if(mode==='cancel')f.d.cancel(id,'parent');
  await f.d.tick();assert.equal(f.counts().notifications,0,mode);
 }
});
test('concurrent retry, duplicate target, and delegation cycles are refused before effect',async t=>{
 let release;const barrier=new Promise(r=>release=r);const f=fixture(t);const original=f.options.prepare;f.d.prepare=async(...args)=>{await barrier;return original(...args)};
 const id=randomUUID(),first=f.d.create('parent','target',{requestId:id,text:'review'});
 await assert.rejects(()=>f.d.create('parent','target',{requestId:id,text:'review'}),{code:'delegation-busy'});release();await first;
 await assert.rejects(()=>f.d.create('parent','target',{requestId:randomUUID(),text:'more'}),{code:'delegation-busy'});
 await assert.rejects(()=>f.d.create('target','parent',{requestId:randomUUID(),text:'loop'}),{code:'delegation-busy'});
 assert.equal(f.counts().dispatches,1);
});
test('partial records survive restart; rotated traces fail closed',async t=>{
 const f=fixture(t),id=await start(f);await f.d.tick();const line=JSON.stringify(answer());fs.appendFileSync(f.file,line.slice(0,10));await f.d.tick();
 assert.equal(f.d.get(id,'parent').outcome,null);fs.appendFileSync(f.file,line.slice(10)+'\n');const resumed=f.create();await resumed.tick();assert.equal(resumed.get(id,'parent').outcome,'completed');
 const f2=fixture(t),id2=await start(f2);fs.renameSync(f2.file,f2.file+'.old');fs.writeFileSync(f2.file,'');await f2.d.tick();assert.equal(f2.d.get(id2,'parent').outcome,'uncertain');
});
test('Codex needs matched source input plus same native turn completion and final answer',()=>{
 const e={},expected=hash('exact');const feed=r=>consumeEvidence(e,r,expected,'codex');
 feed({type:'event_msg',payload:{type:'task_started',turn_id:'turn'}});
 feed({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'exact'}]}});
 feed({type:'turn_context',payload:{turn_id:'turn'}});
 feed({type:'response_item',payload:{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'intermediate'}]}});
 assert.equal(e.outcome,undefined);
 feed({type:'response_item',payload:{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'done'}]}});
 feed({type:'event_msg',payload:{type:'task_complete',turn_id:'wrong'}});assert.equal(e.outcome,undefined);
 feed({type:'event_msg',payload:{type:'task_complete',turn_id:'turn'}});assert.equal(e.outcome,'completed');
});
test('foreign source cannot read or cancel a follow-up',async t=>{
 const f=fixture(t),id=await start(f);assert.throws(()=>f.d.get(id,'other'),{code:'not-found'});assert.throws(()=>f.d.cancel(id,'other'),{code:'not-found'});
});

test('Claude bracketed paste is matched as a whole; quoted or mismatched wrappers are not',()=>{
 const expected='[message from parent:] review\n\n[AM delegation 123]';
 for(const [text,match] of [[`\n\n<pasted_content id="0040">\n${expected}\n</pasted_content id="0040">\n`,true],
  [`quoted: ${expected}`,false],[`<pasted_content id="0040">\n${expected}\n</pasted_content id="0041">`,false]]){
  const e={};consumeEvidence(e,input(text),hash(expected),'claude');assert.equal(!!e.matched,match);
 }
});

test('cancellation during an asynchronous parent check cannot be overwritten by notification',async t=>{
 const f=fixture(t),id=await start(f);f.append(answer());f.state.parent='waiting';
 let release,entered;const pending=new Promise(r=>release=r),seen=new Promise(r=>entered=r);
 f.d.state=async sid=>{if(sid==='parent'){entered();await pending;}return f.state[sid]};
 const ticking=f.d.tick();await seen;f.d.cancel(id,'parent');release();await ticking;
 assert.equal(f.counts().notifications,0);assert.equal(f.d.get(id,'parent').state,'cancelled');
});

test('uncertain recovery or mismatched restored settings never becomes an automatic second attempt',async t=>{
 for(const code of ['codex-recovery-uncertain','codex-recovery-review']){
  let count=0;const f=fixture(t,{notify:async()=>{count++;throw Object.assign(Error(),{code})}});
  const id=await start(f);f.append(answer());f.state.parent='unloaded';await f.d.tick();await f.create().tick();
  assert.equal(count,1);assert.match(f.d.get(id,'parent').state,/^notification-(uncertain|review)$/);
 }
});


test('cancellation during target observation or scan stays terminal across restart',async t=>{
 for(const boundary of ['target','scan']){
  const f=fixture(t),id=await start(f);f.state.parent='waiting';
  let release,entered;const pending=new Promise(r=>release=r),seen=new Promise(r=>entered=r);
  if(boundary==='target')f.d.state=async sid=>{if(sid==='target'){entered();await pending;}return f.state[sid]};
  else {const scan=f.d.scan;f.d.scan=async j=>{scan(j);entered();await pending;};}
  const ticking=f.d.tick();await seen;f.d.cancel(id,'parent');release();await ticking;
  assert.equal(f.d.get(id,'parent').state,'cancelled',boundary);
  f.append(answer());await f.create().tick();assert.equal(f.counts().notifications,0,boundary);
 }
});
