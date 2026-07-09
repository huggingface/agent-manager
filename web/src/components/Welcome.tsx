import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { AmMark, PlusGlyph, PulseGlyph, KeyGlyph, GridGlyph, BellGlyph, LockGlyph } from './icons';

// First-run welcome: one scrollable card covering the things a newcomer can't
// guess. Shown once per Space (server-flagged) and reopenable from Settings.
const ITEMS: { icon: ReactNode; title: string; body: ReactNode }[] = [
  {
    icon: <PulseGlyph />,
    title: 'Your agents are always running',
    body: <>They live in the cloud, not on your laptop. Close the tab, shut the lid, switch devices, and they keep working. Reconnect anytime to pick up where they are.</>,
  },
  {
    icon: <PlusGlyph />,
    title: 'Use any agent or harness in one click',
    body: <>Claude Code, Codex, Gemini, opencode, Hermes, OpenClaw and more, side by side. Hit <b>+</b>, pick one, and it walks you through login on first launch.</>,
  },
  {
    icon: <KeyGlyph />,
    title: 'Manage keys and secrets in one place',
    body: <>Add API keys once as <b>Space secrets</b> and <b>label them</b> in Settings. Every agent then learns what's available through a generated <span className="mono">environment</span> skill.</>,
  },
  {
    icon: <GridGlyph />,
    title: 'Run everything from a single window',
    body: <>Overview shows what each agent did since your last message, whose turn it is, and lets you reply inline, so you steer a whole fleet without juggling tabs.</>,
  },
  {
    icon: <BellGlyph />,
    title: 'Get pinged the moment they need you',
    body: <>Say "<b>notify me</b>" in a prompt and the agent messages your phone or desktop when it's done or stuck, so you don't have to watch it.</>,
  },
  {
    icon: <LockGlyph />,
    title: 'Persistent and private',
    body: <>Your work, logins and history persist on your own storage bucket, and the whole Space stays private to you. No shared servers, no one else's eyes.</>,
  },
];

export default function Welcome({ onClose }: { onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Accessible dialog: focus into it on open, close on Escape, and trap Tab so
  // focus can't wander to the (invisible) page behind the modal.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab' || !cardRef.current) return;
      const f = cardRef.current.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="welcome-backdrop" onClick={onClose}>
      <div className="welcome-card" role="dialog" aria-modal="true" aria-labelledby="welcome-title" ref={cardRef} onClick={(e) => e.stopPropagation()}>
        <div className="welcome-head">
          <span className="welcome-mark"><AmMark /></span>
          <div>
            <h2 id="welcome-title">Welcome to Agent Manager</h2>
            <p>Run a fleet of AI coding agents from one place. Always on, always yours.</p>
          </div>
        </div>
        <div className="welcome-items">
          {ITEMS.map((it) => (
            <div key={it.title} className="welcome-item">
              <span className="welcome-ico">{it.icon}</span>
              <div className="welcome-text">
                <div className="welcome-item-title">{it.title}</div>
                <div className="welcome-item-body">{it.body}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="welcome-foot">
          <span className="welcome-reopen mono">reopen anytime from Settings</span>
          <button className="btn-primary" ref={closeRef} onClick={onClose}>Get started</button>
        </div>
      </div>
    </div>
  );
}
