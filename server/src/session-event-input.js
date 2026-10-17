// Provider-independent transports. A PTY write is not a native queue ACK.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {localEventTarget,exactEventResume,eventFailure as fail} from './session-event-target.js';
import {hash,externalText,privateFile} from './webhook-providers.js';
import {traceCheckpoint,scanEvidence} from './delegations.js';
import {nativeEventReadiness} from './session-event-readiness.js';
import {openCodeCheckpoint,scanOpenCode} from './session-event-opencode.js';

export class SessionEventInput {
  constructor({dir,getSession,codex,state,running,resume,ready,send,trace,remote,assertWritable=()=>{}}) {
    Object.assign(this,{dir,getSession,codex,state,running,resume,ready,send,trace,remote,assertWritable});
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const st=fs.lstatSync(dir);
    if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077))throw fail('event-journal-unavailable');
    this.inFlight=new Set();
  }
  context(id) {
    const s=this.getSession(id);
    return s?.cli==='codex' ? this.codex.context(id) : localEventTarget(s);
  }
  file(id) {
    if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id))throw fail('event-invalid-request');
    return path.join(this.dir,id+'.json');
  }
  readReceipt(id) {
    try{return JSON.parse(privateFile(this.file(id),null));}
    catch(e){if(e.code!=='ENOENT')throw e;return this.codex.readReceipt(id);}
  }
  save(r) {
    const dest=this.file(r.requestId),temp=dest+'.'+randomUUID()+'.tmp';let fd;
    try {fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(r));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      fs.renameSync(temp,dest);fd=fs.openSync(this.dir,'r');fs.fsyncSync(fd);
    } finally {if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch{}}
  }
  async status(id) {
    this.context(id);const s=this.getSession(id);
    if(s.cli==='codex')return this.codex.status(id);
    if(s.cli==='remote')return {status:s.remote.paused?'needs-input':this.remote.state(s)==='working'?'working':'idle'};
    if(!this.running(id))return {status:'unloaded'};
    const state=this.state(s);if(state.status!=='idle')return state;
    const native=nativeEventReadiness(s,await this.trace(s));
    return native?{status:native}:state;
  }
  async prepare(job) {
    const s=this.getSession(job.target.sessionId);this.context(s?.id);
    job.cli=s.cli;job.evidence={};
    if(s.cli==='codex'||s.cli==='claude') {
      const location=await this.trace(s);if(!location?.path)throw fail('event-resume-required');
      job.cursor=traceCheckpoint(location.path);job.observer='jsonl';
    } else if(s.cli==='opencode') {
      const location=await this.trace(s);if(!location?.path||!s.opencodeSessionId)throw fail('event-resume-required');
      job.cursor=openCodeCheckpoint(location.path,s.opencodeSessionId);job.observer='opencode';
    } else {job.observer='unavailable';job.cursor=null;}
  }
  async observe(job) {
    if(job.observer==='jsonl'||(!job.observer&&job.cli==='codex'))scanEvidence(job);
    else if(job.observer==='opencode')scanOpenCode(job);
    // No native final signal: remain submitted, never infer success from idle.
  }
  async sendFromExternal(id,{text,requestId},principal,{verifySource=()=>{}}={}) {
    const s=this.getSession(id),target=this.context(id);
    if(s.cli==='codex')return this.codex.sendFromExternal(id,{text,requestId},principal,{verifySource});
    if(principal?.type!=='webhook'||typeof text!=='string'||!text.trim()||text.length>40000)throw fail('event-invalid-request');
    const content=externalText(principal,text),digest=hash(content);
    if(/[\x00-\x08\x0b-\x1f\x7f]/.test(content))throw fail('event-invalid-text');
    if(this.inFlight.has(id))throw fail('event-target-busy');
    this.inFlight.add(id);
    try {
      const verify=()=>{this.assertWritable();verifySource();if(this.context(id).stamp!==target.stamp)throw fail('event-target-changed');};
      verify();
      const old=this.readReceipt(requestId);
      if(old) {
        if(old.stamp!==target.stamp||old.hash!==digest)throw fail('event-send-uncertain');
        if(old.state==='submitted')return {deliveryState:'submitted',receiptId:requestId};
        throw fail('event-send-uncertain');
      }
      const receipt={version:1,requestId,sessionId:id,cli:s.cli,stamp:target.stamp,hash:digest,principal,state:'sending',createdAt:new Date().toISOString()};
      if(s.cli==='remote') {
        if(s.remote.paused||this.remote.state(s)==='working')throw fail('event-target-busy');
        verify();this.save(receipt);
        const message=this.remote.append(s.remote.name,{role:'user',from:`external:${principal.id}`,text:content},{durable:true});
        receipt.remoteSeq=message.seq;
      } else {
        if(!this.running(id)) {
          exactEventResume(s); // Reject unsupported restart before creating a PTY.
          const location=await this.trace(s);verify();
          if(!location?.path)throw fail('event-resume-required');
          const native=nativeEventReadiness(s,location);
          if(native&&native!=='idle')throw fail('event-target-busy');
          if(s.cli==='opencode')openCodeCheckpoint(location.path,s.opencodeSessionId);
          else traceCheckpoint(location.path);
          this.resume(this.getSession(id));await this.ready(id);verify();
        }
        const location=await this.trace(this.getSession(id));verify();
        const guard=()=>{
          verify();
          const current=this.getSession(id),status=this.state(current);
          if(!this.running(id)||status.status!=='idle')throw fail('event-target-busy');
          const native=nativeEventReadiness(current,location);
          if(native&&native!=='idle')throw fail('event-target-busy');
        };
        guard();
        // Runner invokes this after waiting its per-pane send chain, checking
        // the composer, and immediately before writing any bytes. A crash
        // after this receipt can NEVER cause automatic retyping.
        await this.send(id,content,{beforeWrite:()=>{guard();this.save(receipt);},beforeEnter:()=>{verify();if(this.state(this.getSession(id)).status==='needs-input')throw fail('event-target-busy');}});
      }
      receipt.state='submitted';receipt.submittedAt=new Date().toISOString();this.save(receipt);
      return {deliveryState:'submitted',receiptId:requestId};
    } catch(e) {
      // A partial terminal write or remote append with an unknown ACK is not
      // retryable, even when the underlying error happened to say "busy".
      if(this.readReceipt(requestId))throw fail('event-send-uncertain');
      throw e;
    } finally {this.inFlight.delete(id);}
  }
}
