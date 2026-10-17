import fs from 'node:fs';
import path from 'node:path';
import {createHash, createHmac, timingSafeEqual, randomUUID} from 'node:crypto';
import {isIPv4} from 'node:net';

export const MAX_BODY = 256 * 1024;
export const TTL = 24 * 60 * 60 * 1000;
export const WINDOW = 30_000;
export const id = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
export const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
export const tailIP = v => isIPv4(v) && v.split('.')[0] === '100' && +v.split('.')[1] >= 64 && +v.split('.')[1] <= 127;
export const hash = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
export function check(ok) { if (!ok) throw new Error('federation-refused'); }
export function shape(v, keys) {
  check(v !== null && typeof v === 'object' && !Array.isArray(v));
  check(Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)));
}
export const short = (v, n) => typeof v === 'string' && Buffer.byteLength(v) <= n && !/[\x00-\x1f\x7f]/.test(v);
export function configValid(c) {
  shape(c, ['version','mode','instanceId','localIp','nodeId','port','tailscale','peer','permissions']);
  check(c.version === 1 && ['hub','spoke'].includes(c.mode) && id(c.instanceId));
  check(tailIP(c.localIp) && id(c.nodeId) && Number.isInteger(c.port) && c.port >= 1024 && c.port <= 65535);
  check(typeof c.tailscale === 'string' && path.isAbsolute(c.tailscale));
  shape(c.peer, ['id','ip','nodeId','key','epoch']);
  check(id(c.peer.id) && c.peer.id !== c.instanceId && tailIP(c.peer.ip) && c.peer.ip !== c.localIp && id(c.peer.nodeId));
  check(typeof c.peer.key === 'string' && /^[0-9a-f]{64}$/.test(c.peer.key) && uuid(c.peer.epoch));
  shape(c.permissions, ['export','send','receive']);
  check(Array.isArray(c.permissions.export) && c.permissions.export.length <= 50);
  for (const item of c.permissions.export) { shape(item, ['id','summary']); check(id(item.id) && short(item.summary, 300)); }
  check(new Set(c.permissions.export.map(x=>x.id)).size === c.permissions.export.length);
  for (const name of ['send','receive']) {
    check(Array.isArray(c.permissions[name]) && c.permissions[name].length <= 100);
    for (const item of c.permissions[name]) {shape(item,['from','to']); check(id(item.from) && id(item.to));}
  }
  return c;
}
export const allowed = (c, direction, from, to) => c.permissions[direction].some(r => r.from === from && r.to === to);
export function messageValid(m, now) {
  shape(m,['id','from','to','text','createdAt']);
  check(uuid(m.id) && id(m.from) && id(m.to));
  check(typeof m.text === 'string' && m.text.trim().length > 0 && Buffer.byteLength(m.text) <= 8192 && !m.text.includes('\0'));
  check(Number.isSafeInteger(m.createdAt) && m.createdAt <= now + WINDOW && m.createdAt >= now - TTL);
}
export const TERMINAL = ['accepted','uncertain','rejected','expired'];
export function payloadValid(p, now) {
  shape(p,['roster','messages','receipts']);
  check(Array.isArray(p.roster) && p.roster.length <= 50);
  const ids = new Set();
  for (const r of p.roster) {
    shape(r,['id','name','cli','state','lastActivityAt','summary','receives']);
    check(id(r.id) && !ids.has(r.id) && short(r.name,200) && id(r.cli) && short(r.summary,300)); ids.add(r.id);
    check(['working','waiting','idle','stopped','unknown'].includes(r.state) && typeof r.receives === 'boolean');
    check(r.lastActivityAt === null || (typeof r.lastActivityAt === 'string' && Number.isFinite(Date.parse(r.lastActivityAt))));
  }
  check(Array.isArray(p.messages) && p.messages.length <= 4);
  for (const m of p.messages) messageValid(m, now);
  check(Array.isArray(p.receipts) && p.receipts.length <= 1000);
  for (const r of p.receipts) {shape(r,['id','hash','status']); check(uuid(r.id) && /^[0-9a-f]{64}$/.test(r.hash) && TERMINAL.includes(r.status));}
}
export function envelope(c, payload, nonce, now) {
  return JSON.stringify({version:1,from:c.instanceId,to:c.peer.id,epoch:c.peer.epoch,nonce,time:now,payload});
}
export function decode(c, raw, now, expectedNonce) {
  check(Buffer.byteLength(raw) <= MAX_BODY);
  const e = JSON.parse(raw);
  shape(e,['version','from','to','epoch','nonce','time','payload']);
  check(e.version === 1 && e.from === c.peer.id && e.to === c.instanceId && e.epoch === c.peer.epoch);
  check(uuid(e.nonce) && (!expectedNonce || e.nonce === expectedNonce) && Number.isSafeInteger(e.time) && Math.abs(now-e.time) <= WINDOW);
  payloadValid(e.payload, now);
  return e;
}
export const mac = (key, direction, body) => createHmac('sha256',Buffer.from(key,'hex')).update(direction+'\n'+body).digest('hex');
export function verifyMac(key, direction, body, signature) {
  check(typeof signature === 'string' && /^[0-9a-f]{64}$/.test(signature));
  check(timingSafeEqual(Buffer.from(mac(key,direction,body),'hex'),Buffer.from(signature,'hex')));
}
export function privateDir(dir) {
  const s = fs.lstatSync(dir);
  check(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o077) === 0);
  check(fs.realpathSync(dir) === path.resolve(dir));
}
export function privateRead(file, max = 24 * 1024 * 1024) {
  privateDir(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    check(s.isFile() && s.uid === process.getuid() && (s.mode & 0o077) === 0 && s.size <= max);
    return fs.readFileSync(fd,'utf8');
  } finally {fs.closeSync(fd);}
}
export function privateWrite(file, value) {
  privateDir(path.dirname(file));
  const temp = file+'.'+randomUUID()+'.tmp';
  let fd;
  try {
    fd = fs.openSync(temp,'wx',0o600); fs.writeFileSync(fd,JSON.stringify(value)+'\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd=undefined;
    fs.renameSync(temp,file);
    fd=fs.openSync(path.dirname(file),'r'); fs.fsyncSync(fd);
  } finally {if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch{}}
}
export function loadConfig(file) {return configValid(JSON.parse(privateRead(file,64*1024)));}

// Exclusive process ownership: two AMs must never dispatch from one journal.
// A crashed process leaves a lock for explicit, PID-checked administrative
// cleanup. There is deliberately no racy automatic stale-lock takeover.
export function claimStore(dir) {
  privateDir(dir);
  const file=path.join(dir,'runtime.lock'),owner={pid:process.pid,nonce:randomUUID()};
  const fd=fs.openSync(file,'wx',0o600);
  try {fs.writeFileSync(fd,JSON.stringify(owner));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  return ()=>{
    const current=JSON.parse(privateRead(file,1024));
    check(current.pid===owner.pid && current.nonce===owner.nonce);fs.unlinkSync(file);
  };
}
export function unlockDeadStore(configFile) {
  loadConfig(configFile);
  const file=path.join(path.dirname(configFile),'runtime.lock');
  const raw=privateRead(file,1024),owner=JSON.parse(raw);
  check(Number.isSafeInteger(owner.pid) && owner.pid>0 && uuid(owner.nonce));
  let dead=false;try{process.kill(owner.pid,0);}catch(e){dead=e.code==='ESRCH';}
  check(dead && privateRead(file,1024)===raw);fs.unlinkSync(file);
}
