import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {traceCheckpoint, scanEvidence} from './delegations.js';
import {hash, reject, policyStamp, verifyEvent, eventPrompt, externalPrincipal, externalText, privateFile} from './webhook-providers.js';

const pending = new Set(['pending','sending','accepted','blocked']);
const busy = new Set(['codex-task-busy','codex-send-busy','codex-recovery-busy']);
const transient = new Set([...busy,'space-locked']);
const uncertain = new Set(['codex-send-uncertain','codex-recovery-uncertain','codex-request-conflict']);
export class Webhooks {
  constructor({dir, sources, secret, input, trace, assertWritable = () => {}, now = Date.now, scan = scanEvidence}) {
    Object.assign(this, {dir,sources,secret,input,trace,assertWritable,now,scan});
    this.jobs = new Map(); this.limits = new Map(); this.running = false;
    fs.mkdirSync(dir, {recursive:true,mode:0o700});
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077) throw reject(503);
    const names = fs.readdirSync(dir).filter(x => /^[a-f0-9]{64}\.json$/.test(x));
    if (names.length > 10000) throw reject(503);
    for (const name of names) {
      const job = JSON.parse(privateFile(path.join(dir,name), null, 131072));
      if (job.version !== 1 || job.key + '.json' !== name || !job.sourceId || !job.requestId || !job.audit) throw reject(503);
      this.jobs.set(job.key, job);
    }
  }
  save(job) {
    job.updatedAt = new Date(this.now()).toISOString();
    const dest = path.join(this.dir,job.key+'.json'), temp = dest+'.'+randomUUID()+'.tmp';
    let fd;
    try {
      fd=fs.openSync(temp,'wx',0o600); fs.writeFileSync(fd,JSON.stringify(job)); fs.fsyncSync(fd); fs.closeSync(fd); fd=undefined;
      fs.renameSync(temp,dest); fd=fs.openSync(this.dir,'r'); fs.fsyncSync(fd);
    } finally {if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch{}}
    this.jobs.set(job.key,job);
  }
  transition(job,state,reason) {
    if (job.state === state && job.reason === reason) return;
    job.state=state;job.reason=reason;
    job.audit.push({at:new Date(this.now()).toISOString(),state,reason});job.audit=job.audit.slice(-64);
    this.save(job);
  }
  current(job) {
    this.assertWritable();
    const source = this.sources().get(job.sourceId);
    if (!source?.enabled || policyStamp(source) !== job.policy) throw reject(409);
    const target = this.input.context(source.target.sessionId);
    if (target.stamp !== source.target.stamp || target.threadId !== source.target.threadId) throw reject(409);
    return source;
  }
  receive(id,headers,raw) {
    const source=this.sources().get(id);
    if (!source?.enabled) throw reject(404);
    const window=Math.floor(this.now()/60000), limit=this.limits.get(id);
    const count=limit?.window===window ? limit.count+1 : 1;
    this.limits.set(id,{window,count});if(count>60)throw reject(429);
    const event=verifyEvent(source,headers,raw,this.secret(source),this.now());
    const key=hash(JSON.stringify([id,event.id])), bodyHash=hash(raw), previous=this.jobs.get(key);
    if(previous) {if(previous.bodyHash!==bodyHash)throw reject(409);return {ok:true};}
    const own=[...this.jobs.values()].filter(j=>j.sourceId===id);
    if(this.jobs.size>=10000 || own.filter(j=>pending.has(j.state)).length>=100
      || own.filter(j=>Date.parse(j.createdAt)>this.now()-86400000).length>=100)throw reject(503);
    const job={version:1,key,sourceId:id,provider:source.provider,event,bodyHash,policy:policyStamp(source),
      target:source.target,requestId:randomUUID(),state:'pending',reason:'durable-receipt',createdAt:new Date(this.now()).toISOString(),audit:[]};
    // The duplicate acknowledgement does not disclose target or processing state.
    if(Date.parse(event.occurredAt)<Date.parse(source.activatedAt)) {job.state='ignored';job.reason='before-activation';}
    else if(source.provider==='granola' && own.some(j=>j.event.resourceId===event.resourceId && j.event.type===event.type && j.state!=='ignored')) {
      job.state='ignored';job.reason='duplicate-note';
    }
    job.audit.push({at:job.createdAt,state:job.state,reason:job.reason});this.save(job);
    return {ok:true};
  }
  async advance(job) {
    let source;
    try {source=this.current(job);} catch (e) {
      if(e.code==='space-locked')return;
      // Configuration failure is an availability fault, not a reason to mutate
      // accepted work or deliver to a fallback destination.
      if(e.status!==409)return;
      this.transition(job,'revoked','source-or-binding-changed');return;
    }
    if(this.now()-Date.parse(job.createdAt)>86400000) {
      this.transition(job,job.state==='pending'?'expired':'uncertain','observation-or-delivery-deadline');return;
    }
    if(job.state==='accepted' || job.state==='blocked') {
      try {
        const old=hash(JSON.stringify([job.cursor,job.evidence]));this.scan(job);
        if(job.evidence.outcome) {
          // Keep only a digest, not private result text, in webhook audit files.
          job.resultHash=job.evidence.answer ? hash(job.evidence.answer) : null;
          delete job.evidence.answer;
          this.transition(job,job.evidence.outcome,job.evidence.reason);return;
        }
        const status=await this.input.status(job.target.sessionId);
        this.current(job);
        if(status.status==='needs-input')this.transition(job,'blocked','native-input-required');
        else if(job.state==='blocked')this.transition(job,'accepted','observing-native-result');
        if(old!==hash(JSON.stringify([job.cursor,job.evidence])))this.save(job);
      } catch {this.transition(job,'uncertain','native-evidence-unavailable');}
      return;
    }
    const principal=externalPrincipal(source,job.event), text=eventPrompt(source,job.event);
    try {
      const receipt=this.input.readReceipt(job.requestId);
      // No receipt after a crash between journal and send is provably unsent:
      // CodexInput fsyncs its sending receipt before any native queue call.
      if(!receipt) {
        const status=await this.input.status(job.target.sessionId);this.current(job);
        if(!['idle','unloaded'].includes(status.status))return;
        const file=await this.trace(job.target.sessionId);this.current(job);
        job.cursor=traceCheckpoint(file);job.evidence={};job.cli='codex';
        job.expectedHash=hash(externalText(principal,text).trim());
        this.transition(job,'sending','native-submit-intent');
        // Always save a refreshed cursor even if already in sending state.
        this.save(job);
      }
      const result=await this.input.sendFromExternal(job.target.sessionId,{text,requestId:job.requestId},principal,{verifySource:()=>this.current(job)});
      job.receipt={queuedSubmissionId:result.queuedSubmissionId};
      this.transition(job,'accepted','native-queue-ack');
    } catch(e) {
      if(transient.has(e.code)) {this.transition(job,'pending','waiting-for-destination');return;}
      this.transition(job,uncertain.has(e.code)?'uncertain':'review',uncertain.has(e.code)?'native-ack-uncertain':'delivery-requires-review');
    }
  }
  async tick() {
    if(this.running)return;this.running=true;
    try {for(const job of this.jobs.values())if(pending.has(job.state))await this.advance(job);}
    finally{this.running=false;}
  }
  start() {this.timer=setInterval(()=>this.tick().catch(()=>{}),3000);this.timer.unref();}
  stop() {clearInterval(this.timer);}
}

// Completely separate surface: never mount this handler on AM's public API.
export function webhookServer(service,{now=Date.now}={}) {
  let window=0,count=0;
  const server=http.createServer(async(req,res)=>{
    const send=(status,body={error:'Webhook rejected'})=>{if(!res.headersSent){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Connection':'close'});res.end(JSON.stringify(body));}};
    const minute=Math.floor(now()/60000);if(minute!==window){window=minute;count=0;}
    if(++count>300){send(429);return;}
    const route=/^\/hooks\/([a-zA-Z0-9_-]{1,128})$/.exec(req.url || '');
    if(req.method!=='POST'||!route){send(404);return;}
    if(req.headers['content-type']?.split(';')[0].trim()!=='application/json' || req.headers['content-encoding']){send(415);return;}
    if(Number(req.headers['content-length'] || 0)>16384){send(413);return;}
    const timeout=setTimeout(()=>{send(408);req.destroy();},10000);timeout.unref();
    try {
      let length=0;const chunks=[];
      for await(const chunk of req){length+=chunk.length;if(length>16384){send(413);req.destroy();return;}chunks.push(chunk);}
      const result=service.receive(route[1],req.headers,Buffer.concat(chunks));send(202,result);
    } catch(e) {send([400,401,404,409,413,429,503].includes(e.status)?e.status:503);}
    finally {clearTimeout(timeout);}
  });
  server.headersTimeout=10000;server.requestTimeout=12000;server.maxHeadersCount=32;
  server.on('clientError',(_err,socket)=>socket.destroy());
  return server;
}
