// Builds antigravity-steps.json from real agy conversation databases.
//
//   node test/fixtures/antigravity-scrub.mjs <workspace-root> <conv.db>... > test/fixtures/antigravity-steps.json
//
// Only the protobuf fields the reader uses survive (KEEP, by field number, with
// the real nesting), so signatures, config blobs, ids of the install and the
// model's request ids are dropped. Every path under <workspace-root> becomes
// @WS@, which the test replaces with its own workspace folder.
import { DatabaseSync } from 'node:sqlite';
import { pbDecode } from '../../src/antigravity.js';

const KEEP = {
  1: 1, 4: 1,
  5: { 1: { 1: 1, 2: 1 }, 4: { 1: 1, 2: 1, 3: 1 }, 9: { 2: 1, 3: 1, 5: 1 } },
  19: { 1: 1, 2: 1, 3: { 1: 1 }, 12: { 12: 1 } },
  20: { 1: 1, 3: 1, 7: { 1: 1, 2: 1, 3: 1 }, 8: 1, 16: 1 },
  24: { 3: { 1: 1, 2: 1, 3: 1 } },
  31: { 1: 1, 2: 1, 3: 1 },
  114: { 1: 1 },
  140: { 2: { 1: 1 } },
};
const [root, ...dbs] = process.argv.slice(2);
const scrub = (t) => t.split(root).join('@WS@');
function walk(buf, keep) {
  const out = [];
  for (const [f, vals] of pbDecode(buf)) {
    const k = keep[f];
    if (!k) continue;
    for (const v of vals) {
      if (typeof v === 'number') out.push([f, v]);
      else if (k === 1) out.push([f, scrub(v.toString('utf8'))]);
      else out.push([f, walk(v, k)]);
    }
  }
  return out;
}
const conversations = dbs.map((p) => {
  const db = new DatabaseSync(p, { readOnly: true });
  const steps = db.prepare('select idx, step_type, status, step_payload from steps order by idx').all()
    .map((r) => ({ idx: r.idx, step_type: r.step_type, status: r.status, payload: walk(Buffer.from(r.step_payload), KEEP) }));
  db.close();
  return { steps };
});
process.stdout.write(`${JSON.stringify({ agy: '1.4.10', conversations }, null, 1)}\n`);
