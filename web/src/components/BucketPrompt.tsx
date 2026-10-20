import { useEffect, useRef, useState } from 'react';
import HfHeaderIcon from './HfHeaderIcon';

// Asked before getting started, on a Space with no bucket mounted at /data
// (server/src/storage.js). A freshly duplicated Space runs fine without one,
// which is the problem: nothing says that every agent, login and conversation
// is on the container's own disk until the first restart wipes it.
//
// The steps are the install page's step 2 (Locked.tsx), with the same picture.
// Mounting a bucket restarts the Space and the server finds it by itself, so
// "Yes" does not take the operator's word for it: it waits for the server to
// see the bucket (App polls /api/info and reloads), and only "Continue without
// a bucket" goes on to getting started without one.

/** How long to wait before saying the bucket is taking longer than a restart. */
export const SLOW_MS = 3 * 60_000;

export default function BucketPrompt({ waiting, onAttached, onSkip }: {
  /** "Yes" was clicked and the server still sees no bucket. */
  waiting: boolean;
  onAttached: () => void;
  onSkip: () => void;
}) {
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => { primary.current?.focus(); }, []);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const t = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => window.clearTimeout(t);
  }, [waiting]);

  return (
    <div className="welcome-backdrop">
      <div className="welcome-card bucket-card" role="dialog" aria-modal="true" aria-labelledby="bucket-title">
        <div className="welcome-head">
          <div>
            <h2 id="bucket-title">Have you attached a bucket?</h2>
            <p className="bucket-lead">
              This Space has no storage bucket. Without one, your agents' work, logins and history
              are lost on every restart or update.
            </p>
          </div>
        </div>

        <div className="bucket-step">
          <p>
            Click <HfHeaderIcon /> at the top right of this page to show the Space's menu bar, then open
            {' '}<b>Settings → Storage → Mount a bucket</b>. Choose <b>Create new bucket</b>, keep
            it <b>Private</b>, set the mount path to <span className="mono">/data</span> and
            access to <b>Read &amp; Write</b>.
          </p>
          <img src="/install/mount-bucket.png" alt="The Mount a bucket dialog: private bucket, mount path /data, read & write" />
          <p className="bucket-note">Mounting restarts the Space. Agent Manager finds the bucket by itself when it is back.</p>
        </div>

        {waiting ? (
          <div className="bucket-wait" role="status" aria-live="polite">
            <span className="bucket-spin" aria-hidden="true" />
            <div>
              <b>The Space is restarting to mount it…</b>
              <div className="bucket-wait-sub">
                {slow
                  ? <>Still no bucket at <span className="mono">/data</span>. Check that it is mounted there with <b>Read &amp; Write</b> access.</>
                  : <>This page reloads by itself once the bucket is there.</>}
              </div>
            </div>
          </div>
        ) : null}

        <div className="welcome-foot bucket-foot">
          <button className="bucket-skip" onClick={onSkip}>Continue without a bucket</button>
          {waiting ? null : (
            <button className="btn-primary" ref={primary} onClick={onAttached}>Yes, I've attached it</button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The one line that stays while the operator runs without a bucket. */
export function NoBucketBanner({ onShow }: { onShow: () => void }) {
  return (
    <div className="bkfail nobucket" role="status">
      <span className="bkfail-dot" aria-hidden="true" />
      <span className="bkfail-txt"><b>Not saved:</b> no bucket attached.</span>
      <button className="bkfail-link" onClick={onShow}>how to attach one</button>
    </div>
  );
}
