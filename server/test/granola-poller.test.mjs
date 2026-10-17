import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {GranolaPoller,proxyGet} from '../src/granola-poller.js';
import {SessionEvents} from '../src/session-events.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'granola-poll-'));test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const note=(n=1,extra={})=>({id:'not_'+String(n).padStart(14,'0'),owner:{email:'owner@example.com'},created_at:'2026-10-17T12:00:01Z',updated_at:'2026-10-17T12:00:01Z',deleted_at:null,...extra});
function fixture(){
 let now=Date.parse('2026-10-17T12:00:00Z'),calls=0;const observed=[];
 const s={id:'meetings',enabled:true,provider:'granola',transport:'poller',revision:1,ownerEmail:'owner@example.com',target:{sessionId:'exact',stamp:'exact'},workflow:{mode:'drafts-calendar',instructions:'Test workflow'}};
 const sources=()=>new Map([[s.id,s]]);let data={notes:[],hasMore:false};
 const events=new SessionEvents({dir:fs.mkdtempSync(path.join(root,'events-')),sources,input:{},now:()=>now});
 const options={dir:fs.mkdtempSync(path.join(root,'poll-')),sources,events,now:()=>now,request:async q=>{calls++;observed.push(q);if(data instanceof Error)throw data;return typeof data==='function'?data(q):data;}};
 const poller=new GranolaPoller(options);
 return {s,events,poller,options,observed,setData:d=>data=d,time:ms=>now+=ms,calls:()=>calls};
}
test('disabled source makes zero requests; cadence 30s and no events when empty',async()=>{
 const f=fixture();f.s.enabled=false;await f.poller.tick();assert.equal(f.calls(),0);
 f.s.enabled=true;await f.poller.tick();assert.equal(f.calls(),1);await f.poller.tick();assert.equal(f.calls(),1);
 f.time(30000);await f.poller.tick();assert.equal(f.calls(),2);assert.equal(f.events.jobs.size,0);
});
test('ready new owned notes queue once across edits and restart; old/shared/deleted excluded',async()=>{
 const f=fixture();await f.poller.tick();f.time(30000);
 f.setData({notes:[note(),note(2,{owner:{email:'someone@example.com'}}),note(3,{created_at:'2026-01-01T00:00:00Z'}),note(4,{deleted_at:'2026-10-17T12:00:02Z'})],hasMore:false});
 await f.poller.tick();assert.equal(f.events.jobs.size,1);const id=[...f.events.jobs.values()][0].requestId;
 const jobs=new SessionEvents({dir:f.events.dir,sources:f.options.sources,input:{},now:f.options.now});
 const restarted=new GranolaPoller({...f.options,events:jobs});f.time(30000);f.setData({notes:[note(1,{updated_at:'2026-10-17T12:01:00Z'})],hasMore:false});await restarted.tick();
 assert.equal(jobs.jobs.size,1);assert.equal([...jobs.jobs.values()][0].requestId,id);
});
test('pagination is complete before checkpoint, malformed/repeated pages fail closed',async()=>{
 const f=fixture();await f.poller.tick();const before=f.poller.load(f.s).watermark;f.time(30000);
 f.setData(q=>q.cursor?{notes:[note(2)],hasMore:true,cursor:'same'}:{notes:[note()],hasMore:true,cursor:'same'});
 await f.poller.tick();assert.equal(f.events.jobs.size,0);assert.equal(f.poller.load(f.s).watermark,before);
 f.time(120000);f.setData(q=>q.cursor?{notes:[note(2)],hasMore:false}:{notes:[note()],hasMore:true,cursor:'next'});await f.poller.tick();assert.equal(f.events.jobs.size,2);
});
test('auth/disabled blocks until operator revision changes; 429 backs off',async()=>{
 const f=fixture();f.setData(Object.assign(new Error('auth'),{status:401}));await f.poller.tick();assert.equal(f.poller.status()[0].status,'blocked');f.time(3600000);await f.poller.tick();assert.equal(f.calls(),1);
 f.s.revision++;f.setData(Object.assign(new Error('limit'),{status:429,retryAfter:300}));await f.poller.tick();assert.equal(f.calls(),2);f.time(299000);await f.poller.tick();assert.equal(f.calls(),2);
 f.time(1000);f.setData({notes:[],hasMore:false});await f.poller.tick();assert.equal(f.poller.status()[0].status,'ready');
});
test('source disabled during read never queues, concurrent ticks do not overlap',async()=>{
 const f=fixture();let release;f.setData(()=>new Promise(r=>release=r));const a=f.poller.tick();await f.poller.tick();assert.equal(f.calls(),1);
 f.s.enabled=false;release({notes:[note()],hasMore:false});await a;assert.equal(f.events.jobs.size,0);
});
test('journal enqueue failure preserves checkpoint; replay cannot duplicate previously queued notes',async()=>{
 const f=fixture();await f.poller.tick();const before=f.poller.load(f.s).watermark;f.time(30000);f.setData({notes:[note(),note(2)],hasMore:false});
 const enqueue=f.events.enqueue.bind(f.events);let n=0;f.events.enqueue=(...args)=>{if(++n===2)throw new Error('disk');return enqueue(...args);};
 await f.poller.tick();assert.equal(f.poller.load(f.s).watermark,before);assert.equal(f.events.jobs.size,1);
 f.events.enqueue=enqueue;f.time(120000);await f.poller.tick();assert.equal(f.events.jobs.size,2);
});
test('hourly full reconciliation catches late notes without updated_at changes',async()=>{
 const f=fixture();await f.poller.tick();f.time(3600000);await f.poller.tick();assert.equal(f.observed.at(-1).updated_after,undefined);
});
test('corrupt state is preserved and never resets activation',async()=>{
 const f=fixture();fs.writeFileSync(f.poller.file(f.s.id),'broken',{mode:0o600});await assert.rejects(f.poller.tick());assert.equal(f.calls(),0);assert.equal(fs.readFileSync(f.poller.file(f.s.id),'utf8'),'broken');
});
test('Unix proxy client emits GET without credentials, handles rate limits and refuses redirects',async t=>{
 const sock=path.join(root,'proxy.sock');let request;
 const server=http.createServer((req,res)=>{request=req;res.writeHead(req.url.includes('cursor=redirect')?302:req.url.includes('cursor=limited')?429:200,{'retry-after':'120','content-type':'application/json'});res.end(JSON.stringify({notes:[],hasMore:false}));});
 await new Promise(r=>server.listen(sock,r));t.after(()=>server.close());
 await proxyGet({page_size:'30'},{socketPath:sock});assert.equal(request.method,'GET');assert.equal(request.headers.authorization,undefined);assert.match(request.url,/^\/granola\/v1\/notes\?/);
 await assert.rejects(proxyGet({cursor:'limited'},{socketPath:sock}),e=>e.status===429&&e.retryAfter===120);
 await assert.rejects(proxyGet({cursor:'redirect'},{socketPath:sock}),e=>e.status===302);
});
test('event worker waits for busy destination, submits once with poller attribution and observes completion',async()=>{
 const f=fixture();let busy=true,sends=0,receipt=null;f.events.input={
  context:()=>({stamp:'exact'}),status:async()=>({status:busy?'working':'idle'}),readReceipt:()=>receipt,
  prepare:async j=>{j.evidence={};},sendFromExternal:async(_id,p,principal,{verifySource})=>{verifySource();assert.equal(principal.type,'poller');assert.match(p.text,/UNSENT/);sends++;receipt={};return {deliveryState:'accepted',receiptId:p.requestId};},
  observe:async j=>{j.evidence={outcome:'completed',answerHash:'result',reason:'test-native-complete'};}
 };
 await f.poller.tick();f.time(30000);f.setData({notes:[note()],hasMore:false});await f.poller.tick();await f.events.tick();assert.equal(sends,0);
 busy=false;await f.events.tick();assert.equal(sends,1);assert.equal([...f.events.jobs.values()][0].state,'accepted');await f.events.tick();assert.equal(sends,1);assert.equal([...f.events.jobs.values()][0].state,'completed');
});
