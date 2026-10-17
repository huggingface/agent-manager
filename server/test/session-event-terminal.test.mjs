// Exercise the real runner's guarded PTY input, without a model or production.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {randomUUID} from 'node:crypto';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-event-terminal-'));
process.env.DATA_DIR=path.join(root,'data');process.env.AM_REPIN_DIR=path.join(root,'repin');process.env.AM_INPUT_REQUIRED_DIR=path.join(root,'input-required');
process.env.AM_TEST_REPAINT_CMD='bash --noprofile --norc -i';
const config=await import('../src/config.js');config.ensureDirs();
const store=await import('../src/sessions.js');store.init();
const runner=await import('../src/runner.js');
const remote=await import('../src/remote.js');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test.after(async()=>{for(const s of store.list())if(runner.isRunning(s.id))await runner.stop(s.id);fs.rmSync(root,{recursive:true,force:true});});
test('guards run inside the per-pane queue, never send rejected text, protect an unsubmitted revoked paste',async()=>{
 assert.ok(runner.ghosttyReady(),runner.ghosttyError);
 const s=store.create({cli:'test-repaint',name:'event-fixture',path:'fixture'});runner.ensureRunning(s);
 await runner.waitForInputReady(s.id);await delay(500);
 const output=path.join(root,'executed'),cmd=`echo fixture >> '${output}'`;
 await assert.rejects(runner.sendInput(s.id,cmd,{beforeWrite:()=>{throw Error('revoked');}}),/revoked/);await delay(400);assert.equal(fs.existsSync(output),false);
 let saved=false,entered=false;
 await runner.sendInput(s.id,cmd,{beforeWrite:()=>{saved=true;},beforeEnter:()=>{assert.equal(saved,true);entered=true;}});await delay(500);
 assert.equal(entered,true);assert.equal(fs.readFileSync(output,'utf8'),'fixture\n');
 let allowed=true;
 const a=runner.sendInput(s.id,':',{beforeEnter:()=>{allowed=false;}});
 const b=runner.sendInput(s.id,cmd,{beforeWrite:()=>{if(!allowed)throw Error('revoked in queue');}});
 await a;await assert.rejects(b,/revoked in queue/);await delay(400);assert.equal(fs.readFileSync(output,'utf8'),'fixture\n');
 await assert.rejects(runner.sendInput(s.id,cmd,{beforeEnter:()=>{throw Error('revoked during paste');}}),/revoked during paste/);await delay(500);
 assert.equal(fs.readFileSync(output,'utf8'),'fixture\n');
 await assert.rejects(runner.sendInput(s.id,'echo unrelated'),{code:'input-line-busy'});
 assert.ok(runner.unsubmittedInput(s.id));await runner.stop(s.id);
});
test('strict runner restart commands cannot fall back to a fresh or latest conversation',()=>{
 const id=randomUUID();
 for(const s of [{cli:'claude',sessionUuid:id},{cli:'opencode',opencodeSessionId:'ses_exact'},{cli:'fx',fxSessionId:'fx_exact'}]) {
  const cmd=runner.commandFor({...s,everStarted:true},{exactResume:true});assert.doesNotMatch(cmd,/continue|\|\||--last|else/);assert.match(cmd,/--resume|--session/);
 }
 for(const cli of ['gemini','hermes','openclaw','shell','codex','unknown'])assert.throws(()=>runner.commandFor({cli,everStarted:true},{exactResume:true}),{code:'event-resume-required'});
});
test('remote durable append is restored from disk; a failed write is not a memory-only success',()=>{
 const name='fixture-remote';const m=remote.append(name,{role:'user',from:'external:fixture',text:'event payload'},{durable:true});assert.equal(m.seq,1);
 assert.equal(remote.pendingFor(name,0).length,1);remote.forget(name);assert.equal(remote.messagesSince(name,0)[0].text,'event payload');
 const collision=path.join(remote.folderFor(name),'00002-user.md');fs.writeFileSync(collision,'occupied');
 assert.throws(()=>remote.append(name,{role:'user',from:'external:fixture',text:'must not appear'},{durable:true}),{code:'EEXIST'});
 assert.equal(remote.messagesSince(name,0).length,1);assert.equal(fs.readFileSync(collision,'utf8'),'occupied');
});
