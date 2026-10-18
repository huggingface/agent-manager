import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {randomUUID,createHmac,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {SessionEventInput} from '../src/session-event-input.js';
import {localEventTarget,exactEventResume,EVENT_CLIS} from '../src/session-event-target.js';
import {nativeEventReadiness} from '../src/session-event-readiness.js';
import {openCodeCheckpoint,scanOpenCode} from '../src/session-event-opencode.js';
import {SessionEvents} from '../src/session-events.js';
import {hash,externalText} from '../src/session-event-policy.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-event-adapters-'));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const principal={type:'poller',id:'fixture',provider:'standard',revision:1,eventId:'evt_1'};
function fixture(cli='claude') {
 const dir=fs.mkdtempSync(path.join(root,'receipts-')),trace=cli==='opencode'?(()=>{const d=database();d.db.close();return d.file;})():path.join(dir,'trace.jsonl');if(cli!=='opencode')fs.writeFileSync(trace,'');
 const s={id:'target',sessionUuid:randomUUID(),cli,path:'work',everStarted:true,opencodeSessionId:cli==='opencode'?'ses_test':null,fxSessionId:cli==='fx'?'fx_test':null,remote:cli==='remote'?{name:'laptop'}:null};
 let status='idle',running=true,locked=false,before=()=>{},enter=()=>{};const calls=[],resumes=[];
 const deps={dir,getSession:()=>s,codex:{readReceipt:()=>null},state:()=>({status}),running:()=>running,
  resume:session=>{resumes.push({...session});running=true;},ready:async()=>{},trace:async()=>({path:trace}),
  send:async(id,text,opts)=>{before();opts.beforeWrite();calls.push({id,text});enter();opts.beforeEnter();},
  remote:{state:()=>status==='idle'?'stopped':status,append:(name,message,options)=>{calls.push({name,message,options});return {seq:1};}},
  assertWritable:()=>{if(locked)throw Object.assign(Error(),{code:'space-locked'});}};
 const input=new SessionEventInput(deps);
 const send=(requestId=randomUUID(),verifySource=()=>{})=>input.sendFromExternal(s.id,{text:'Summarize this resource.',requestId},principal,{verifySource});
 return {s,input,deps,trace,calls,resumes,send,status:v=>status=v,stop:()=>running=false,lock:()=>locked=true,before:fn=>before=fn,enter:fn=>enter=fn};
}
for(const cli of [...EVENT_CLIS].filter(x=>x!=='codex'))test(`${cli}: common transport preserves external identity and deduplicates across restart`,async()=>{
 const f=fixture(cli),id=randomUUID();const result=await f.send(id);assert.equal(result.deliveryState,'submitted');assert.equal(f.calls.length,1);
 const r=f.input.readReceipt(id);assert.equal(r.cli,cli);assert.deepEqual(r.principal,principal);assert.equal(r.state,'submitted');
 assert.equal(fs.statSync(f.input.file(id)).mode&0o777,0o600);
 const input=new SessionEventInput(f.deps);await input.sendFromExternal(f.s.id,{text:'Summarize this resource.',requestId:id},principal);
 assert.equal(f.calls.length,1);assert.equal(f.resumes.length,0);
 const text=cli==='remote'?f.calls[0].message.text:f.calls[0].text;assert.match(text,/AM external source/);assert.doesNotMatch(text,/message from/);
 if(cli==='remote')assert.deepEqual(f.calls[0].options,{durable:true});
});
test('busy, approval, privacy lock and composer guards do not send, even after queue wait',async()=>{
 for(const status of ['working','needs-input','unknown']) {const f=fixture();f.status(status);await assert.rejects(f.send(),{code:'event-target-busy'});assert.equal(f.calls.length,0);}
 const f=fixture();f.before(()=>f.status('working'));await assert.rejects(f.send(),{code:'event-target-busy'});assert.equal(f.calls.length,0);
 const lock=fixture();lock.before(()=>lock.lock());await assert.rejects(lock.send(),{code:'space-locked'});assert.equal(lock.calls.length,0);
 const revoked=fixture();let valid=true;revoked.before(()=>valid=false);
 await assert.rejects(revoked.send(randomUUID(),()=>{if(!valid)throw Error('revoked');}));assert.equal(revoked.calls.length,0);
});
test('our own terminal echo is not mistaken for new work before Enter; permission changes still block',async()=>{
 const f=fixture();f.enter(()=>f.status('working'));await f.send();assert.equal(f.calls.length,1);
 const blocked=fixture();blocked.enter(()=>blocked.status('needs-input'));await assert.rejects(blocked.send(),{code:'event-send-uncertain'});
});
test('a partial write, revoked policy during paste, or crash intent never retypes',async()=>{
 for(const mode of ['crash','revoked']) {
  const f=fixture(),id=randomUUID();let valid=true;
  f.enter(()=>{valid=false;if(mode==='crash')throw Error('lost process');});
  await assert.rejects(f.send(id,()=>{if(!valid)throw Error('revoked');}),{code:'event-send-uncertain'});
  assert.equal(f.input.readReceipt(id).state,'sending');
  const restart=new SessionEventInput(f.deps);
  await assert.rejects(restart.sendFromExternal(f.s.id,{text:'Summarize this resource.',requestId:id},principal),{code:'event-send-uncertain'});
  assert.equal(f.calls.length,1);
 }
});
test('receipt must be durable before any terminal bytes; save failure cannot report submitted',async()=>{
 const f=fixture();f.input.save=()=>{throw Error('disk full');};await assert.rejects(f.send());assert.equal(f.calls.length,0);
});
test('context pins UUID, CLI, folder, native IDs and remote name; unsafe destinations refused',async()=>{
 for(const cli of ['shell','files','trace','voice','unknown'])assert.throws(()=>localEventTarget({...fixture().s,cli}));
 for(const patch of [{sessionUuid:randomUUID()},{cli:'gemini'},{path:'other'},{opencodeSessionId:'ses_other'}]){
  const f=fixture();f.before(()=>Object.assign(f.s,patch));await assert.rejects(f.send(),{code:'event-target-changed'});assert.equal(f.calls.length,0);
 }
 const archived=fixture();archived.s.archivedAt='today';await assert.rejects(archived.send());
 const f=fixture(),id=randomUUID();await f.send(id);
 await assert.rejects(f.input.sendFromExternal(f.s.id,{text:'different',requestId:id},principal),{code:'event-send-uncertain'});assert.equal(f.calls.length,1);
});
test('exact restart never falls back to another conversation; unknown restart stays queued',async()=>{
 for(const cli of ['claude','opencode','fx']){
  const f=fixture(cli);const command=exactEventResume(f.s);assert.doesNotMatch(command,/continue|\|\||;|--last/);
  assert.match(command,new RegExp(cli==='claude'?f.s.sessionUuid:cli==='opencode'?f.s.opencodeSessionId:f.s.fxSessionId));
 }
 const f=fixture();f.stop();await f.send();assert.equal(f.resumes.length,1);assert.equal(f.resumes[0].sessionUuid,f.s.sessionUuid);
 for(const cli of ['gemini','hermes','openclaw']){const f=fixture(cli);f.stop();await assert.rejects(f.send(),{code:'event-resume-required'});assert.equal(f.resumes.length,0);assert.equal(f.calls.length,0);}
 const gone=fixture();gone.stop();gone.deps.trace=async()=>null;gone.input.trace=gone.deps.trace;await assert.rejects(gone.send(),{code:'event-resume-required'});assert.equal(gone.resumes.length,0);
});
test('remote offline queues durably; paused and active peers wait; storage failure is uncertain, never repeated',async()=>{
 const f=fixture('remote');f.s.remote.paused=true;await assert.rejects(f.send(),{code:'event-target-busy'});assert.equal(f.calls.length,0);
 f.s.remote.paused=false;f.status('working');await assert.rejects(f.send(),{code:'event-target-busy'});
 f.status('idle');f.input.remote.append=()=>{throw Error('disk');};const id=randomUUID();await assert.rejects(f.send(id),{code:'event-send-uncertain'});
 await assert.rejects(f.send(id),{code:'event-send-uncertain'});
});
function database() {
 const file=path.join(root,randomUUID()+'.db'),db=new DatabaseSync(file);
 db.exec('CREATE TABLE session(id TEXT); CREATE TABLE message(id TEXT,session_id TEXT,data TEXT,time_created INTEGER); CREATE TABLE part(id TEXT,session_id TEXT,message_id TEXT,data TEXT,time_created INTEGER);');
 db.prepare('INSERT INTO session VALUES (?)').run('ses_test');
 const add=(id,data,parts=[])=>{db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(id,'ses_test',JSON.stringify(data),Date.now());for(const [i,p]of parts.entries())db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(id+'-'+i,'ses_test',id,JSON.stringify(p),i);};
 return {db,file,add};
}
test('OpenCode requires exact input, matching parentID and completed native stop, not tool or intermediate output',()=>{
 const d=database();try{
 const j={cursor:openCodeCheckpoint(d.file,'ses_test'),evidence:{},expectedHash:hash('unique event')};
 d.add('u',{role:'user'},[{type:'text',text:'unique event'}]);
 d.add('a',{role:'assistant',parentID:'u',finish:'tool-calls',time:{completed:1}},[{type:'text',text:'intermediate'}]);
 scanOpenCode(j);assert.equal(j.evidence.matched,true);assert.equal(j.evidence.outcome,undefined);
 d.add('unrelated',{role:'assistant',parentID:'other',finish:'stop',time:{completed:1}},[{type:'text',text:'wrong'}]);
 scanOpenCode(j);assert.equal(j.evidence.outcome,undefined);
 d.add('final',{role:'assistant',parentID:'u',finish:'stop',time:{created:1}},[{type:'text',text:'result'}]);
 scanOpenCode(j);assert.equal(j.evidence.outcome,undefined);
 d.db.prepare('UPDATE message SET data=? WHERE id=?').run(JSON.stringify({role:'assistant',parentID:'u',finish:'stop',time:{completed:2}}),'final');
 scanOpenCode(j);assert.equal(j.evidence.outcome,'completed');assert.equal(j.evidence.answer,'result');
 }finally{d.db.close();}
});
test('OpenCode competing user input, native errors, absent pin and oversized evidence fail safely',()=>{
 for(const mode of ['input','error','large']){const d=database();try{
 const j={cursor:openCodeCheckpoint(d.file,'ses_test'),evidence:{},expectedHash:hash('event')};d.add('u',{role:'user'},[{type:'text',text:'event'}]);
 if(mode==='input')d.add('u2',{role:'user'},[{type:'text',text:'operator'}]);
 if(mode==='error')d.add('a',{role:'assistant',parentID:'u',error:{name:'APIError'}});
 if(mode==='large')d.add('a',{role:'assistant',parentID:'u'},[{type:'text',text:'x'.repeat(1024*1024+1)}]);
 if(mode==='large')assert.throws(()=>scanOpenCode(j));else {scanOpenCode(j);assert.equal(j.evidence.outcome,mode==='input'?'uncertain':'failed');}
 assert.throws(()=>openCodeCheckpoint(d.file,'ses_missing'));
 }finally{d.db.close();}}
});
test('provider-independent pipeline: API observation -> Claude transport -> native acceptance and final result after restart',async()=>{
 const f=fixture('claude'),now=Date.now();
 const source={id:'fixture',provider:'granola',enabled:true,revision:1,ownerEmail:'owner@example.com',workflow:{mode:'research',instructions:'Summarize.'},target:localEventTarget(f.s)};
 const deps={dir:path.join(f.deps.dir,'jobs'),sources:()=>new Map([[source.id,source]]),input:f.input};
 const service=new SessionEvents(deps),event={id:'not_12345678901234',type:'note.ready',resourceId:'not_12345678901234',occurredAt:new Date(now).toISOString(),activatedAt:new Date(now-10000).toISOString()};
 service.enqueue(source.id,event);f.status('working');await service.tick();assert.equal(f.calls.length,0);
 f.status('idle');await service.tick();const job=[...service.jobs.values()][0];assert.equal(job.state,'submitted');
 fs.appendFileSync(f.trace,JSON.stringify({type:'user',message:{content:f.calls[0].text}})+'\n');
 await service.tick();assert.equal(job.state,'accepted');
 fs.appendFileSync(f.trace,JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Private result'}],stop_reason:'end_turn'}})+'\n');
 const restart=new SessionEvents(deps);await restart.tick();const completed=[...restart.jobs.values()][0];assert.equal(completed.state,'completed');assert.equal(completed.resultHash,hash('Private result'));
 restart.enqueue(source.id,event);await restart.tick();assert.equal(f.calls.length,1);
 assert.ok(!fs.readFileSync(path.join(deps.dir,job.key+'.json'),'utf8').includes('Private result'));
});
test('engines without native result evidence never call quiet terminal completed',async()=>{
 const f=fixture('hermes'),j={target:localEventTarget(f.s),expectedHash:'x'};await f.input.prepare(j);await f.input.observe(j);assert.equal(j.observer,'unavailable');assert.deepEqual(j.evidence,{});
});
test('native busy evidence overrides a quiet Claude or OpenCode terminal; stopped active turns never resume automatically',async()=>{
 for(const cli of ['claude','opencode']) {
  const f=fixture(cli);
  if(cli==='claude')fs.appendFileSync(f.trace,JSON.stringify({type:'user',message:{content:'long task'}})+'\n');
  else {const db=new DatabaseSync(f.trace);db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('u','ses_test',JSON.stringify({role:'user'}),1);db.close();}
  assert.equal((await f.input.status(f.s.id)).status,'working');
  await assert.rejects(f.send(),{code:'event-target-busy'});assert.equal(f.calls.length,0);
  f.stop();await assert.rejects(f.send(),{code:'event-target-busy'});assert.equal(f.resumes.length,0);
 }
 const f=fixture();fs.writeFileSync(f.trace,'partial');assert.equal(nativeEventReadiness(f.s,{path:f.trace}),'unknown');
 assert.equal(nativeEventReadiness(f.s,null),'unknown');
});
test('OpenCode readiness works for long histories, distinguishes tool turns and asks for input on errors',()=>{
 const d=database(),s={cli:'opencode',opencodeSessionId:'ses_test'},location={path:d.file};
 try {
 for(let n=0;n<100;n++){d.add('u'+n,{role:'user'});d.add('a'+n,{role:'assistant',parentID:'u'+n,time:{completed:1},finish:'stop'});}
 assert.equal(nativeEventReadiness(s,location),'idle');
 d.add('u-last',{role:'user'});d.add('tool',{role:'assistant',parentID:'u-last',time:{completed:1},finish:'tool-calls'});assert.equal(nativeEventReadiness(s,location),'working');
 d.add('error',{role:'assistant',parentID:'u-last',error:{name:'APIError'}});assert.equal(nativeEventReadiness(s,location),'needs-input');
 }finally{d.db.close();}
});

test('new archived-Codex diagnostic revokes a pending event durably and never revives it after restore',async()=>{
 const f=fixture(),source={id:'fixture',provider:'granola',enabled:true,revision:1,ownerEmail:'owner@example.com',workflow:{mode:'research',instructions:'Summarize.'},target:localEventTarget(f.s)};
 let archived=true;const input={context:()=>{if(archived)throw Object.assign(Error('archived'),{code:'codex-target-archived'});return source.target;},sendFromExternal:()=>{throw Error('must not dispatch');}};
 const deps={dir:path.join(f.deps.dir,'archive-jobs'),sources:()=>new Map([[source.id,source]]),input};
 const service=new SessionEvents(deps),at=new Date().toISOString();service.enqueue(source.id,{id:'not_12345678901234',resourceId:'not_12345678901234',type:'note.ready',occurredAt:at,activatedAt:at});
 await service.tick();assert.equal([...service.jobs.values()][0].state,'revoked');
 archived=false;const restart=new SessionEvents(deps);await restart.tick();assert.equal([...restart.jobs.values()][0].state,'revoked');
});

test('local monitor principal is supported across every non-Codex adapter without sender impersonation',async()=>{
 for(const cli of [...EVENT_CLIS].filter(x=>x!=='codex')){
  const f=fixture(cli),requestId=randomUUID(),source={...principal,type:'local-monitor',provider:'local-monitor'};
  await f.input.sendFromExternal(f.s.id,{text:'Inspect batch.',requestId},source);
  assert.deepEqual(f.input.readReceipt(requestId).principal,source);
  const text=cli==='remote'?f.calls[0].message.text:f.calls[0].text;assert.match(text,/local-monitor/);assert.doesNotMatch(text,/message from/);
 }
});
