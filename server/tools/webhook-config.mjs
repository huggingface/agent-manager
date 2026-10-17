// Offline preparation only: never load/resume a thread or enable a source.
import fs from 'node:fs';
import path from 'node:path';
import {CodexBindings} from '../src/codex-bindings.js';
if(process.argv.length!==5)throw new Error('Usage: node webhook-config.mjs DATA_DIR SESSION_ID OUTPUT_JSON');
const [data,id,destination]=process.argv.slice(2),output=path.resolve(destination);
const sessions=JSON.parse(fs.readFileSync(path.join(data,'sessions.json'),'utf8'));
const session=sessions.find(s=>s.id===id),binding=new CodexBindings(path.join(data,'codex-bindings.json')).forSession(id);
if(!session || session.cli!=='codex' || session.archivedAt || !binding || binding.amSessionUuid!==session.sessionUuid || binding.threadId!==session.codexSessionId)
  throw new Error('An existing, unambiguous active shared Codex binding is required.');
const source={id:'granola-followups',provider:'granola',enabled:false,revision:1,
 secretFile:path.join(path.dirname(output),'granola-webhook.key'),activatedAt:'SET_AT_ACTIVATION',noteLookupVerified:false,ownerEmail:'operator@example.com',
 target:{sessionId:id,threadId:binding.threadId,stamp:JSON.stringify([session.sessionUuid,binding.endpointId,binding.threadId,binding.revision,binding.cwd])}};
const fd=fs.openSync(output,'wx',0o600);
try{fs.writeFileSync(fd,JSON.stringify({version:1,sources:[source]},null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
console.log('Disabled configuration prepared. Verify deployment prerequisites before activation.');
