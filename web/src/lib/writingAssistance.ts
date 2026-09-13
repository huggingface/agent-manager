import { useSyncExternalStore } from 'react';

const KEY = 'am:writing-assistance';
const CHANGE = 'am:writing-assistance-change';
let volatilePreference: boolean | undefined;
const snapshot = () => {
  if (volatilePreference !== undefined) return volatilePreference;
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
};
const subscribe = (notify: () => void) => {
  const onStorage = (event: StorageEvent) => { if (!event.key || event.key === KEY) notify(); };
  window.addEventListener(CHANGE, notify);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE, notify);
    window.removeEventListener('storage', onStorage);
  };
};

/** Browser-local preference shared by every composer; raw terminal input never uses it. */
export function useWritingAssistance() {
  const enabled = useSyncExternalStore(subscribe, snapshot, () => true);
  const setEnabled = (value: boolean) => {
    try { localStorage.setItem(KEY, value ? 'on' : 'off'); volatilePreference = undefined; }
    catch { volatilePreference = value; }
    window.dispatchEvent(new Event(CHANGE));
  };
  return [enabled, setEnabled] as const;
}
