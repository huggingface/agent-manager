import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {
  check, hash, loadConfig, privateRead, privateWrite, allowed, messageValid,
  payloadValid, decode, envelope, mac, verifyMac, TERMINAL, TTL, WINDOW, uuid, MAX_BODY, claimStore,
} from './policy.js';

// Single AM process owns this store. No TTL eviction of message receipts: the
// per-epoch budget fails closed rather than allowing a very late duplicate.
export class Federation {
  constructor({configFile, roster, sourceExists, deliver, authorize=()=>{}, now=Date.now}) {
    Object.assign(this,{configFile,roster,sourceExists,deliver,authorize,now});
    this.config=loadConfig(configFile); this.stamp=hash(this.config);
    this.file=path.join(path.dirname(configFile),'state-'+this.config.peer.epoch+'.json');
    this.release=claimStore(path.dirname(configFile));
    try {
      try { this.state=JSON.parse(privateRead(this.file)); }
      catch(e) {if(e.code!=='ENOENT')throw e;this.state={version:1,epoch:this.config.peer.epoch,nonces:{},inbox:{},outbox:{},roster:[],lastSeen:null,audit:[]};}
      check(this.state.version===1 && this.state.epoch===this.config.peer.epoch);
      for(const r of Object.values(this.state.inbox)) if(r.status==='dispatching') {r.status='uncertain';delete r.message.text;}
      // Online is process-local evidence, never a persisted guess after restart.
      this.onlineAt=null;this.tail=Promise.resolve();this.save();
    } catch(e) {this.release();throw e;}
  }
  current() {check(!this.closed && !this.failed && hash(loadConfig(this.configFile))===this.stamp);return this.config;}
  admit() {const c=this.current();this.authorize();return c;}
  close() {if(!this.closed){this.closed=true;this.release();}}
  serial(fn) {
    const result=this.tail.then(()=>{this.admit();return fn();});
    this.tail=result.catch(()=>{});return result;
  }
  save() {
    try {privateWrite(this.file,this.state);}
    catch(e) {this.failed=true;throw e;}
  }
  audit(event, r) {
    this.state.audit.push({at:new Date(this.now()).toISOString(),event,peer:this.config.peer.id,
      ...(r?{id:r.message.id,from:r.message.from,to:r.message.to,hash:r.hash,status:r.status}:{})});
    this.state.audit=this.state.audit.slice(-2000);
  }
  finish(r,status) {r.status=status; delete r.message.text;this.audit('delivery',r);}
  expire() {
    for(const table of [this.state.inbox,this.state.outbox]) for(const r of Object.values(table)) {
      if(r.status==='queued' && r.message.createdAt < this.now()-TTL)this.finish(r,'expired');
    }
  }
  async enqueue({id,from,to,text}) {
    return this.serial(async()=>{
      const c=this.current(), message={id,from,to,text,createdAt:this.now()};
      messageValid(message,this.now());check(allowed(c,'send',from,to));
      check(await this.sourceExists(from));this.current();
      const old=this.state.outbox[id];
      if(old) {check(old.hash===hash({...message,createdAt:old.message.createdAt}));return this.publicRecord(old);}
      check(Object.keys(this.state.outbox).length<1000);
      const r={message,hash:hash(message),status:'queued'};
      this.state.outbox[id]=r;this.audit('enqueued',r);this.save();return this.publicRecord(r);
    });
  }
  publicRecord(r) {return {id:r.message.id,from:r.message.from,to:r.message.to,createdAt:r.message.createdAt,status:r.status,hash:r.hash};}
  view() {
    let enabled=true;try{this.admit();}catch{enabled=false;}
    const online=enabled && this.onlineAt!==null && this.now()-this.onlineAt<30_000;
    return {enabled,instance:this.config.instanceId,peer:{id:this.config.peer.id,online,lastSeen:this.state.lastSeen},
      roster:enabled?this.state.roster.map(r=>({...r,machine:this.config.peer.id,stale:!online})):[],
      outgoing:Object.values(this.state.outbox).map(r=>this.publicRecord(r)),
      incoming:Object.values(this.state.inbox).map(r=>this.publicRecord(r)),audit:this.state.audit.slice(-100)};
  }
  refreshRoster() {
    if(this.rosterPending)return this.rosterPending;
    if(this.rosterAt && this.now()-this.rosterAt<10_000)return null;
    const c=this.current();
    this.rosterPending=Promise.resolve().then(()=>this.roster(c)).then(roster=>{
      this.current();payloadValid({roster,messages:[],receipts:[]},this.now());
      this.cachedRoster=roster;this.rosterAt=this.now();
    }).catch(()=>{this.cachedRoster=[];this.rosterAt=this.now();}).finally(()=>{this.rosterPending=null;});
    return this.rosterPending;
  }
  async payload() {
    this.current();this.expire();
    const pending=this.refreshRoster();
    // Slow/offline native observations must not hold up peer authentication or
    // accumulate refresh workers. Only one refresh runs; stale rows disappear.
    if(!this.cachedRoster && pending) {
      let timer;try{await Promise.race([pending,new Promise(r=>{timer=setTimeout(r,100);})]);}finally{clearTimeout(timer);}
    }
    this.admit();
    const roster=this.rosterAt && this.now()-this.rosterAt<30_000 ? this.cachedRoster : [];
    const queued=Object.values(this.state.outbox).filter(r=>r.status==='queued');
    const offset=(this.outCursor || 0) % (queued.length || 1);
    const batch=[...queued.slice(offset),...queued.slice(0,offset)].slice(0,4);
    const payload={roster,messages:batch.map(r=>r.message),
      receipts:Object.values(this.state.inbox).filter(r=>TERMINAL.includes(r.status)).map(r=>({id:r.message.id,hash:r.hash,status:r.status}))};
    while(Buffer.byteLength(JSON.stringify(payload)) > MAX_BODY-1024 && payload.messages.length)payload.messages.pop();
    check(Buffer.byteLength(JSON.stringify(payload)) <= MAX_BODY-1024);
    this.outCursor=offset+Math.max(1,payload.messages.length);
    payloadValid(payload,this.now());return payload;
  }
  ingest(p) {
    const c=this.current();payloadValid(p,this.now());
    // Validate the entire batch before changing anything; unauthorised and
    // nonexistent targets get the same protocol refusal and reveal no roster.
    let added=0;
    for(const m of p.messages) {
      check(allowed(c,'receive',m.from,m.to));
      const old=this.state.inbox[m.id];
      if(old)check(old.hash===hash(m));else added++;
    }
    check(Object.keys(this.state.inbox).length+added<=1000);
    for(const r of p.receipts) {
      const old=this.state.outbox[r.id];check(old && old.hash===r.hash);
      check(old.status==='queued' || old.status===r.status || old.status==='expired');
    }
    for(const m of p.messages) if(!this.state.inbox[m.id]) {
      const r={message:m,hash:hash(m),status:'queued',dispatchId:randomUUID()};
      this.state.inbox[m.id]=r;this.audit('received',r);
    }
    for(const r of p.receipts) {
      const old=this.state.outbox[r.id];
      // A late receipt is authoritative even if our local expiry won the race.
      if(old.status!==r.status)this.finish(old,r.status);
    }
    this.state.roster=p.roster;this.state.lastSeen=new Date(this.now()).toISOString();this.onlineAt=this.now();
  }
  async accept(raw, signature) {
    return this.serial(async()=>{
      const c=this.current();verifyMac(c.peer.key,'request',raw,signature);
      try {
      const e=decode(c,raw,this.now());
      // Retain through the whole admissible timestamp window, including future
      // timestamps, so a replay cannot become admissible again after pruning.
      for(const [n,at] of Object.entries(this.state.nonces))if(at<this.now()-2*WINDOW)delete this.state.nonces[n];
      check(!Object.hasOwn(this.state.nonces,e.nonce) && Object.keys(this.state.nonces).length<512);
      this.state.nonces[e.nonce]=this.now();this.save();
      this.ingest(e.payload);this.save();
      const body=envelope(c,await this.payload(),e.nonce,this.now());this.save();
      return {body,signature:mac(c.peer.key,'response',body)};
      } catch(e) {this.audit('authenticated-exchange-refused');this.save();throw e;}
    });
  }
  async request() {
    return this.serial(async()=>{
      const c=this.current(),nonce=randomUUID(),body=envelope(c,await this.payload(),nonce,this.now());this.state.pendingNonce=nonce;this.save();
      return {body,nonce,signature:mac(c.peer.key,'request',body)};
    });
  }
  async response(raw,signature,nonce) {
    return this.serial(()=>{
      const c=this.current();check(uuid(nonce) && this.state.pendingNonce===nonce);verifyMac(c.peer.key,'response',raw,signature);
      this.ingest(decode(c,raw,this.now(),nonce).payload);delete this.state.pendingNonce;this.save();
    });
  }
  async drain() {
    return this.serial(async()=>{
      this.expire();this.save();
      // Only one native mutation per tick; no automatic interruption or boot.
      const queued=Object.values(this.state.inbox).filter(r=>r.status==='queued');
      const offset=(this.inCursor || 0) % (queued.length || 1);this.inCursor=offset+1;
      for(const r of queued.slice(offset,offset+1)) {
        const c=this.current();check(allowed(c,'receive',r.message.from,r.message.to));
        let committed=false;
        const beforeDispatch=()=>{
          this.current();check(!committed);committed=true;r.status='dispatching';this.audit('dispatching',r);this.save();
        };
        try {
          const status=await this.deliver(r.message,{peer:c.peer.id,instance:c.instanceId,epoch:c.peer.epoch,
            requestId:r.dispatchId,beforeDispatch,verify:()=>this.admit()});
          check(['deferred','accepted','rejected'].includes(status));
          if(status==='deferred')check(!committed);
          else {if(status==='accepted')check(committed);this.finish(r,status);}
        } catch {
          // Even known failures after dispatch are conservative: do not retry
          // without an operator looking at the target's actual transcript.
          if(committed)this.finish(r,'uncertain');
          else if(this.failed)throw new Error('federation-refused');
          // Preflight unavailable -> keep queued. Revocation is checked again
          // before every effect; it is never interpreted as permission to send.
        }
        this.save();break;
      }
    });
  }
}
