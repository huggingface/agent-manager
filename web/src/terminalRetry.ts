// Upgrade refusals are reported as 1006 by browser WebSocket APIs. Bound the
// retries without attempting a mutation or discarding the terminal/Reader state.
// Only failures while the server answers are charged here: an outage (nothing
// answers at all) is waited out through lib/serverReach instead.
export function terminalRetryDelay(failures: number, closeCode: number): number | null {
  if (closeCode === 1008 || failures >= 5) return null;
  return Math.min(1200 * 1.7 ** Math.max(0, failures - 1), 15_000);
}
