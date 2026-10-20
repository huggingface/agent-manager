// Imported first by main.tsx: ES modules run in import order, so this cleans
// the address before any other module reads `location` at load time. The edge
// has already set its session cookie by the time this document loads, so a
// reload of the cleaned address still authenticates.
import { stripForeignParams } from './lib/appUrl';

// Never log the address itself: the parameters being removed may be secrets.
// Links stay clean either way; they are built from the allowlist, not the address.
try {
  if (!stripForeignParams()) console.warn('[boot] could not remove foreign query parameters from the address');
} catch (err) {
  console.warn('[boot] could not remove foreign query parameters from the address:', err instanceof Error ? err.name : 'error');
}
