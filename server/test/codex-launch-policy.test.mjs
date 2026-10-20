import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-launch-policy-'));
process.env.DATA_DIR=root;
delete process.env.AM_CODEX_BINDINGS_PILOT;
delete process.env.AM_CODEX_SHARED_CREATE;
const {codexLaunchBlock,assertCodexLaunchAllowed,assertLegacyCodexCreationAllowed}=await import('../src/codex-launch-policy.js');
const {commandFor,ensureRunning,restart}=await import('../src/runner.js');
const {SessionRuntime}=await import('../src/session-runtime.js');
const unbound={forSession:()=>null};
const bound={forSession:()=>({threadId:'11111111-1111-4111-8111-111111111111'})};
const session={id:'legacy',cli:'codex',codexSessionId:'11111111-1111-4111-8111-111111111111',everStarted:true,path:'must-not-be-created'};
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('standalone configuration and other CLIs retain their launch commands',()=>{
  assert.equal(codexLaunchBlock(session,unbound),null);
  assert.match(commandFor(session),/resume/);
  const claude=commandFor({...session,cli:'claude'});
  process.env.AM_CODEX_BINDINGS_PILOT='1';
  try {assert.equal(commandFor({...session,cli:'claude'}),claude);assert.equal(codexLaunchBlock({...session,cli:'shell'},unbound),null);}
  finally {delete process.env.AM_CODEX_BINDINGS_PILOT;}
});
test('both host flags forbid unbound launch even without a daemon; reject before workspace or PTY creation',()=>{
  for(const key of ['AM_CODEX_BINDINGS_PILOT','AM_CODEX_SHARED_CREATE']) {
    process.env[key]='1';
    try {
      for(const fn of [assertCodexLaunchAllowed,commandFor,ensureRunning]) assert.throws(()=>fn(session),e=>e.statusCode===409&&e.code==='codex-migration-required');
      assert.throws(()=>assertLegacyCodexCreationAllowed('codex'),{code:'codex-shared-create-required'});
      assert.equal(codexLaunchBlock(session,bound),null);
      assert.equal(fs.existsSync(path.join(root,'workspaces',session.path)),false);
    } finally {delete process.env[key];}
  }
});
// `codexMigration` is what prepareCodexMigration writes next to codexSharedOnly,
// and it is what tells this session apart from an imported reference whose
// binding failed — that one is told to finish its import, not to migrate a
// conversation it never had. Both stay blocked; they are told different things.
test('incomplete migration stays blocked when shared flags are removed',()=>{
 const migrating={...session,codexSharedOnly:true,codexMigration:{phase:'prepared',threadId:session.codexSessionId,key:'k'}};
 assert.throws(()=>assertCodexLaunchAllowed(migrating,unbound),{code:'codex-migration-required'});
 assert.throws(()=>assertCodexLaunchAllowed({...session,codexSharedOnly:true},unbound),{code:'codex-import-incomplete'});
});
test('Reader exposes same-thread migration without claiming a running TUI stopped or modifying history',async()=>{
 process.env.AM_CODEX_BINDINGS_PILOT='1';
 try {
  const runtime=new SessionRuntime({bindings:unbound,codex:{attach(){throw Error('must not connect')}}});
  const page={turns:[{id:'original',text:'original history'}]};
  const before=JSON.stringify({session,page});
  const row=runtime.presentation(session);assert.equal(row.state,undefined);
  assert.equal(row.codexMigrationRequired.threadId,session.codexSessionId);
  assert.equal(row.codexMigrationRequired.previewUrl,'/api/sessions/legacy/codex/migration');
  const view=await runtime.trace(session,page);assert.equal(view.interaction.canSend,false);
  assert.match(view.interaction.error,/existing thread/);assert.deepEqual(view.turns,page.turns);
  assert.equal(JSON.stringify({session,page}),before);
  assert.equal(codexLaunchBlock({...session,codexSessionId:null},unbound).previewUrl,null);
  assert.throws(()=>codexLaunchBlock(session,{forSession(){throw Error('unavailable')}}));
 }finally{delete process.env.AM_CODEX_BINDINGS_PILOT;}
});

test('CLI update restart refuses legacy Codex before stopping or relaunching', async () => {
  process.env.AM_CODEX_BINDINGS_PILOT='1';
  try { await assert.rejects(restart(session), {code:'codex-migration-required'}); }
  finally { delete process.env.AM_CODEX_BINDINGS_PILOT; }
});
