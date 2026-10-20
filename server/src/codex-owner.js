import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export async function writerOwner(home,threadId) {
  const stdout=await new Promise((resolve,reject)=>execFile('python3',
    [fileURLToPath(new URL('../../scripts/codex-writer.py',import.meta.url)),home,threadId],
    {timeout:5000,maxBuffer:8192},(error,out)=>error?reject(error):resolve(out)));
  return JSON.parse(stdout);
}
