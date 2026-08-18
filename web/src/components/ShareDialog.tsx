import { useEffect, useState } from 'react';
import * as api from '../api';
import type { Session } from '../types';
import { LockGlyph } from './icons';

// Share one agent session as a Hub dataset (docs/session-sharing.md).
//
// Private or public, one code path on the server: private is a gated repo with
// the named users pre-authorized (the Hub lets us grant access without them
// requesting it), public is public. Either way the outcome is a LINK the operator
// sends to whoever should read it — there is no in-app notification, by design.
//
// The dialog's job beyond collecting two fields is to be honest about redaction:
// a public share is REFUSED when a credential is found, and we show which rule
// caught what either way. A trace is not a thing to publish hopefully.
export default function ShareDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const [info, setInfo] = useState<api.ShareInfo | null>(null);
  const [visibility, setVisibility] = useState<'public' | 'gated'>('gated');
  const [recipients, setRecipients] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<api.ShareResult | null>(null);
  const [blocked, setBlocked] = useState<{ message: string; hits: Record<string, number> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => { api.getShareInfo(session.id).then(setInfo).catch(() => setInfo(null)); }, [session.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const users = recipients.split(/[\s,]+/).map((u) => u.trim().replace(/^@/, '')).filter(Boolean);

  const publish = async () => {
    setBusy(true); setError(null); setBlocked(null);
    try {
      setResult(await api.shareSession(session.id, {
        visibility,
        grantTo: visibility === 'gated' ? users : [],
      }));
    } catch (e) {
      if (e instanceof api.RedactionBlocked) setBlocked({ message: e.message, hits: e.hits });
      else setError((e as Error).message || 'share failed');
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };

  const hitList = (hits: Record<string, number>) =>
    Object.entries(hits).map(([r, n]) => `${r} × ${n}`).join(', ');

  return (
    <div className="welcome-backdrop" onClick={onClose}>
      <div className="welcome-card share-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="welcome-head">
          <span className="welcome-mark"><LockGlyph /></span>
          <div>
            <h2 id="share-title" style={{ margin: 0, fontSize: 16 }}>Share “{session.name}”</h2>
            <p className="share-sub">
              Publishes this session’s transcript as a dataset on the Hub. The workspace files are not included.
            </p>
          </div>
        </div>

        {info && !info.canShare && (
          <p className="share-warn">
            {info.reason === 'no-hf-token' && 'No HF_TOKEN on this Space — add it as a secret to share sessions.'}
            {info.reason === 'unsupported-cli' && `Sharing doesn't support ${session.cli} sessions.`}
            {info.reason === 'no-transcript' && 'This session hasn’t written a transcript yet — run it first.'}
          </p>
        )}

        {!result && (
          <>
            <div className="share-modes">
              <button
                className={`btn-ghost${visibility === 'gated' ? ' on' : ''}`}
                onClick={() => setVisibility('gated')}
              >
                Private
              </button>
              <button
                className={`btn-ghost${visibility === 'public' ? ' on' : ''}`}
                onClick={() => setVisibility('public')}
              >
                Public
              </button>
            </div>

            {visibility === 'public' && (
              <p className="share-note">
                Anyone with the link can read it, and it shows up in Hub search. A public share is{' '}
                <strong>refused</strong> if the transcript contains anything credential-shaped.
              </p>
            )}

            {/* Only for a private share, and only because it GRANTS access —
                without a named user a gated dataset is readable by nobody. A
                public share needs no names: you just send the link. */}
            {visibility === 'gated' && (
              <label className="share-field">
                <span>Give access to</span>
                <input
                  value={recipients}
                  onChange={(e) => setRecipients(e.target.value)}
                  placeholder="alice, bob"
                  autoFocus
                />
                <small>
                  Hugging Face usernames. Published as a gated dataset and each person is granted
                  access directly — they don’t have to request it. Optional — leave empty to publish
                  with nobody granted yet.
                </small>
              </label>
            )}

            {blocked && (
              <div className="share-blocked">
                <strong>Not published.</strong> The transcript contains {hitList(blocked.hits)}.
                Share it with named people instead, or clear the secret from the session first.
              </div>
            )}
            {error && <div className="share-blocked">{error}</div>}

            <div className="share-actions">
              <button className="btn-ghost" onClick={onClose}>Cancel</button>
              {/* Publishing is not the only reason to want the transcript. This
                  saves the file to the operator's own device and puts it
                  nowhere else, so it is offered even when sharing is refused —
                  a session with a credential in it is exactly one you may want
                  to read locally. */}
              {info?.reason !== 'no-transcript' && (
                <a
                  className="btn-ghost"
                  href={api.traceDownloadUrl(session.id)}
                  download
                  title="Save the transcript file to this device. Nothing is published."
                >Download transcript</a>
              )}
              <button
                className="btn-primary"
                disabled={busy || !info?.canShare}
                onClick={publish}
              >
                {busy ? 'Publishing…' : 'Publish'}
              </button>
            </div>
            {info?.namespace && (
              <small className="share-dest">
                Goes to <code>{info.namespace}/am-session-…</code>
              </small>
            )}
          </>
        )}

        {result && (
          <>
            <p className="share-ok">
              {result.visibility === 'public'
                ? 'Published publicly.'
                : result.granted.length
                  ? `Published for ${result.granted.join(', ')}.`
                  // Gated with nobody granted: the repo exists but is unreadable by
                  // anyone else, so say that rather than implying it was delivered.
                  : 'Published as a gated dataset — nobody has access yet.'}
            </p>
            <div className="share-linkrow">
              <input readOnly value={result.url} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn-ghost" onClick={() => copy(result.url)}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
            {/* The link IS the handoff — nothing notifies them, so say what to do
                with it and what they do at the other end. */}
            <p className="share-note">
              Send this link to whoever should read it. They paste it into <em>Settings → Open a shared
              trace</em> in their own Agent Manager to open the session{result.visibility === 'public' ? '' : ' — a granted user can read it even though the dataset is gated'}.
            </p>
            <ul className="share-facts">
              <li>{result.stats.prompts} prompts · {result.stats.turns} turns · {result.stats.toolCalls} tool calls</li>
              <li>
                Redaction: {Object.keys(result.redaction).length ? hitList(result.redaction) : 'nothing matched'}
              </li>
              {!!Object.keys(result.dropped || {}).length && (
                <li>Dropped {hitList(result.dropped)} (these embed whole files)</li>
              )}
            </ul>
            {!!result.grantErrors.length && (
              <div className="share-blocked">
                Couldn’t grant: {result.grantErrors.map((g) => `${g.user} (${g.error})`).join('; ')}
              </div>
            )}
            <p className="share-note">
              The dataset viewer can take a while to render a brand-new dataset. The
              <em> Files</em> tab works immediately.
            </p>
            <div className="share-actions">
              <button className="btn-ghost" onClick={onClose}>Close</button>
              <a className="btn-primary" href={result.url} target="_blank" rel="noreferrer">Open on the Hub</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
