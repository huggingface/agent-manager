// A TCP port nothing is listening on, from the kernel, for a suite's own server.
//
// Fixed port constants (7889, 7893, …) made every server suite a hazard to run
// beside another: two suites that picked the same number — or the same suite in
// two checkouts on one machine — collide, and the loser reads as a product bug.
// The kernel's ephemeral allocator does not hand the same port out again soon,
// so the gap between closing this probe and the server binding it is safe in
// practice, and it is what lets scripts/run-suites.mjs run suites in parallel.
import net from 'node:net';

export function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
