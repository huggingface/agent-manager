// The fixture server must own its port before it seeds anything. With the port
// already taken, the spawned child dies of EADDRINUSE while the OTHER listener
// answers every probe — so a helper that trusts /api/health would write its
// fixture fleet into someone else's instance and measure someone else's build.
// This holds a stub on the port, asks the helper to start there, and requires
// a rejection with zero writes to the stub. Run with:  node test/fixtureServer.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { startFixtureServer } from './helpers/fixture-server.mjs';

const PORT = 7909;
const hits = [];
const stub = http.createServer((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  res.setHeader('content-type', 'application/json');
  // Answers like a healthy server that belongs to somebody else.
  res.end(JSON.stringify({ ok: true, dataDir: '/somebody/elses/data', id: 'x' }));
});
await new Promise((r) => stub.listen(PORT, '127.0.0.1', r));

let failed = 0;
const check = (what, ok, detail = '') => { console.log(`  ${ok ? 'ok ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`); if (!ok) failed++; };
try {
  const outcome = await startFixtureServer({ port: PORT, publicDir: '/nonexistent', tag: 'am-occupied-' })
    .then((s) => ({ started: s }), (e) => ({ error: e }));
  check('starting on an occupied port is rejected', !!outcome.error, outcome.error ? outcome.error.message.split('\n')[0] : 'resolved');
  if (outcome.started) await outcome.started.stop();
  const writes = hits.filter((h) => !h.startsWith('GET '));
  check('the other listener received no fixture writes', writes.length === 0, writes.slice(0, 3).join(', '));
  check('…and was not even probed for readiness', hits.length === 0, hits.slice(0, 3).join(', '));
} finally {
  stub.close();
}
console.log(failed ? `\n${failed} failed` : '\nfixture-server: ok');
process.exit(failed ? 1 : 0);
