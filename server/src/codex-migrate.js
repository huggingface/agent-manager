// Explicit migration of an already stopped AM TUI. Never release a process,
// rewrite a native file, infer a neighbouring task, or send model input.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ApiError} from './api-errors.js';
import {ObservationClient} from './codex-shared.js';
import {configuredEndpoint,bindExistingThread} from './codex-context.js';
import {recoveryPlan,verifyRecovered} from './codex-recovery.js';
import {validThreadId} from './codex-bindings.js';
import {WORKSPACES_DIR} from './config.js';
const fail=(code,message)=>new ApiError(409,code,message);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const enabled=()=>process.env.AM_CODEX_BINDINGS_PILOT==='1'&&process.env.AM_CODEX_MIGRATION==='1';
export async function writerOwner(home,threadId) {
  const {stdout}=await promisify(execFile)('python3',[fileURLToPath(new URL('../../scripts/codex-writer.py',import.meta.url)),home,threadId],{timeout:5000,maxBuffer:8192});
  return JSON.parse(stdout);
}
export class MigrationClient extends ObservationClient {
  allows(method,p) {
    return super.allows(method,p)
      || (method==='thread/turns/list'&&p.threadId===this.threadId&&p.limit===50&&p.itemsView==='full'&&p.sortDirection==='desc'&&Object.keys(p).length===5)
      || (method==='thread/resume'&&this.resumeParams&&isDeepStrictEqual(p,this.resumeParams));
  }
}
export async function historyDigest(client,threadId) {
  const h=createHash('sha256'),seen=new Set();let cursor=null,count=0,latest=null;
  for(let i=0;i<100;i++) {
    const page=await client.call('thread/turns/list',{threadId,limit:50,itemsView:'full',sortDirection:'desc',cursor});
    if(!Array.isArray(page.data))throw fail('codex-migration-history','Could not verify the complete history.');
    for(const turn of page.data){if(!latest)latest=turn;if(!turn.id||seen.has(turn.id)||turn.status==='inProgress')throw fail('codex-migration-active','History is active or inconsistent. No migration was performed.');seen.add(turn.id);h.update(JSON.stringify(canonical(turn))+'\n');count++;}
    if(!page.nextCursor)return {count,sha256:h.digest('hex'),latest};
    if(cursor===page.nextCursor||!page.data.length)break;cursor=page.nextCursor;
  }
  throw fail('codex-migration-history','History exceeds the verification bound.');
}
export class CodexMigration {
  constructor({store,bindings,isRunning,endpoint=configuredEndpoint,connect=(...a)=>MigrationClient.connect(...a),owner=writerOwner,root=WORKSPACES_DIR,enabled:gate=enabled,assertWritable=()=>{},bind=bindExistingThread}) {
    Object.assign(this,{store,bindings,isRunning,endpoint,connect,owner,root,enabled:gate,assertWritable,bind});this.busy=new Set();
  }
  session(id) {
    if(!this.enabled())throw fail('codex-migration-disabled','Migration is disabled on this manager.');
    const s=this.store.get(id);
    if(!s||s.cli!=='codex'||!validThreadId(s.codexSessionId)||s.archivedAt)throw fail('codex-migration-session','Choose an existing, unarchived Codex session with an exact thread ID.');
    if(this.isRunning(id))throw fail('codex-migration-running','Close this session’s owning TUI with /quit first. No process was stopped.');
    if(s.pendingPrompt||s.pendingImagePaths?.length)throw fail('codex-migration-pending','Resolve queued input before migration.');
    if(this.store.list().some(x=>x.id!==id&&x.cli==='codex'&&x.codexSessionId===s.codexSessionId))throw fail('codex-migration-ambiguous','Multiple AM views claim this thread.');
    return s;
  }
  stamp(s,endpoint,cwd){return hash([s.id,s.sessionUuid,s.codexSessionId,s.path,endpoint.id,cwd]);}
  async inspect(id,{signal}={}) {
    const s=this.session(id),endpoint=this.endpoint(),cwd=await fs.realpath(path.resolve(this.root,s.path??s.id)),root=await fs.realpath(this.root);
    if(cwd!==root&&!cwd.startsWith(root+path.sep))throw fail('codex-migration-workspace','Workspace is outside this manager.');
    const stamp=this.stamp(s,endpoint,cwd),binding=this.bindings.forSession(id);
    if(binding)throw fail('codex-migration-already-shared','This session already has a shared binding.');
    const owner=await this.owner(endpoint.home,s.codexSessionId);
    if(!['free','absent'].includes(owner.state)&&!(owner.state==='held'&&owner.daemon&&s.codexMigration?.phase==='prepared'))throw fail('codex-migration-owner',owner.state==='held'?`Thread is still owned by PID ${owner.pid}. Close its verified TUI first.`:'Writer ownership could not be verified.');
    if(owner.activeGoal!==false||owner.queuedInput!==false)throw fail('codex-migration-pending','Native goals or queued input must be resolved and verified first.');
    let client;
    try {
      client=await this.connect(endpoint,{signal});client.threadId=s.codexSessionId;
      if(client.endpoint.socket!==endpoint.socket||client.endpoint.home!==endpoint.home)throw fail('codex-migration-endpoint','Endpoint changed.');
      const {thread}=await client.call('thread/read',{threadId:s.codexSessionId,includeTurns:false});
      if(thread?.id!==s.codexSessionId||thread.parentThreadId||await fs.realpath(thread.cwd)!==cwd||!['notLoaded','idle'].includes(thread.status?.type))throw fail('codex-migration-thread','The exact root task must be inactive.');
      if(thread.status.type==='idle'&&s.codexMigration?.phase!=='prepared')throw fail('codex-migration-handoff','Task is already loaded; use the existing binding workflow.');
      const file=await fs.realpath(thread.path),relative=path.relative(endpoint.home,file);
      if(!relative.startsWith('sessions'+path.sep)||path.extname(file)!=='.jsonl')throw fail('codex-migration-history','Unverified rollout path.');
      const fd=await fs.open(file,'r');let header;
      try{const buffer=Buffer.alloc(128*1024),{bytesRead}=await fd.read(buffer,0,buffer.length,0),end=buffer.subarray(0,bytesRead).indexOf(10);if(end<0)throw Error('header');header=JSON.parse(buffer.toString('utf8',0,end));}finally{await fd.close();}
      if(header.type!=='session_meta'||header.payload?.id!==s.codexSessionId||header.payload.source?.subagent||header.payload.thread_source==='subagent'||await fs.realpath(header.payload.cwd)!==cwd)throw fail('codex-migration-history','Rollout identity mismatch.');
      const history=await historyDigest(client,s.codexSessionId),{settings}=await recoveryPlan(file,{stamp,workdir:cwd},thread,history.latest);
      const digest={count:history.count,sha256:history.sha256},key=hash([stamp,digest,settings]);
      if(s.codexMigration&&s.codexMigration.key!==key)throw fail('codex-migration-changed','Prepared migration changed. Review the exact thread; no automatic retry.');
      this.session(id);if(signal?.aborted||client.closed)throw fail('codex-migration-cancelled','Verification cancelled.');
      return {key,stamp,threadId:s.codexSessionId,sessionId:id,name:s.name,endpoint,cwd,owner,history:digest,settings};
    }finally{client?.close();}
  }
  async apply(id,key,{signal}={}) {
    if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw new ApiError(400,'invalid-input','Pass the current migration preview key.');
    if(this.busy.has(id))throw fail('codex-migration-busy','Migration is already in progress.');
    this.busy.add(id);let client;
    try{
      const plan=await this.inspect(id,{signal});if(plan.key!==key)throw fail('codex-migration-stale','Preview changed. Refresh before migration.');
      const check=()=>{const s=this.session(id);if(this.stamp(s,this.endpoint(),plan.cwd)!==plan.stamp||signal?.aborted)throw fail('codex-migration-changed','Session or endpoint changed.');this.assertWritable();};
      check();
      // Durable launch guard precedes the first native mutation. Even a crash
      // here must not revive this session as a standalone TUI.
      this.store.prepareCodexMigration(id,{key,phase:'prepared',threadId:plan.threadId,history:plan.history});
      const owner=await this.owner(plan.endpoint.home,plan.threadId);
      if(owner.activeGoal!==false||owner.queuedInput!==false)throw fail('codex-migration-pending','Native work appeared during verification. No resume was sent.');
      if(!['free','absent'].includes(owner.state)&&!isDeepStrictEqual(owner,plan.owner))throw fail('codex-migration-owner','Writer changed during migration. No resume was sent.');
      client=await this.connect(plan.endpoint,{signal});client.threadId=plan.threadId;check();
      client.resumeParams={threadId:plan.threadId,excludeTurns:true,...plan.settings.params};
      let resumed;try{resumed=await client.call('thread/resume',client.resumeParams);}catch{throw fail('codex-migration-uncertain','Reopen could not be confirmed. The standalone launch stays disabled. Refresh the migration preview; no message was sent.');}finally{client.resumeParams=null;}
      verifyRecovered(resumed,plan.settings,plan.threadId);
      const after=await historyDigest(client,plan.threadId);
      if(after.sha256!==plan.history.sha256||after.count!==plan.history.count)throw fail('codex-migration-history','History changed. Standalone launch remains disabled; review this exact thread.');
      check();
      const binding=await this.bind({sessionId:id,threadId:plan.threadId,expectedRevision:0},{getSession:this.store.get,sessions:this.store.list,isRunning:this.isRunning,bindings:this.bindings,config:plan.endpoint,signal,beforeCommit:check});
      return {ok:true,sessionId:id,threadId:plan.threadId,history:plan.history,binding};
    }finally{client?.close();this.busy.delete(id);}
  }
}
