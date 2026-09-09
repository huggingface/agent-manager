// The browser's side of the privacy lock. The server decides (server/src/
// visibility.js); this module only makes sure the app hears about it through
// one shared channel and cannot be talked out of a lock by a stale response.
//
// How an open app learns the state:
//   - every /api response with status 403 and body {error:'locked'} (api.ts)
//   - a terminal socket closed with LOCKED_CLOSE_CODE (TerminalPane)
//   - /api/info, fetched on load, on return to the tab, and every 15 s while
//     locked (App)
// The first two are pushed into the third's tracker via announceLock(), so a
// lock is applied the moment any channel sees it, and unlocking happens only
// through a status response requested AFTER the last lock observation.

export type LockReason = 'public-space' | 'public-bucket' | 'checking' | 'verification-unavailable';

export interface LockStatus {
  locked: boolean;
  reason: LockReason | null;
  bucket: string | null;
  bucketUnverified?: boolean;
  attemptedAt?: number | null;
  verifiedAt?: number | null;
  checkMs?: number;
  graceMs?: number;
  space?: { verdict: string; verifiedAt: number | null; attemptedAt: number | null };
}

export const LOCKED_EVENT = 'am-locked';
/** Close code the server uses for a terminal socket the lock refused or revoked. */
export const LOCKED_CLOSE_CODE = 4003;

export interface LockAnnouncement { reason: LockReason | null; bucket: string | null }

export const announceLock = (detail: LockAnnouncement) => {
  try { window.dispatchEvent(new CustomEvent(LOCKED_EVENT, { detail })); } catch { /* no window (tests) */ }
};

/** Parse a lock reason out of a socket close reason such as "locked:public-space". */
export const reasonFromCloseReason = (reason: string | undefined | null): LockReason | null => {
  const m = /^locked:([a-z-]+)$/.exec(reason || '');
  return m ? (m[1] as LockReason) : null;
};

/**
 * Orders status observations so a slow, older "unlocked" response can never
 * undo a newer lock. Every lock observation opens a new epoch; an unlocked
 * status is applied only if it was requested in the current epoch.
 */
export function createLockTracker() {
  let epoch = 0;
  return {
    /** Call when a status request starts; pass the value to accept(). */
    begin: () => epoch,
    /** A lock seen through any channel. */
    observeLocked: () => { epoch += 1; },
    /** Whether a status fetched after begin() returned `began` may be applied. */
    accept: (began: number, locked: boolean) => {
      if (locked) { epoch += 1; return true; }
      return began === epoch;
    },
  };
}

const ago = (ts: number | null | undefined, now: number) => {
  if (!ts) return null;
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** Human copy for the two non-public lock states. */
export function describeVerification(status: LockStatus | null | undefined, now = Date.now()) {
  const verified = ago(status?.verifiedAt ?? status?.space?.verifiedAt, now);
  const attempted = ago(status?.attemptedAt, now);
  const everyS = Math.round((status?.checkMs || 60_000) / 1000);
  const graceS = Math.round((status?.graceMs || 150_000) / 1000);
  return {
    lastVerified: verified ? `Last verified private ${verified}.` : 'This Space has not been verified private yet in this run.',
    lastAttempt: attempted ? `Last check ${attempted}.` : 'No check has completed yet.',
    cadence: everyS >= 60 && everyS % 60 === 0 ? `every ${everyS / 60} min` : `every ${everyS} s`,
    grace: graceS % 60 === 0 ? `${graceS / 60} min` : `${(graceS / 60).toFixed(1).replace(/\.0$/, '')} min`,
  };
}
