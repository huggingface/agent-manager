// Offline preparation only: never load/resume a thread or enable a source.
import fs from 'node:fs';
import path from 'node:path';
import {CodexBindings} from '../src/codex-bindings.js';
if(![5,6].includes(process.argv.length))throw new Error('Usage: node webhook-config.mjs DATA_DIR SESSION_ID OUTPUT_JSON [standard|granola]');
const provider=process.argv[5] || 'standard';
if(!['standard','granola'].includes(provider))throw new Error('Unsupported provider');
const [data,id,destination]=process.argv.slice(2),output=path.resolve(destination);
const sessions=JSON.parse(fs.readFileSync(path.join(data,'sessions.json'),'utf8'));
const session=sessions.find(s=>s.id===id),binding=new CodexBindings(path.join(data,'codex-bindings.json')).forSession(id);
if(!session || session.cli!=='codex' || session.archivedAt || !binding || binding.amSessionUuid!==session.sessionUuid || binding.threadId!==session.codexSessionId)
  throw new Error('An existing shared Codex binding is required. Import or migrate the same native thread first; never start a separate TUI.');
const source={id:provider==='granola'?'granola-followups':'external-events',provider,enabled:false,revision:1,
 secretFile:path.join(path.dirname(output),provider+'-webhook.key'),activatedAt:'SET_AT_ACTIVATION',
 ...(provider==='granola'?{noteLookupVerified:false,ownerEmail:'operator@example.com'}:{events:['event_ready'],instruction:'SET_FIXED_AUTHORIZED_WORKFLOW'}),
 target:{sessionId:id,threadId:binding.threadId,stamp:JSON.stringify([session.sessionUuid,binding.endpointId,binding.threadId,binding.revision,binding.cwd])}};
const fd=fs.openSync(output,'wx',0o600);
try{fs.writeFileSync(fd,JSON.stringify({version:1,sources:[source]},null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
console.log('Disabled configuration prepared. Verify deployment prerequisites before activation.');
