// pi stores one JSONL per session under sessions/<workspace>/.
import fsp from 'node:fs/promises';
import path from 'node:path';

export const piSessionsRoot = () => path.join(process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || '', '.pi', 'agent'), 'sessions');
export async function piTraceFiles() {
  const root = piSessionsRoot();
  let dirs = []; try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files = []; try { files = await fsp.readdir(path.join(root, d.name)); } catch { continue; }
    for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(root, d.name, f));
  }
  return out;
}
export async function findPiTrace(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id || '')) return null;
  const matches = (await piTraceFiles()).filter((p) => path.basename(p).endsWith(`_${id}.jsonl`));
  // A duplicated UUID is ambiguous; never hand another pane's file to the reader.
  return matches.length === 1 ? matches[0] : null;
}
