import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';import {build} from 'esbuild';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-creation-ui-'));
try{
 const out=path.join(root,'intent.mjs');await build({entryPoints:['src/lib/creationIntent.ts'],outfile:out,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const memory=new Map();globalThis.localStorage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
 const {withCreationIntent}=await import(pathToFileURL(out));let ids=[];
 const payload={name:'fixture',cli:'codex',prompt:'PRIVATE_TEST_TEXT'};
 await assert.rejects(withCreationIntent(payload,async id=>{ids.push(id);throw Error('lost acknowledgement');}));
 assert.equal(memory.size,1);assert.ok(!JSON.stringify([...memory]).includes('PRIVATE_TEST_TEXT'));
 const reloaded=await import(pathToFileURL(out)+'?reload');
 assert.equal(await reloaded.withCreationIntent(payload,async id=>{ids.push(id);return 'same session';}),'same session');
 assert.equal(ids[0],ids[1]);assert.equal(memory.size,0);
 await withCreationIntent(payload,async id=>{assert.notEqual(id,ids[0]);});
 let release;const gate=new Promise(r=>release=r);ids=[];
 const send=async id=>{ids.push(id);if(ids.length===2)release();await gate;return 'same';};
 await Promise.all([withCreationIntent(payload,send),withCreationIntent(payload,send)]);assert.equal(ids[0],ids[1]);
 localStorage.removeItem=()=>{throw Error('storage unavailable');};assert.equal(await withCreationIntent(payload,async()=> 'acknowledged'),'acknowledged');
 console.log('creation-intent: reload/lost ACK, concurrent retry identity, no prompt storage and acknowledged cleanup passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
