import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {execFileSync} from 'node:child_process';import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const tool=fileURLToPath(new URL('../tools/webhook-config.mjs',import.meta.url));
test('generic configuration accepts AM-created, Remote-imported and TUI-migrated Codex identities without model/project restrictions',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'am-webhook-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const [kind,flags,model] of [['created',{codexSharedOnly:true},'model-a'],['imported',{codexSharedOnly:true},'model-b'],['migrated',{},'model-c']]){
  const session={id:kind,cli:'codex',sessionUuid:randomUUID(),codexSessionId:randomUUID(),name:kind,path:kind,model,...flags};
  fs.writeFileSync(path.join(dir,'sessions.json'),JSON.stringify([session]));
  const binding={amSessionId:kind,amSessionUuid:session.sessionUuid,threadId:session.codexSessionId,endpointId:'a'.repeat(64),cwd:dir,revision:2,boundAt:new Date().toISOString()};
  fs.writeFileSync(path.join(dir,'codex-bindings.json'),JSON.stringify({version:1,bindings:[binding]}));
  const output=path.join(dir,kind+'.json');execFileSync(process.execPath,[tool,dir,kind,output]);
  const source=JSON.parse(fs.readFileSync(output)).sources[0];
  assert.equal(source.provider,'standard');assert.equal(source.enabled,false);assert.equal(source.target.sessionId,kind);assert.equal(source.target.threadId,session.codexSessionId);
  assert.deepEqual(JSON.parse(source.target.stamp),[session.sessionUuid,binding.endpointId,session.codexSessionId,2,dir]);
  assert.equal(source.noteLookupVerified,undefined);assert.equal(fs.statSync(output).mode&0o777,0o600);
  assert.throws(()=>execFileSync(process.execPath,[tool,dir,kind,output],{stdio:'pipe'}));
  const granola=path.join(dir,kind+'-granola.json');execFileSync(process.execPath,[tool,dir,kind,granola,'granola']);
  assert.equal(JSON.parse(fs.readFileSync(granola)).sources[0].provider,'granola');
 }
});
test('unmapped and archived sessions require explicit migration/restore, never a TUI or new thread',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'am-webhook-unmapped-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const sessions=[{id:'legacy',cli:'codex',sessionUuid:randomUUID(),codexSessionId:randomUUID()}];fs.writeFileSync(path.join(dir,'sessions.json'),JSON.stringify(sessions));
 const output=path.join(dir,'no.json');assert.throws(()=>execFileSync(process.execPath,[tool,dir,'legacy',output],{stdio:'pipe'}));assert.equal(fs.existsSync(output),false);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'sessions.json'))),sessions);
 sessions[0].archivedAt=new Date().toISOString();fs.writeFileSync(path.join(dir,'sessions.json'),JSON.stringify(sessions));
 fs.writeFileSync(path.join(dir,'codex-bindings.json'),JSON.stringify({version:1,bindings:[{amSessionId:'legacy',amSessionUuid:sessions[0].sessionUuid,threadId:sessions[0].codexSessionId,endpointId:'a'.repeat(64),cwd:dir,revision:1,boundAt:new Date().toISOString()}]}));
 assert.throws(()=>execFileSync(process.execPath,[tool,dir,'legacy',output],{stdio:'pipe'}));assert.equal(fs.existsSync(output),false);

});
