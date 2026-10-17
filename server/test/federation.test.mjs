import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID,randomBytes} from 'node:crypto';
import {Federation} from '../src/federation/core.js';
import {amAdapter} from '../src/federation/adapter.js';
import {configValid,privateWrite,loadConfig,hash,mac,envelope,MAX_BODY,TTL} from '../src/federation/policy.js';
import {verifyIdentity} from '../src/federation/identity.js';
import {exchangeHandler,poll} from '../src/federation/transport.js';
import {protectedRead} from '../src/request-admission.js';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-federation-test-'));
  const live=[];t.after(()=>{for(const c of live)c?.close();fs.rmSync(root,{recursive:true,force:true});});
  const secret=randomBytes(32).toString('hex'),epoch=randomUUID();let now=Date.now();
  const sent=[];
  const configs=['hub','spoke'].map((mode,i)=>({version:1,mode,instanceId:mode,localIp:`100.64.0.${i+1}`,nodeId:`node${i}`,
    port:7871,tailscale:'/usr/bin/tailscale',peer:{id:i?'hub':'spoke',ip:`100.64.0.${2-i}`,nodeId:`node${1-i}`,key:secret,epoch},
    permissions:{export:[{id:mode+'-agent',summary:'Approved research'}],send:[{from:mode+'-agent',to:(i?'hub':'spoke')+'-agent'}],
      receive:[{from:(i?'hub':'spoke')+'-agent',to:mode+'-agent'}]}}));
  const files=configs.map((c,i)=>{const dir=path.join(root,String(i));fs.mkdirSync(dir,{mode:0o700});const file=path.join(dir,'config.json');privateWrite(file,c);return file;});
  const make=(i,deliver=async(m,ctx)=>{ctx.beforeDispatch();sent.push({i,m,ctx});return 'accepted';})=>{live[i]?.close();const core=new Federation({configFile:files[i],now:()=>now,
    sourceExists:async id=>id===configs[i].instanceId+'-agent',deliver,
    roster:async()=>[{id:configs[i].instanceId+'-agent',name:'Research',cli:'codex',state:'waiting',lastActivityAt:null,summary:'Approved research',receives:true}]});live[i]=core;return core;};
  const hub=make(0),spoke=make(1);
  const exchange=async(a=hub,b=spoke)=>{const req=await b.request(),res=await a.accept(req.body,req.signature);await b.response(res.body,res.signature,req.nonce);return {req,res};};
  const message=(i=1)=>({id:randomUUID(),from:configs[i].instanceId+'-agent',to:configs[1-i].instanceId+'-agent',text:'Please review the code.'});
  return {root,files,configs,hub,spoke,make,exchange,message,sent,secret,now:()=>now,advance:ms=>{now+=ms;}};
}

test('bidirectional durable messaging, roster, attribution context and no duplicate dispatch',async t=>{
  const f=fixture(t),one=f.message(),two=f.message(0);
  await f.spoke.enqueue(one);await f.hub.enqueue(two);await f.exchange();
  assert.equal(f.hub.view().roster[0].machine,'spoke');assert.equal(f.hub.view().peer.online,true);
  await f.hub.drain();await f.spoke.drain();await f.exchange();
  assert.equal(f.sent.length,2);assert.equal(f.hub.view().outgoing[0].status,'accepted');assert.equal(f.spoke.view().outgoing[0].status,'accepted');
  assert.equal((await f.spoke.enqueue(one)).status,'accepted');
  const restarted=f.make(0);await f.exchange(restarted);await restarted.drain();assert.equal(f.sent.length,2);
  assert(!JSON.stringify(f.hub.view()).includes(f.secret));assert(!JSON.stringify(f.hub.view()).includes(one.text));
  assert.equal(fs.statSync(f.hub.file).mode & 0o777,0o600);
});

test('offline cache, reconnect and expiry are explicit; busy head does not starve later messages',async t=>{
  const f=fixture(t);await f.exchange();f.advance(31_000);
  assert.equal(f.spoke.view().peer.online,false);assert.equal(f.spoke.view().roster[0].stale,true);
  const m=f.message();await f.spoke.enqueue(m);await f.exchange();
  const busy=f.make(0,async()=> 'deferred');await busy.drain();assert.equal(busy.view().incoming[0].status,'queued');
  await f.exchange(busy);assert.equal(f.spoke.view().peer.online,true);
  f.advance(TTL+1);await busy.drain();assert.equal(busy.view().incoming[0].status,'expired');assert.equal(f.sent.length,0);
});

test('replayed nonce rejected across restart, repeated response refused, tamper and stale time fail closed',async t=>{
  const f=fixture(t),{req,res}=await f.exchange();
  await assert.rejects(f.hub.accept(req.body,req.signature));
  await assert.rejects(f.make(0).accept(req.body,req.signature));
  await assert.rejects(f.spoke.response(res.body,res.signature,req.nonce));
  await assert.rejects(f.hub.accept(req.body+' ',req.signature));
  const next=await f.spoke.request();f.advance(31_000);await assert.rejects(f.hub.accept(next.body,next.signature));assert.equal(f.sent.length,0);
});

test('unauthorized sender/destination and capability never dispatch or reveal target existence',async t=>{
  const f=fixture(t);
  await assert.rejects(f.spoke.enqueue({...f.message(),from:'invented'}));
  await assert.rejects(f.spoke.enqueue({...f.message(),to:'shell'}));
  for(const change of [p=>p.messages[0].to='secret-session',p=>p.shell='id',p=>p.messages[0].attachments=['/etc/passwd']]) {
    const p={roster:[],messages:[{...f.message(),createdAt:f.now()}],receipts:[]};change(p);
    const body=envelope(f.configs[1],p,randomUUID(),f.now());
    await assert.rejects(f.hub.accept(body,mac(f.secret,'request',body)),/federation-refused/);
  }
  assert.equal(f.hub.view().incoming.length,0);assert.equal(f.sent.length,0);
});

test('same message ID binds original text and receipts survive duplicate transport',async t=>{
  const f=fixture(t),m=f.message();await f.spoke.enqueue(m);await f.exchange();await f.exchange();await f.hub.drain();await f.exchange();
  assert.equal(f.sent.length,1);await assert.rejects(f.spoke.enqueue({...m,text:'different'}));
  const payload={roster:[],messages:[{...m,text:'different',createdAt:f.now()}],receipts:[]};
  const body=envelope(f.configs[1],payload,randomUUID(),f.now());await assert.rejects(f.hub.accept(body,mac(f.secret,'request',body)));
});

test('lost native acknowledgement and process crash do not cause another inference',async t=>{
  const f=fixture(t);let calls=0;
  const ambiguous=f.make(0,async(_m,c)=>{c.beforeDispatch();calls++;throw new Error('lost ACK');});
  await f.spoke.enqueue(f.message());await f.exchange(ambiguous);await ambiguous.drain();
  assert.equal(ambiguous.view().incoming[0].status,'uncertain');await f.make(0).drain();assert.equal(calls,1);
  const state=JSON.parse(fs.readFileSync(ambiguous.file));Object.values(state.inbox)[0].status='dispatching';privateWrite(ambiguous.file,state);
  const restarted=f.make(0);assert.equal(restarted.view().incoming[0].status,'uncertain');await restarted.drain();assert.equal(f.sent.length,0);
});

test('configuration rotation/revocation and permissions changes stop pending dispatch immediately',async t=>{
  const f=fixture(t);await f.spoke.enqueue(f.message());await f.exchange();
  const changed={...f.configs[0],peer:{...f.configs[0].peer,key:randomBytes(32).toString('hex')}};
  privateWrite(f.files[0],changed);await assert.rejects(f.hub.drain());assert.equal(f.sent.length,0);assert.equal(f.hub.view().enabled,false);
  const req=await f.spoke.request();await assert.rejects(f.make(0).accept(req.body,req.signature));
  fs.chmodSync(f.files[1],0o644);await assert.rejects(f.spoke.enqueue(f.message()));
});

test('key alone, IP alone, and forwarded identity are insufficient; local config is strict',async t=>{
  const f=fixture(t),c=f.configs[0];
  await assert.rejects(verifyIdentity(c,'100.64.0.3',async()=>c.peer.nodeId));
  await assert.rejects(verifyIdentity(c,c.peer.ip,async()=> 'another-node'));
  await verifyIdentity(c,c.peer.ip,async()=>c.peer.nodeId);
  for(const value of ['127.0.0.1','0.0.0.0','example.com','169.254.169.254'])assert.throws(()=>configValid({...c,localIp:value}));
  assert.throws(()=>configValid({...c,shell:'id'}));
  fs.chmodSync(path.dirname(f.files[0]),0o755);assert.throws(()=>loadConfig(f.files[0]));fs.chmodSync(path.dirname(f.files[0]),0o700);
  assert.equal(protectedRead('/API/Federation/'),true);
});

test('adapter uses native shared Codex queue, never steers busy or boots unloaded/legacy sessions',async()=>{
  let status='working',calls=0,commits=0,locked=false;
  const sessions={target:{id:'target',sessionUuid:'uuid1',cli:'codex'},source:{id:'source',sessionUuid:'uuid2',cli:'claude'}};
  const adapter=amAdapter({getSession:id=>sessions[id],shared:s=>s?.cli==='codex',isLocked:()=>locked,listRows:async()=>[],
    input:{status:async()=>({status}),send:async(id,arg,options)=>{calls++;options.verifySource();assert.equal(id,'target');assert.equal(options.source.federation.sessionId,'remote-source');assert.match(arg.text,/peer-attested/);}}});
  const m={id:randomUUID(),from:'remote-source',to:'target',text:'review'},ctx={peer:'laptop',instance:'vps',epoch:randomUUID(),requestId:randomUUID(),beforeDispatch:()=>commits++,verify:()=>{}};
  for(const s of ['working','unloaded','needs-input']){status=s;assert.equal(await adapter.deliver(m,ctx),'deferred');}
  assert.equal(calls,0);assert.equal(commits,0);
  status='idle';assert.equal(await adapter.deliver(m,ctx),'accepted');assert.equal(calls,1);assert.equal(commits,1);
  assert.equal(await adapter.deliver({...m,to:'source'},ctx),'rejected');
  locked=true;await assert.rejects(adapter.deliver(m,ctx));assert.equal(calls,1);
});

test('roster exposes only explicitly selected safe fields and operator summaries',async()=>{
  const a=amAdapter({getSession:id=>({id,cli:'claude'}),shared:()=>false,isLocked:()=>false,
    listRows:async()=>[{id:'selected',name:'Claude',cli:'claude',state:'waiting',lastActivityAt:'2026-10-15T00:00:00Z',workdir:'/secret',lastPrompt:'private'},
      {id:'unselected',name:'hidden'}]});
  const result=await a.roster({permissions:{export:[{id:'selected',summary:'Approved summary'}],receive:[]}});
  assert.equal(result.length,1);assert.equal(result[0].summary,'Approved summary');assert.equal(result[0].receives,false);
  assert(!JSON.stringify(result).includes('private'));assert(!JSON.stringify(result).includes('/secret'));
});

test('real HTTP exchange fixture: two instances, no redirects, rate limit, generic denial and wrong identity',async t=>{
  const f=fixture(t);let wrong=false,identityCalls=0;
  const handler=exchangeHandler(f.hub,{now:f.now,identity:async(c,ip)=>{identityCalls++;await verifyIdentity(c,ip,async()=>wrong?'wrong':c.peer.nodeId);}});
  // Only the test wrapper models Tailscale addressing. Production has no bypass.
  const server=http.createServer((req,res)=>{Object.defineProperty(req.socket,'remoteAddress',{value:f.configs[0].peer.ip,configurable:true});handler(req,res);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const port=server.address().port;
  const request=(options,callback)=>http.request({...options,hostname:'127.0.0.1',port,localAddress:'127.0.0.1'},callback);
  const exchange=()=>poll(f.spoke,{identity:async(c,ip)=>verifyIdentity(c,ip,async()=>c.peer.nodeId),request});
  await f.spoke.enqueue(f.message());await exchange();await f.hub.drain();await exchange();
  assert.equal(f.spoke.view().outgoing[0].status,'accepted');assert.equal(f.sent.length,1);assert.equal(identityCalls,2);
  wrong=true;await assert.rejects(exchange());wrong=false;
  const raw=async(pathname,body='{}',extra={})=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path:pathname,method:'POST',headers:{'content-type':'application/json','x-am-federation-mac':'0'.repeat(64),...extra}},res=>{
      let result='';res.on('data',chunk=>result+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:result}));});req.on('error',reject);req.end(body);
  });
  const denied=await raw('/api/agents/secret/prompt');assert.equal(denied.status,403);
  assert.deepEqual(await raw('/federation/v1/exchange','{}',{'tailscale-user-login':'admin'}),denied);
  for(let i=0;i<60;i++)await raw('/federation/v1/exchange');
  await assert.rejects(exchange());assert.equal(f.sent.length,1);
});

test('oversize, invalid UTF-8, message budget and worst-case JSON escaping stay bounded',async t=>{
  const f=fixture(t);
  await assert.rejects(f.spoke.enqueue({...f.message(),text:'x'.repeat(8193)}));
  const {readBody}=await import('../src/federation/transport.js');
  const {Readable}=await import('node:stream');
  await assert.rejects(readBody(Readable.from([Buffer.alloc(MAX_BODY+1)])));
  await assert.rejects(readBody(Readable.from([Buffer.from([0xff])])));
  for(let i=0;i<1000;i++) {
    const message={...f.message(0),createdAt:f.now()},r={message,hash:hash(message),status:'accepted'};
    f.spoke.state.inbox[message.id]=r;
  }
  for(let i=0;i<4;i++)await f.spoke.enqueue({...f.message(),text:'\x01'.repeat(8192)});
  const result=await f.spoke.request();assert(Buffer.byteLength(result.body)<=MAX_BODY);
  const body=JSON.parse(result.body);assert(body.payload.messages.length>0 && body.payload.messages.length<4);
  const incoming={...f.message(0),createdAt:f.now()},payload={roster:[],messages:[incoming],receipts:[]};
  const raw=envelope(f.configs[0],payload,randomUUID(),f.now());
  await assert.rejects(f.spoke.accept(raw,mac(f.secret,'request',raw)));
});

test('exclusive journal owner and explicit dead-PID cleanup refuse a live process',async t=>{
  const f=fixture(t);
  const {unlockDeadStore}=await import('../src/federation/policy.js');
  assert.throws(()=>new Federation({configFile:f.files[0]}),{code:'EEXIST'});
  assert.throws(()=>unlockDeadStore(f.files[0]));
  assert.equal(f.hub.view().enabled,true);
  f.hub.close();
  privateWrite(path.join(path.dirname(f.files[0]),'runtime.lock'),{pid:2147483647,nonce:randomUUID()});
  unlockDeadStore(f.files[0]);assert.equal(f.make(0).view().enabled,true);
});

test('slow roster observations are single-flight and do not block exchange',async t=>{
  const f=fixture(t);let count=0,release;
  f.hub.roster=async()=>{count++;return new Promise(r=>{release=r;});};
  await f.exchange();await f.exchange();assert.equal(count,1);assert.equal(f.spoke.view().peer.online,true);
  release([]);
});

test('round-robin dispatch lets a second target proceed while the first remains busy',async t=>{
  const f=fixture(t),first=f.message(),second=f.message();await f.spoke.enqueue(first);await f.spoke.enqueue(second);
  const receiver=f.make(0,async(m,ctx)=>{if(m.id===first.id)return 'deferred';ctx.beforeDispatch();f.sent.push(m);return 'accepted';});
  await f.exchange(receiver);await receiver.drain();await receiver.drain();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].id,second.id);assert.equal(receiver.view().incoming[0].status,'queued');
});

test('local API requires matching operation origin, is opt-in, and rejects broad binds before transport',async t=>{
  const express=(await import('express')).default;
  const {installFederation}=await import('../src/federation/index.js');
  const f=fixture(t);f.hub.close();
  const data=path.join(f.root,'data');fs.mkdirSync(data);
  let started=0,core;
  const adapter={roster:async()=>[],sourceExists:async id=>id==='hub-agent',deliver:async()=>{throw Error('not used');}};
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.operationOrigin={id:req.headers['x-am-origin'] || req.body?.from};next();});
  const api={get:(route,fn)=>app.get(route,fn),post:(route,fn)=>app.post(route,(req,res,next)=>Promise.resolve(fn(req,res)).catch(next))};
  installFederation({api,adapter,dataDir:data,workspacesDir:data,bindHost:'127.0.0.1',configFile:f.files[0],
    start:async c=>{started++;core=c;}});
  app.use((e,_req,res,_next)=>res.status(e.statusCode || 500).json({code:e.code}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>{try{core?.close();}catch{}server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,message=f.message(0);
  const send=origin=>fetch(base+'/api/federation/messages',{method:'POST',headers:{'content-type':'application/json','x-am-origin':origin},body:JSON.stringify(message)});
  assert.equal((await send('spoke-agent')).status,403);assert.equal((await send('hub-agent')).status,202);assert.equal(started,1);
  const view=await (await fetch(base+'/api/federation')).json();assert.equal(view.outgoing.length,1);assert(!JSON.stringify(view).includes(f.secret));
  for(const bindHost of ['0.0.0.0','100.64.0.1','::']) {
    const routes={get(){},post(){}};installFederation({api:routes,adapter,dataDir:data,workspacesDir:data,bindHost,configFile:f.files[0],start:async()=>{started++;}});
  }
  assert.equal(started,1);
  let get;installFederation({api:{get:(_r,fn)=>get=fn,post(){}},adapter,dataDir:data,workspacesDir:data,bindHost:'127.0.0.1',configFile:null});
  let disabled;get({}, {json:v=>disabled=v});assert.deepEqual(disabled,{enabled:false});
});

test('offline pairing CLI generates deny-all private files and rotates/revokes without printing secrets',async t=>{
  const {spawnSync}=await import('node:child_process');
  const f=fixture(t),dir=path.join(f.root,'offline-pair');
  const run=(...args)=>spawnSync(process.execPath,[new URL('../../scripts/federation-pair.mjs',import.meta.url).pathname,...args],{encoding:'utf8'});
  let result=run('init',dir,'100.64.0.10','hub-node','100.64.0.20','spoke-node');assert.equal(result.status,0,result.stderr);
  const a=path.join(dir,'hub.json'),b=path.join(dir,'spoke.json'),first=loadConfig(a);
  assert.deepEqual(first.permissions,{export:[],send:[],receive:[]});assert.equal(first.peer.key,loadConfig(b).peer.key);
  assert(!result.stdout.includes(first.peer.key));assert.equal(fs.statSync(a).mode&0o777,0o600);
  result=run('rotate',a,b);assert.equal(result.status,0,result.stderr);const rotated=loadConfig(a);
  assert.notEqual(rotated.peer.key,first.peer.key);assert.notEqual(rotated.peer.epoch,first.peer.epoch);assert.equal(rotated.peer.key,loadConfig(b).peer.key);
  assert(!result.stdout.includes(rotated.peer.key));result=run('revoke',a);assert.equal(result.status,0);
  assert.notEqual(loadConfig(a).peer.key,loadConfig(b).peer.key);
});


test('privacy lock blocks cached roster disclosure, transport and queued native work',async t=>{
  const f=fixture(t);await f.spoke.enqueue(f.message());await f.exchange();
  f.hub.authorize=()=>{throw new Error('locked');};
  assert.equal(f.hub.view().enabled,false);assert.equal(f.hub.view().roster.length,0);
  const request=await f.spoke.request();await assert.rejects(f.hub.accept(request.body,request.signature));
  await assert.rejects(f.hub.drain());assert.equal(f.sent.length,0);
});
