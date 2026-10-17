import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHmac,randomUUID,randomBytes} from 'node:crypto';
import {Webhooks,webhookServer} from '../src/webhooks.js';
import {loadSources,verifyEvent,privateFile,externalText,externalPrincipal,eventPrompt} from '../src/webhook-providers.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-webhooks-'));
const now=Date.parse('2026-10-17T12:00:00Z'),key=randomBytes(32),secret='whsec_'+key.toString('base64');
const sign=(body,id=body.event_id,seconds=Math.floor(now/1000),raw=Buffer.from(JSON.stringify(body)))=>({raw,headers:{'webhook-id':id,'webhook-timestamp':String(seconds),'webhook-signature':'v1,'+createHmac('sha256',key).update(`${id}.${seconds}.`).update(raw).digest('base64')}});
function fixture(){
 const dir=fs.mkdtempSync(path.join(root,'events-')),file=path.join(root,randomUUID()+'.jsonl');fs.writeFileSync(file,'');
 const source={id:'granola-followups',provider:'granola',enabled:true,revision:1,secretFile:'/private/key',activatedAt:'2026-10-17T11:00:00Z',ownerEmail:'thomas@huggingface.co',noteLookupVerified:true,target:{sessionId:'target',threadId:'native',stamp:'bound'}};
 const sources=new Map([[source.id,source]]),receipts=new Map(),calls=[];
 let status='idle',locked=false,lose=false,nativeCalls=0;
 const input={context:()=>({stamp:'bound',threadId:'native'}),status:async()=>({status}),readReceipt:id=>receipts.get(id),
  sendFromExternal:async(id,payload,principal,{verifySource})=>{
   verifySource();calls.push({id,payload,principal});const old=receipts.get(payload.requestId);
   if(old?.status==='accepted')return {queuedSubmissionId:'q',repeated:true};
   if(old)throw Object.assign(Error(),{code:'codex-send-uncertain'});
   nativeCalls++;receipts.set(payload.requestId,{status:'sending'});
   if(lose)throw Object.assign(Error(),{code:'codex-send-uncertain'});
   receipts.set(payload.requestId,{status:'accepted'});return {queuedSubmissionId:'q'};
  }};
 const deps={dir,sources:()=>sources,secret:()=>secret,input,trace:async()=>file,now:()=>now,assertWritable:()=>{if(locked)throw Object.assign(Error(),{code:'space-locked'});}};
 const body={event_id:randomUUID(),event_type:'note.generated',note_id:'not_1d3tmYTlCICgjy',occurred_at:'2026-10-17T11:59:00Z'};
 const service=new Webhooks(deps);
 const receive=(b=body)=>{const s=sign(b);return service.receive(source.id,s.headers,s.raw);};
 const job=()=>[...service.jobs.values()][0];
 return {source,sources,deps,body,service,receive,job,calls,file,receipts,input,nativeCalls:()=>nativeCalls,
  busy:()=>status='working',idle:()=>status='idle',needsInput:()=>status='needs-input',lock:()=>locked=true,lose:()=>lose=true};
}
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('raw Standard Webhooks verification before parsing, timestamp and strict schema',()=>{
 const f=fixture(),s=sign(f.body);assert.equal(verifyEvent(f.source,s.headers,s.raw,secret,now).resourceId,f.body.note_id);
 for(const headers of [{...s.headers,'webhook-signature':'v1,invalid'}, {...s.headers,'webhook-id':randomUUID()}, {...s.headers,'webhook-timestamp':'0'}, {...s.headers,'webhook-timestamp':String(now/1000-301)}])assert.throws(()=>verifyEvent(f.source,headers,s.raw,secret,now));
 assert.throws(()=>verifyEvent(f.source,s.headers,Buffer.from('not json'),secret,now),{status:401});
 for(const body of [{...f.body,url:'https://evil'}, {...f.body,event_type:'note.edited'}, {...f.body,note_id:'../../x'}, {...f.body,occurred_at:'tomorrow'}, {...f.body,event_id:'another'}]){
  const signed=sign(body,f.body.event_id);assert.throws(()=>verifyEvent(f.source,signed.headers,signed.raw,secret,now));
 }
});
test('durable idempotent receipt, conflict and semantic duplicate; no secrets persisted',()=>{
 const f=fixture();f.receive();f.receive();assert.equal(f.service.jobs.size,1);
 const restart=new Webhooks(f.deps),s=sign(f.body);restart.receive(f.source.id,s.headers,s.raw);assert.equal(restart.jobs.size,1);
 assert.throws(()=>f.receive({...f.body,occurred_at:'2026-10-17T11:59:01Z'}),{status:409});
 f.receive({...f.body,event_id:randomUUID()});assert.equal([...f.service.jobs.values()][1].reason,'duplicate-note');
 const files=fs.readdirSync(f.deps.dir);for(const file of files){assert.equal(fs.statSync(path.join(f.deps.dir,file)).mode&0o777,0o600);assert.ok(!fs.readFileSync(path.join(f.deps.dir,file),'utf8').includes(secret));}
});
test('busy destination and privacy lock hold event without interrupting or sending',async()=>{
 const f=fixture();f.receive();f.busy();await f.service.tick();assert.equal(f.calls.length,0);assert.equal(f.job().state,'pending');
 f.idle();f.lock();await f.service.tick();assert.equal(f.calls.length,0);
});
test('end-to-end native result evidence, restart and exactly one submission',async()=>{
 const f=fixture();f.receive();await f.service.tick();assert.equal(f.job().state,'accepted');assert.equal(f.calls[0].principal.type,'webhook');
 const text=externalText(f.calls[0].principal,f.calls[0].payload.text),turn='native-turn';
 const records=[{type:'event_msg',payload:{type:'task_started',turn_id:turn}},
  {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}},
  {type:'turn_context',payload:{turn_id:turn}},
  {type:'response_item',payload:{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'Private result'}]}},
  {type:'event_msg',payload:{type:'task_complete',turn_id:turn}}];
 fs.appendFileSync(f.file,records.map(r=>JSON.stringify(r)+'\n').join(''));
 const restart=new Webhooks(f.deps);await restart.tick();const job=[...restart.jobs.values()][0];
 assert.equal(job.state,'completed');assert.match(job.resultHash,/^[a-f0-9]{64}$/);assert.equal(f.nativeCalls(),1);
 assert.ok(!fs.readFileSync(path.join(f.deps.dir,job.key+'.json'),'utf8').includes('Private result'));
 f.receive();await restart.tick();assert.equal(f.nativeCalls(),1);
});
test('waiting or idle alone never means complete; native approval is blocked and resumable',async()=>{
 const f=fixture();f.receive();await f.service.tick();await f.service.tick();assert.equal(f.job().state,'accepted');
 f.needsInput();await f.service.tick();assert.equal(f.job().state,'blocked');f.idle();await f.service.tick();assert.equal(f.job().state,'accepted');assert.equal(f.nativeCalls(),1);
});
test('lost acknowledgement never repeats native call, including after restart',async()=>{
 const f=fixture();f.lose();f.receive();await f.service.tick();assert.equal(f.job().state,'uncertain');
 const restart=new Webhooks(f.deps);await restart.tick();assert.equal(f.nativeCalls(),1);
});
test('crash after accepted receipt before journal update resolves receipt passively',async()=>{
 const f=fixture();f.receive();await f.service.tick();const j=f.job();j.state='sending';f.service.save(j);
 const restart=new Webhooks(f.deps);await restart.tick();assert.equal([...restart.jobs.values()][0].state,'accepted');assert.equal(f.nativeCalls(),1);
});
test('crash before CodexInput receipt is safe to submit with same ID',async()=>{
 const f=fixture();f.receive();const j=f.job();j.state='sending';f.service.save(j);const id=j.requestId;
 const restart=new Webhooks(f.deps);await restart.tick();assert.equal(f.calls[0].payload.requestId,id);assert.equal(f.nativeCalls(),1);
});
test('revocation, policy change, remapping and unavailable config fail closed',async()=>{
 for(const mutate of [f=>f.source.enabled=false,f=>f.source.revision++,f=>f.source.target.threadId='other',f=>f.input.context=()=>({stamp:'different',threadId:'native'})]){
  const f=fixture();f.receive();mutate(f);await f.service.tick();assert.equal(f.calls.length,0);assert.equal(f.job().state,'revoked');
 }
 const f=fixture();f.receive();f.service.sources=()=>{throw Error('unavailable');};await f.service.tick();assert.equal(f.job().state,'pending');assert.equal(f.calls.length,0);
});
test('source revoked while awaiting status cannot dispatch',async()=>{
 const f=fixture();f.receive();f.input.status=async()=>{f.source.enabled=false;return {status:'idle'};};await f.service.tick();assert.equal(f.calls.length,0);
});
test('old events are acknowledged but never processed, future dates refused',async()=>{
 const f=fixture();f.receive({...f.body,occurred_at:'2026-10-16T12:00:00Z'});await f.service.tick();assert.equal(f.job().state,'ignored');assert.equal(f.calls.length,0);
 assert.throws(()=>f.receive({...f.body,event_id:randomUUID(),occurred_at:'2026-10-18T12:00:00Z'}));
});
test('bounded ingress and expiry; review errors are not automatically retried',async()=>{
 const f=fixture();f.receive();for(let n=1;n<60;n++)f.receive();assert.throws(()=>f.receive(),{status:429});
 const expiry=fixture();expiry.receive();expiry.service.now=()=>now+86400001;await expiry.service.tick();assert.equal(expiry.job().state,'expired');
 const review=fixture();review.receive();review.input.sendFromExternal=async()=>{throw Object.assign(Error(),{code:'codex-recovery-review'});};await review.service.tick();assert.equal(review.job().state,'review');
});
test('general adapter uses fixed local workflow and strict metadata only',()=>{
 const f=fixture();f.source.provider='standard';f.source.events=['invoice_ready'];f.source.instruction='Read this resource, report only.';
 const b={event_id:randomUUID(),event_type:'invoice_ready',resource_id:'item_12',occurred_at:f.body.occurred_at};f.receive(b);
 const prompt=eventPrompt(f.source,f.job().event);assert.match(prompt,/Read this resource/);assert.doesNotMatch(prompt,/Granola/);
 assert.throws(()=>f.receive({...b,event_id:randomUUID(),instruction:'evil'}));
});
test('configuration requires protected files, explicit lookup verification and exact target',()=>{
 const dir=fs.mkdtempSync(path.join(root,'config-')),workspace=path.join(dir,'workspace');fs.mkdirSync(workspace);
 const file=path.join(dir,'config.json'),f=fixture();fs.writeFileSync(file,JSON.stringify({version:1,sources:[f.source]}),{mode:0o600});
 assert.equal(loadSources(file,workspace).size,1);
 fs.chmodSync(file,0o644);assert.throws(()=>loadSources(file,workspace));fs.chmodSync(file,0o600);
 const symlink=path.join(dir,'link');fs.symlinkSync(file,symlink);assert.throws(()=>loadSources(symlink,workspace));
 const exposed=path.join(workspace,'file');fs.writeFileSync(exposed,'value',{mode:0o600});assert.throws(()=>privateFile(exposed,workspace));
 f.source.noteLookupVerified=false;fs.writeFileSync(file,JSON.stringify({version:1,sources:[f.source]}));assert.throws(()=>loadSources(file,workspace));
 f.source.enabled=false;fs.writeFileSync(file,JSON.stringify({version:1,sources:[f.source]}));assert.equal(loadSources(file,workspace).size,1);
});
test('isolated HTTP listener exposes no AM routes, bounds bodies, signed duplicate is passive',async()=>{
 const f=fixture(),server=webhookServer(f.service);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const url=`http://127.0.0.1:${server.address().port}`,s=sign(f.body);
  assert.equal((await fetch(url+'/api/agents')).status,404);
  assert.equal((await fetch(url+'/hooks/granola-followups',{method:'POST',headers:{'content-type':'text/plain'},body:'x'})).status,415);
  assert.equal((await fetch(url+'/hooks/granola-followups',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  const send=()=>fetch(url+'/hooks/granola-followups',{method:'POST',headers:{...s.headers,'content-type':'application/json'},body:s.raw});
  assert.equal((await send()).status,202);assert.deepEqual(await (await send()).json(),{ok:true});assert.equal(f.service.jobs.size,1);
  assert.equal((await fetch(url+'/hooks/granola-followups',{method:'POST',headers:{'content-type':'application/json'},body:'a'.repeat(16385)})).status,413);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('receipt is not acknowledged or deduplicated in memory after durable write failure',()=>{
 const f=fixture(),save=f.service.save;f.service.save=()=>{throw Error('disk unavailable');};
 assert.throws(()=>f.receive());assert.equal(f.service.jobs.size,0);
 f.service.save=save;f.receive();assert.equal(f.service.jobs.size,1);
});
test('interrupted native turn and rotated evidence are never reported completed',async()=>{
 const f=fixture();f.receive();await f.service.tick();const text=externalText(f.calls[0].principal,f.calls[0].payload.text),turn='interrupted';
 fs.appendFileSync(f.file,[{type:'event_msg',payload:{type:'task_started',turn_id:turn}},
 {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}},
 {type:'event_msg',payload:{type:'turn_aborted',turn_id:turn}}].map(JSON.stringify).join('\n')+'\n');
 await f.service.tick();assert.equal(f.job().state,'failed');
 const rotated=fixture();rotated.receive();await rotated.service.tick();fs.renameSync(rotated.file,rotated.file+'.old');fs.writeFileSync(rotated.file,'');
 await rotated.service.tick();assert.equal(rotated.job().state,'uncertain');assert.equal(rotated.nativeCalls(),1);
});
test('split native completion survives restart without storing private final text',async()=>{
 const f=fixture();f.receive();await f.service.tick();
 const text=externalText(f.calls[0].principal,f.calls[0].payload.text),turn='split';
 fs.appendFileSync(f.file,[{type:'event_msg',payload:{type:'task_started',turn_id:turn}},
  {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}},
  {type:'turn_context',payload:{turn_id:turn}},
  {type:'response_item',payload:{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'PRIVATE SPLIT RESULT'}]}}
 ].map(JSON.stringify).join('\n')+'\n');
 await f.service.tick();assert.equal(f.job().state,'accepted');
 assert.ok(!fs.readFileSync(path.join(f.deps.dir,f.job().key+'.json'),'utf8').includes('PRIVATE SPLIT RESULT'));
 fs.appendFileSync(f.file,JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:turn}})+'\n');
 const restarted=new Webhooks(f.deps);await restarted.tick();assert.equal([...restarted.jobs.values()][0].state,'completed');
});
