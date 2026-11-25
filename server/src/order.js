import path from 'node:path';
import { DATA_DIR } from './config.js';
import { createJsonStore } from './json-store.js';

// Top-level sidebar order: a flat list of refs mixing groups and loose sessions.
// Refs look like "g:<groupId>" or "s:<sessionId>".
const ORDER_FILE = path.join(DATA_DIR, 'order.json');
const store = createJsonStore(ORDER_FILE, {
  empty: () => [],
  validate(parsed) {
    if (!Array.isArray(parsed)) throw new TypeError('order.json must contain a JSON array');
    return parsed;
  },
});
let order = [];

export const isPoisoned = () => store.isPoisoned();

function persist() {
  try {
    store.save(order);
  } catch (e) { console.error('[order.persist]', e && e.message); }
}

export function init() {
  order = store.load();
}

export function list() {
  return order.slice();
}

function rm(ref) {
  const i = order.indexOf(ref);
  if (i >= 0) order.splice(i, 1);
}

export function drop(ref) { rm(ref); persist(); }
export function prepend(ref) { rm(ref); order.unshift(ref); persist(); }

export function insertAt(ref, index) {
  rm(ref);
  const i = !Number.isInteger(index) || index < 0 || index > order.length ? order.length : index;
  order.splice(i, 0, ref);
  persist();
}

// Replace oldRef in place with newRef (used when two sessions merge into a group).
export function replace(oldRef, newRef) {
  rm(newRef);
  const i = order.indexOf(oldRef);
  if (i >= 0) order[i] = newRef; else order.unshift(newRef);
  persist();
}

export function indexOf(ref) { return order.indexOf(ref); }

// Drop stale refs and add any missing valid ones (newest first) to the front.
export function normalize(valid) {
  const set = new Set(valid);
  const existing = order.filter((r) => set.has(r));
  const missing = valid.filter((r) => !existing.includes(r));
  const next = [...missing, ...existing];
  if (next.length !== order.length || next.some((r, i) => r !== order[i])) {
    order = next;
    persist();
  }
}
