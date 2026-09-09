import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fxSessionForPid } from '../src/fx-process.js';

if (process.platform !== 'linux') {
  console.log('fx-process: skipped (Linux /proc required)');
  process.exit(0);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-process-'));
const root = path.join(tmp, 'sessions');
const children = [];
try {
  // Real concurrent processes in one cwd, each holding its own session lock.
  for (const id of ['session-a', 'session-b']) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    const child = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      const fd = fs.openSync(process.argv[1], 'a');
      process.stdout.write('ready\\n');
      setInterval(() => fs.fsyncSync(fd), 1000);
    `, path.join(dir, 'session.lock')], { cwd: tmp, stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    await once(child.stdout, 'data');
  }
  assert.equal(fxSessionForPid(children[0].pid, root)?.id, 'session-a');
  assert.equal(fxSessionForPid(children[1].pid, root)?.id, 'session-b');
  const link = path.join(tmp, 'linked-sessions');
  fs.symlinkSync(root, link);
  assert.equal(fxSessionForPid(children[0].pid, link)?.id, 'session-a');
  assert.equal(fxSessionForPid(children[0].pid, path.join(tmp, 'other')), null);
  assert.equal(fxSessionForPid(-1, root), null);
  const exited = once(children[0], 'exit');
  children[0].kill();
  await exited;
  assert.equal(fxSessionForPid(children[0].pid, root), null);
  assert.equal(fxSessionForPid(children[1].pid, root)?.id, 'session-b');
  console.log('fx-process: concurrent ownership, symlinks and process exit passed');
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
