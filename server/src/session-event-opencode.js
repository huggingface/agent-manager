// OpenCode's native message/part database, not Reader's inferred final labels.
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {hash} from './session-event-policy.js';
import {eventFailure as fail} from './session-event-target.js';
const LIMIT=1024*1024;
function open(file,sessionId) {
  const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw fail('event-evidence-unavailable');
  const db=new DatabaseSync(file,{readOnly:true});
  try {db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100;');
    if(!db.prepare('SELECT id FROM session WHERE id=?').get(sessionId))throw fail('event-evidence-unavailable');
    return {db,st};
  }catch(e){db.close();throw e;}
}
export function openCodeCheckpoint(file,sessionId) {
  const {db,st}=open(file,sessionId);
  try {return {file,sessionId,dev:st.dev,ino:st.ino,after:db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM message WHERE session_id=?').get(sessionId).n};}
  finally{db.close();}
}
export function scanOpenCode(job) {
  const c=job.cursor,{db,st}=open(c.file,c.sessionId),e=job.evidence;
  try {
    if(st.dev!==c.dev||st.ino!==c.ino)throw fail('event-evidence-changed');
    // Re-read the bounded suffix: streaming messages are updated in place.
    const rows=db.prepare('SELECT id, substr(data,1,?) AS data, length(data) AS size FROM message WHERE session_id=? AND rowid>? ORDER BY rowid LIMIT 257').all(LIMIT+1,c.sessionId,c.after);
    if(rows.length>256||rows.reduce((n,r)=>n+r.size,0)>LIMIT)throw fail('event-evidence-limit');
    let matched=false,bytes=0;
    for(const row of rows) {
      const m=JSON.parse(row.data);
      const parts=db.prepare('SELECT substr(data,1,?) AS data,length(data) AS size FROM part WHERE session_id=? AND message_id=? ORDER BY time_created,id LIMIT 257').all(LIMIT+1,c.sessionId,row.id);
      bytes+=parts.reduce((n,p)=>n+p.size,0);if(parts.length>256||bytes>LIMIT)throw fail('event-evidence-limit');
      const data=parts.map(p=>JSON.parse(p.data)),text=data.filter(p=>p.type==='text'&&!p.synthetic&&!p.ignored).map(p=>p.text||'').join('');
      if(m.role==='user') {
        if(!matched&&hash(text.trim())===job.expectedHash){matched=true;e.matched=true;e.userId=row.id;continue;}
        if(matched){e.outcome='uncertain';e.reason='another-user-input';return;}
      }
      if(!matched||m.role!=='assistant'||m.parentID!==e.userId)continue;
      if(m.error){e.outcome='failed';e.reason='harness-api-error';return;}
      if(m.time?.completed&&m.finish==='stop'&&text.trim()&&!data.some(p=>p.type==='tool'&&['pending','running'].includes(p.state?.status))) {
        if(e.redact){e.answerHash=hash(text);e.hasAnswer=true;}else e.answer=text.slice(-16000);e.outcome='completed';e.reason='harness-end-turn';return;
      }
      if(m.time?.completed&&m.finish&&!['stop','tool-calls','unknown'].includes(m.finish)){e.outcome='failed';e.reason='harness-stop';return;}
    }
    if(e.matched&&!matched)throw fail('event-evidence-changed');
  } finally {db.close();}
}
export function openCodeReadiness(file,sessionId) {
  const {db}=open(file,sessionId);
  try {
    const user=db.prepare("SELECT id FROM message WHERE session_id=? AND json_extract(data,'$.role')='user' ORDER BY rowid DESC LIMIT 1").get(sessionId);
    if(!user)return db.prepare('SELECT id FROM message WHERE session_id=? LIMIT 1').get(sessionId)?'unknown':'idle';
    const row=db.prepare("SELECT substr(data,1,?) AS data,length(data) AS size FROM message WHERE session_id=? AND json_extract(data,'$.role')='assistant' AND json_extract(data,'$.parentID')=? ORDER BY rowid DESC LIMIT 1").get(LIMIT+1,sessionId,user.id);
    if(!row)return 'working';if(row.size>LIMIT)return 'unknown';
    const answer=JSON.parse(row.data);
    if(answer.error)return 'needs-input';
    return answer.time?.completed&&answer.finish==='stop'?'idle':'working';
  }finally{db.close();}
}
