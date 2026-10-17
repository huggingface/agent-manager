import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import express from 'express';
import {WebhookSettings,mountWebhookSettings} from '../src/webhook-settings.js';
import {eventPrompt,loadSources} from '../src/webhook-providers.js';
import {WORKFLOW_PRESETS,validWorkflow} from '../src/webhook-workflows.js';
import {createValidator} from '../src/api-validation.js';
import {apiRoutes,apiErrorHandler,ApiError} from '../src/api-errors.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-webhook-settings-'));test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
function fixture(){
 const dir=fs.mkdtempSync(path.join(root,'config-')),workspaces=path.join(dir,'workspace');fs.mkdirSync(workspaces);
 const file=path.join(dir,'webhooks.json'),source={id:'meetings',provider:'granola',enabled:false,revision:1,secretFile:'/private/DO-NOT-EXPOSE.key',ownerEmail:'operator@example.com',target:{sessionId:'target',threadId:'native',stamp:'private-stamp'}};
 fs.writeFileSync(file,JSON.stringify({version:1,sources:[source]}),{mode:0o600});
 return {file,workspaces,source,service:new WebhookSettings({file,workspaces,getSession:()=>({name:'Meeting follow-ups'})})};
}
test('settings expose workflows but no secret paths, accounts or private binding stamps',()=>{
 const f=fixture(),v=f.service.view();assert.equal(v.sources[0].sessionName,'Meeting follow-ups');assert.equal(v.sources[0].enabled,false);assert.equal(v.presets.length,3);
 assert.doesNotMatch(JSON.stringify(v),/DO-NOT-EXPOSE|private-stamp|operator@example/);assert.equal(new WebhookSettings({}).view().configured,false);
});
test('CAS save preserves routing, credentials and enablement; stale edits cannot overwrite',()=>{
 const f=fixture(),before=f.service.view(),workflow={mode:'drafts-calendar',instructions:'Research context; prepare appropriate drafts.'};
 const after=f.service.update('meetings',{revision:before.revision,workflow});assert.notEqual(after.revision,before.revision);assert.equal(after.sources[0].revision,2);assert.deepEqual(after.sources[0].workflow,workflow);
 const saved=JSON.parse(fs.readFileSync(f.file)).sources[0];assert.equal(saved.enabled,false);assert.deepEqual(saved.target,f.source.target);assert.equal(saved.secretFile,f.source.secretFile);assert.equal(fs.statSync(f.file).mode&0o777,0o600);
 assert.throws(()=>f.service.update('meetings',{revision:before.revision,workflow}),{code:'webhook-settings-conflict'});assert.equal(f.service.view().revision,after.revision);
});
test('invalid modes, control bytes, immutable fields, unsafe config and oversized instructions are refused',()=>{
 const f=fixture(),revision=f.service.view().revision;
 for(const workflow of [{mode:'send',instructions:'x'},{mode:'drafts',instructions:''},{mode:'drafts',instructions:'x'.repeat(12001)},{mode:'drafts',instructions:'bad\x1b'},{mode:'drafts',instructions:'x',secret:'x'}]){
  assert.equal(Boolean(validWorkflow(workflow)),false);assert.throws(()=>f.service.update('meetings',{revision,workflow}),{code:'invalid-input'});
 }
 assert.throws(()=>f.service.update('meetings',{revision,workflow:{mode:'drafts',instructions:'x'},enabled:true}),{code:'invalid-input'});
 fs.chmodSync(f.file,0o644);assert.throws(()=>f.service.view(),{code:'webhook-settings-unavailable'});
});
test('Granola instructions retain ownership/cutoff checks and an explicit action ceiling',()=>{
 const s={provider:'granola',ownerEmail:'operator@example.com',activatedAt:'2026-10-17T12:00:00Z'},event={id:'e',type:'note.generated',resourceId:'not_12345678901234',occurredAt:'2026-10-17T13:00:00Z'};
 for(const p of WORKFLOW_PRESETS){const prompt=eventPrompt({...s,workflow:{mode:p.mode,instructions:p.instructions}},event);
  for(const pattern of [/operator@example/,/2026-10-17T12:00:00Z/,/report BLOCKED and stop/,/Never send or schedule messages/,/Gmail, Slack, Beeper/])assert.match(prompt,pattern);
  assert.match(prompt,p.mode==='research'?/No external writes/:/UNSENT drafts/);
  assert.match(prompt,p.mode==='drafts-calendar'?/no attendees, no invitations/:p.mode==='drafts'?/Calendar writes are not authorized/:/Read-only research/);
 }
 assert.match(eventPrompt(s,event),/No external writes/);
 const f=fixture(),config=JSON.parse(fs.readFileSync(f.file));config.sources[0].workflow={mode:'send',instructions:'x'};fs.writeFileSync(f.file,JSON.stringify(config));assert.throws(()=>loadSources(f.file,f.workspaces));
});
test('private HTTP editor rejects agents, conflicts and privacy lock; saving never enables a provider',async t=>{
 const f=fixture(),app=express();app.use(express.json());let locked=false;
 const api=apiRoutes(app,createValidator({cliExists:()=>true,sessionExists:()=>true,groupExists:()=>true}));mountWebhookSettings(api,f.service,{writable:()=>{if(locked)throw new ApiError(403,'space-locked','Locked.');}});app.use(apiErrorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const base=`http://127.0.0.1:${server.address().port}`,view=await(await fetch(base+'/api/webhooks/settings')).json();
 const body={revision:view.revision,workflow:{mode:'drafts-calendar',instructions:'Configured workflow.'}};
 const put=(headers={},suffix='')=>fetch(base+'/api/webhooks/meetings/workflow'+suffix,{method:'PUT',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await put()).status,403);assert.equal((await put({'x-am-origin':'operator'},'?from=agent')).status,403);
 const saved=await put({'x-am-origin':'operator'});assert.equal(saved.status,200);assert.equal((await saved.json()).sources[0].enabled,false);
 assert.equal((await put({'x-am-origin':'operator'})).status,409);locked=true;assert.equal((await put({'x-am-origin':'operator'})).status,403);
});
