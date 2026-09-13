// Read-only file links have stable, named roots rather than depending on the
// lifetime of a Files session. Never use a caller-supplied directory as a root.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { kindOfFile, mimeOf, readTextHead } from './preview.js';

export function fileLinkRoots(workspaces, extra = process.env.AM_FILE_LINK_ROOTS || '{}') {
  const configured = JSON.parse(extra);
  if (!configured || Array.isArray(configured) || typeof configured !== 'object') {
    throw new Error('AM_FILE_LINK_ROOTS must be a JSON object of names to absolute directories');
  }
  const roots = new Map([['workspace', path.resolve(workspaces)]]);
  for (const [name, dir] of Object.entries(configured)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || name === 'workspace'
      || typeof dir !== 'string' || !path.isAbsolute(dir) || path.resolve(dir) === path.parse(dir).root) {
      throw new Error('Invalid AM_FILE_LINK_ROOTS entry: ' + name);
    }
    roots.set(name, path.resolve(dir));
  }
  return roots;
}

const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const fail = (message, status = 404) => Object.assign(new Error(message), { status });

function checkedFile(roots, name, relative) {
  const root = roots.get(name);
  if (!root) throw fail('This file location is not available here.');
  const file = path.resolve(root, relative);
  if (!inside(root, file)) throw fail('This path is outside the available file locations.', 403);
  let real, stat;
  try {
    real = fs.realpathSync(file);
    if (!inside(fs.realpathSync(root), real)) throw fail('This link leaves its available file location.', 403);
    stat = fs.statSync(real);
  } catch (error) {
    if (error.status) throw error;
    throw fail('File not found. It may have moved or been deleted.');
  }
  if (!stat.isFile()) throw fail('This reference points to a folder. Open it in Files.', 400);
  return { root: name, path: path.relative(root, file), absolute: file, real, stat };
}

export function resolveFileLink(roots, getSession, query) {
  const ref = query.file;
  if (typeof ref !== 'string' || !ref || ref.length > 8192 || /[\x00-\x1f\\]/.test(ref)) {
    throw fail('Invalid file reference.', 400);
  }
  if (query.root !== undefined) {
    if (typeof query.root !== 'string' || path.isAbsolute(ref)) throw fail('Invalid file location.', 400);
    return checkedFile(roots, query.root, ref);
  }

  let session;
  if (query.session !== undefined) {
    if (typeof query.session !== 'string') throw fail('Invalid session.', 400);
    session = getSession(query.session);
    if (session?.cli === 'trace') {
      session = session.traceSource?.kind === 'session' ? getSession(session.traceSource.ref) : null;
    }
    if (!session || session.cli === 'remote' || session.cli === 'trace') {
      throw fail('File unavailable here: this conversation has no local working folder.');
    }
  }
  // Absolute references must map to an explicitly allowed root. Prefer the
  // most specific root when an operator configured overlapping directories.
  if (path.isAbsolute(ref)) {
    const file = path.resolve(ref);
    const entry = [...roots].sort((a, b) => b[1].length - a[1].length).find(([, root]) => inside(root, file));
    if (!entry) throw fail('This file is outside the available locations. Configure AM_FILE_LINK_ROOTS to include its folder.', 403);
    return checkedFile(roots, entry[0], path.relative(entry[1], file));
  }
  // `workspace/` is the same explicit workspace-root label shown in the UI.
  if (ref.startsWith('workspace/')) return checkedFile(roots, 'workspace', ref.slice(10));
  if (!session) throw fail('This relative reference needs its originating session.');
  const base = session.cli === 'files' && !session.path ? '' : session.path ?? session.id;
  return checkedFile(roots, 'workspace', path.join(base, ref));
}

export function fileLinksRouter({ roots, getSession }) {
  const router = express.Router();
  // Every request rechecks the real path, including requests for raw bytes.
  // No write, delete, or agent-start operation is exposed through this router.
  router.get('/:action', (req, res, next) => {
    if (!['resolve', 'preview', 'raw', 'download'].includes(req.params.action)) return next();
    try {
      const target = resolveFileLink(roots, getSession, req.query);
      const { root, path: relative, absolute, real, stat } = target;
      const publicTarget = { root, path: relative, absolute };
      res.setHeader('cache-control', 'no-store');
      if (req.params.action === 'resolve') return res.json(publicTarget);
      const kind = kindOfFile(real);
      if (req.params.action === 'preview') {
        const meta = { path: relative, name: path.basename(absolute), size: stat.size, mtime: stat.mtimeMs, kind, mime: mimeOf(real, kind) };
        if (kind === 'text' || kind === 'markdown') Object.assign(meta, readTextHead(real));
        return res.json(meta);
      }
      if (req.params.action === 'download') return res.download(real, path.basename(absolute), { dotfiles: 'allow' });
      res.setHeader('content-type', mimeOf(real, kind));
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-security-policy', 'sandbox allow-scripts allow-popups allow-forms allow-modals');
      res.setHeader('content-disposition', `inline; filename="${path.basename(absolute).replace(/[^\w.\- ]/g, '_')}"`);
      return res.sendFile(real, { dotfiles: 'allow' });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not read this file.' });
    }
  });
  return router;
}
