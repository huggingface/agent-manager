import type { Info } from '../api';

/**
 * Should the app ask about a bucket? Only on a Space whose server says its data
 * will not survive a restart (server/src/storage.js). A server too old to say
 * (no `storage`) and any local install never ask.
 */
export function needsBucket(info: Pick<Info, 'spaceId' | 'storage'> | null | undefined): boolean {
  return !!info?.spaceId && info.storage?.persistent === false;
}
