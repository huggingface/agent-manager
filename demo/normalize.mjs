// Runs the raw rollout through the PRODUCTION normalizer and writes what the
// demo serves. This is the point of the two files: the demo is fed what the
// server feeds the reader, so the envelope filtering under test is the real
// one rather than something the fixture pre-applied.
//
//   session.raw.jsonl  — a synthetic Codex rollout, the harness's own format
//   session.jsonl      — the normalized result: one reader turn per line,
//                        exactly the objects a trace window's `turns` holds
//                        ({ id, role, ts, kind?, blocks: [...] })
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTraceByPath } from '../server/src/traces.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const raw = path.join(HERE, 'session.raw.jsonl');
const out = path.join(HERE, 'session.jsonl');

// One v2 reader window over the whole file: the same code path a cold reader's
// request takes, so ids, final marking and envelope filtering are all the
// server's own.
const page = await readTraceByPath(raw, {
  window: { at: 'tail', cursor: 0, bytes: 8 * 1024 * 1024, min: 1_000_000, version: 2 },
});
const turns = page.turns || [];
if (!turns.length) throw new Error('the normalizer returned nothing — is the rollout shape still right?');
if (!page.window?.atStart) throw new Error('the window did not reach the start of the file');

const roles = turns.reduce((n, t) => ({ ...n, [t.role]: (n[t.role] || 0) + 1 }), {});
const leaked = turns.filter((t) => t.role === 'user' && t.blocks.some((b) =>
  b.type === 'text' && (/^#\s*AGENTS\.md instructions/.test(b.text) || b.text.startsWith('<environment_context>'))));
if (leaked.length) {
  throw new Error(`${leaked.length} injected envelope(s) survived as user turns — the normalizer did not filter them`);
}
fs.writeFileSync(out, turns.map((t) => JSON.stringify(t)).join('\n') + '\n');
console.log(`${out}: ${turns.length} normalized turns (${JSON.stringify(roles)}), ${fs.statSync(out).size} bytes`);
