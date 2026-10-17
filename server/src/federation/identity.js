import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {networkInterfaces} from 'node:os';
import {check, tailIP} from './policy.js';
const exec = promisify(execFile);

// No shell, URLs, identity headers or user-supplied CLI arguments. The official
// CLI handles authenticated LocalAPI access on Linux and macOS GUI installs.
export async function whois(binary, ip) {
  check(tailIP(ip));
  const {stdout} = await exec(binary,['whois','--json',ip],{timeout:3000,maxBuffer:256*1024,encoding:'utf8'});
  const value = JSON.parse(stdout);
  check(typeof value.Node?.StableID === 'string');
  return value.Node.StableID;
}
export async function verifyIdentity(c, ip, lookup = whois) {
  check(ip === c.peer.ip && tailIP(ip));
  check(await lookup(c.tailscale,ip) === c.peer.nodeId);
}
export async function verifyLocal(c, lookup = whois) {
  check(Object.values(networkInterfaces()).flat().some(x=>x?.address === c.localIp && !x.internal));
  check(await lookup(c.tailscale,c.localIp) === c.nodeId);
}
