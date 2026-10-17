// Strengthen the AM terminal activity signal where native records are pinned.
// Unknown or incomplete records must not turn a silent tool call into "idle".
import fs from 'node:fs';
import {openCodeReadiness} from './session-event-opencode.js';
export function nativeEventReadiness(s,location) {
  if(!['claude','opencode'].includes(s.cli))return null;
  try {
    if(!location?.path)return 'unknown';
    if(s.cli==='opencode')return openCodeReadiness(location.path,s.opencodeSessionId);
    const fd=fs.openSync(location.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try {
      const stat=fs.fstatSync(fd);if(!stat.isFile())return 'unknown';
      if(!stat.size)return 'idle';
      const size=Math.min(stat.size,1024*1024),buffer=Buffer.alloc(size);
      fs.readSync(fd,buffer,0,size,stat.size-size);
      if(buffer.at(-1)!==10)return 'unknown';
      const lines=buffer.toString('utf8').split('\n');if(stat.size>size)lines.shift();
      for(let n=lines.length-1;n>=0;n--) {
        if(!lines[n])continue;const r=JSON.parse(lines[n]);if(r.isSidechain||r.isMeta)continue;
        if(r.type==='assistant')return ['end_turn','stop_sequence'].includes(r.message?.stop_reason)?'idle':'working';
        if(r.type==='user')return 'working';
        if(r.type==='result'&&r.is_error)return 'needs-input';
      }
      return 'unknown';
    }finally{fs.closeSync(fd);}
  }catch{return 'unknown';}
}
