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
// $AM_LOCAL/agy-home-replaced/, the link is made again, and it is reported
// (`restored`, logged and shown by state-links.js).
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
      // A linked dotfile that is a real file now: a save by rename (sed -i, an
      // editor, a temp+rename write) replaced the link with a local copy.
      if (!restoreReplaced(link, target, st, out, mirror)) return;
    } else {
      out.kept.push(link); // a real file or directory: agy's or a tool's own
      return;
    }
  }
  try { fs.symlinkSync(target, link); out.linked.push(link); } catch (e) { out.errors.push(`${link}: ${e.code || e.message}`); }
}

const newer = (a, b) => a.mtimeMs > b.mtimeMs + 1; // 1 ms: copies keep mtime to the ms
// Copy src over dst through a temp file beside dst, keeping mode and times.
function copyFileOver(src, dst) {
  const tmp = `${dst}.agy-home-${process.pid}.tmp`;
  fs.copyFileSync(src, tmp);
  const st = fs.statSync(src);
  fs.chmodSync(tmp, st.mode & 0o7777);
  fs.utimesSync(tmp, st.atime, st.mtime);
  fs.renameSync(tmp, dst);
}
// Every file under the local tree `src` that is not older than (or is missing
// from) the bucket tree `dst`, copied over; returns how many.
function copyNewerTree(src, dst) {
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); n += copyNewerTree(s, d); continue; }
    if (!e.isFile()) continue;
    let ds = null; try { ds = fs.statSync(d); } catch {}
    if (!ds || !newer(ds, fs.statSync(s))) { copyFileOver(s, d); n += 1; }
  }
  return n;
}

/**
 * `link` was linked to `target` on the bucket and is a real file or directory
 * now. Neither side is dropped: what is newer locally is copied to the bucket,
 * the local copy is then moved to $AM_LOCAL/agy-home-replaced/<time>/ and the
 * link is made again. Returns false (and leaves it) if that could not be done.
 */
function restoreReplaced(link, target, st, out, mirror) {
  let ts;
  try { ts = fs.statSync(target); } catch { out.kept.push(link); return false; } // gone from the bucket: leave the local one
  const rel = path.relative(mirror.home, link);
  const aside = path.join(mirror.aside, rel);
  let action;
  try {
    if (st.isFile() && ts.isFile()) {
      // The local save wins unless the bucket copy was changed after it.
      if (!newer(ts, st)) { copyFileOver(link, target); action = 'copied back to the bucket (newer)'; }
      else action = 'the bucket copy is newer; kept it';
    } else if (st.isDirectory() && ts.isDirectory()) {
      const n = copyNewerTree(link, target);
      action = `${n} newer file(s) copied back to the bucket`;
    } else { out.kept.push(link); return false; }
    fs.mkdirSync(path.dirname(aside), { recursive: true });
    fs.renameSync(link, aside);
  } catch (e) {
    out.errors.push(`${link}: could not restore the link (${e.code || e.message}); left as is`);
    return false;
  }
  out.restored.push({ path: link, target, action, aside });
  return true;
}
/**
 * Lay out $AGY_HOME as described above. Returns `{ home, linked, kept,
 * restored, errors, stateOk }`, or null when there is no $AGY_HOME. `stateOk` is false if either
 * state folder is not the link to $ANTIGRAVITY_LIVE (then agy must not start
 * on it: runner.js refuses rather than let it write somewhere unsaved).
 */
export function prepareAgyHome(env = process.env) {
  const home = agyHomeDir(env);
  const live = env.ANTIGRAVITY_LIVE;
  const bucketHome = env.HOME;
  if (!home || !live) return null;
  const out = { home, linked: [], kept: [], restored: [], errors: [], stateOk: true };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const mirror = { home, aside: path.join(path.dirname(home), 'agy-home-replaced', stamp) };
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
      if (n === '.gemini') continue;
      ensureLink(path.join(home, n), path.join(bucketHome, n), out, mirror);
    }
    let gnames = [];
    try { gnames = fs.readdirSync(path.join(bucketHome, '.gemini')); } catch {}
    for (const n of gnames) {
      if (isStateCopy(n)) continue;
      ensureLink(path.join(gem, n), path.join(bucketHome, '.gemini', n), out, mirror);
    }
  }
  return out;
}
