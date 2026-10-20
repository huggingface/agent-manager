import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash,webcrypto} from 'node:crypto';import {build} from 'esbuild';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'am-intents-'));
const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
try {
 const load=async(file,name)=>{const out=path.join(root,name+'.mjs');await build({entryPoints:[file],outfile:out,bundle:true,platform:'node',format:'esm',logLevel:'silent'});return import(pathToFileURL(out));};
 const memory=new Map();globalThis.localStorage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues:b=>webcrypto.getRandomValues(b)}});
 const {fingerprint,randomUUID}=await load('src/lib/durableIntent.ts','intent');
 for(const text of ['', 'abc', 'a'.repeat(55),'a'.repeat(56),'a'.repeat(64),'a'.repeat(100000),'été 🏡'])assert.equal(await fingerprint(text),createHash('sha256').update(text).digest('hex'));
 assert.match(randomUUID(),/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 const api=await load('src/api.ts','api'),tab=await load('src/api.ts','other-tab');
 const calls=[];let resolveA;
 globalThis.fetch=async(url,init)=>{const body=JSON.parse(init.body);calls.push({url,body});if(body.text==='A')return new Promise(r=>resolveA=r);throw Error('lost acknowledgement');};
 const a=api.sendInput('s','A');await assert.rejects(tab.sendInput('s','B'));
 resolveA(new Response('{"ok":true}'));await a;await assert.rejects(api.sendInput('s','B'));
 const b=calls.filter(c=>c.body.text==='B');assert.equal(b[0].body.requestId,b[1].body.requestId,'late A acknowledgement retains B across tabs');
 globalThis.fetch=async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return new Response('{"ok":true}');};
 await api.sendInput('s','C');await tab.sendInput('s','B');assert.equal(calls.at(-1).body.requestId,b[0].body.requestId);assert.equal(memory.size,0);
 const oldId=randomUUID();memory.set('am-pending-input:s',JSON.stringify({content:JSON.stringify(['old',[]]),requestId:oldId}));
 await api.sendInput('s','different');assert.ok(memory.has('am-pending-input:s'));
 await api.sendInput('s','old');assert.equal(calls.at(-1).body.requestId,oldId);assert.equal(memory.size,0);
 globalThis.fetch=async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});throw Error('lost acknowledgement');};
 await assert.rejects(api.createSession('fixture','codex'),/connection was interrupted/);
 const first=calls.at(-1);assert.ok(first.body.requestId);
 globalThis.fetch=async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return new Response('{"id":"fixture"}');};
 await tab.createSession('fixture','codex');assert.equal(calls.at(-1).body.requestId,first.body.requestId);assert.equal(memory.size,0);
 console.log('durable-intent: HTTP SHA/UUID, creation/retry, independent tabs/reordered ACKs, old uncertain inputs, legacy migration passed');
} finally {Object.defineProperty(globalThis,'crypto',descriptor);fs.rmSync(root,{recursive:true,force:true});}
