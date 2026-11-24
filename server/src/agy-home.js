// Antigravity runs with its own HOME on local disk.
//
// agy has no config-dir override: it keeps everything, SQLite included, under
// $HOME/.gemini/{antigravity-cli,config}. HOME is /data/home, on the bucket,
// and SQLite on hf-mount corrupts (its fsync is not durable). Until #250 the
// entrypoint linked those two folders to local disk, but a link ON the bucket
// does not stay put: from 2026-11-20 both were real directories on hf-mount
// again, four conversations came back malformed, and the link restored by hand
// on 11-24 was gone again within minutes. agy re-creates a missing one as a
// real directory at its next start.
//
// So AM's agy never resolves its state through the bucket at all. It is
// launched with HOME=$AGY_HOME ($AM_LOCAL/agy-home), a directory on local disk:
//
//   $AGY_HOME/.gemini/antigravity-cli -> $ANTIGRAVITY_LIVE/antigravity-cli
//   $AGY_HOME/.gemini/config          -> $ANTIGRAVITY_LIVE/config
//   $AGY_HOME/<every other entry of /data/home>        -> /data/home/<entry>
//   $AGY_HOME/.gemini/<every other entry of ~/.gemini> -> /data/home/.gemini/<entry>
//
// All of these links live on local disk, which keeps them. Linking EVERY other
// entry (not a hand-picked list) is what keeps agy's tool calls working like
// any other pane: git (.gitconfig, .ssh), gh (.config/gh), the HF token
// (.cache/huggingface), npm/pip/uv config, skills (.agents, ~/.gemini extras),
// shell rc files and whatever an operator adds later. Writes through a link go
// to the bucket exactly as they would with HOME=/data/home. Only a NEW
// top-level file created in ~ from inside agy stays on local disk (a restart
// loses it); `cd ~` lands in $AGY_HOME, whose listing matches /data/home.
//
// Idempotent and cheap (one readdir of each HOME level, an lstat per entry):
// run at server start and before every agy launch. An entry agy or a tool
// created in $AGY_HOME itself is never replaced. A LINKED entry that a save by
// rename (sed -i, an editor, a temp+rename write) turned into a local file is
// put back: the newer side wins on the bucket, the local copy is kept under
// $AM_LOCAL/agy-home-replaced/, a bucket version it overwrites is kept there
// AND under /data/home/.agy-home-replaced/, the link is made again, and it is
// reported (`restored`, logged and shown by state-links.js). A folder is put
// back in the background, off the launch path.
import fs from 'node:fs';
import path from 'node:path';

/** $AGY_HOME, or null where Antigravity's state is not kept on local disk (a local run, tests). */
export function agyHomeDir(env = process.env) {
  if (env.AGY_HOME) return env.AGY_HOME;
  return env.ANTIGRAVITY_LIVE && env.AM_LOCAL ? path.join(env.AM_LOCAL, 'agy-home') : null;
}

// The two folders agy keeps its state in; never linked to the bucket.
const STATE = ['antigravity-cli', 'config'];
// The bucket's own copies and rollback folders of those two.
const isStateCopy = (name) => STATE.some((s) => name === s || name.startsWith(`${s}.`));
// On the bucket HOME: the bucket's versions of dotfiles a reconcile overwrote.
export const DURABLE_ASIDE = '.agy-home-replaced';

const newer = (a, b) => a.mtimeMs > b.mtimeMs + 1; // 1 ms: copies keep mtime to the ms
const fsp = fs.promises;

// Copy src over dst through a temp file beside dst, keeping mode and times.
async function copyFileOver(src, dst) {
  const tmp = `${dst}.agy-home-${process.pid}.tmp`;
  await fsp.copyFile(src, tmp);
  const st = await fsp.stat(src);
  await fsp.chmod(tmp, st.mode & 0o7777);
  await fsp.utimes(tmp, st.atime, st.mtime);
  await fsp.rename(tmp, dst);
}
function copyFileOverSync(src, dst) {
  const tmp = `${dst}.agy-home-${process.pid}.tmp`;
  fs.copyFileSync(src, tmp);
  const st = fs.statSync(src);
  fs.chmodSync(tmp, st.mode & 0o7777);
  fs.utimesSync(tmp, st.atime, st.mtime);
  fs.renameSync(tmp, dst);
}
const sameContentSync = (a, b) => {
  const sa = fs.statSync(a); const sb = fs.statSync(b);
  return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
};
const sameContent = async (a, b) => {
  const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
  if (sa.size !== sb.size) return false;
  const [ba, bb] = await Promise.all([fsp.readFile(a), fsp.readFile(b)]);
  return ba.equals(bb);
};

// Where the bucket's version of `rel` goes before it is overwritten: on local
// disk beside the local copy, and on the bucket itself so a restart keeps it.
const bucketCopies = (mirror, rel) => [path.join(mirror.aside, 'bucket', rel), path.join(mirror.durable, rel)];
function keepBucketSync(file, mirror, rel) {
  const to = bucketCopies(mirror, rel);
  for (const t of to) { fs.mkdirSync(path.dirname(t), { recursive: true }); copyFileOverSync(file, t); }
  return to;
}
async function keepBucket(file, mirror, rel) {
  const to = bucketCopies(mirror, rel);
  for (const t of to) { await fsp.mkdir(path.dirname(t), { recursive: true }); await copyFileOver(file, t); }
  return to;
}

/**
 * `link` was linked to `target` on the bucket and is a real FILE now. Nothing
 * is dropped: identical content is just linked again; otherwise the newer side
 * (the local save on a tie) ends up on the bucket, and before a bucket file is
 * overwritten its content is kept twice — $AM_LOCAL/agy-home-replaced/<time>/
 * bucket/ and /data/home/.agy-home-replaced/<time>/ (durable). The local copy
 * goes to $AM_LOCAL/agy-home-replaced/<time>/local/, and the link is made.
 * Returns false (and leaves it) if that could not be done.
 */
function restoreReplacedFile(link, target, st, ts, out, mirror) {
  const rel = path.relative(mirror.home, link);
  const aside = path.join(mirror.aside, 'local', rel);
  let action; let kept = [];
  try {
    if (sameContentSync(link, target)) action = 'identical to the bucket copy';
    else if (!newer(ts, st)) {
      kept = keepBucketSync(target, mirror, rel);
      copyFileOverSync(link, target);
      action = 'copied back to the bucket (newer)';
    } else action = 'the bucket copy is newer; kept it';
    fs.mkdirSync(path.dirname(aside), { recursive: true });
    fs.renameSync(link, aside);
  } catch (e) {
    out.errors.push(`${link}: could not restore the link (${e.code || e.message}); left as is`);
    return false;
  }
  out.restored.push({ kind: 'file', path: link, target, action, aside, bucketKept: kept });
  return true;
}

// Files under the local tree `src` not older than the bucket's (or missing
// there) go to the bucket tree `dst`; a bucket file is kept (keepBucket)
// before it is overwritten, identical ones are skipped.
async function copyNewerTree(src, dst, mirror, relBase, kept) {
  let n = 0;
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name); const rel = path.join(relBase, e.name);
    if (e.isDirectory()) { await fsp.mkdir(d, { recursive: true }); n += await copyNewerTree(s, d, mirror, rel, kept); continue; }
    if (!e.isFile()) continue;
    let ds = null; try { ds = await fsp.stat(d); } catch {}
    if (ds && (await sameContent(s, d) || newer(ds, await fsp.stat(s)))) continue;
    if (ds) kept.push(...await keepBucket(d, mirror, rel));
    await copyFileOver(s, d); n += 1;
  }
  return n;
}

// Folders being put back right now, so two launches do not both do it.
const dirsInFlight = new Set();
/**
 * A linked DIRECTORY that is a real one now, put back off the launch path:
 * its newer files to the bucket (keeping what they overwrite), the local
 * folder aside, the link again. Resolves to the same record as a file's, or
 * null when it was left alone.
 */
async function restoreReplacedDir({ link, target }, mirror) {
  if (dirsInFlight.has(link)) return null;
  dirsInFlight.add(link);
  const rel = path.relative(mirror.home, link);
  const aside = path.join(mirror.aside, 'local', rel);
  try {
    const kept = [];
    const n = await copyNewerTree(link, target, mirror, rel, kept);
    await fsp.mkdir(path.dirname(aside), { recursive: true });
    await fsp.rename(link, aside);
    await fsp.symlink(target, link);
    return { kind: 'folder', path: link, target, action: `${n} newer file(s) copied back to the bucket`, aside, bucketKept: kept };
  } catch (e) {
    return { kind: 'folder', path: link, target, action: `could not restore the link (${e.code || e.message}); left as is`, aside: null, bucketKept: [], error: true };
  } finally { dirsInFlight.delete(link); }
}

/** Make `link` a symlink to `target` unless something is already there. */
function ensureLink(link, target, out, mirror = null) {
  let st = null;
  try { st = fs.lstatSync(link); } catch { /* nothing there */ }
  if (st) {
    if (st.isSymbolicLink()) {
      let to = null;
      try { to = fs.readlinkSync(link); } catch {}
      if (to === target) return;
      // A link we made earlier, to a target that moved: point it again. A
      // link someone else made (elsewhere) stays.
      if (to && path.dirname(to) !== path.dirname(target)) { out.kept.push(link); return; }
      try { fs.unlinkSync(link); } catch { out.kept.push(link); return; }
    } else if (mirror) {
      // A linked entry that is real now: a save by rename (sed -i, an editor,
      // a temp+rename write) replaced the link with a local copy.
      let ts;
      try { ts = fs.statSync(target); } catch { out.kept.push(link); return; } // gone from the bucket: leave the local one
      if (st.isFile() && ts.isFile()) { if (!restoreReplacedFile(link, target, st, ts, out, mirror)) return; }
      else if (st.isDirectory() && ts.isDirectory()) { out.pendingDirs.push({ link, target }); return; }
      else { out.kept.push(link); return; }
    } else {
      out.kept.push(link); // a real file or directory: agy's or a tool's own
      return;
    }
  }
  try { fs.symlinkSync(target, link); out.linked.push(link); } catch (e) { out.errors.push(`${link}: ${e.code || e.message}`); }
}

/**
 * Lay out $AGY_HOME as described above. Returns `{ home, linked, kept,
 * restored, pendingDirs, dirsDone, errors, stateOk }`, or null when there is
 * no $AGY_HOME. `stateOk` is false if either state folder is not the link to
 * $ANTIGRAVITY_LIVE (then agy must not start on it: runner.js refuses rather
 * than let it write somewhere unsaved). Folders to put back (`pendingDirs`)
 * are done in the background; `dirsDone` resolves to their records.
 */
export function prepareAgyHome(env = process.env) {
  const home = agyHomeDir(env);
  const live = env.ANTIGRAVITY_LIVE;
  const bucketHome = env.HOME;
  if (!home || !live) return null;
  const out = { home, linked: [], kept: [], restored: [], pendingDirs: [], dirsDone: Promise.resolve([]), errors: [], stateOk: true };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.(\d+)Z$/, '.$1Z');
  const mirror = {
    home,
    aside: path.join(path.dirname(home), 'agy-home-replaced', stamp),
    durable: path.join(bucketHome || home, DURABLE_ASIDE, stamp),
  };
  const gem = path.join(home, '.gemini');
  try { fs.mkdirSync(gem, { recursive: true }); } catch (e) { out.errors.push(`${gem}: ${e.code || e.message}`); out.stateOk = false; return out; }
  for (const s of STATE) {
    const target = path.join(live, s);
    try { fs.mkdirSync(target, { recursive: true }); } catch {}
    const link = path.join(gem, s);
    ensureLink(link, target, out);
    let ok = false;
    try { ok = fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === target; } catch {}
    if (!ok) out.stateOk = false;
  }
  if (bucketHome && path.resolve(bucketHome) !== path.resolve(home)) {
    let names = [];
    try { names = fs.readdirSync(bucketHome); } catch { /* no bucket HOME: nothing else to link */ }
    for (const n of names) {
      if (n === '.gemini' || n === DURABLE_ASIDE) continue;
      ensureLink(path.join(home, n), path.join(bucketHome, n), out, mirror);
    }
    let gnames = [];
    try { gnames = fs.readdirSync(path.join(bucketHome, '.gemini')); } catch {}
    for (const n of gnames) {
      if (isStateCopy(n)) continue;
      ensureLink(path.join(gem, n), path.join(bucketHome, '.gemini', n), out, mirror);
    }
  }
  if (out.pendingDirs.length) {
    out.dirsDone = Promise.all(out.pendingDirs.map((d) => restoreReplacedDir(d, mirror))).then((r) => r.filter(Boolean));
  }
  return out;
}
