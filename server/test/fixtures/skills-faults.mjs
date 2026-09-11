// Test-only preload: fail one named fixture path, never production IO.
import fs from 'node:fs';
import path from 'node:path';
const file = process.env.AM_SKILLS_TEST_FAULT;
const originalRead = fs.readFileSync;
const fault = () => { try { return JSON.parse(originalRead(file, 'utf8')); } catch { return {}; } };
for (const method of ['unlinkSync', 'renameSync']) {
  const original = fs[method];
  fs[method] = (...args) => {
    const f = fault();
    const destination = method === 'renameSync' ? args[1] : args[0];
    if (f.method === method && f.path === destination && destination.startsWith(path.dirname(process.env.HOME) + '/')) {
      throw Object.assign(new Error('Fixture storage failure'), { code: 'EIO' });
    }
    return original(...args);
  };
}
