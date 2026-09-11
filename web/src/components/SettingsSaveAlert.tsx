import { useSyncExternalStore } from 'react';
import { useSaverState } from '../lib/saveQueue';
import {
  configSaver, secretsSaver, saverFor, settingsSlot, subscribeSettings, overwriteSettings,
  type Kind,
} from '../lib/settingsSaves';

// A settings change is sent as it is made, which means it can fail after the
// panel it was made in is closed. Without this, that failure has nowhere to
// appear: the change is still only in this browser, and nothing on screen says
// so. It stays until the change lands or is given up — this is not a toast.
const LABEL: Record<Kind, string> = { config: 'A setting', secrets: 'A description' };

export default function SettingsSaveAlert({ onOpen, hidden }: { onOpen: () => void; hidden?: boolean }) {
  const cfg = useSaverState(configSaver);
  const secrets = useSaverState(secretsSaver);
  const slots = useSyncExternalStore(subscribeSettings,
    () => `${settingsSlot('config').conflict ? 'c' : ''}${settingsSlot('secrets').conflict ? 's' : ''}`,
    () => '');
  const failing: Kind[] = [];
  if (cfg.status === 'error') failing.push('config');
  if (secrets.status === 'error') failing.push('secrets');
  if (hidden || failing.length === 0) return null;
  const kind = failing[0];
  const state = kind === 'config' ? cfg : secrets;
  const conflicted = !!settingsSlot(kind).conflict && !settingsSlot(kind).readError;
  void slots;   // re-renders when a conflict appears or clears
  return (
    <div className="save-alert" role="alert">
      <span>
        {conflicted
          ? `Somebody else changed ${LABEL[kind].toLowerCase()} you were editing.`
          : state.unresolved
            ? `${LABEL[kind]} you changed was not saved — the server did not answer.`
            : state.error
              ? `${LABEL[kind]} you changed was not saved — ${state.error}`
              : `${LABEL[kind]} you changed was not saved.`}
      </span>
      <button className="mini-btn" onClick={onOpen}>Open settings</button>
      <button
        className="mini-btn primary"
        onClick={() => { void (conflicted ? overwriteSettings(kind) : saverFor(kind).retry()); }}
      >{conflicted ? 'Keep mine' : 'Retry'}</button>
    </div>
  );
}
