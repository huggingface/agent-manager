import fs from 'node:fs';
import path from 'node:path';

// fx holds its event log open for the conversation's lifetime. On Linux that
// gives us an exact owner even when several panes share the same workspace.
export function fxSessionForPid(pid, root = path.join(process.env.HOME || '', '.fx', 'sessions')) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { root = fs.realpathSync(root); } catch { return null; }
  const fromFds = (owner) => {
    const ids = new Set();
    let fds;
    try { fds = fs.readdirSync(`/proc/${owner}/fd`); } catch { return null; }
    for (const fd of fds.slice(0, 512)) {
      let target;
      try { target = fs.readlinkSync(`/proc/${owner}/fd/${fd}`); } catch { continue; }
      const rel = path.relative(root, target).split(path.sep);
      if (rel.length === 2 && rel[1] === 'events.jsonl'
          && /^[A-Za-z0-9._-]{1,255}$/.test(rel[0]) && !['.', '..'].includes(rel[0])) ids.add(rel[0]);
    }
    return ids.size === 1 ? { id: [...ids][0] } : null;
  };
  const own = fromFds(pid);
  if (own) return own;
  // The --continue fallback can leave a shell waiting for fx. Only inspect its
  // direct fx child, never a tool/subagent spawned by an already-running fx.
  try {
    if (!['bash', 'sh', 'dash'].includes(fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim())) return null;
    const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
    const hits = children.flatMap((child) => {
      try {
        if (fs.readFileSync(`/proc/${child}/comm`, 'utf8').trim() !== 'fx') return [];
        const hit = fromFds(child);
        return hit ? [hit] : [];
      } catch { return []; }
    });
    return hits.length === 1 ? hits[0] : null;
  } catch { return null; }
}
