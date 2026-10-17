import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import express from 'express';
import {EventSettings,mountEventSettings} from '../src/event-settings.js';
import {loadSources} from '../src/session-event-policy.js';
import {createValidator} from '../src/api-validation.js';import {apiRoutes,apiErrorHandler} from '../src/api-errors.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'source-settings-'));test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
function fixture(){const dir=fs.mkdtempSync(path.join(root,'config-')),file=path.join(dir,'sources.json'),workspaces=path.join(dir,'workspaces');fs.mkdirSync(workspaces);
 const source={id:'granola',provider:'granola',transport:'poller',enabled:false,intervalSeconds:30,revision:1,ownerEmail:'operator@example.com',target:{sessionId:'exact',threadId:'exact-native',stamp:'binding-secret-metadata'},workflow:{mode:'drafts-calendar',instructions:'Research then draft.'}};
 fs.writeFileSync(file,JSON.stringify({version:1,sources:[source]}),{mode:0o600});return {file,workspaces,source,settings:new EventSettings({file,workspaces})};}
test('strict source configuration excludes credentials/URLs/arbitrary intervals and unsafe files',()=>{
 const f=fixture();assert.equal(loadSources(f.file,f.workspaces).size,1);
 for(const mutate of [s=>s.secret='x',s=>s.url='https://evil',s=>s.intervalSeconds=1,s=>s.workflow.mode='send']){
  const s=structuredClone(f.source);mutate(s);fs.writeFileSync(f.file,JSON.stringify({version:1,sources:[s]}));assert.throws(()=>loadSources(f.file,f.workspaces));
 }
 fs.writeFileSync(f.file,JSON.stringify({version:1,sources:[f.source]}));fs.chmodSync(f.file,0o644);assert.throws(()=>loadSources(f.file,f.workspaces));
});
test('workflow editor redacts account and binding, preserves target/cadence/disabled flag and uses CAS',()=>{
 const f=fixture(),view=f.settings.view();assert.doesNotMatch(JSON.stringify(view),/operator@example|binding-secret/);
 const updated=f.settings.update('granola',{revision:view.revision,workflow:{mode:'research',instructions:'Report only.'}});
 const s=JSON.parse(fs.readFileSync(f.file)).sources[0];assert.deepEqual(s.target,f.source.target);assert.equal(s.enabled,false);assert.equal(s.intervalSeconds,30);assert.equal(s.revision,2);
 assert.throws(()=>f.settings.update('granola',{revision:view.revision,workflow:s.workflow}),{code:'event-source-settings-conflict'});
 assert.throws(()=>f.settings.update('granola',{revision:updated.revision,workflow:s.workflow,enabled:true}),{code:'invalid-input'});
});
test('real HTTP settings requires operator origin and rejects agent identity',async t=>{
 const f=fixture(),app=express();app.use(express.json());mountEventSettings(apiRoutes(app,createValidator({cliExists:()=>true,sessionExists:()=>true,groupExists:()=>true})),f.settings);app.use(apiErrorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
 const v=await(await fetch(base+'/api/event-sources/settings')).json();const send=(origin,suffix='')=>fetch(base+'/api/event-sources/granola/workflow'+suffix,{method:'PUT',headers:{'content-type':'application/json',...(origin?{'x-am-origin':origin}:{})},body:JSON.stringify({revision:v.revision,workflow:{mode:'drafts',instructions:'Make drafts.'}})});
 assert.equal((await send(null)).status,403);assert.equal((await send('operator','?from=agent')).status,403);assert.equal((await send('operator')).status,200);
});
