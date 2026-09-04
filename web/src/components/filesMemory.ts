// What a Files pane remembers when it isn't on screen.
//
// The pane unmounts whenever its tile shows something else, so without this
// every switch away threw out where you were AND anything you had typed — you
// came back to the workspace root with an empty editor. State lives here
// instead, keyed by session, and the pane reads it back on mount.
//
// The in-memory map is what makes a pane switch lossless. localStorage is the
// second line: it also survives a reload of the whole app, which is the other
// way people lose a buffer they never asked to lose.
import type { FileLinkRequest } from '../lib/fileLinks';

export interface Draft {
  path: string;
  text: string;
  /** Content tag the buffer was based on — see contentTag() on the server. */
  base: string | null;
}

export interface FilesMemory {
  root: string;
  viewing: string | null;
  target: string | null;
  sort?: { key: 'name' | 'size' | 'time'; desc: boolean };
  draft: Draft | null;
  linkedFile?: FileLinkRequest | null;
}

const EMPTY: FilesMemory = { root: '', viewing: null, target: null, draft: null };

// A buffer big enough to be worth keeping is still small next to the 5 MB
// localStorage budget; past this the in-memory copy alone carries it, so a pane
// switch is still safe and only a full reload loses it.
const DRAFT_MAX = 256 * 1024;

const mem = new Map<string, FilesMemory>();
const key = (id: string) => `am.files.${id}`;

export function recall(id: string): FilesMemory {
  const held = mem.get(id);
  if (held) return held;
  try {
    const raw = localStorage.getItem(key(id));
    if (raw) {
      const parsed = { ...EMPTY, ...JSON.parse(raw) } as FilesMemory;
      mem.set(id, parsed);
      return parsed;
    }
  } catch {
    // corrupt or unavailable storage is not worth failing a pane over
  }
  return EMPTY;
}

export function remember(id: string, patch: Partial<FilesMemory>) {
  const next = { ...recall(id), ...patch };
  mem.set(id, next);
  try {
    const forDisk = next.draft && next.draft.text.length > DRAFT_MAX ? { ...next, draft: null } : next;
    localStorage.setItem(key(id), JSON.stringify(forDisk));
  } catch {
    // over quota, or private mode: memory still has it
  }
}

export function forget(id: string) {
  mem.delete(id);
  try { localStorage.removeItem(key(id)); } catch {}
}

// One sticky preference rather than a per-file one: wrapping is about how you
// like to read, not about the file in front of you.
const WRAP = 'am.files.wrap';
export const readWrap = (): boolean => {
  try { return localStorage.getItem(WRAP) === '1'; } catch { return false; }
};
export const writeWrap = (on: boolean) => {
  try { localStorage.setItem(WRAP, on ? '1' : '0'); } catch {}
};
