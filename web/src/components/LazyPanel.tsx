// The boundary a deferred panel mounts behind. It reserves the panel's place
// while the code is on its way, shows the panel once it lands, and — when it
// does not — says so where the panel would be, with a way onwards that is true:
// Try again when a retry can work, Reload when a newer build made this tab's
// chunk URLs stale, and always the panel's own Close. The page around it stays
// interactive, and nothing here can reopen a panel that was closed meanwhile:
// open/closed is the parent's state and module completion never touches it.
import { useSyncExternalStore, type ReactNode } from 'react';
import { readModule, retryModule, subscribeModule, type Loader, type ModuleState } from '../lib/lazyModule';

export function useLazyModule<T>(load: Loader<T>): ModuleState<T> {
  return useSyncExternalStore(
    (cb) => subscribeModule(load, cb),
    () => readModule(load),
    () => readModule(load),
  );
}

export default function LazyPanel<T>({ load, render, what, onClose, closeLabel = 'Close', className }: {
  /** A stable, module-level `() => import('…')` — the cache is keyed by it. */
  load: Loader<T>;
  render: (m: T) => ReactNode;
  /** Named in the loading and failure copy: "the file browser". */
  what: string;
  onClose?: () => void;
  closeLabel?: string;
  className?: string;
}) {
  const st = useLazyModule(load);
  const cls = `lazy-panel${className ? ` ${className}` : ''}`;
  if (st.kind === 'ready') return <>{render(st.module)}</>;
  if (st.kind === 'loading') {
    return (
      <div className={cls} aria-busy="true" aria-live="polite">
        <div className="lazy-msg">Loading {what}…</div>
      </div>
    );
  }
  const stale = st.stale === true;
  return (
    <div className={`${cls} lazy-failed`} role="alert">
      <div className="lazy-card">
        <div className="lazy-title">{stale ? 'Agent Manager was updated' : `Couldn’t load ${what}`}</div>
        <div className="lazy-msg">
          {stale
            ? 'A newer version was deployed since this page loaded, so this tab can’t fetch that part any more. Reload to get the new version — finish or copy anything unsent first.'
            : st.retryable
              ? 'The request didn’t get through — you may be offline.'
              : 'The request didn’t get through. Reloading the page usually fixes it — finish or copy anything unsent first.'}
        </div>
        <div className="lazy-actions">
          {st.retryable && <button className="btn-primary" onClick={() => retryModule(load)}>Try again</button>}
          {(stale || !st.retryable) && <button className="btn-primary" onClick={() => location.reload()}>Reload</button>}
          {onClose && <button className="btn-ghost" onClick={onClose}>{closeLabel}</button>}
        </div>
      </div>
    </div>
  );
}
