import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class SkillError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const conflict = (message) => { throw new SkillError(409, message); };
const hash = (content) => createHash('sha256').update(content).digest('hex');
const digest = (value) => value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
const below = (root, file) => file.startsWith(root + path.sep);

// Keep the old filename -> slug mapping, but never substitute an empty fallback.
export function skillId(filename) {
  if (typeof filename !== 'string' || !/^[\w.\- ]{1,80}$/.test(filename)
      || filename.includes('..')) throw new SkillError(400, 'Invalid skill filename');
  const id = filename.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40);
  if (!id) throw new SkillError(400, 'Skill filename must contain a letter or number');
  return id;
}

export function generatedSkill(filename, content) {
  const id = skillId(filename);
  let body = content, desc = '';
  const fm = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    const d = fm[1].match(/^description:\s*(.+)$/m);
    if (d) desc = d[1].trim().replace(/^["']|["']$/g, '');
    body = fm[2];
  }
  if (!desc) desc = (body.match(/^#+\s*(.+)$/m)?.[1] || body.split('\n').find((l) => l.trim()) || id).trim();
  desc = desc.replace(/\s+/g, ' ').slice(0, 300).replace(/"/g, '\\"');
  return `---\nname: ${id}\ndescription: "${desc}"\n---\n\n${body.trim()}\n`;
}

export function skillTargetDirs(env = process.env) {
  if (!env.SPACE_ID && env.AM_DISTRIBUTE_SKILLS !== '1') return [];
  const home = env.HOME || os.homedir();
  const dirs = [path.join(home, '.agents', 'skills'), path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills'), path.join(home, '.hermes', 'skills')];
  for (const home of [env.GEMINI_CLI_HOME, env.OPENCLAW_HOME]) if (home) dirs.push(path.join(home, '.agents', 'skills'));
  return dirs;
}

// One instance per manager. Every caller (including reads and boot) goes through
// its queue. Injectable sync IO keeps fault tests deterministic; no awaited gap
// exists between preflight and publication within a process.
export function createSkillsService({ sourceRoot, stateRoot, targetRoots = [], io = fs, nonce = randomUUID }) {
  let queue = Promise.resolve();
  const serial = (fn) => (...args) => {
    const result = queue.then(() => fn(...args));
    queue = result.catch(() => {});
    return result;
  };
  const stat = (p) => { try { return io.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  // Resolve configured aliases, including a not-yet-created suffix, without
  // creating anything. Dangling configured symlinks are errors, not missing dirs.
  function canonical(p) {
    p = path.resolve(p);
    if (stat(p)) return io.realpathSync(p);
    const parent = path.dirname(p);
    if (parent === p) throw new Error('Cannot resolve skills root');
    return path.join(canonical(parent), path.basename(p));
  }
  // Lazy resolution lets a bad skill root degrade skills, not server startup.
  let roots;
  function config() {
    if (!roots) {
      const source = canonical(sourceRoot), state = canonical(stateRoot);
      const targets = [...new Set(targetRoots.map(canonical))].sort();
      const all = [source, state, ...targets];
      if (all.some((a, i) => all.some((b, j) => i !== j && (a === b || below(a, b))))) {
        throw new SkillError(409, 'Skills source, state and destination roots must not overlap');
      }
      roots = { source, state, targets };
    }
    return roots;
  }
  function checkRoot(root) {
    if (canonical(root) !== root) conflict('Skills root changed; restore its configured location');
    const s = stat(root);
    if (s && !s.isDirectory()) conflict('Skills root is not a directory');
  }
  function entry(root, file) {
    checkRoot(root);
    if (!below(root, file)) conflict('Invalid managed file path');
    const parts = path.relative(root, file).split(path.sep);
    let p = root;
    for (const [i, part] of parts.entries()) {
      p = path.join(p, part);
      const s = stat(p);
      if (s?.isSymbolicLink()) conflict('Symlink at managed skill entry');
      if (s && i < parts.length - 1 && !s.isDirectory()) conflict('Managed skill parent is not a directory');
      if (s && i === parts.length - 1 && !s.isFile()) conflict('Managed skill entry is not a regular file');
    }
    return stat(file);
  }
  function read(root, file) { return entry(root, file) ? io.readFileSync(file, 'utf8') : null; }
  function current(root, file) { return entry(root, file) ? hash(io.readFileSync(file)) : null; }
  function mkdir(root, dir = root) {
    checkRoot(root);
    io.mkdirSync(root, { recursive: true });
    if (dir !== root) {
      if (!below(root, dir) || path.dirname(dir) !== root) conflict('Invalid skill directory');
      const s = stat(dir);
      if (s && (s.isSymbolicLink() || !s.isDirectory())) conflict('Invalid skill directory');
      if (!s) io.mkdirSync(dir);
    }
  }
  function atomic(root, file, content, expected) {
    entry(root, file);
    mkdir(root, path.dirname(file));
    const temp = path.join(path.dirname(file), `.am-skill-${nonce()}.tmp`);
    let fd, owned = false, inode;
    try {
      fd = io.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      owned = true;
      inode = io.fstatSync(fd).ino;
      io.writeFileSync(fd, content, 'utf8');
      io.fsyncSync(fd);
      io.closeSync(fd); fd = undefined;
      if (current(root, file) !== expected) conflict('Skill file changed before publication');
      const ts = stat(temp);
      if (!ts?.isFile() || ts.isSymbolicLink() || ts.ino !== inode) conflict('Skill temporary file changed');
      // Bucket-backed roots need rename (hard links are not generally supported).
      // The queue + immediate revision check protect manager operations; this
      // is not a renameat2/OS sandbox against hostile same-user races.
      io.renameSync(temp, file); owned = false;
    } finally {
      if (fd !== undefined) io.closeSync(fd);
      // Never clean a pre-existing or substituted temp entry.
      const s = owned ? stat(temp) : null;
      if (s?.isFile() && !s.isSymbolicLink() && s.ino === inode) io.unlinkSync(temp);
    }
  }
  const manifestPath = () => path.join(config().state, 'skills-v1.json');
  function load() {
    const { state } = config();
    const bytes = read(state, manifestPath());
    if (bytes === null) return { version: 1, sourceRoot: config().source, disabledGenerated: [], skills: Object.create(null) };
    try {
      const m = JSON.parse(bytes);
      if (m.version !== 1 || m.sourceRoot !== config().source || !m.skills || Array.isArray(m.skills) || typeof m.skills !== 'object') throw new Error();
      if (!Array.isArray(m.disabledGenerated) || m.disabledGenerated.some((name) => { try { skillId(name); return false; } catch { return true; } })) throw new Error();
      const ids = new Set();
      for (const [name, r] of Object.entries(m.skills)) {
        if (typeof r.instance !== 'string' || !r.instance || r.id !== skillId(name) || ids.has(r.id) || !digest(r.sourceHash) || !Array.isArray(r.targets)) throw new Error();
        ids.add(r.id);
        const seen = new Set();
        for (const t of r.targets) {
          if (typeof t.root !== 'string' || t.path !== path.join(t.root, r.id, 'SKILL.md')
              || !path.isAbsolute(t.root) || !digest(t.hash) || typeof t.dirOwned !== 'boolean' || seen.has(t.root)) throw new Error();
          seen.add(t.root);
        }
        if (r.pending && (!['write', 'delete'].includes(r.pending.kind) || typeof r.pending.id !== 'string'
            || (r.pending.kind === 'write' && (!r.pending.sourceHash || !digest(r.pending.sourceHash) || !r.pending.targetHash || !digest(r.pending.targetHash))))) throw new Error();
      }
      Object.setPrototypeOf(m.skills, null);
      return m;
    } catch { throw new SkillError(503, 'Invalid ownership manifest; skills mutations are disabled until it is repaired'); }
  }
  function persist(m) {
    const { state } = config();
    atomic(state, manifestPath(), JSON.stringify(m, null, 2) + '\n', current(state, manifestPath()));
  }
  function names(m) {
    const { source } = config(); checkRoot(source);
    return [...new Set([...(stat(source) ? io.readdirSync(source).filter((n) => !n.startsWith('.am-skill-')) : []), ...Object.keys(m.skills)])];
  }
  function identity(name, m) {
    const id = skillId(name);
    for (const other of names(m)) {
      if (other === name) continue;
      let otherId; try { otherId = skillId(other); } catch { continue; }
      if (other.toLowerCase() === name.toLowerCase() || otherId === id) conflict(`Skill name conflicts with ${other}; choose a different name or open the existing skill`);
    }
    return id;
  }
  function targetsValid(r) {
    const allowed = config().targets;
    for (const t of r.targets) {
      if (!allowed.includes(t.root) || canonical(t.root) !== t.root) conflict('Recorded destination is no longer configured; restore the target configuration before retrying');
      entry(t.root, t.path);
    }
  }
  function snapshot(name, m) {
    const { source, targets } = config();
    skillId(name);
    const content = read(source, path.join(source, name));
    const record = m.skills[name];
    if (content === null && !record) throw new SkillError(404, 'Skill not found; no owned installation was removed');
    const installed = (record?.targets || []).map((t) => {
      let observed, error;
      try {
        if (!targets.includes(t.root)) conflict('Destination is no longer configured');
        observed = current(t.root, t.path);
      } catch (e) { error = e.message; }
      return { path: t.path, hash: observed, ...(error ? { error } : {}) };
    });
    const revision = hash(JSON.stringify({ name, contentHash: content === null ? null : hash(content), record, installed, targets }));
    let problem;
    try {
      identity(name, m);
      if (record) verified(record, name, { deleting: record.pending?.kind === 'delete' });
      else problem = 'Ownership is not established. Resolve the name or installation conflict and restart distribution; existing installations are untouched.';
    } catch (e) { problem = e.message; }
    return { name, content: content ?? '', sourceExists: content !== null, revision, ...(problem ? { problem } : {}),
      managed: !!record, pending: record?.pending?.kind || null,
      installations: installed.map(({ path, hash, error }) => ({ path, exists: hash !== null && hash !== undefined, ...(error ? { error } : {}) })) };
  }
  function match(name, m, revision) {
    if (!revision) throw new SkillError(428, 'A current skill revision is required');
    if (snapshot(name, m).revision !== revision) conflict('Skill or installations changed; refresh before saving or confirming deletion');
  }
  function verified(r, name, { deleting = false } = {}) {
    const { source } = config();
    targetsValid(r);
    const src = current(source, path.join(source, name));
    if (src !== r.sourceHash && src !== r.pending?.sourceHash && !(deleting && src === null)) conflict('Source was modified outside the manager');
    for (const t of r.targets) {
      const actual = current(t.root, t.path);
      if (actual !== t.hash && actual !== r.pending?.targetHash && actual !== null) conflict(`Installed file was modified outside the manager: ${t.path}`);
      // A file that was never owned cannot be claimed simply because it appeared.
      if (t.hash === null && actual !== null && actual !== r.pending?.targetHash) conflict(`Unowned installation: ${t.path}`);
    }
  }
  function targetPlan(r, id, expected, adopt) {
    targetsValid(r);
    const result = [...r.targets];
    for (const root of config().targets) {
      if (result.some((t) => t.root === root)) continue;
      const file = path.join(root, id, 'SKILL.md');
      const actual = current(root, file);
      if (actual !== null && (!adopt || actual !== expected)) conflict(`Unowned installation at ${file}; choose another name or resolve it outside the manager`);
      result.push({ root, path: file, hash: actual, dirOwned: !stat(path.dirname(file)) });
    }
    return result;
  }
  function outcome(name, source, targets, manifest, error) {
    let skill;
    try { skill = snapshot(name, load()); } catch { /* missing or inaccessible */ }
    const ok = !error && manifest === 'persisted' && targets.every((t) => !t.error);
    return { ok, status: ok ? 'complete' : 'partial', source, targets, manifest, ...(error ? { error } : {}), skill: skill || null };
  }
  function finishWrite(name, content, m) {
    const { source } = config(), r = m.skills[name], pending = r.pending;
    if (hash(content) !== pending.sourceHash) conflict('An incomplete save must be retried with the same content');
    verified(r, name);
    const file = path.join(source, name), results = [];
    let sourceStatus = 'unchanged';
    try {
      const actual = current(source, file);
      if (actual !== pending.sourceHash) atomic(source, file, content, actual);
      sourceStatus = 'persisted';
    } catch (e) { return outcome(name, 'failed', r.targets.map((t) => ({ path: t.path, status: 'not-attempted' })), 'persisted', e.message); }
    const generated = generatedSkill(name, content);
    for (const t of r.targets) {
      try {
        const actual = current(t.root, t.path);
        if (actual !== pending.targetHash) atomic(t.root, t.path, generated, actual);
        results.push({ path: t.path, status: 'installed' });
      } catch (e) { results.push({ path: t.path, status: 'failed', error: e.message }); }
    }
    if (results.some((t) => t.error)) return outcome(name, sourceStatus, results, 'persisted', 'Some installations failed; retry this save');
    r.sourceHash = pending.sourceHash;
    for (const t of r.targets) t.hash = pending.targetHash;
    delete r.pending;
    try { persist(m); } catch (e) { return outcome(name, sourceStatus, results, 'failed', e.message); }
    return outcome(name, sourceStatus, results, 'persisted');
  }
  function write(name, content, { create = false, revision, boot = false, generated = false } = {}) {
    if (typeof content !== 'string') throw new SkillError(400, 'Skill content must be text');
    const m = load(), id = identity(name, m), { source } = config();
    const existing = read(source, path.join(source, name));
    let r = m.skills[name];
    if (create && (r || existing !== null)) conflict('Skill already exists; choose a different name or open the existing skill');
    if (!create && !boot) match(name, m, revision);
    if (r?.pending?.kind === 'delete') conflict('Deletion is pending; retry deletion before creating this skill again');
    if (r?.pending?.kind === 'write') return finishWrite(name, content, m);
    if (r) verified(r, name);
    else {
      if (!create && !boot) conflict('Skill is not managed; refresh after startup adoption or resolve its installation conflict');
      r = { id, instance: nonce(), sourceHash: existing === null ? null : hash(existing), targets: [] };
    }
    // Legacy adoption is checked against the CURRENT source, including for the
    // generated environment skill, before any newly generated text is written.
    r.targets = targetPlan(r, id, hash(generatedSkill(name, existing ?? content)), boot && existing !== null);
    r.generated = r.generated || generated;
    r.pending = { kind: 'write', id: nonce(), sourceHash: hash(content), targetHash: hash(generatedSkill(name, content)) };
    m.skills[name] = r;
    if (create) m.disabledGenerated = m.disabledGenerated.filter((n) => n !== name);
    persist(m); // intent first; a failure here must change no skill bytes
    return finishWrite(name, content, m);
  }
  function remove(name, revision) {
    const m = load(); identity(name, m); match(name, m, revision);
    const r = m.skills[name];
    if (!r) throw new SkillError(404, 'No ownership record; no installed files were removed');
    if (r.pending?.kind === 'write') conflict('A save is incomplete; retry it before deleting');
    verified(r, name, { deleting: true });
    if (!r.pending) {
      r.pending = { kind: 'delete', id: nonce() };
      persist(m); // exact frozen target set; boot must never republish this source
    }
    const results = [];
    for (const t of r.targets) {
      try {
        const actual = current(t.root, t.path);
        if (actual !== null) {
          if (actual !== t.hash) conflict('Installed file changed during deletion');
          io.unlinkSync(t.path);
        }
        results.push({ path: t.path, status: actual === null ? 'absent' : 'removed' });
        // Only directories we created, only when empty. Extra files always stay.
        if (t.dirOwned) {
          const dir = path.dirname(t.path);
          try { io.rmdirSync(dir); } catch (e) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) results[results.length - 1].directoryError = e.message; }
        }
      } catch (e) { results.push({ path: t.path, status: 'failed', error: e.message }); }
    }
    if (results.some((t) => t.error)) return outcome(name, 'retained', results, 'persisted', 'Deletion is incomplete; only the remaining confirmed installations will be retried');
    const { source } = config(), file = path.join(source, name);
    try {
      const actual = current(source, file);
      if (actual !== null) {
        if (actual !== r.sourceHash) conflict('Source changed during deletion');
        io.unlinkSync(file);
      }
    } catch (e) { return outcome(name, 'failed', results, 'persisted', e.message); }
    delete m.skills[name];
    if (r.generated && !m.disabledGenerated.includes(name)) m.disabledGenerated.push(name);
    try { persist(m); } catch (e) { return outcome(name, 'removed', results, 'failed', e.message); }
    return outcome(name, 'removed', results, 'persisted');
  }
  function redistribute() {
    const results = [];
    let m;
    try { m = load(); } catch (e) { return { ok: false, error: e.message, results }; }
    let all;
    try { all = names(m); } catch (e) { return { ok: false, error: e.message, results }; }
    for (const name of all) {
      try {
        if (m.skills[name]?.pending?.kind === 'delete') { results.push({ name, ok: false, error: 'Deletion pending; explicit retry required' }); continue; }
        const content = read(config().source, path.join(config().source, name));
        if (content === null) throw new SkillError(409, 'Source missing; existing installations were retained');
        results.push({ name, ...write(name, content, { boot: true }) });
      } catch (e) { results.push({ name, ok: false, error: e.message }); }
    }
    return { ok: results.every((r) => r.ok), results };
  }
  return {
    list: serial(() => { const m = load(); return names(m).map((name) => {
      try { const s = snapshot(name, m); return { name, size: Buffer.byteLength(s.content), pending: s.pending }; }
      catch (e) { return { name, size: 0, error: e.message }; }
    }).sort((a, b) => a.name.localeCompare(b.name)); }),
    get: serial((name) => snapshot(name, load())),
    create: serial((name, content) => write(name, content, { create: true })),
    update: serial((name, content, revision) => write(name, content, { revision })),
    remove: serial(remove),
    redistribute: serial(redistribute),
    generate: serial((name, content) => {
      skillId(name);
      if (load().disabledGenerated.includes(name)) return { ok: true, status: 'complete', source: 'generation-disabled', targets: [], manifest: 'persisted', skill: null };
      return write(name, content, { boot: true, generated: true });
    }),
  };
}
