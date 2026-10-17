import http from 'node:http';
import {check, MAX_BODY} from './policy.js';
import {verifyIdentity, verifyLocal} from './identity.js';

export async function readBody(stream) {
  const chunks=[];let bytes=0;
  for await(const chunk of stream) {bytes+=chunk.length;check(bytes<=MAX_BODY);chunks.push(chunk);}
  const buffer=Buffer.concat(chunks),text=buffer.toString('utf8');
  check(Buffer.from(text,'utf8').equals(buffer));return text;
}
const oneHeader = (req,name) => req.rawHeaders.filter((_,i,a)=>i%2===0 && a[i].toLowerCase()===name).length===1;

// Pure handler exported for socket-level tests. Production always supplies the
// native identity verifier; there is no environment flag to bypass Tailscale.
export function exchangeHandler(core,{identity=verifyIdentity,now=Date.now}={}) {
  let active=0,window=now(),count=0;
  return async(req,res)=>{
    let admitted=false;
    const refuse=()=>{if(!res.headersSent)res.writeHead(403,{'content-type':'application/json','connection':'close','cache-control':'no-store'});res.end('{"error":"federation-refused"}');};
    const timeout=setTimeout(()=>{req.destroy();res.destroy();},10_000);timeout.unref();
    try {
      const c=core.current();
      check(req.socket.remoteAddress===c.peer.ip);
      check(req.method==='POST' && req.url==='/federation/v1/exchange');
      check(req.headers['content-type']==='application/json' && oneHeader(req,'x-am-federation-mac'));
      check(!Object.keys(req.headers).some(k=>k.startsWith('x-forwarded-') || k.startsWith('tailscale-') || k==='forwarded'));
      if(now()-window>=60_000){window=now();count=0;}
      check(active<2 && ++count<=60);active++;admitted=true;
      await identity(c,req.socket.remoteAddress);core.admit();
      const raw=await readBody(req);
      const result=await core.accept(raw,req.headers['x-am-federation-mac']);core.admit();
      if(res.destroyed)return;
      res.writeHead(200,{'content-type':'application/json','x-am-federation-mac':result.signature,'cache-control':'no-store'});res.end(result.body);
    } catch {refuse();}
    finally {clearTimeout(timeout);if(admitted)active--;}
  };
}

export async function poll(core,{identity=verifyIdentity,request=http.request}={}) {
  const c=core.current();await identity(c,c.peer.ip);core.current();
  const outgoing=await core.request();
  const incoming=await new Promise((resolve,reject)=>{
    const req=request({hostname:c.peer.ip,port:c.port,localAddress:c.localIp,path:'/federation/v1/exchange',method:'POST',
      agent:false,signal:AbortSignal.timeout(10_000),headers:{'content-type':'application/json','content-length':Buffer.byteLength(outgoing.body),
        'x-am-federation-mac':outgoing.signature}},async res=>{
      try {check(res.statusCode===200 && oneHeader(res,'x-am-federation-mac'));resolve({body:await readBody(res),signature:res.headers['x-am-federation-mac']});}
      catch(e){res.destroy();reject(e);}
    });
    req.on('error',reject);req.end(outgoing.body);
  });
  await core.response(incoming.body,incoming.signature,outgoing.nonce);
}

export async function startTransport(core) {
  const c=core.current();await verifyLocal(c);
  let server=null,stopped=false,timer;
  if(c.mode==='hub') {
    server=http.createServer({maxHeaderSize:4096,headersTimeout:5000,requestTimeout:10_000,keepAliveTimeout:1000},exchangeHandler(core));
    server.maxConnections=8;server.maxRequestsPerSocket=1;
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(c.port,c.localIp,resolve);});
  }
  const tick=async()=>{
    if(stopped)return;
    try {
      core.current();
      if(c.mode==='spoke')await poll(core);
      await core.drain();
    } catch { /* status retains lastSeen and becomes offline; no credential/error body logging */ }
    finally {if(!stopped){timer=setTimeout(tick,5000);timer.unref();}}
  };
  timer=setTimeout(tick,0);timer.unref();
  return ()=>{stopped=true;clearTimeout(timer);server?.close();server?.closeAllConnections();};
}
