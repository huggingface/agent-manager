#!/usr/bin/env node
// Offline pairing helper. Never prints credentials; files must be transferred
// out of band by the administrator, never through AM's file or prompt APIs.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {configValid,loadConfig,privateDir,privateWrite,check,unlockDeadStore} from '../server/src/federation/policy.js';

function newCredentials(){return {key:randomBytes(32).toString('hex'),epoch:randomUUID()};}
const [command,...args]=process.argv.slice(2);
try {
  if(command==='init' && args.length===5) {
    const [dir,hubIp,hubNode,spokeIp,spokeNode]=args;
    check(path.isAbsolute(dir));fs.mkdirSync(dir,{mode:0o700});privateDir(dir);
    const credentials=newCredentials();
    const common={version:1,port:7871,tailscale:'/usr/bin/tailscale',permissions:{export:[],send:[],receive:[]}};
    const hub=configValid({...common,mode:'hub',instanceId:'vps',localIp:hubIp,nodeId:hubNode,
      peer:{id:'laptop',ip:spokeIp,nodeId:spokeNode,...credentials}});
    const spoke=configValid({...common,mode:'spoke',instanceId:'laptop',localIp:spokeIp,nodeId:spokeNode,
      peer:{id:'vps',ip:hubIp,nodeId:hubNode,...credentials}});
    privateWrite(path.join(dir,'hub.json'),hub);privateWrite(path.join(dir,'spoke.json'),spoke);
    console.log('Pair files created with deny-all permissions. See docs/federation.md before enabling.');
  } else if(command==='rotate' && args.length===2) {
    const [hubFile,spokeFile]=args,hub=loadConfig(hubFile),spoke=loadConfig(spokeFile);
    check(hub.mode==='hub' && spoke.mode==='spoke' && hub.instanceId===spoke.peer.id && spoke.instanceId===hub.peer.id);
    const credentials=newCredentials();
    // First replacement immediately invalidates the old runtime. Failure to
    // replace the second file leaves both ends unable to authenticate, safely.
    privateWrite(hubFile,{...hub,peer:{...hub.peer,...credentials}});
    privateWrite(spokeFile,{...spoke,peer:{...spoke.peer,...credentials}});
    console.log('Credentials rotated; old epoch is disabled. Install both files and restart opted-in AM processes.');
  } else if(command==='revoke' && args.length===1) {
    const c=loadConfig(args[0]);privateWrite(args[0],{...c,peer:{...c.peer,...newCredentials()}});
    console.log('Old pairing revoked locally. Pending old-epoch messages will not be replayed.');
  } else if(command==='unlock' && args.length===1) {
    unlockDeadStore(args[0]);console.log('Dead-process lock removed; no live process was interrupted.');
  } else if(command==='check' && args.length===1) {
    loadConfig(args[0]);console.log('Private configuration schema and permissions are valid; no network check performed.');
  } else {
    console.error('Usage: node scripts/federation-pair.mjs init PRIVATE_DIR HUB_IP HUB_NODE_ID SPOKE_IP SPOKE_NODE_ID\n       node scripts/federation-pair.mjs rotate HUB_FILE SPOKE_FILE\n       node scripts/federation-pair.mjs revoke CONFIG_FILE\n       node scripts/federation-pair.mjs unlock CONFIG_FILE\n       node scripts/federation-pair.mjs check CONFIG_FILE');
    process.exitCode=2;
  }
} catch {console.error('Pairing refused: check arguments, file ownership, directory permissions and configuration.');process.exitCode=1;}
