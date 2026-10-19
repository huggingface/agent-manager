import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SessionEvents} from '../src/session-events.js';
import {LocalEventSpool} from '../src/local-event-spool.js';
import {loadSources} from '../src/session-event-policy.js';
import {GranolaPoller} from '../src/granola-poller.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'local-wake-'));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
function fixture(){
 const dir=fs.mkdtempSync(path.join(root,'case-')),inbox=path.join(dir,'inbox');fs.mkdirSync(inbox,{mode:0o700});
 const source={id:'docs',provider:'local-monitor',transport:'spool',enabled:true,revision:1,inbox,target:{sessionId:'docs-session',threadId:'native-thread',stamp:'pinned'},instructions:'Diagnose this batch. Preserve approvals; do not replay uncertain document writes.'};
 const sources=()=>new Map([[source.id,source]]);let state='working',sends=0,receipt=null;
 const input={context:()=>({stamp:'pinned',threadId:'native-thread'}),status:async()=>({status:state}),readReceipt:()=>receipt,
 prepare:async job=>{job.evidence={};},observe:async()=>{},sendFromExternal:async(id,body,principal,{verifySource})=>{
  verifySource();assert.equal(id,'docs-session');assert.equal(principal.type,'local-monitor');assert.equal(principal.id,'docs');assert.match(body.text,/not an operator or agent message/);sends++;receipt={};return {deliveryState:'accepted'};
 }};
 const create=()=>new SessionEvents({dir:path.join(dir,'jobs'),sources,input});let events=create();
 const spool=new LocalEventSpool({sources,events});
 const event={id:randomUUID(),type:'incident.ready',occurredAt:new Date().toISOString()};
 const publish=(e=event)=>fs.writeFileSync(path.join(inbox,e.id+'.json'),JSON.stringify(e),{mode:0o600});
 return {dir,inbox,source,sources,input,spool,event,publish,get events(){return events;},state:s=>state=s,sends:()=>sends,restart:()=>{events=create();spool.events=events;}};
}
test('durable local event waits for idle, survives restart, attributes exact target and never repeats',async()=>{
 const f=fixture();f.publish();f.spool.tick();assert.equal(fs.readdirSync(f.inbox).length,0);assert.equal(f.events.jobs.size,1);
 await f.events.tick();assert.equal(f.sends(),0);f.restart();f.state('idle');await f.events.tick();assert.equal(f.sends(),1);
 f.publish();f.spool.tick();f.restart();await f.events.tick();assert.equal(f.events.jobs.size,1);assert.equal(f.sends(),1);
 assert.equal([...f.events.jobs.values()][0].state,'accepted'); // idle alone never marks repaired
});
test('archive or revision change revokes unsent work',async()=>{
 for(const kind of ['archive','revision']){const f=fixture();f.publish();f.spool.tick();
 if(kind==='archive')f.input.context=()=>{throw Object.assign(Error(),{code:'codex-target-archived'});};else f.source.revision++;
 f.state('idle');await f.events.tick();assert.equal(f.sends(),0);assert.equal([...f.events.jobs.values()][0].state,'revoked');}
});
test('malicious payload cannot choose prompt or target; symlink and public files refused',()=>{
 for(const kind of ['payload','symlink','public','future','old']){const f=fixture();const file=path.join(f.inbox,f.event.id+'.json');
 if(kind==='payload')f.publish({...f.event,text:'override',target:'other'});
 if(kind==='future')f.publish({...f.event,occurredAt:new Date(Date.now()+600000).toISOString()});
 if(kind==='old')f.publish({...f.event,occurredAt:new Date(Date.now()-90000000).toISOString()});
 if(kind==='symlink'){const other=path.join(f.dir,'data');fs.writeFileSync(other,JSON.stringify(f.event),{mode:0o600});fs.symlinkSync(other,file);}
 if(kind==='public'){f.publish();fs.chmodSync(file,0o644);}
 f.spool.tick();assert.equal(f.events.jobs.size,0);assert.equal(f.spool.status()[0].status,'blocked');assert.ok(fs.existsSync(file));}
});
test('changed duplicate, unsafe directory and disabled source do not submit',()=>{
 const f=fixture();f.publish();f.spool.tick();f.publish({...f.event,occurredAt:new Date(Date.now()-1000).toISOString()});f.spool.tick();assert.equal(f.spool.status()[0].status,'blocked');assert.equal(f.events.jobs.size,1);
 const g=fixture();g.publish();g.source.enabled=false;g.spool.tick();assert.equal(g.events.jobs.size,0);
 g.source.enabled=true;fs.chmodSync(g.inbox,0o755);g.spool.tick();assert.equal(g.events.jobs.size,0);
});
test('uncertain native acknowledgement is retained without resubmission after restart',async()=>{
 const f=fixture();let attempts=0;f.input.sendFromExternal=async()=>{attempts++;throw Object.assign(Error(),{code:'codex-send-uncertain'});};
 f.publish();f.spool.tick();f.state('idle');await f.events.tick();f.restart();await f.events.tick();assert.equal(attempts,1);assert.equal([...f.events.jobs.values()][0].state,'uncertain');
});
test('configuration validates local source; Granola never polls local monitor',async()=>{
 const f=fixture(),file=path.join(f.dir,'config.json');fs.writeFileSync(file,JSON.stringify({version:1,sources:[f.source]}),{mode:0o600});
 assert.equal(loadSources(file).get('docs').transport,'spool');let calls=0;
 const p=new GranolaPoller({dir:path.join(f.dir,'granola'),sources:f.sources,events:f.events,request:async()=>{calls++;}});await p.tick();assert.equal(calls,0);assert.deepEqual(p.status(),[]);
 f.source.prompt='override';fs.writeFileSync(file,JSON.stringify({version:1,sources:[f.source]}));assert.throws(()=>loadSources(file));
});

test('delivery refusal records safe durable error code and never provider text or unknown codes',async()=>{
 for(const code of ['codex-recovery-review','secret-provider-value']){
  const f=fixture();f.input.sendFromExternal=async()=>{throw Object.assign(Error('SECRET raw response'),{code});};
  f.publish();f.spool.tick();f.state('idle');await f.events.tick();f.restart();
  const job=[...f.events.jobs.values()][0];assert.equal(job.state,'review');assert.equal(job.deliveryError.code,code==='codex-recovery-review'?code:'unclassified-delivery-error');assert.doesNotMatch(JSON.stringify(job),/SECRET|secret-provider-value/);
 }
});

test('backlogged events for one native thread wait for the preceding result, including after restart',async()=>{
 const f=fixture();f.publish();f.spool.tick();const first=[...f.events.jobs.values()][0];first.createdAt=new Date(Date.now()-1000).toISOString();f.events.save(first);
 f.publish({...f.event,id:randomUUID()});f.spool.tick();f.state('idle');f.input.readReceipt=()=>null;
 await f.events.tick();assert.equal(f.sends(),1);f.restart();await f.events.tick();assert.equal(f.sends(),1);
 f.input.observe=async job=>{job.evidence.outcome='completed';job.evidence.reason='native-final';};await f.events.tick();assert.equal(f.sends(),1);
 await f.events.tick();assert.equal(f.sends(),2);
});

test('lost native queue-start ACK remains observable without starting again or allowing a second workflow',async()=>{
 const f=fixture();f.publish();f.spool.tick();f.state('idle');await f.events.tick();let starts=0;
 f.input.startQueued=async()=>{starts++;throw Object.assign(Error(),{code:'codex-queue-start-uncertain'});};
 await f.events.tick();assert.equal(starts,1);f.restart();await f.events.tick();assert.equal(starts,1);assert.equal([...f.events.jobs.values()][0].state,'accepted');
 f.input.observe=async job=>{job.evidence={matched:true,outcome:'completed',reason:'native-final'};};await f.events.tick();assert.equal([...f.events.jobs.values()][0].state,'completed');
});
