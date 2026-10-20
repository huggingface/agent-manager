import { withDurableIntent } from './durableIntent';

// Retain only a content fingerprint and UUID until creation is acknowledged.
export function withCreationIntent<T>(payload: unknown, send: (requestId: string) => Promise<T>): Promise<T> {
  return withDurableIntent('am-codex-create', payload, send);
}
