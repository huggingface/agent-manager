// Recovery serves an operator-opened view or an attributed agent delivery.
// No daemon launch, permission widening or input replay.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ApiError } from './api-errors.js';
const refused = () => new ApiError(409, 'codex-recovery-review', 'Saved settings cannot be restored safely here. Review this task in Codex Terminal or Remote.');
const special = (kind, access) => ({path:{type:'special',value:{kind}},access});
// Codex 0.162.1's TUI persists its built-in Default mode prompt here, while
// app-server-created threads persist null. This exact literal was verified
// against the installed binary; arbitrary client instructions still fail closed.
const DEFAULT_MODE_162 = '1042cc643eb0147ca1039b19287c7462ceb297502f7f310d9664ac323a12feca';
// Earlier TUI Default text retained verbatim by migrated conversations.
const DEFAULT_MODE_LEGACY = '3e7e1681d9b2bc391ab2440ab792d3d6383f693a92a4e4533710a6378846966b';
function standardDefaultInstructions(value) {
  return value == null || (typeof value === 'string'
    && [DEFAULT_MODE_162, DEFAULT_MODE_LEGACY].includes(createHash('sha256').update(value).digest('hex')));
}
export function recoverySettings(p, thread, workdir) {
  if (!p || p.cwd !== workdir || typeof p.model !== 'string' || !p.model
      || typeof thread.modelProvider !== 'string' || !thread.modelProvider
      || !['untrusted','on-request','never'].includes(p.approval_policy)
      || !['user','auto_review'].includes(p.approvals_reviewer)
      || p.collaboration_mode?.mode !== 'default'
      || !standardDefaultInstructions(p.collaboration_mode.settings?.developer_instructions)
      || p.disabled_plugin_ids?.length || p.realtime_active) throw refused();
  const policy=p.sandbox_policy, workspace=policy?.type==='workspace-write', full=policy?.type==='danger-full-access';
  // Restore only exact installed presets, including an already-saved full-access
  // preset. Never infer full access from a missing or custom permission profile.
  const expectedPolicy=workspace ? {type:'workspace-write',network_access:false,exclude_tmpdir_env_var:false,exclude_slash_tmp:false} : full ? {type:'danger-full-access'} : {type:'read-only'};
  if(!isDeepStrictEqual(policy,expectedPolicy))throw refused();
  const entries=[special('root','read')];
  if(workspace)entries.push({path:{type:'path',path:workdir},access:'write'},special('slash_tmp','write'),special('tmpdir','write'),
    ...['.git','.agents','.codex','.aws'].map(name=>({path:{type:'path',path:path.join(workdir,name)},access:'read',missing_path_behavior:'skip'})));
  if(!isDeepStrictEqual(p.permission_profile,full ? {type:'disabled'} : {type:'managed',file_system:{type:'restricted',entries},network:'restricted'}))throw refused();
  const effort=p.effort??p.collaboration_mode.settings.reasoning_effort??null;
  if(effort!==null&&!['none','minimal','low','medium','high','xhigh','max','ultra'].includes(effort))throw refused();
  const serviceTier=p.service_tier??null;
  if(serviceTier!==null&&!['fast','flex','priority','default'].includes(serviceTier))throw refused();
  const config={};
  if(effort!==null)config.model_reasoning_effort=effort;
  if(workspace)Object.assign(config,{'sandbox_workspace_write.network_access':false,'sandbox_workspace_write.writable_roots':[],
    'sandbox_workspace_write.exclude_tmpdir_env_var':false,'sandbox_workspace_write.exclude_slash_tmp':false});
  return {params:{model:p.model,modelProvider:thread.modelProvider,approvalPolicy:p.approval_policy,
    approvalsReviewer:p.approvals_reviewer,sandbox:policy.type,cwd:workdir,...(serviceTier!==null?{serviceTier}:{}),...(Object.keys(config).length?{config}:{})},
    expected:{model:p.model,modelProvider:thread.modelProvider,approvalPolicy:p.approval_policy,approvalsReviewer:p.approvals_reviewer,
      cwd:workdir,reasoningEffort:effort,serviceTier,sandbox:workspace?{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false}:full?{type:'dangerFullAccess'}:{type:'readOnly',networkAccess:false}}};
}
export function verifyRecovered(result, settings, threadId) {
  if(result?.thread?.id!==threadId||Object.entries(settings.expected).some(([key,value])=>!isDeepStrictEqual(result[key]??null,value)))throw refused();
}
export async function recoveryPlan(file, context, thread, latestTurn) {
  const fd=await fs.open(file,'r');
  try {
    const stat=await fd.stat();
    if(!stat.isFile())throw refused();
    const length=Math.min(stat.size,8*1024*1024),offset=stat.size-length,buffer=Buffer.alloc(length);
    const {bytesRead}=await fd.read(buffer,0,length,offset);
    const lines=buffer.toString('utf8',0,bytesRead).split('\n');if(offset)lines.shift();
    let saved, applied, terminal;const nativeTurns=new Set();
    for(let i=lines.length-1;i>=0;i--){if(!lines[i].trim())continue;
      let record;try{record=JSON.parse(lines[i]);}catch{throw refused();}
      if(record.type==='event_msg' && record.payload?.turn_id)nativeTurns.add(record.payload.turn_id);
      if(!terminal && record.type==='event_msg' && ['task_complete','task_started','turn_aborted'].includes(record.payload?.type))terminal=record.payload;
      if(!applied && record.type==='event_msg' && record.payload?.type==='thread_settings_applied')applied=record.payload;
      if(record.type==='turn_context'){saved=record.payload;break;}}
    if(typeof saved?.turn_id!=='string' || !saved.turn_id)throw refused();
    if(latestTurn?.id){if(saved.turn_id!==latestTurn.id)throw refused();}
    // Some 0.162.1 cold threads expose no turns until first resume. The verified
    // native rollout may supply the missing ID only for a completed final turn,
    // with no later start or other turn. Never override a nonempty native index.
    else if(thread.status?.type!=='notLoaded' || terminal?.type!=='task_complete'
        || terminal.turn_id!==saved.turn_id || [...nativeTurns].some(id=>id!==saved.turn_id))throw refused();
    // A native settings change after the last turn must never be overwritten
    // by stale turn_context (e.g. full access changed to a restricted profile).
    if(applied){
      const p=applied.thread_settings;
      if(applied.thread_id!==thread.id || !p || p.model_provider_id!==thread.modelProvider)throw refused();
      for(const key of ['model','cwd','approval_policy','approvals_reviewer','permission_profile','collaboration_mode'])
        if(!isDeepStrictEqual(p[key],saved[key]))throw refused();
      if(!isDeepStrictEqual(p.runtime_workspace_roots,[context.workdir])
          || !isDeepStrictEqual(p.disabled_plugin_ids??[],saved.disabled_plugin_ids??[])
          || (p.reasoning_effort??null)!==(saved.effort??saved.collaboration_mode?.settings?.reasoning_effort??null)
          || (p.service_tier??null)!==(saved.service_tier??null))throw refused();
    }
    const settings=recoverySettings(saved,thread,context.workdir);
    const key=createHash('sha256').update(JSON.stringify([context.stamp,saved.turn_id,settings])).digest('hex');
    return {key,settings};
  } finally {await fd.close();}
}
