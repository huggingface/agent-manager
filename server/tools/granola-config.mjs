import {POST_MEETING_INSTRUCTIONS} from '../src/event-workflows.js';
// Offline preparation only: never load/resume a thread or enable a source.
import fs from 'node:fs';
import path from 'node:path';
import {localEventTarget} from '../src/session-event-target.js';
import {CodexBindings} from '../src/codex-bindings.js';
if(process.argv.length!==6)throw new Error('Usage: node granola-config.mjs DATA_DIR SESSION_ID OUTPUT_JSON OWNER_EMAIL');
const [data,id,destination,ownerEmail]=process.argv.slice(2),output=path.resolve(destination);
if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail))throw new Error('Invalid owner email');
const sessions=JSON.parse(fs.readFileSync(path.join(data,'sessions.json'),'utf8'));
const session=sessions.find(s=>s.id===id),binding=session?.cli==='codex'?new CodexBindings(path.join(data,'codex-bindings.json')).forSession(id):null;
if(!session || session.archivedAt || (session.cli==='codex' && (!binding || binding.amSessionUuid!==session.sessionUuid || binding.threadId!==session.codexSessionId)))
  throw new Error('An existing shared Codex binding is required. Import or migrate the same native thread first; never start a separate TUI.');
const source={id:'granola-followups',provider:'granola',transport:'poller',enabled:false,revision:1,intervalSeconds:30,ownerEmail,workflow:{mode:'drafts-calendar',instructions:POST_MEETING_INSTRUCTIONS},
 target:session.cli==='codex'?{sessionId:id,threadId:binding.threadId,stamp:JSON.stringify([session.sessionUuid,binding.endpointId,binding.threadId,binding.revision,binding.cwd])}:localEventTarget(session)};
const fd=fs.openSync(output,'wx',0o600);
try{fs.writeFileSync(fd,JSON.stringify({version:1,sources:[source]},null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
console.log('Disabled configuration prepared. Verify deployment prerequisites before activation.');
