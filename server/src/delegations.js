// Durable opt-in follow-up. HTTP /wait remains an observation, never a callback.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {ApiError} from './api-errors.js';
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(s);
export const hash = s => createHash('sha256').update(s).digest('hex');
const terminal = new Set(['delivered','cancelled','expired','stale','notification-uncertain','notification-review','failed']);
const fail = (code, message) => new ApiError(409, code, message);
const textOf = content => typeof content === 'string' ? content : (content || []).filter(x => ['text','input_text','output_text'].includes(x.type)).map(x=>x.text || '').join('');
// Claude TUI persists bracketed paste as one exact wrapper. Strip only a full,
// matching numeric wrapper, never arbitrary quoted/tool markup or a substring.
export function inputText(text, cli) {
  const value=text.trim();
  if(cli!=='claude')return value;
  const paste=/^<pasted_content id="([0-9]{1,12})">\n([\s\S]*)\n<\/pasted_content id="\1">$/.exec(value);
  return paste ? paste[2].trim() : value;
}


// Only harness records can end the exact dispatched exchange. A tool output,
// quoted marker, old answer, or pane state cannot establish completion.
export function consumeEvidence(e, record, expectedHash, cli) {
  if (e.outcome) return;
  const p=record.payload || {}, m=record.message || {};
  if (cli === 'codex' && record.type === 'event_msg' && p.type === 'task_started') e.recentTurn=p.turn_id;
  const user=cli === 'claude' ? record.type === 'user' && !record.isMeta && !record.isSidechain
    : record.type === 'response_item' && p.type === 'message' && p.role === 'user';
  const content=cli === 'claude' ? m.content : p.content;
  if (user) {
    const text=textOf(content);
    // tool_result blocks are not new user input.
    if (text) {
      if (!e.matched && hash(inputText(text,cli)) === expectedHash) {e.matched=true;e.turnId=e.recentTurn || null;return;}
      if (e.matched) {e.outcome='uncertain';e.reason='another-user-input';return;}
    }
  }
  if (!e.matched) return;
  if (cli === 'claude') {
    if (record.isSidechain) return;
    if (record.type === 'assistant') {
      const text=textOf(m.content);
      if (text) e.answer=((e.answer || '')+text).slice(-16000);
      if ((m.content || []).some?.(v=>v.type==='tool_use' && v.name==='AskUserQuestion')) e.blocked=true;
      if (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence') {
        if (text && e.answer) {e.outcome='completed';e.reason='harness-end-turn';}
      } else if (m.stop_reason && !['tool_use'].includes(m.stop_reason)) {e.outcome='failed';e.reason='harness-stop-'+m.stop_reason;}
      if (record.isApiErrorMessage) {e.outcome='failed';e.reason='harness-api-error';}
    }
    if (record.type === 'user' && Array.isArray(m.content) && m.content.some(v=>v.type==='tool_result')) e.blocked=false;
    if (record.type === 'result' && record.is_error) {e.outcome='failed';e.reason='harness-error';}
  } else {
    if (record.type==='turn_context') {
      if (e.turnId && e.turnId !== p.turn_id) {e.outcome='uncertain';e.reason='turn-changed';}
      else e.turnId=p.turn_id;
    }
    if (record.type==='response_item' && p.role==='assistant' && p.type==='message' && p.phase==='final') e.answer=textOf(p.content).slice(-16000);
    if (record.type==='event_msg' && p.turn_id === e.turnId && e.turnId) {
      if (p.type==='task_complete') {e.outcome=e.answer ? 'completed':'uncertain';e.reason=e.answer?'harness-task-complete':'no-final-result';}
      if (p.type==='turn_aborted') {e.outcome='failed';e.reason='harness-aborted';}
    }
  }
}

export function traceCheckpoint(file) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {const s=fs.fstatSync(fd);if(!s.isFile())throw fail('delegation-trace','A regular native trace is required.');
    if(s.size){const b=Buffer.alloc(1);fs.readSync(fd,b,0,1,s.size-1);if(b[0]!==10)throw fail('delegation-trace','The native trace is being written; retry.');}
    return {file,dev:s.dev,ino:s.ino,offset:s.size};
  } finally {fs.closeSync(fd);}
}
export function scanEvidence(job) {
  const c=job.cursor,fd=fs.openSync(c.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const s=fs.fstatSync(fd);
    if(s.dev!==c.dev || s.ino!==c.ino || s.size<c.offset)throw fail('delegation-trace-changed','Native trace changed.');
    const bytes=Math.min(s.size-c.offset,4*1024*1024),buf=Buffer.alloc(bytes);
    fs.readSync(fd,buf,0,bytes,c.offset);const end=buf.lastIndexOf(10);
    if(end<0){job.evidence.caughtUp=bytes===0;if(bytes===4*1024*1024)throw fail('delegation-trace-limit','Native record exceeds the scan limit.');return;}
    for(const line of buf.subarray(0,end).toString('utf8').split('\n')) {
      if(line)consumeEvidence(job.evidence,JSON.parse(line),job.expectedHash,job.cli);
    }
    c.offset+=end+1;job.evidence.caughtUp=c.offset===s.size;
  } finally {fs.closeSync(fd);}
}

export class Delegations {
  constructor({dir,identity,state,prepare,dispatch,notify,assertWritable,now=Date.now,scan=scanEvidence}) {
    Object.assign(this,{dir,identity,state,prepare,dispatch,notify,assertWritable,now,scan});
    this.jobs=new Map();this.written=new Map();this.busy=false;this.creating=new Map();
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    for(const name of fs.readdirSync(dir).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))) {
      const j=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
      if(j.version!==1 || !uuid(j.id) || name!==j.id+'.json')throw new Error('Invalid delegation journal');
      this.jobs.set(j.id,j);this.written.set(j.id,hash(JSON.stringify({...j,updatedAt:null,audit:null})));
    }
  }
  save(j) {
    const signature=hash(JSON.stringify({...j,updatedAt:null,audit:null}));
    if(this.written.get(j.id)===signature)return;
    j.updatedAt=this.now();
    const event={at:j.updatedAt,state:j.state,outcome:j.evidence?.outcome || null,reason:j.evidence?.reason || j.reason || null};
    const last=j.audit?.at(-1);if(!last || ['state','outcome','reason'].some(k=>last[k]!==event[k]))j.audit=[...(j.audit || []),event].slice(-100);
    const file=path.join(this.dir,j.id+'.json'),tmp=file+'.'+randomUUID()+'.tmp';
    let fd;
    try {fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(j));fs.fsyncSync(fd);fs.closeSync(fd);fd=null;fs.renameSync(tmp,file);
      fd=fs.openSync(this.dir,'r');fs.fsyncSync(fd);this.jobs.set(j.id,j);this.written.set(j.id,signature);
    } finally {if(fd!==null && fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp)}catch{}}
  }
  view(j) {return {id:j.id,parentId:j.parentId,targetId:j.targetId,state:j.state,outcome:j.evidence?.outcome || null,reason:j.evidence?.reason || j.reason || null,result:j.evidence?.answer || null,createdAt:j.createdAt,updatedAt:j.updatedAt,expiresAt:j.expiresAt,notification:j.notification || null,audit:j.audit || []};}
  get(id,parentId) {const j=this.jobs.get(id);if(!j || j.parentId!==parentId)throw new ApiError(404,'not-found','Delegation not found.');return this.view(j);}
  valid(j) {try{return this.identity(j.parentId)===j.parentIdentity && this.identity(j.targetId)===j.targetIdentity;}catch(e){if(['codex-sender-stale','codex-unmapped','codex-binding-stale'].includes(e?.code))return false;throw e;}}
  async create(parentId,targetId,{requestId,text}) {
    if(!uuid(requestId) || typeof text!=='string' || !text.trim() || text.length>40000)throw new ApiError(400,'invalid-input','A stable UUID and text of at most 40000 characters are required.');
    if(parentId===targetId)throw fail('delegation-self','Cannot delegate to yourself.');
    this.assertWritable();const key=hash(JSON.stringify([parentId,targetId,text]));
    const existing=this.jobs.get(requestId);
    if(existing){if(existing.key!==key)throw fail('delegation-conflict','This requestId belongs to different work.');if(!this.valid(existing))throw fail('delegation-stale','Session identity changed.');return this.get(requestId,parentId);}
    if([...this.creating.values()].some(r=>r.id===requestId || r.targetId===targetId || r.targetId===parentId || r.parentId===targetId))throw fail('delegation-busy','An incompatible delegation is being created.');
    const active=[...this.jobs.values()].filter(j=>!terminal.has(j.state));
    if(this.jobs.size>=10000 || active.length+this.creating.size>=100)throw fail('delegation-limit','Too many outstanding delegations.');
    if(active.some(j=>j.targetId===targetId || j.targetId===parentId || j.parentId===targetId))throw fail('delegation-busy','Target or parent participates in an incompatible outstanding delegation.');
    this.creating.set(targetId,{id:requestId,parentId,targetId});
    try {
      const parentIdentity=this.identity(parentId),targetIdentity=this.identity(targetId);
      const payload=text+`\n\n[AM delegation ${requestId}]`;
      const prepared=await this.prepare(parentId,targetId,payload);
      const j={version:1,id:requestId,key,parentId,targetId,parentIdentity,targetIdentity,cli:prepared.cli,expectedHash:hash(prepared.expectedText.trim()),cursor:prepared.cursor,evidence:{},state:'dispatching',createdAt:this.now(),expiresAt:this.now()+86400000,callbackId:randomUUID()};
      if(!this.valid(j))throw fail('delegation-stale','Session identity changed.');
      this.assertWritable();this.save(j); // before the non-idempotent legacy PTY effect
      try {
        await this.dispatch(j,payload);
        j.state='watching';
      } catch(error) {j.state='dispatch-uncertain';j.reason=error?.code || 'dispatch-uncertain';}
      this.save(j);return this.view(j);
    } finally {this.creating.delete(targetId);}
  }
  cancel(id,parentId) {
    this.assertWritable();this.get(id,parentId);const j=this.jobs.get(id);
    if(this.creating.has(j.targetId))throw fail('delegation-busy','Dispatch is in progress; retry cancellation after it settles.');
    if(j.state==='notifying')throw fail('delegation-notifying','Delivery is in flight; cancellation cannot retract it.');
    if(!terminal.has(j.state)){j.state='cancelled';this.save(j);}return this.view(j);
  }
  async tick() {
    if(this.busy)return;this.busy=true;
    try {
      for(const j of this.jobs.values()) {
        if(terminal.has(j.state) || this.creating.has(j.targetId))continue;
        try {this.assertWritable();}catch{break;}
        try {
          if(this.now()>j.expiresAt){j.state='expired';this.save(j);continue;}
          if(!this.valid(j)){j.state='stale';this.save(j);continue;}
          if(!j.evidence.outcome) {
            try {await this.scan(j);}catch {j.evidence.outcome='uncertain';j.evidence.reason='trace-unavailable-or-changed';}
            if(terminal.has(j.state))continue;
            if(!j.evidence.outcome && j.evidence.matched && j.evidence.caughtUp) {
              const state=await this.state(j.targetId);
              if(terminal.has(j.state))continue;
              if(state==='input-required' || state==='needs-input' || j.evidence.blocked){j.evidence.outcome='blocked';j.evidence.reason='input-required';}
              else if(state==='stopped'){j.evidence.outcome='failed';j.evidence.reason='process-stopped-without-result';}
            }
            // A restored dispatch-in-flight is observed, never replayed to a PTY.
            if(j.evidence.matched && !j.evidence.outcome)j.state='watching';
            this.save(j);
          }
          if(terminal.has(j.state) || !j.evidence.outcome)continue;
          if(!['waiting','idle','stopped','unloaded'].includes(await this.state(j.parentId)))continue;
          if(terminal.has(j.state))continue;
          if(!this.valid(j)){j.state='stale';this.save(j);continue;}
          this.assertWritable();j.state='notifying';this.save(j);
          // notify uses CodexInput's native receipt/recovery path, not a second
          // transport. Repeating this UUID after a crash is receipt-only.
          try {
            j.notification=await this.notify(j,()=>{this.assertWritable();if(!this.valid(j))throw fail('delegation-stale','Session identity changed.');});
            j.state='delivered';
          } catch(error) {
            if(['codex-send-uncertain','codex-request-conflict','codex-recovery-uncertain'].includes(error?.code))j.state='notification-uncertain';
            else if(error?.code==='codex-recovery-review')j.state='notification-review';
            else j.state='ready';
            j.reason=error?.code || 'notification-unavailable';
          }
          this.save(j);
        }catch { /* Identity or storage unavailable: fail closed; next tick rechecks. */ }
      }
    }finally{this.busy=false;}
  }
  start() {const t=setInterval(()=>this.tick().catch(()=>{}),5000);t.unref();return ()=>clearInterval(t);}
}
