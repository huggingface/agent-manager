import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {traceActivity} from '../src/trace-activity.js';
import {__parseCodexForTest as parseCodex,__parseClaudeForTest as parseClaude,digestFor} from '../src/traces.js';
const empty=()=>parseCodex('').digest;const at=Date.parse('2026-10-11T10:00:00Z');
const msg=(role,text,delta)=>({type:'response_item',timestamp:new Date(at+delta).toISOString(),payload:{type:'message',role,content:[{type:'text',text}]}});
const line=j=>JSON.stringify(j)+'\n';const tool=n=>line({type:'response_item',timestamp:new Date(at+9000).toISOString(),payload:{type:'function_call_output',output:'x'.repeat(n)}});
test('large tool tails preserve exact exchange timestamps, including previous answer',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'am-activity-large-'));const file=path.join(dir,'rollout.jsonl');
 try {
  await fs.writeFile(file,line(msg('user','first',0))+line(msg('assistant','answer',1000))+line({type:'event_msg',timestamp:new Date(at+2000).toISOString(),payload:{type:'task_complete',last_agent_message:'answer'}})+line(msg('user','next',3000))+tool(13*1024*1024));
  let d=await digestFor({id:'fixture',cli:'codex',codexRollout:file});
  assert.equal(d.lastPromptTs,at+3000);assert.equal(d.lastAnswerTs,at+1000);assert.equal(d.activityError,null);
  await fs.appendFile(file,tool(7*1024*1024)+tool(7*1024*1024));
  d=await traceActivity(file,parseCodex,empty);assert.equal(d.lastPromptTs,at+3000);assert.equal(d.lastAnswerTs,at+1000);assert.equal(d.activityError,null);
  await fs.appendFile(file,line(msg('assistant','new answer',4000)));
  d=await traceActivity(file,parseCodex,empty);assert.equal(d.lastAnswerTs,at+4000);
  await fs.appendFile(file,line({type:'event_msg',timestamp:new Date(at+5000).toISOString(),payload:{type:'task_complete',last_agent_message:'new answer'}}));
  d=await traceActivity(file,parseCodex,empty);assert.equal(d.lastAnswerTs,at+4000);
  await fs.appendFile(file,tool(17*1024*1024));d=await traceActivity(file,parseCodex,empty);assert.equal(d.activityError,'activity-incomplete');assert.equal(d.lastAnswerTs,at+4000);
  await fs.writeFile(file,line(msg('user','replacement',6000)));
  d=await traceActivity(file,parseCodex,empty);assert.equal(d.lastPromptTs,at+6000);assert.equal(d.lastAnswerTs,0);assert.equal(d.activityError,null);
  const partial=line(msg('assistant','complete later',7000));await fs.appendFile(file,partial.slice(0,40));d=await traceActivity(file,parseCodex,empty);assert.equal(d.activityError,'activity-incomplete');
  await fs.appendFile(file,partial.slice(40));d=await traceActivity(file,parseCodex,empty);assert.equal(d.lastAnswerTs,at+7000);assert.equal(d.activityError,null);
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('Claude message identities preserve repeated identical answers and ignore tool user records',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'am-activity-claude-'));const file=path.join(dir,'claude.jsonl');
 try {
  const assistant=(id,n)=>line({type:'assistant',timestamp:new Date(at+n).toISOString(),message:{id,content:[{type:'text',text:'same'}]}});
  await fs.writeFile(file,assistant('a',0)+assistant('a',1000)+assistant('b',2000)+line({type:'user',toolUseResult:{},timestamp:new Date(at+9000).toISOString(),message:{content:'tool'}}));
  const d=await traceActivity(file,parseClaude,empty);assert.equal(d.lastAnswerTs,at+2000);assert.equal(d.lastPromptTs,0);
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
