#!/usr/bin/env node
// Preview an exact AM session before applying its returned migration key.
import {pathToFileURL} from 'node:url';
export async function run(args,{fetch:request=fetch,out=console.log}={}) {
 const [base,action,query,key]=args;
 if(!base||!['preview','apply'].includes(action)||!query||(action==='apply'&&!/^[a-f0-9]{64}$/.test(key||'')))throw Error('Usage: node scripts/am-codex-migrate.mjs BASE_URL preview SESSION_NAME_OR_ID | BASE_URL apply SESSION_NAME_OR_ID PREVIEW_KEY');
 const url=new URL(base);if(url.username||url.password||url.search||url.hash||!['http:','https:'].includes(url.protocol))throw Error('Use a trusted AM URL without credentials or query parameters.');
 const read=async(route,options)=>{const res=await request(new URL(route,url),{redirect:'error',...options});const body=await res.json();if(!res.ok)throw Error((body.code||res.status)+': '+(body.error||'Request refused'));return body;};
 const all=await read('/api/sessions'),exact=all.filter(s=>s.id===query),matches=exact.length?exact:all.filter(s=>s.cli==='codex'&&s.name.toLowerCase()===query.toLowerCase());
 if(matches.length!==1)throw Error('Select a unique exact session name or AM ID.');
 const route='/api/sessions/'+encodeURIComponent(matches[0].id)+'/codex/migration';
 const result=await read(route,action==='apply'?{method:'POST',headers:{'content-type':'application/json','x-am-origin':'operator'},body:JSON.stringify({key})}:undefined);
 out(JSON.stringify(result,null,2));return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)run(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
