import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationActivity,agentListOptions,filterAgentRows} from '../src/agent-list.js';
import {__parseCodexForTest as parseCodex,__parseClaudeForTest as parseClaude} from '../src/traces.js';
const at=Date.parse('2026-10-11T10:00:00Z');
const msg=(role,text,ts)=>({type:'response_item',timestamp:new Date(ts).toISOString(),payload:{type:'message',role,content:[{type:role==='user'?'input_text':'output_text',text}]}});
const parse=items=>parseCodex(items.map(x=>JSON.stringify(x)).join('\n')).digest;
test('actual exchange dates survive next prompt, metadata, tools and completion mirror',()=>{
 const d=parse([msg('user','first',at-5000),msg('assistant','answer',at-4000),
 {type:'event_msg',timestamp:new Date(at-3000).toISOString(),payload:{type:'task_complete',last_agent_message:'answer'}},
 msg('user','second',at-2000),msg('user','# AGENTS.md instructions for imported workspace',at),{type:'session_meta',timestamp:new Date(at).toISOString(),payload:{}},
 {type:'response_item',timestamp:new Date(at).toISOString(),payload:{type:'function_call',name:'test'}}]);
 assert.equal(d.lastAssistantText,'');assert.equal(d.lastAssistantTs,0);
 assert.deepEqual(conversationActivity(d),{lastPromptAt:new Date(at-2000).toISOString(),lastAnswerAt:new Date(at-4000).toISOString(),lastActivityAt:new Date(at-2000).toISOString(),activityKind:'prompt'});
});
test('Claude prior answer date is retained without changing the current summary',()=>{
 const d=parseClaude([
 {type:'assistant',timestamp:new Date(at-3000).toISOString(),message:{id:'a',role:'assistant',content:[{type:'text',text:'reply'}]}},
 {type:'user',timestamp:new Date(at).toISOString(),message:{role:'user',content:[{type:'text',text:'next'}]}}
 ].map(JSON.stringify).join('\n')).digest;
 assert.equal(d.lastAssistantText,'');assert.equal(conversationActivity(d).lastAnswerAt,new Date(at-3000).toISOString());
});
test('missing activity stays null regardless of creation or screen refresh',()=>{
 assert.deepEqual(conversationActivity({createdAt:at,_ts:at,lastAssistantTs:0}),{lastPromptAt:null,lastAnswerAt:null,lastActivityAt:null,activityKind:null});
});
const rows=[
 {id:'old',name:'A',cli:'codex',state:'waiting',group:'Team',createdAt:new Date(at).toISOString(),lastActivityAt:new Date(at-7*864e5).toISOString()},
 {id:'import',name:'B',cli:'codex',state:'working',group:'Team',trace:null,lastActivityAt:new Date(at-1000).toISOString()},
 {id:'archived',name:'C',cli:'claude',state:'stopped',group:'Team',archivedAt:new Date(at).toISOString(),lastActivityAt:new Date(at-2000).toISOString()},
 {id:'empty',name:'D',cli:'codex',state:'unknown',group:'Else',createdAt:new Date(at).toISOString(),lastActivityAt:null},
];
const filter=q=>filterAgentRows(rows,agentListOptions(q),at).map(x=>x.id);
test('filters four-day window by real exchange, not recent import/creation',()=>{
 assert.deepEqual(filter({active_within_minutes:'5760',include_archived:'true',limit:'200'}),['import','archived']);
});
test('combines group, cli, state, archive, ordering before limit',()=>{
 assert.deepEqual(filter({group:'team',cli:'codex,claude',state:'working,stopped',include_archived:'true',sort:'recent_conversation',limit:'1'}),['import']);
 assert.deepEqual(filter({group:'TEAM',sort:'name'}),['old','import']);
 assert.deepEqual(filter({include_archived:'true',sort:'recent_conversation'}),['import','archived','old','empty']);
});
test('rejects malformed or unsupported options rather than silently ignoring them',()=>{
 for(const q of [{limit:'0'},{limit:'1.5'},{limit:'1001'},{active_within_minutes:'bad'},{include_archived:'yes'},{state:'banana'},{sort:'recent'},{group:''},{limit:['2','3']},{unknown:'x'}])assert.throws(()=>agentListOptions(q),e=>e.status===400||e.code==='invalid-input');
 assert.throws(()=>agentListOptions({cli:'banana'},{cliExists:()=>false}));
});
