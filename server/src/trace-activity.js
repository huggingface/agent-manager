import fs from 'node:fs/promises';

// Activity is independent of the bounded display tail. Scan complete JSONL
// records with bounded memory and retain a compact append cursor per file.
// Oversized/malformed records are explicitly incomplete evidence, never an
// assertion that no exchange happened. Nothing here resumes a native thread.
const RECORD_LIMIT = 16 * 1024 * 1024;
const CHUNK = 64 * 1024;
const cache = new Map();
const pending = new Map();
const compact = d => Object.fromEntries(['lastPromptTs','lastAnswerTs','outHash','outFresh','outKey'].map(k=>[k,d[k]]));

export async function traceActivity(file, parser, emptyDigest) {
  // Serialize a file's scan to avoid duplicate cold reads and cursor races.
  const previous = pending.get(file) || Promise.resolve();
  const work = previous.catch(()=>{}).then(()=>scan(file,parser,emptyDigest));
  pending.set(file,work);
  try { return await work; } finally { if(pending.get(file)===work)pending.delete(file); }
}

async function scan(file, parser, emptyDigest) {
  const handle = await fs.open(file,'r');
  try {
    const stat = await handle.stat();
    const identity = `${stat.dev}:${stat.ino}`;
    const key = `${identity}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const old = cache.get(file);
    if(old?.key===key)return old.result;
    // Append-only transcripts: replacements, truncation and same-size edits
    // start a fresh scan. Verify the prefix and the prior boundary on growth.
    const fingerprint = async (at, length) => {
      const b=Buffer.alloc(length); const {bytesRead}=await handle.read(b,0,length,at);
      return b.subarray(0,bytesRead).toString('base64');
    };
    const prefix = await fingerprint(0,Math.min(256,stat.size));
    const append = old && old.identity===identity && stat.size>old.size &&
      old.prefix===await fingerprint(0,Math.min(256,old.size)) &&
      old.boundary===await fingerprint(Math.max(0,old.offset-256),Math.min(256,old.offset));
    let state = append ? {...old.state} : compact(emptyDigest());
    let error = append ? old.error : null;
    let offset = append ? old.offset : 0;
    let position=offset, parts=[], length=0, oversized=false;
    const buf=Buffer.alloc(CHUNK);
    while(position<stat.size) {
      const {bytesRead}=await handle.read(buf,0,Math.min(CHUNK,stat.size-position),position);
      if(!bytesRead) { error='activity-incomplete'; break; }
      let start=0;
      while(start<bytesRead) {
        const newline=buf.indexOf(10,start);
        const end=newline>=0 && newline<bytesRead ? newline : bytesRead;
        length+=end-start;
        if(length>RECORD_LIMIT) { oversized=true; parts=[]; }
        else if(!oversized)parts.push(Buffer.from(buf.subarray(start,end)));
        if(end<bytesRead) {
          if(oversized)error='activity-incomplete';
          else if(length) {
            const line=Buffer.concat(parts,length).toString('utf8');
            try { JSON.parse(line); state=compact(parser(line,{...emptyDigest(),...state}).digest); }
            catch { error='activity-incomplete'; }
          }
          parts=[];length=0;oversized=false;offset=position+end+1;
        }
        start=end+1;
      }
      position+=bytesRead;
      // Large cold histories must not monopolize the server event loop.
      await new Promise(resolve=>setImmediate(resolve));
    }
    const finalStat=await handle.stat();
    if(finalStat.size<stat.size || (finalStat.size===stat.size && finalStat.mtimeMs!==stat.mtimeMs)) {
      cache.delete(file);
      return {lastPromptTs:0,lastAnswerTs:0,activityError:'activity-incomplete'};
    }
    // Do not commit a partial last record: re-read it after the next append.
    const result={lastPromptTs:state.lastPromptTs,lastAnswerTs:state.lastAnswerTs,activityError:error || (length || oversized ? 'activity-incomplete' : null)};
    cache.delete(file);
    cache.set(file,{identity,key,size:stat.size,prefix,offset,state,error,result,
      boundary:await fingerprint(Math.max(0,offset-256),Math.min(256,offset))});
    if(cache.size>256)cache.delete(cache.keys().next().value);
    return result;
  } finally { await handle.close(); }
}
