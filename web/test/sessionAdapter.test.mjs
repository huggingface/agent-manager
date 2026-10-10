import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';import {build} from 'esbuild';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-adapter-ui-'));
async function load(file,name){const out=path.join(root,name+'.mjs');await build({entryPoints:[file],outfile:out,bundle:true,platform:'node',format:'esm',logLevel:'silent'});return import(pathToFileURL(out));}
try{
 const {ReaderStore}=await load('src/lib/readerStore.ts','store');
 const turn=(id,nativeTurnId,role,text)=>({id,nativeTurnId,role,blocks:[{type:'text',text}]});
 const old=turn('old','old','user','Older history'),user=turn('u','current','user','Question'),answer=turn('a','current','assistant','Partial');
 let page={harness:'codex',harnessLabel:'Codex',sessionId:'s',title:'',model:null,cwd:null,firstTs:0,lastTs:0,usage:null,truncated:false,total:null,userTurns:null,activity:'working',generation:'g',revision:'r',turns:[old,user,answer],window:{mode:'bytes',start:0,end:10,atStart:true,atEnd:true},live:{replaceTurnIds:['current'],turns:[turn('live-u','current','user','Question'),{id:'live-r',nativeTurnId:'current',role:'assistant',blocks:[{type:'thinking',text:'Reasoning'}]},turn('live-a','current','assistant','Partial streamed')]},interaction:{canSend:false,requests:[],error:null}};
 const store=new ReaderStore({window:async()=>page,summary:async()=>({...page,activity:'waiting'})});
 await store.loadNewer();let state=store.getSnapshot();assert.equal(state.turns.filter(t=>t.role==='user').length,2);assert.equal(state.turns.at(-1).blocks[0].text,'Partial streamed');assert.equal(state.head.activity,'working');
 page={...page,turns:[],window:{...page.window,start:10,end:10},live:{...page.live,turns:[...page.live.turns.slice(0,-1),turn('live-a','current','assistant','Partial streamed further')]}};
 await store.loadNewer();state=store.getSnapshot();assert.equal(state.turns.length,4);assert.equal(state.turns[0].blocks[0].text,'Older history');assert.equal(state.turns.at(-1).blocks[0].text,'Partial streamed further');
 page={...page,turns:[{id:'marker',nativeTurnId:'current',role:'system',blocks:[],event:{type:'task-complete',text:'Partial'}}],activity:'waiting',live:{replaceTurnIds:[],turns:[]},interaction:{canSend:true,requests:[],error:null},window:{...page.window,end:20}};
 await store.loadNewer();state=store.getSnapshot();assert.equal(state.turns.filter(t=>t.role==='user').length,2);assert.ok(!JSON.stringify(state.turns).includes('streamed'));assert.equal(state.turns.at(-1).kind,'final');
 const memory=new Map();globalThis.localStorage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
 const requests=[];globalThis.fetch=async(url,init)=>{requests.push({url,body:JSON.parse(init.body)});if(requests.length===1)throw Error('lost response');return new Response('{"ok":true}',{headers:{'content-type':'application/json'}});};
 const api=await load('src/api.ts','api');await assert.rejects(api.sendInput('s','hello',['att-fixture']));await api.sendInput('s','hello',['att-fixture']);
 assert.equal(requests[0].url,'/api/sessions/s/input');assert.equal(requests[0].body.requestId,requests[1].body.requestId);assert.deepEqual(requests[1].body.attachmentIds,['att-fixture']);assert.equal(memory.size,0);
 console.log('session-adapter: common live history, exact replacement, completion, existing history and delivery retry passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
