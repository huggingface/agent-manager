import test from 'node:test';import assert from 'node:assert/strict';import {run} from '../../scripts/am-codex-migrate.mjs';
test('migration CLI resolves exact names or IDs and never selects an ambiguous name',async()=>{
 const calls=[],sessions=[{id:'one',name:'Microduck',cli:'codex'},{id:'two',name:'Microduck',cli:'codex'}];
 const fetch=async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify(url.pathname==='/api/sessions'?sessions:{key:'a'.repeat(64)}),{status:200});};
 await assert.rejects(run(['http://localhost:7862','preview','microduck'],{fetch,out:()=>{}}),/unique/);assert.equal(calls.length,1);
 await run(['http://localhost:7862','preview','one'],{fetch,out:()=>{}});assert.equal(calls.at(-1).url,'http://localhost:7862/api/sessions/one/codex/migration');assert.equal(calls.at(-1).options.method,undefined);
 await run(['http://localhost:7862','apply','one','a'.repeat(64)],{fetch,out:()=>{}});assert.equal(calls.at(-1).options.method,'POST');assert.equal(calls.at(-1).options.headers['x-am-origin'],'operator');assert.equal(JSON.parse(calls.at(-1).options.body).key,'a'.repeat(64));
});
