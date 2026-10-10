// Recovery is explicit and bounded. No daemon launch, model input or policy guess.
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
function standardDefaultInstructions(value) {
  return value == null || (typeof value === 'string'
    && createHash('sha256').update(value).digest('hex') === DEFAULT_MODE_162);
}
export function recoverySettings(p, thread, workdir) {
  if (!p || p.cwd !== workdir || typeof p.model !== 'string' || !p.model
      || typeof thread.modelProvider !== 'string' || !thread.modelProvider
      || !['untrusted','on-request','never'].includes(p.approval_policy)
      || !['user','auto_review'].includes(p.approvals_reviewer)
      || p.collaboration_mode?.mode !== 'default'
      || !standardDefaultInstructions(p.collaboration_mode.settings?.developer_instructions)
      || p.disabled_plugin_ids?.length || p.realtime_active) throw refused();
  const policy=p.sandbox_policy, workspace=policy?.type==='workspace-write';
  // Only standard restricted profiles whose complete resolved permissions match
  // the installed 0.162.1 presets. Custom profiles and broader policies fail closed.
  const expectedPolicy=workspace ? {type:'workspace-write',network_access:false,exclude_tmpdir_env_var:false,exclude_slash_tmp:false} : {type:'read-only'};
  if(!isDeepStrictEqual(policy,expectedPolicy))throw refused();
  const entries=[special('root','read')];
  if(workspace)entries.push({path:{type:'path',path:workdir},access:'write'},special('slash_tmp','write'),special('tmpdir','write'),
    ...['.git','.agents','.codex','.aws'].map(name=>({path:{type:'path',path:path.join(workdir,name)},access:'read',missing_path_behavior:'skip'})));
  if(!isDeepStrictEqual(p.permission_profile,{type:'managed',file_system:{type:'restricted',entries},network:'restricted'}))throw refused();
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
      cwd:workdir,reasoningEffort:effort,serviceTier,sandbox:workspace?{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false}:{type:'readOnly',networkAccess:false}}};
}
export function verifyRecovered(result, settings, threadId) {
  if(result?.thread?.id!==threadId||Object.entries(settings.expected).some(([key,value])=>!isDeepStrictEqual(result[key]??null,value)))throw refused();
}
export async function recoveryPlan(file, context, thread, latestTurn) {
  if(!latestTurn?.id)throw refused();
  const fd=await fs.open(file,'r');
  try {
    const stat=await fd.stat();
    if(!stat.isFile())throw refused();
    const length=Math.min(stat.size,8*1024*1024),offset=stat.size-length,buffer=Buffer.alloc(length);
    const {bytesRead}=await fd.read(buffer,0,length,offset);
    const lines=buffer.toString('utf8',0,bytesRead).split('\n');if(offset)lines.shift();
    let saved;
    for(let i=lines.length-1;i>=0;i--){if(!lines[i].trim())continue;
      let record;try{record=JSON.parse(lines[i]);}catch{throw refused();}
      if(record.type==='turn_context'){saved=record.payload;break;}}
    if(saved?.turn_id!==latestTurn.id)throw refused();
    const settings=recoverySettings(saved,thread,context.workdir);
    const key=createHash('sha256').update(JSON.stringify([context.stamp,latestTurn.id,settings])).digest('hex');
    return {key,settings};
  } finally {await fd.close();}
}
