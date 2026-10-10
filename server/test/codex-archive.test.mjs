import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-shared-archive-'));
process.env.DATA_DIR=root;
const store=await import('../src/sessions.js');store.init();
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('shared archive/restore preserve thread identity and persist across reload',()=>{
 const session=store.createCodexReference({name:'fixture',path:'.',threadId:'native-thread'});
 store.update(session.id,{pinnedAt:'today'});
 const archived=store.setArchived(session.id,true);
 assert.ok(archived.archivedAt);assert.equal(archived.pinnedAt,undefined);
 for(const k of ['id','sessionUuid','codexSessionId','path'])assert.equal(archived[k],session[k]);
 store.init();assert.ok(store.get(session.id).archivedAt);
 store.setArchived(session.id,false);store.init();assert.equal(store.get(session.id).archivedAt,undefined);
 assert.equal(store.get(session.id).codexSessionId,session.codexSessionId);
});
test('failed archive persistence does not acknowledge or mutate the visible session',t=>{
 const session=store.createCodexReference({name:'fixture',path:'.',threadId:'another-thread'});
 const before=fs.readFileSync(path.join(root,'sessions.json'),'utf8');
 const open=fs.openSync;t.mock.method(fs,'openSync',(...args)=>{
  if(args[1]==='wx')throw Object.assign(Error('fixture write failure'),{code:'EACCES'});
  return open(...args);
 });
 assert.throws(()=>store.setArchived(session.id,true),/fixture write failure/);
 assert.equal(store.get(session.id).archivedAt,undefined);
 assert.equal(fs.readFileSync(path.join(root,'sessions.json'),'utf8'),before);
});

test('migration guard keeps the legacy row identity and survives reload',()=>{
 const s=store.create({name:'Legacy migration',cli:'codex',path:'.'});store.update(s.id,{codexSessionId:'exact-native-id',pinnedAt:'today'});
 const result=store.prepareCodexMigration(s.id,{phase:'prepared',threadId:'exact-native-id',key:'preview'});
 for(const k of ['id','sessionUuid','name','path','codexSessionId','pinnedAt'])assert.equal(result[k],s[k]);
 store.init();assert.equal(store.get(s.id).codexSharedOnly,true);assert.equal(store.get(s.id).codexMigration.key,'preview');
});
test('failed migration guard write does not mutate memory or disk',t=>{
 const s=store.create({name:'Cannot guard',cli:'codex',path:'.'});store.update(s.id,{codexSessionId:'exact-failed-id'});
 const before=fs.readFileSync(path.join(root,'sessions.json'),'utf8'),open=fs.openSync;
 t.mock.method(fs,'openSync',(...args)=>{if(args[1]==='wx')throw Error('fixture migration write failure');return open(...args);});
 assert.throws(()=>store.prepareCodexMigration(s.id,{threadId:'exact-failed-id'}),/fixture migration write failure/);
 assert.equal(store.get(s.id).codexSharedOnly,undefined);assert.equal(fs.readFileSync(path.join(root,'sessions.json'),'utf8'),before);
});
