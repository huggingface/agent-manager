import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { DownloadGlyph } from './icons';

// Kind glyphs for the file listing, drawn with icons.tsx's pen (16px grid, 1.2
// stroke, round joins). Kept here, not there: icons.tsx ships in the entry
// chunk, and only the lazy Files pane draws these.
const G = ({ className, children }: { className?: string; children: ReactNode }) => (
  <svg className={className} width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round">
    {children}
  </svg>
);

export const VideoGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <rect x="2" y="3.2" width="12" height="9.6" rx="1" />
    <path d="M6.6 5.9v4.2L10.2 8z" />
  </G>
);

export const AudioGlyph = ({ className }: { className?: string }) => (
  <G className={className}>
    <path d="M6 11.6V3.4l6.5-1.3v8.1" />
    <circle cx="4.5" cy="11.6" r="1.5" />
    <circle cx="11" cy="10.2" r="1.5" />
  </G>
);

// m:ss, or h:mm:ss past the hour. A live stream or a file the browser can't
// measure reports Infinity/NaN; say nothing rather than "NaN:NaN".
export const fmtDuration = (s: number) => {
  if (!Number.isFinite(s) || s <= 0) return null;
  const t = Math.round(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
};

// Video and audio, played by the browser's own element straight from /raw,
// which answers Range requests so seeking fetches only what it needs. Whether a
// given file decodes is only known once the element tries — an .mkv or .mov
// may or may not, depending on its codecs and the browser — so a decode error
// turns into the same honest card as any other file we can't show.
export default function MediaView({ kind, src, name, onFacts, onDownload }: {
  kind: 'video' | 'audio';
  src: string;
  name: string;
  /** "1280×720 · 0:12" for the pane's info strip, once metadata is in. */
  onFacts: (facts: string | null) => void;
  onDownload: () => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="fv-empty">
        This browser can't play this format.
        <div className="fv-sub">Download it to play it in another app.</div>
        <button className="mini-btn" onClick={onDownload}>
          <DownloadGlyph /> Download
        </button>
      </div>
    );
  }
  const props = {
    src, controls: true, preload: 'metadata' as const, title: name,
    onError: () => { setFailed(true); onFacts(null); },
    onLoadedMetadata: (e: SyntheticEvent<HTMLVideoElement | HTMLAudioElement>) => {
      const el = e.currentTarget;
      const facts = [
        el instanceof HTMLVideoElement && el.videoWidth ? `${el.videoWidth}×${el.videoHeight}` : null,
        fmtDuration(el.duration),
      ].filter(Boolean);
      onFacts(facts.length ? facts.join(' · ') : null);
    },
  };
  return (
    <div className={`fv-media fv-${kind}`}>
      {kind === 'video' ? <video {...props} playsInline /> : <audio {...props} />}
    </div>
  );
}
