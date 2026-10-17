import path from 'node:path';
import fs from 'node:fs';
import {Federation} from './core.js';
import {startTransport} from './transport.js';
import {ApiError} from '../api-errors.js';
import {check,shape} from './policy.js';

// Secrets are deliberately outside AM settings, operations capture and data
// export. An invalid opt-in config disables federation, never broadens access.
export function installFederation({api,adapter,dataDir,workspacesDir,bindHost,start=startTransport,configFile=process.env.AM_FEDERATION_CONFIG}) {
  let core=null,ready=false;
  if(configFile) {
    try {
      check(['127.0.0.1','::1'].includes(bindHost));
      check(path.isAbsolute(configFile));
      const file=fs.realpathSync(configFile);
      for(const root of [dataDir,workspacesDir]) {
        const relative=path.relative(fs.realpathSync(root),file);
        check(relative.startsWith('..'+path.sep) || path.isAbsolute(relative));
      }
      core=new Federation({configFile:file,...adapter});
      process.once('exit',()=>{try{core.close();}catch{}});
      start(core).then(()=>{ready=true;}).catch(()=>{try{core.close();}catch{}console.error('[federation] disabled: configuration or Tailscale verification failed');});
    } catch {console.error('[federation] disabled: invalid private configuration');}
  }
  api.get('/api/federation',(_req,res)=>res.json(ready?core.view():{enabled:false}));
  api.post('/api/federation/messages',async(req,res)=>{
    if(!ready)throw new ApiError(409,'federation-unavailable','Federation is not available.');
    try {
      shape(req.body,['id','from','to','text']);
      check(req.operationOrigin?.id===req.body.from);
      const result=await core.enqueue(req.body);res.status(202).json(result);
    } catch {throw new ApiError(403,'federation-refused','Federation request refused. Check the local pairing policy.');}
  });
  return ()=>ready?core.view():{enabled:false};
}
