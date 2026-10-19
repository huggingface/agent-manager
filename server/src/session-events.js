import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {traceCheckpoint, scanEvidence} from './delegations.js';
import {hash, reject, policyStamp, eventPrompt, externalPrincipal, externalText, privateFile} from './session-event-policy.js';

const pending = new Set(['pending','sending','submitted','accepted','blocked']);
const busy = new Set(['codex-task-busy','codex-send-busy','codex-recovery-busy']);
const transient = new Set([...busy,'space-locked','event-target-busy','event-resume-required','input-line-busy','input-not-ready']);
const diagnosticCodes = new Set(['codex-recovery-review','codex-recovery-pending','codex-not-loaded','codex-client-limit','codex-binding-stale','codex-source-stale','codex-target-archived','codex-unmapped','codex-thread-mismatch','codex-send-uncertain','codex-recovery-uncertain','codex-request-conflict','event-send-uncertain','event-target-changed','event-target-unavailable','event-journal-unavailable']);
const uncertain = new Set(['codex-send-uncertain','codex-recovery-uncertain','codex-request-conflict','event-send-uncertain']);
export class SessionEvents {
  constructor({dir, sources, input, trace, assertWritable = () => {}, now = Date.now, scan = scanEvidence}) {
    Object.assign(this, {dir,sources,input,trace,assertWritable,now,scan});
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
    let target;
    try {target=this.input.context(source.target.sessionId);}catch(e){
      if(['event-target-unavailable','codex-unmapped','codex-target-archived','codex-binding-stale'].includes(e.code))throw reject(409);
      throw e;
    }
    if (target.stamp !== source.target.stamp || (source.target.threadId !== undefined && target.threadId !== source.target.threadId)) throw reject(409);
    return source;
  }
  enqueue(id,event){
    const source=this.sources().get(id);if(!source?.enabled)throw reject(404);
    if(source.provider==='local-monitor'){
      if(!event||Object.keys(event).sort().join(',')!=='id,occurredAt,type'||! /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(event.id)||event.type!=='incident.ready'
        ||typeof event.occurredAt!=='string'||!Number.isFinite(Date.parse(event.occurredAt))||Date.parse(event.occurredAt)>this.now()+300000||this.now()-Date.parse(event.occurredAt)>86400000)throw reject();
    }else if(!/^not_[A-Za-z0-9]{14}$/.test(event.resourceId)||event.id!==event.resourceId||event.type!=='note.ready'
      ||!Number.isFinite(Date.parse(event.activatedAt))||!Number.isFinite(Date.parse(event.occurredAt)))throw reject();
    const key=hash(JSON.stringify([id,event.id]));
    if(this.jobs.has(key)){
      if(source.provider==='local-monitor'&&hash(JSON.stringify(this.jobs.get(key).event))!==hash(JSON.stringify(event)))throw reject(409);
      return {ok:true,repeated:true};
    }
    const own=[...this.jobs.values()].filter(j=>j.sourceId===id);
    if(this.jobs.size>=10000||own.filter(j=>pending.has(j.state)).length>=100)throw reject(503);
    const job={version:1,key,sourceId:id,provider:source.provider,event,policy:policyStamp(source),target:source.target,
      requestId:randomUUID(),state:'pending',reason:'durable-api-observation',createdAt:new Date(this.now()).toISOString(),audit:[]};
    job.audit.push({at:job.createdAt,state:job.state,reason:job.reason});this.save(job);return {ok:true};
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
    if(['submitted','accepted','blocked'].includes(job.state)) {
      try {
        const old=hash(JSON.stringify([job.cursor,job.evidence]));
        job.evidence.redact=true;
        if(job.evidence.answer){job.evidence.answerHash=hash(job.evidence.answer);job.evidence.hasAnswer=true;delete job.evidence.answer;}
        if(this.input.observe)await this.input.observe(job);else await this.scan(job);
        this.current(job);
        if(job.evidence.outcome) {
          // Keep only a digest, not private result text, in webhook audit files.
          job.resultHash=job.evidence.answer ? hash(job.evidence.answer) : job.evidence.answerHash || null;
          delete job.evidence.answer;
          this.transition(job,job.evidence.outcome,job.evidence.reason);return;
        }
        const status=await this.input.status(job.target.sessionId);
        this.current(job);
        if(status.status==='idle'&&!job.evidence.matched&&!job.queueStartUncertain&&this.input.startQueued) {
          try {await this.input.startQueued(job,externalPrincipal(source,job.event),{verifySource:()=>this.current(job)});}
          catch(e){
            if(e.code==='codex-queue-start-uncertain'){
              job.queueStartUncertain=true;job.deliveryError={code:e.code,stage:'native-queue-start',at:new Date(this.now()).toISOString()};this.save(job);
              // Continue observing: a lost ACK can still produce native evidence.
              return;
            }
            throw e;
          }
        }
        if(status.status==='needs-input')this.transition(job,'blocked','native-input-required');
        else if(job.state==='blocked')this.transition(job,job.deliveryState||'accepted','observing-native-result');
        if(job.state==='submitted'&&job.evidence.matched){job.deliveryState='accepted';this.transition(job,'accepted','native-input-observed');}
        if(old!==hash(JSON.stringify([job.cursor,job.evidence])))this.save(job);
      } catch {this.transition(job,'uncertain','native-evidence-unavailable');}
      return;
    }
    const principal=externalPrincipal(source,job.event), text=eventPrompt(source,job.event);
    try {
      const receipt=this.input.readReceipt(job.requestId);
      // No receipt after a crash between journal and send is provably unsent:
      // Every transport fsyncs its intent before queueing, typing or appending.
      if(!receipt) {
        const status=await this.input.status(job.target.sessionId);this.current(job);
        if(!['idle','unloaded'].includes(status.status)){
          this.transition(job,'pending',status.status==='needs-input'?'destination-input-required':status.status==='unknown'?'destination-status-unknown':'destination-busy');return;
        }
        if(this.input.prepare)await this.input.prepare(job);
        else {const file=await this.trace(job.target.sessionId);job.cursor=traceCheckpoint(file);job.evidence={};job.cli='codex';}
        this.current(job);
        job.evidence.redact=true;
        job.expectedHash=hash(externalText(principal,text).trim());
        this.transition(job,'sending','native-submit-intent');
        // Always save a refreshed cursor even if already in sending state.
        this.save(job);
      }
      const result=await this.input.sendFromExternal(job.target.sessionId,{text,requestId:job.requestId},principal,{verifySource:()=>this.current(job)});
      job.receipt={queuedSubmissionId:result.queuedSubmissionId,receiptId:result.receiptId};
      job.deliveryState=result.deliveryState||'accepted';
      this.transition(job,job.deliveryState,job.deliveryState==='submitted'?'transport-submitted':'native-queue-ack');
    } catch(e) {
      // Do not persist provider messages, paths, payloads or arbitrary codes.
      job.deliveryError={code:diagnosticCodes.has(e.code)||transient.has(e.code)?e.code:'unclassified-delivery-error',stage:'native-submit',at:new Date(this.now()).toISOString()};
      if(transient.has(e.code)) {this.transition(job,'pending',e.code==='event-resume-required'?'exact-resume-required':'waiting-for-destination');return;}
      this.transition(job,uncertain.has(e.code)?'uncertain':'review',uncertain.has(e.code)?'native-ack-uncertain':'delivery-requires-review');
    }
  }
  async tick() {
    if(this.running)return;this.running=true;
    try {
      // One in-flight workflow per destination. A queue ACK is not completion:
      // submitting the next note early would break native turn correlation.
      const destinations=new Set();
      const ordered=[...this.jobs.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.key.localeCompare(b.key));
      for(const job of ordered)if(pending.has(job.state)&&!destinations.has(job.target.sessionId)){
        destinations.add(job.target.sessionId);await this.advance(job);
      }
    }
    finally{this.running=false;}
  }
  start() {this.timer=setInterval(()=>this.tick().catch(()=>{}),3000);this.timer.unref();}
  stop() {clearInterval(this.timer);}
}

