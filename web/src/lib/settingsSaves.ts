import * as api from '../api';
import { createSaver, type Reconciled, type SaverHandle, type SaverState } from './saveQueue';

// The settings savers live here, not inside the panel.
//
// A change is sent the moment it is made, which means a change can still be in
// flight — or waiting behind one, or failed and worth retrying — when the panel
// that made it is closed. If the saver died with the component, closing Settings
// would be the one reliable way to lose a setting: the work would be cancelled,
// the failure would have nowhere to appear, and reopening would fetch the old
// server value straight over the edit. So the two resources are owned by this
// module for the life of the page, and the panel is a view onto them.
//
// This is not a store for the application. It is two savers and the little that
// belongs with them: the revision each one is replacing, the value still owed to
// the server, and what the server said when it refused.

export type Kind = 'config' | 'secrets';
export type ConfigValue = api.AmConfig;
export type NotesValue = Record<string, string>;

export type SettingsSlot = {
  /** The revision we believe is committed — the base the next save replaces. */
  rev: string | null;
  /** What the server said it is holding, when it refused ours. */
  conflict: { rev: string | null; value: unknown } | null;
  /** The generated environment skill, which is a separate outcome from saving. */
  derived: api.DerivedStatus | null;
  /** Why the saved file could not be read at all. */
  readError: string | null;
  /** The derived update has been pending long enough to be worth saying so. */
  derivedSlow: boolean;
};

const slots: Record<Kind, SettingsSlot> = {
  config: { rev: null, conflict: null, derived: null, readError: null, derivedSlow: false },
  secrets: { rev: null, conflict: null, derived: null, readError: null, derivedSlow: false },
};

const listeners = new Set<() => void>();
const announce = () => listeners.forEach((fn) => fn());
export const subscribeSettings = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const settingsSlot = (kind: Kind) => slots[kind];

// A settings write is small. Fifteen seconds is not a network being slow, it is
// a request that is not coming back, and the slot has to be given up so the next
// edit is not trapped behind it.
const TIMEOUT_MS = 15_000;

// Compare only the fields that are actually stored: a response carries derived
// status, the default Space and a revision, none of which are the value.
const configShape = (c: any) => JSON.stringify({
  artifacts: c?.artifacts, jobs: c?.jobs, archive: c?.archive, revive: c?.revive, backup: c?.backup,
});
// Key order is not content: the same descriptions rebuilt by a form and the
// same descriptions read back from disk must compare equal.
const notesShape = (n: any) => JSON.stringify(Object.fromEntries(Object.entries(n || {}).sort()));

/**
 * What the server holds, after our own answer went missing.
 *
 * The revision is the dangerous part. Adopting it before knowing whose version
 * it belongs to turns "somebody else wrote while we were waiting" into "here is
 * a fresh base for our old value" — and the retry then replaces their change
 * with ours and reports it saved. So the read-back decides first:
 *
 *  - same value as we sent → it was ours; it landed, and the revision is ours to take;
 *  - different value, revision unchanged → nothing was committed; send it again
 *    against the base we already hold;
 *  - different value, revision moved → someone else is there. That is a
 *    conflict, and replacing it is the operator's call, not a recovery step.
 */
async function reconcileWith<T, R extends { rev?: string | null; derived?: api.DerivedStatus }>(
  kind: Kind,
  sent: T,
  read: () => Promise<R>,
  shape: (v: any) => string,
  valueOf: (r: R) => unknown,
): Promise<Reconciled<R>> {
  const slot = slots[kind];
  const current = await read();
  slot.derived = current.derived ?? slot.derived;
  slot.readError = (current as any).readError ?? null;
  if (shape(valueOf(current)) === shape(sent)) {
    slot.rev = current.rev ?? null;
    announce();
    return { outcome: 'committed', result: current };
  }
  if ((current.rev ?? null) === slot.rev) {
    announce();
    return { outcome: 'lost' };
  }
  return {
    outcome: 'conflict',
    error: new api.SettingsConflict(
      'these settings were changed somewhere else while this save was unanswered',
      'stale', current.rev ?? null, valueOf(current),
    ),
  };
}

function noteCommit(kind: Kind, res: { rev?: string | null; derived?: api.DerivedStatus }) {
  slots[kind].rev = res.rev ?? null;
  slots[kind].derived = res.derived ?? slots[kind].derived;
  slots[kind].conflict = null;
  slots[kind].readError = null;
  if (slots[kind].derived?.pending) followDerived();
}

// A save answers before the work it sets off has finished, so the answer can
// only say "started". Without this the panel keeps a tick over a derived update
// that failed afterwards — and the only other way to find out would be to send
// the settings again, which is not a status check.
let derivedWatch: ReturnType<typeof setTimeout> | null = null;
let derivedTries = 0;
function followDerived() {
  if (derivedWatch) return;
  derivedTries = 0;
  const look = () => {
    derivedWatch = null;
    api.getDerivedStatus().then((report) => {
      const slow = report.pending && derivedTries >= 2;
      for (const kind of ['config', 'secrets'] as Kind[]) {
        slots[kind].derived = report;
        slots[kind].derivedSlow = slow;
      }
      announce();
      // Bounded: a pass that never settles stops being asked about rather than
      // being polled forever.
      if (report.pending && ++derivedTries < 12) derivedWatch = setTimeout(look, 500);
    }).catch(() => { /* the panel keeps what it last knew */ });
  };
  derivedWatch = setTimeout(look, 150);
}
function noteFailure(kind: Kind, err: Error) {
  if (err instanceof api.SettingsConflict) {
    slots[kind].conflict = { rev: err.rev, value: err.value };
    // 'unreadable' is not a race, it is a damaged file: there is no revision to
    // move to, and nothing may be written over it until a human looks.
    if (err.code === 'unreadable') slots[kind].readError = err.message;
  }
  announce();
}

export const configSaver: SaverHandle<ConfigValue, api.AmConfig> = createSaver<ConfigValue, api.AmConfig>({
  send: (value) => api.saveConfig(value, slots.config.rev),
  onCommit: (_v, res) => { noteCommit('config', res); announce(); },
  onFail: (err) => noteFailure('config', err),
  timeoutMs: TIMEOUT_MS,
  // A lost answer may have committed. Ask what is stored before sending
  // anything again: retrying blind either repeats a write that already landed or
  // walks over whatever replaced it.
  reconcile: (value) => reconcileWith('config', value, api.getConfig, configShape, (c) => c),
});

export const secretsSaver: SaverHandle<NotesValue, api.SecretsData> = createSaver<NotesValue, api.SecretsData>({
  send: (notes) => api.saveSecrets(notes, slots.secrets.rev),
  onCommit: (_v, res) => { noteCommit('secrets', res); announce(); },
  onFail: (err) => noteFailure('secrets', err),
  timeoutMs: TIMEOUT_MS,
  reconcile: (notes) => reconcileWith('secrets', notes, api.getSecrets, notesShape, (d) => d.notes),
});

export const saverFor = (kind: Kind) => (kind === 'config' ? configSaver : secretsSaver) as SaverHandle<any, any>;

/**
 * What a read told us. The revision is only adopted when nothing of ours is
 * still owed — otherwise a background read would hand a pending write the
 * revision of somebody else's change, and the precondition it exists to trip
 * would sail through.
 */
export function noteServerRead(kind: Kind, read: { rev?: string | null; readError?: string | null; derived?: api.DerivedStatus }) {
  const slot = slots[kind];
  slot.derived = read.derived ?? slot.derived;
  slot.readError = read.readError ?? null;
  if (!saverFor(kind).pending()) {
    slot.rev = read.rev ?? null;
    slot.conflict = null;
  }
  announce();
}

/** The value still owed to the server, which a reopened panel must show. */
export const pendingSettings = (kind: Kind) => saverFor(kind).pending();

/** Send the local value again over what the server turned out to hold. */
export function overwriteSettings(kind: Kind) {
  const slot = slots[kind];
  const value = saverFor(kind).pending();
  if (!value || !slot.conflict) return Promise.resolve(false);
  // Deliberate, and only from a button: the revision moves to the one the server
  // reported, so the next attempt is a replacement of what is really there.
  slot.rev = slot.conflict.rev;
  slot.conflict = null;
  announce();
  return saverFor(kind).request(value);
}

/** Give up the local value and take what the server has. */
export function adoptServerSettings(kind: Kind) {
  const slot = slots[kind];
  const taken = slot.conflict;
  saverFor(kind).reset();
  if (taken) { slot.rev = taken.rev; slot.conflict = null; }
  announce();
  return taken ? taken.value : null;
}

export const anySettingsFailing = () => (['config', 'secrets'] as Kind[])
  .filter((k) => saverFor(k).state().status === 'error');
export const anySettingsOutstanding = () => (['config', 'secrets'] as Kind[])
  .some((k) => saverFor(k).state().outstanding);

// Both savers push their state through the same subscription, so one indicator
// can watch the pair.
configSaver.subscribe(announce);
secretsSaver.subscribe(announce);

// A reload while a change is still owed to the server would take it with it. The
// browser only allows a prompt — it cannot be told to wait for the write, and
// nothing here pretends otherwise.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (!anySettingsOutstanding()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

export type { SaverState };
