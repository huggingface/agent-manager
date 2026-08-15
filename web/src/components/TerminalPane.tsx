import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon, Base64 } from '@xterm/addon-clipboard';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { Cli, Session } from '../types';
import { STATE_LABEL, isRemote } from '../types';
import Logo from './Logo';
import TraceInfo from './TraceInfo';
import ConversationView from './conversation/ConversationView';
import { isPassive } from '../types';
import type { PaneMode } from '../lib/paneMode';
import { groupLabel, sessionTitle } from '../lib/sessionTitle';
import { BackGlyph, CloseGlyph, RefreshGlyph , SearchGlyph } from './icons';
import * as api from '../api';
import type { Attachment } from '../api';
import {
  MAX_ATTACHMENTS, attachmentFileError, filesFromClipboardItems, filesFromTransfer,
  transferMayContainFile,
} from '../lib/attachments';

const THEMES: Record<'light' | 'dark', ITheme> = {
  dark: {
    background: '#0e1217', foreground: '#c6d0d8',
    cursor: '#43c98a', cursorAccent: '#0e1217',
    selectionBackground: '#2bb3bd44',
    // ANSI tuned bright enough for the dark background (used by the prompt).
    green: '#43c98a', brightGreen: '#5fe0a0',
    cyan: '#5fd0d8', brightCyan: '#7fe3ea',
    blue: '#6ea8fe', brightBlue: '#8cbcff',
    red: '#e0726a', yellow: '#e0a948',
  },
  light: {
    background: '#ffffff', foreground: '#1b2329',
    cursor: '#0e7c86', cursorAccent: '#ffffff',
    selectionBackground: '#0e7c8633',
    // ANSI darkened for contrast on white (fixes the unreadable prompt in light mode).
    green: '#1c8c57', brightGreen: '#1c8c57',
    cyan: '#0e7c86', brightCyan: '#0e7c86',
    blue: '#2257c4', brightBlue: '#2257c4',
    red: '#c2433a', yellow: '#9a6a00',
  },
};

type ConnState = 'connecting' | 'connected' | 'closed' | 'exited';

// Close code the server uses when the session's process exited for real (vs a
// transient drop). The client must NOT auto-reconnect on this, or it would
// respawn the agent in a loop and trample an in-progress login flow.
const EXIT_CODE = 4000;

function workspaceLabel(p: string | null) {
  const rel = (p || '').replace(/^\.\/?/, '').replace(/^\/+|\/+$/g, '');
  return rel ? `workspace/${rel}/` : 'workspace/';
}

// Serialize the current selection, joining soft-wrapped rows instead of
// emitting a newline per visual row. Some full-width rows painted with cursor
// movement lack xterm's wrap flag, so a filled last cell is a second signal.
function selectionText(term: Terminal): string {
  try {
    const pos = term.getSelectionPosition?.();
    if (!pos) return term.getSelection();
    const buf = term.buffer.active;
    const cols = term.cols;
    const out: string[] = [];
    let cur = '';
    for (let y = pos.start.y; y <= pos.end.y; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const startX = y === pos.start.y ? pos.start.x : 0;
      const endX = y === pos.end.y ? pos.end.x : cols;
      cur += line.translateToString(false, startX, endX);
      const lastChar = line.getCell(cols - 1)?.getChars() ?? '';
      const full = endX >= cols && lastChar !== '' && lastChar !== ' ';
      const wrapped = y < pos.end.y && ((buf.getLine(y + 1)?.isWrapped ?? false) || full);
      if (!wrapped) { out.push(cur.replace(/[ \t]+$/, '')); cur = ''; }
    }
    if (cur) out.push(cur.replace(/[ \t]+$/, ''));
    const joined = out.join('\n');
    return joined || term.getSelection();
  } catch {
    return term.getSelection();
  }
}

// Copying to the system clipboard has to survive two hostile conditions on the
// Space: the app is usually embedded in Hugging Face's cross-origin iframe
// (which blocks the async Clipboard API entirely), and the tab is often
// unfocused. So explicit user copies layer:
//   1. execCommand('copy') via a hidden textarea — the ONLY path that works
//      inside the iframe, and it works during any user gesture.
//   2. navigator.clipboard.writeText — the modern path (focused, top-level).
//   3. if both fail (a requested copy couldn't write), stash briefly
//      and flush on the user's next click, so the copy lands when they return.
// It must run synchronously inside the triggering event — deferring to a
// setTimeout loses the activation that execCommand needs.
// Server → client control frames (restore, shared-grid size) ride the terminal
// socket with this leading NUL sentinel, which real pty output never begins with.
const MODE_CTRL = '\x00\x00AM:';

type TerminalPreview = { version: 1; at: number; cols: number; rows: string[] };
const PREVIEW_PREFIX = 'am-terminal-preview:';
const PREVIEW_INDEX = 'am-terminal-preview-index';
const MAX_PREVIEWS = 12;

function loadTerminalPreview(id: string): TerminalPreview | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${PREVIEW_PREFIX}${id}`) || 'null');
    if (parsed?.version !== 1 || !Array.isArray(parsed.rows)
        || !parsed.rows.some((line: unknown) => typeof line === 'string' && line.trim())) return null;
    return {
      version: 1,
      at: Number(parsed.at) || 0,
      cols: Math.max(1, Number(parsed.cols) || 80),
      rows: parsed.rows.filter((line: unknown) => typeof line === 'string').slice(0, 80),
    };
  } catch { return null; }
}

// Keep only a compact rendering of the viewport, never the full 20k-line
// scrollback. It is a loading preview, not a second terminal state model.
function saveTerminalPreview(id: string, term: Terminal) {
  try {
    const buffer = term.buffer.active;
    const rowCount = Math.min(term.rows, 80);
    const colCount = Math.min(term.cols, 240);
    const rows: string[] = [];
    for (let y = 0; y < rowCount; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      rows.push((line?.translateToString(false, 0, colCount) || '').replace(/[ \t]+$/, ''));
    }
    if (!rows.some((line) => line.trim())) return;
    const saved: TerminalPreview = { version: 1, at: Date.now(), cols: term.cols, rows };
    localStorage.setItem(`${PREVIEW_PREFIX}${id}`, JSON.stringify(saved));

    let previous: string[] = [];
    try { previous = JSON.parse(localStorage.getItem(PREVIEW_INDEX) || '[]'); } catch {}
    const next = [id, ...previous].filter((value, i, all) =>
      typeof value === 'string' && all.indexOf(value) === i).slice(0, MAX_PREVIEWS);
    localStorage.setItem(PREVIEW_INDEX, JSON.stringify(next));
    for (const stale of previous) {
      if (typeof stale === 'string' && !next.includes(stale)) {
        localStorage.removeItem(`${PREVIEW_PREFIX}${stale}`);
      }
    }
  } catch { /* storage may be disabled or full; previews are best-effort */ }
}

function legacyCopy(text: string): boolean {
  const prev = document.activeElement as HTMLElement | null;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    prev?.focus?.(); // don't steal focus from the terminal
    return ok;
  } catch { return false; }
}

let clipStash: { text: string; at: number } | null = null;
function copyText(text: string) {
  if (!text) return;
  if (legacyCopy(text)) { clipStash = null; return; }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => { clipStash = null; })
      .catch(() => { clipStash = { text, at: Date.now() }; });
  } else {
    clipStash = { text, at: Date.now() };
  }
}
// A user-requested copy we couldn't complete lands on the next real interaction
// — bounded so a stale copy can't clobber the clipboard much later.
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => {
    if (clipStash && Date.now() - clipStash.at < 8000) legacyCopy(clipStash.text);
    clipStash = null;
  }, true);
}

export default function TerminalPane({
  session, cli, theme, focused, visible, active, zoom = 100, mode = 'terminal', readerEnabled,
  readerReadyKey, onReaderReady, dragId, isMobile, groupName, onBack, onDragActive, onFocus, onRename, onClose,
  onShare,
}: {
  session: Session;
  cli?: Cli;
  theme: 'light' | 'dark';
  groupName?: string | null; // the group this pane belongs to, if any
  focused?: boolean;
  visible?: boolean;
  active?: boolean;
  zoom?: number;
  mode?: PaneMode;          // app-wide reading mode, from the bottom bar
  readerEnabled?: boolean;  // focused reader paints before visible followers
  readerReadyKey?: string;  // visible batch whose first paint is being awaited
  onReaderReady?: () => void;
  onShare?: () => void;      // reader info panel: publish this session
  dragId?: string;          // set when the pane can be rearranged (group view)
  isMobile?: boolean;       // show the on-screen control-key bar
  onBack?: () => void;      // mobile: leave the pane for the list (see .ph-back)
  onDragActive?: (dragging: boolean) => void;
  onFocus?: () => void;
  onRename?: (name: string) => void;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Focus, unless the conversation is covering the terminal. Several paths grab
  // it — becoming active, the header, the key bar — and some fire after the mode
  // changes, so the guard lives with the call rather than with the switch.
  const modeRef = useRef<PaneMode>('terminal');
  const focusTerm = () => { if (modeRef.current !== 'reader') termRef.current?.focus(); };
  const frameRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const resyncRef = useRef<() => void>(() => {});
  const reconcileScrollRef = useRef<() => void>(() => {});
  const claimRef = useRef<() => void>(() => {});
  const uploadImagesRef = useRef<(files: File[]) => void>(() => {});
  const imagePickerRef = useRef<HTMLInputElement>(null);
  const imageUploadBusyRef = useRef(false);
  const imageUploadAbortRef = useRef<AbortController | null>(null);
  const imageStatusTimerRef = useRef<number | null>(null);
  // Reachable from the mode switch: a flick can still be coasting through the
  // terminal's scrollback when the reader covers it.
  const stopGlideRef = useRef<() => void>(() => {});
  const reconnectRef = useRef<() => void>(() => {});
  const controllerRef = useRef(false);
  const previousZoomRef = useRef(zoom);
  const [preview] = useState<TerminalPreview | null>(() => loadTerminalPreview(session.id));
  // The mode is app-wide (the bottom bar owns it, like zoom), but only an agent
  // has a conversation to read: a shell is a shell, and files/trace panels are
  // not this component's business at all.
  const canRender = session.cli !== 'shell' && !isPassive(session.cli);
  const reading = mode === 'reader' && canRender;
  modeRef.current = reading ? 'reader' : 'terminal';
  // Send a raw byte string to the PTY (for the mobile key-bar: arrows, Esc…).
  const sendKeyRef = useRef<(d: string) => void>(() => {});
  const [conn, setConn] = useState<ConnState>('connecting');
  // "starting…" cover while the CLI boots into an empty pane (starting on the
  // Space can take seconds). Hidden only when the screen actually SHOWS
  // something — byte counts lie because a blank-screen repaint can already be
  // kilobytes of escape sequences.
  const [booting, setBooting] = useState(true);
  // The viewer badge is gone, but file insertion still needs the input lease:
  // a watcher must never upload successfully and then have its terminal paste
  // dropped because another browser owns the PTY.
  const [hasInputControl, setHasInputControl] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name);
  // Fallback paste sheet: shown only when we can't read the clipboard directly.
  const [pasteOpen, setPasteOpen] = useState(false);
  const [imageDrop, setImageDrop] = useState(false);
  const [imageStatus, setImageStatus] = useState<{ kind: 'uploading' | 'success' | 'error'; text: string } | null>(null);
  const [imageUploadBusy, setImageUploadBusy] = useState(false);
  const [imageUploadCancelable, setImageUploadCancelable] = useState(false);
  // The reader's search bar is hidden until asked for; the header owns the
  // switch because the icon that reveals it lives there.
  const [searchOpen, setSearchOpen] = useState(false);
  // Who the header's paperclip talks to. The reader registers its own opener
  // (its files go into the composer's draft); otherwise it is the terminal's.
  const [readerAttach, setReaderAttach] = useState<{ open: () => void; disabled: boolean; reason?: string } | null>(null);

  // What the reader already knows about this conversation. The header's `i`
  // takes it as a gift when the reader is mounted, and reads the file itself
  // only when it is not (a terminal pane has parsed nothing).
  const [readerFacts, setReaderFacts] = useState<api.TraceSummary | null>(null);
  const [readerLoaded, setReaderLoaded] = useState<number | undefined>(undefined);
  const [pendingInsert, setPendingInsert] = useState<Attachment[]>([]);
  const supportsAttachments = session.cli !== 'shell';
  const canAttachFiles = supportsAttachments && conn === 'connected' && hasInputControl
    && !imageUploadBusy && pendingInsert.length === 0;
  // One paperclip, whichever view is showing. The reader's registration wins
  // while it is mounted: its files land in the composer's draft, which is the
  // thing the button is for.
  const attach = reading
    ? readerAttach
    : (supportsAttachments ? {
      open: () => imagePickerRef.current?.click(),
      disabled: !canAttachFiles,
      reason: conn === 'connected'
        ? (!hasInputControl
          ? 'Interact with the terminal to take control before attaching files'
          : (pendingInsert.length ? 'Retry the saved file first' : 'Attach files'))
        : 'Restart or reconnect the agent to attach files',
    } : null);
  const commitName = () => {
    const v = draft.trim();
    if (v && v !== session.name) onRename?.(v);
    setEditing(false);
  };

  // Hand text to xterm rather than the socket: paste() applies bracketed-paste
  // framing and normalises newlines, so a multi-line paste arrives as one blob
  // instead of a burst of Enters that submit half-typed prompts.
  const commitPaste = (text: string) => {
    if (!text) return;
    setPasteOpen(false);
    termRef.current?.paste(text);
    focusTerm();
  };

  const showImageStatus = (status: { kind: 'uploading' | 'success' | 'error'; text: string }, linger = 0) => {
    if (imageStatusTimerRef.current) window.clearTimeout(imageStatusTimerRef.current);
    setImageStatus(status);
    if (linger) imageStatusTimerRef.current = window.setTimeout(() => setImageStatus(null), linger);
  };

  const insertTerminalAttachments = async (attachments: Attachment[]) => {
    try {
      const result = await api.insertAttachments(session.id, attachments.map((attachment) => attachment.id));
      setPendingInsert([]);
      const count = attachments.length;
      showImageStatus({
        kind: 'success',
        text: result.mode === 'attached'
          ? `${count === 1 ? 'File' : `${count} files`} attached — continue typing`
          : `${count === 1 ? 'File' : `${count} files`} inserted — press Enter when ready`,
      }, 3000);
      termRef.current?.focus();
      return true;
    } catch {
      setPendingInsert(attachments);
      showImageStatus({
        kind: 'error',
        text: `${attachments.length === 1 ? 'File was' : 'Files were'} saved but not inserted`,
      });
      return false;
    }
  };

  const retryTerminalInsert = async () => {
    if (!pendingInsert.length || imageUploadBusyRef.current) return;
    if (conn !== 'connected') {
      showImageStatus({ kind: 'error', text: 'Restart or reconnect the agent before retrying' });
      return;
    }
    if (!hasInputControl) {
      showImageStatus({ kind: 'error', text: 'Interact with the terminal to take control before retrying' });
      return;
    }
    imageUploadBusyRef.current = true;
    setImageUploadBusy(true);
    showImageStatus({ kind: 'uploading', text: 'inserting saved file…' });
    try { await insertTerminalAttachments(pendingInsert); } finally {
      imageUploadBusyRef.current = false;
      setImageUploadBusy(false);
    }
  };

  const discardTerminalInsert = () => {
    const discarded = pendingInsert;
    setPendingInsert([]);
    void Promise.all(discarded.map((attachment) =>
      api.deleteAttachment(session.id, attachment.id).catch(() => undefined)));
    showImageStatus({ kind: 'success', text: `${discarded.length === 1 ? 'File' : 'Files'} removed` }, 2500);
  };

  uploadImagesRef.current = (files: File[]) => {
    if (!supportsAttachments) return;
    if (conn !== 'connected') {
      showImageStatus({ kind: 'error', text: 'Restart or reconnect the agent before attaching files' }, 5000);
      return;
    }
    if (!hasInputControl) {
      showImageStatus({ kind: 'error', text: 'Interact with the terminal to take control before attaching files' }, 5000);
      return;
    }
    if (pendingInsert.length) {
      showImageStatus({ kind: 'error', text: 'Retry the saved file before attaching another' });
      return;
    }
    if (imageUploadBusyRef.current) return;
    const candidates = files;
    if (candidates.length > MAX_ATTACHMENTS) {
      showImageStatus({ kind: 'error', text: `Attach at most ${MAX_ATTACHMENTS} files at a time` }, 4000);
      return;
    }
    const images = candidates.slice(0, MAX_ATTACHMENTS);
    if (!images.length) return;
    const invalid = images.map((file) => attachmentFileError(file)).find(Boolean);
    if (invalid) { showImageStatus({ kind: 'error', text: invalid }, 4000); return; }
    imageUploadBusyRef.current = true;
    setImageUploadBusy(true);
    const uploadController = new AbortController();
    imageUploadAbortRef.current = uploadController;
    setImageUploadCancelable(true);
    void (async () => {
      const attachments: Attachment[] = [];
      try {
        for (let index = 0; index < images.length; index += 1) {
          const fileLabel = `file${images.length > 1 ? ` ${index + 1}/${images.length}` : ''}`;
          showImageStatus({ kind: 'uploading', text: `uploading ${fileLabel} · 0%` });
          const attachment = await api.uploadAttachment(session.id, images[index], {
            signal: uploadController.signal,
            onProgress: ({ loaded, total }) => {
              const progress = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
              showImageStatus({ kind: 'uploading', text: `uploading ${fileLabel} · ${progress}%` });
            },
          });
          if (uploadController.signal.aborted) {
            await api.deleteAttachment(session.id, attachment.id).catch(() => undefined);
            throw new Error('Upload was canceled before it completed.');
          }
          attachments.push(attachment);
        }
        imageUploadAbortRef.current = null;
        setImageUploadCancelable(false);
        showImageStatus({ kind: 'uploading', text: `inserting file${images.length === 1 ? '' : 's'}…` });
        await insertTerminalAttachments(attachments);
      } catch (error) {
        if (uploadController.signal.aborted) {
          await Promise.all(attachments.map((attachment) =>
            api.deleteAttachment(session.id, attachment.id).catch(() => undefined)));
          setPendingInsert([]);
          showImageStatus({ kind: 'success', text: 'Upload canceled' }, 2500);
        } else if (attachments.length) {
          const reason = error instanceof Error ? error.message : 'upload failed';
          setPendingInsert(attachments);
          showImageStatus({
            kind: 'error',
            text: `${attachments.length} file${attachments.length === 1 ? '' : 's'} saved; another failed: ${reason}`,
          });
        } else {
          showImageStatus({ kind: 'error', text: error instanceof Error ? error.message : 'file upload failed' }, 5000);
        }
      } finally {
        if (imageUploadAbortRef.current === uploadController) imageUploadAbortRef.current = null;
        imageUploadBusyRef.current = false;
        setImageUploadBusy(false);
        setImageUploadCancelable(false);
      }
    })();
  };

  useEffect(() => () => imageUploadAbortRef.current?.abort(), []);

  // Phones have no Ctrl+V, so the key-bar needs an explicit paste. Two paths,
  // because the direct read is unavailable exactly where this app usually runs:
  //   1. navigator.clipboard.readText() — works top-level (iOS shows its own
  //      "Paste" confirmation). BLOCKED in Hugging Face's cross-origin iframe,
  //      and absent on older mobile browsers.
  //   2. a focused textarea the user pastes into with the OS long-press menu.
  //      A `paste` event's clipboardData is always readable — it's user-driven,
  //      not permissioned — so this works even when (1) is denied.
  // execCommand('paste') is not an option: unlike 'copy' it's disabled for web
  // content in every browser, so there is no synchronous legacy path.
  const requestPaste = async () => {
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        const files = await filesFromClipboardItems(items);
        if (files.length && supportsAttachments) { uploadImagesRef.current(files); return; }
      }
      const text = await navigator.clipboard?.readText?.();
      if (text) { commitPaste(text); return; }
    } catch { /* cross-origin iframe / denied permission: use DOM paste below */ }
    setPasteOpen(true);
  };

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, 'Cascadia Code', monospace",
      // Start at the requested zoom so attachment does not briefly create a
      // 100% grid and then force an avoidable reflow as the session boots.
      fontSize: Math.round((13 * zoom) / 100),
      cursorBlink: true,
      scrollback: 20000,
      theme: THEMES[theme],
      // Let users make a local selection even when an agent TUI has grabbed
      // the mouse: ⌥-drag on macOS, Shift-drag elsewhere.
      macOptionClickForcesSelection: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    let lastSelection = '';
    let osc52Text = '';
    let osc52At = 0;

    // An agent may deliberately emit OSC 52. Browsers generally reject an
    // unsolicited clipboard write, so retain it briefly and let Cmd/C perform
    // the write inside a real user gesture.
    const clipboardProvider = {
      readText: (sel: string) => (sel !== 'p' && navigator.clipboard?.readText ? navigator.clipboard.readText().catch(() => '') : ''),
      writeText: (sel: string, data: string) => {
        if (sel !== 'p') {
          osc52Text = data;
          osc52At = Date.now();
        }
      },
    };
    // addon-clipboard@0.1.0 has a (base64, provider) runtime constructor but
    // types it as (provider) — construct positionally to match the runtime.
    term.loadAddon(new (ClipboardAddon as unknown as new (b: Base64, p: typeof clipboardProvider) => ClipboardAddon)(new Base64(), clipboardProvider));
    // Make URLs in agent output clickable. An anchor click rather than
    // window.open: with noopener requested window.open returns null whether it
    // succeeded or was blocked, so there is no way to tell, and layering a
    // fallback behind it opens the link twice. noopener/noreferrer keep the
    // opened page from reaching back into the app through window.opener.
    term.loadAddon(new WebLinksAddon((event, uri) => {
      if (event?.defaultPrevented) return;
      const a = document.createElement('a');
      a.href = uri;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }));
    term.open(hostRef.current!);
    termRef.current = term;
    const host = hostRef.current!;

    let previewTimer: ReturnType<typeof setTimeout> | null = null;
    const persistPreview = () => {
      if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
      saveTerminalPreview(session.id, term);
    };
    const schedulePreview = () => {
      // Preview serialization reads every visible buffer row and writes
      // localStorage synchronously. Debounce until output/scrolling is idle so
      // it never lands in the middle of a mobile drag.
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(persistPreview, 700);
    };

    // xterm deliberately parks its real textarea far off-screen. That is fine
    // with a hardware keyboard, but a mobile browser (especially a Space inside
    // a cross-origin iframe) has no visible focus target to pan above the OSK.
    // Keep the still-transparent 1px input at the bottom of the terminal so the
    // browser's native focused-element avoidance can cross the iframe boundary.
    const mobileInput = isMobile
      ? host.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      : null;
    const anchorMobileInput = () => {
      if (!mobileInput) return;
      // xterm rewrites left/top whenever its cursor moves. Custom properties
      // survive those writes and feed the mobile !important rules in CSS.
      mobileInput.style.setProperty('--am-input-left', `${Math.max(1, Math.round(host.clientWidth / 2))}px`);
      mobileInput.style.setProperty('--am-input-top', `${Math.max(1, host.clientHeight - 12)}px`);
    };
    anchorMobileInput();

    // Track the user's semantic scroll state independently of the viewport's
    // pixel scrollTop. During a row-count change xterm can transiently report
    // the old pixel position against the new scroll height.
    let followingBottom = true;
    const scrollSub = term.onScroll(() => {
      followingBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
      schedulePreview();
    });

    // Track the committed local xterm selection so Cmd/Ctrl+C can copy it
    // synchronously — deferring (setTimeout) would break execCommand's gesture.
    // The selection we have already put on the clipboard. A copy now leaves the
    // highlight in place, so without this a selection would shadow Ctrl+C's
    // SIGINT for as long as it stayed on screen.
    let copiedSelection = '';
    const selSub = term.onSelectionChange(() => {
      lastSelection = term.hasSelection() ? selectionText(term) : '';
      copiedSelection = ''; // a fresh selection is copyable again
    });
    const copySelection = () => {
      const text = term.hasSelection() ? selectionText(term) : lastSelection;
      if (text) copyText(text);
    };
    const onCopy = (e: ClipboardEvent) => {
      if (!term.hasSelection()) return;
      const text = selectionText(term);
      if (!text || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    };
    document.addEventListener('copy', onCopy, true);

    let ws: WebSocket | null = null;
    const send = (o: unknown) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
    };
    const claimControl = () => {
      if (controllerRef.current) return;
      // Activation can precede WebSocket.open when a pane is first mounted.
      // Do not consume that claim locally: onopen will retry it once it can
      // actually reach the server.
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // Optimistic locally so the input event following this gesture is not
      // dropped. WebSocket ordering guarantees claim reaches the server first.
      controllerRef.current = true;
      setHasInputControl(true);
      send({ t: 'claim' });
    };
    claimRef.current = claimControl;
    const onPointerDown = (e: PointerEvent) => {
      // A touch may only be inspecting local scrollback. Claim lazily below if
      // the gesture actually needs to drive an application's mouse mode.
      if (e.pointerType !== 'touch') claimControl();
    };
    const onPaste = (event: ClipboardEvent) => {
      const files = event.clipboardData ? filesFromTransfer(event.clipboardData) : [];
      if (supportsAttachments && files.length) {
        event.preventDefault(); event.stopImmediatePropagation();
        uploadImagesRef.current(files);
        return;
      }
      claimControl();
    };
    const onDragEnter = (event: DragEvent) => {
      if (!supportsAttachments || !event.dataTransfer || !transferMayContainFile(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); setImageDrop(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!supportsAttachments || !event.dataTransfer || !transferMayContainFile(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent) => {
      if (!host.contains(event.relatedTarget as Node | null)) setImageDrop(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!supportsAttachments || !event.dataTransfer || !transferMayContainFile(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); setImageDrop(false);
      uploadImagesRef.current(filesFromTransfer(event.dataTransfer));
    };
    host.addEventListener('pointerdown', onPointerDown, true);
    host.addEventListener('paste', onPaste, true);
    host.addEventListener('dragenter', onDragEnter, true);
    host.addEventListener('dragover', onDragOver, true);
    host.addEventListener('dragleave', onDragLeave, true);
    host.addEventListener('drop', onDrop, true);

    // The mobile key-bar sends control sequences the on-screen keyboard can't.
    sendKeyRef.current = (d: string) => {
      claimControl();
      send({ t: 'i', d });
      endBoot();
    };

    // ⌘/Ctrl+C copies a local selection. Without one, Ctrl+C remains SIGINT;
    // Cmd+C may accept a recent OSC 52 payload deliberately emitted by the app.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C') && term.hasSelection()) {
        // The highlight stays after copying — watching it vanish the instant you
        // copy reads as "did that work?", and every other app keeps it. What it
        // must not do is shadow SIGINT forever, so a second Ctrl+C on a
        // selection we already copied goes to the process instead. Cmd+C is
        // never an interrupt, so it just copies again.
        const text = selectionText(term);
        if (e.ctrlKey && !e.metaKey && text && text === copiedSelection) return true;
        copySelection();
        copiedSelection = text;
        return false;
      }
      if (e.metaKey && (e.key === 'c' || e.key === 'C')) {
        if (osc52Text && Date.now() - osc52At < 120_000) copyText(osc52Text);
        return false;
      }
      claimControl();
      return true;
    });
    // The only local fit: this terminal is still empty, so there is no buffer to
    // reflow, and it gives the initial size we open the socket with. Every later
    // size change goes through resync() as a REQUEST — see there.
    try { fit.fit(); } catch { /* layout not ready yet */ }
    // Re-measure once the webfont is ready (glyph width changes vs the fallback).
    document.fonts?.ready.then(() => resync());

    let closedByUs = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    // Reconnect with backoff: a sleeping/unreachable Space shouldn't be hammered
    // every second by every open pane. Reset once a connection succeeds.
    let retryDelay = 1200;

    // Does the visible screen show real text in its UPPER two-thirds? Agent
    // TUIs paint their bottom input bar first and load the actual content
    // (banner, resumed history) seconds later — only the upper region tells us
    // the pane is genuinely ready. Shell prompts paint at the top anyway.
    const screenHasContent = () => {
      try {
        const buf = term.buffer.active;
        const upper = Math.max(2, Math.floor(term.rows * 2 / 3));
        for (let y = 0; y < upper; y++) {
          const line = buf.getLine(buf.baseY + y);
          if (line && line.translateToString(true).trim().length >= 2) return true;
        }
      } catch { return true; } // never trap the cover on an internal error
      return false;
    };
    let bootLive = false;
    let bootTimer: ReturnType<typeof setTimeout> | null = null;   // safety cap
    let bootCheck: ReturnType<typeof setTimeout> | null = null;   // throttled content probe
    const endBoot = () => {
      bootLive = false;
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
      if (bootCheck) { clearTimeout(bootCheck); bootCheck = null; }
      setBooting(false);
    };
    const connect = () => {
      controllerRef.current = false;
      setHasInputControl(false);
      setConn('connecting');
      // A reconnect keeps the already-rendered xterm visible. On a fresh page,
      // `booting` instead exposes the saved preview until canonical restore has
      // painted real content.
      const needsCover = !screenHasContent();
      setBooting(needsCover);
      bootLive = needsCover;
      if (bootTimer) clearTimeout(bootTimer);
      bootTimer = needsCover ? setTimeout(endBoot, 20_000) : null;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/ws?session=${encodeURIComponent(session.id)}&cols=${term.cols}&rows=${term.rows}`;
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        setConn('connected');
        retryDelay = 1200;
        // Selecting a terminal is an explicit foreground action on mobile.
        // Claim before reporting its fit so an already-open desktop does not
        // leave the phone rendering a clipped desktop-sized canonical grid.
        if (isMobile && !document.hidden) claimControl();
        requestSize();
      };
      ws.onmessage = (e) => {
        const d = typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer);
        // Control frame: a leading NUL sentinel that raw pty output never
        // produces — handle it instead of writing to the term.
        if (typeof d === 'string' && d.startsWith(MODE_CTRL)) {
          try {
            const m = JSON.parse(d.slice(MODE_CTRL.length));
            if (m.t === 'grid' || m.t === 'restore') {
              controllerRef.current = !!m.controller;
              setHasInputControl(!!m.controller);
              const applyGrid = () => {
                try {
                  // xterm can retain the old pixel scrollTop when the viewport
                  // gains rows (notably landscape -> portrait), which leaves a
                  // formerly-live view stranded in history. Preserve the
                  // semantic bottom anchor without disturbing someone who is
                  // deliberately reading scrollback.
                  const wasAtBottom = m.reset || followingBottom;
                  if (m.reset) {
                    term.reset();
                    term.clear();
                  }
                  if (m.cols > 0 && m.rows > 0 && (term.cols !== m.cols || term.rows !== m.rows)) {
                    term.resize(m.cols, m.rows);
                  }
                  if (wasAtBottom) {
                    term.scrollToBottom();
                    followingBottom = true;
                  }
                  schedulePreview();
                } catch { /* ignore */ }
              };
              // Writes are asynchronous. A queued empty write is a barrier so
              // resize/reset cannot reinterpret bytes from the preceding grid.
              const geometryChanged = m.cols > 0 && m.rows > 0
                && (term.cols !== m.cols || term.rows !== m.rows);
              if (m.reset || geometryChanged) term.write('', applyGrid);
              else applyGrid();
            }
          } catch { /* ignore */ }
          return;
        }
        term.write(d, schedulePreview);
        // Probe shortly after each burst (throttled; write() is async).
        if (bootLive && !bootCheck) {
          bootCheck = setTimeout(() => {
            bootCheck = null;
            if (bootLive && screenHasContent()) endBoot();
          }, 150);
        }
      };
      ws.onclose = (e) => {
        // A real process exit: stop here and let the user relaunch. Anything
        // else is a transient drop (sleep/wake, network) → auto-reconnect and
        // reattach to the still-running backend session.
        endBoot();
        if (e.code === EXIT_CODE) { setConn('exited'); return; }
        setConn('closed');
        if (!closedByUs) {
          retry = setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 1.7, 15_000);
        }
      };
      ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
    };
    // Manual restart: clear the dead run's screen so the content probe watches
    // the new process paint, not leftovers.
    reconnectRef.current = () => { if (retry) clearTimeout(retry); retryDelay = 1200; try { term.reset(); } catch { /* ignore */ } connect(); };

    // Report the pane's preferred size without locally fitting its terminal.
    // Only the current controller's preference changes the canonical grid;
    // watchers retain theirs for a future claim.
    let resyncTimer: ReturnType<typeof setTimeout> | null = null;
    const requestSize = () => {
      const box = hostRef.current;
      if (!box || box.clientWidth < 40 || box.clientHeight < 40) return;
      try {
        const d = fit.proposeDimensions();
        const cols = d ? Math.max(1, d.cols) : 0;
        const rows = d ? Math.max(1, d.rows) : 0;
        if (cols > 0 && rows > 0) send({ t: 'r', cols, rows });
      } catch { /* layout not ready */ }
    };
    // ResizeObserver fires every frame while a window is dragged or the sidebar
    // animates. Ask once, when it stops.
    const resync = () => {
      anchorMobileInput();
      if (resyncTimer) clearTimeout(resyncTimer);
      resyncTimer = setTimeout(() => { resyncTimer = null; requestSize(); }, 80);
    };
    resyncRef.current = resync;
    // xterm deliberately ignores DOM scroll events while its viewport is under
    // display:none. Output can still advance its logical viewport in that
    // state, leaving scrollTop behind; the next wheel then calculates a large
    // jump from two contradictory positions. Move away and back through the
    // public scroll API once the pane has layout again. This makes xterm rebuild
    // its scroll area and reconcile scrollTop without changing where the user
    // was reading.
    reconcileScrollRef.current = () => {
      const box = hostRef.current;
      const buffer = term.buffer.active;
      if (!box || box.clientWidth < 40 || box.clientHeight < 40 || buffer.baseY <= 0) return;
      const step = buffer.viewportY > 0 ? -1 : 1;
      term.scrollLines(step);
      term.scrollLines(-step);
    };
    const onReturn = () => resync();
    const onVisible = () => { if (!document.hidden) onReturn(); };
    // Typing means the user sees enough to interact — drop the boot cover.
    // Real keystrokes only (onKey): onData ALSO fires for xterm's automatic
    // replies to the TUI's terminal queries (DA/CPR), which arrive instantly
    // on attach and must not count as "the user typed".
    const keySub = term.onKey(() => { claimControl(); endBoot(); });
    // Watchers render output but do not answer terminal queries. This prevents
    // N browser emulators from injecting N DA/CPR responses into one PTY.
    const dataSub = term.onData((d) => {
      if (controllerRef.current) send({ t: 'i', d });
    });
    const ro = new ResizeObserver(resync);
    ro.observe(hostRef.current!);
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onVisible);

    // A phone drag always navigates browser-retained terminal history. Passing
    // it to an agent's mouse mode at the live bottom makes Claude consume the
    // gesture without moving xterm's viewport, leaving no reliable way back
    // through history on touch-only devices. xterm 5.5 registers no touch
    // listeners of its own (verified against the bundled lib) and .term-host
    // sets touch-action:none on mobile while the terminal is what you see, so
    // neither xterm nor the browser will pan: this is the only touch scrolling
    // a phone has, in every pane. Reader mode is the exception at both ends —
    // it hands touch-action back (.term-host.reading) and these handlers stand
    // down — because there the scroller you mean to drag is its own.
    //
    // Convert the drag to whole rows and carry the remainder in `residual`.
    // Quantising each event to a fixed notch instead silently drops whatever
    // does not fill one — a 96px drag moved the view 68px — and that shortfall
    // is what reads as lag, because the text trails the finger by design.
    // scrollLines moves ydisp, the authority the viewport follows.
    // The frame, not the inner measurement box: .term-host is what carries the
    // touch-action rule and what the user actually drags, and it stays the
    // gesture target however the box inside it is nested.
    const frame = frameRef.current ?? host;
    const viewport = host.querySelector<HTMLElement>('.xterm-viewport');
    let touchY: number | null = null;
    let residual = 0;        // px of gesture not yet worth a whole row
    let glideFrame = 0;
    let velocity = 0;        // px/ms, signed like deltaY (positive scrolls down)
    let lastMoveAt = 0;
    // The scroll area spans every line in the buffer, so its height over that
    // line count is the row height under whichever renderer is attached.
    const scrollByPixels = (px: number) => {
      const lines = term.buffer.active.length;
      const cell = viewport && lines ? viewport.scrollHeight / lines : 0;
      if (!cell) return 0;
      residual += px;
      const rows = Math.trunc(residual / cell);
      if (!rows) return 0;
      residual -= rows * cell;
      term.scrollLines(rows);
      return rows;
    };
    const stopGlide = () => { if (glideFrame) { cancelAnimationFrame(glideFrame); glideFrame = 0; } };
    stopGlideRef.current = stopGlide;
    // Reader mode covers this frame with its own scroller. These listeners sit
    // on .term-host in CAPTURE and preventDefault, so without this guard every
    // drag over the conversation was eaten here and spent on the hidden
    // terminal's scrollback: the trace could not be scrolled back at all on a
    // phone, which is the only place this gesture exists.
    const onTouchStart = (e: TouchEvent) => {
      if (modeRef.current === 'reader') return;
      stopGlide();               // a new touch takes over from any coasting
      velocity = 0;
      residual = 0;
      touchY = e.touches[0].clientY;
      lastMoveAt = e.timeStamp;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (modeRef.current === 'reader') return;
      if (touchY == null || !e.touches.length) return;
      const y = e.touches[0].clientY;
      const deltaY = touchY - y;
      touchY = y;
      if (deltaY === 0) return;
      const dt = e.timeStamp - lastMoveAt;
      lastMoveAt = e.timeStamp;
      // Weight the newest sample heavily: what matters is the speed at release,
      // and a touch stream is noisy. Ignore a stale gap (a paused finger) and
      // anything faster than a touch stream can legitimately be — a single
      // coalesced jump over a 2ms gap is not a 48px/ms flick, and dividing by
      // it would launch the glide clean through the buffer. A hand tops out
      // around 4px/ms; real events arrive 8-16ms apart.
      if (dt >= 4 && dt < 100) {
        const sample = Math.max(-4, Math.min(4, deltaY / dt));
        velocity = velocity * 0.3 + sample * 0.7;
      }
      scrollByPixels(deltaY);
      if (e.cancelable) e.preventDefault(); // keep the page from rubber-banding
      // This listener runs in capture before xterm's listener on the same host.
      // stopPropagation alone would still allow that second handler.
      e.stopImmediatePropagation();
    };
    const onTouchEnd = () => {
      touchY = null;
      const v0 = velocity;
      velocity = 0;
      // A drag that began on the terminal and ended after the switch flipped
      // must not launch anything: the mode is broadcast app-wide, so the flip
      // can come from another pane rather than from this hand.
      if (modeRef.current === 'reader') return;
      // Only a flick coasts. A slow, deliberate drag through history must land
      // exactly where the finger left it — drifting past the line someone was
      // reading is worse than having no momentum at all. 0.4px/ms is about
      // 400px/s: far above a careful drag, far below a real flick.
      if (!viewport || Math.abs(v0) < 0.4) return;
      let v = v0;
      let previous = 0;
      const glide = (now: number) => {
        // Clamp the step so a dropped frame does not teleport the viewport.
        const frame = previous ? Math.min(now - previous, 50) : 16;
        previous = now;
        const before = term.buffer.active.viewportY;
        const rows = scrollByPixels(v * frame);
        v *= 0.95 ** (frame / 16);      // ~5% per 60Hz frame, frame-rate neutral
        // Stop at a standstill, or the moment a requested row does not move the
        // view: that is either end of the buffer, and coasting into it drags.
        if (Math.abs(v) < 0.02 || (rows !== 0 && term.buffer.active.viewportY === before)) {
          glideFrame = 0;
          return;
        }
        glideFrame = requestAnimationFrame(glide);
      };
      glideFrame = requestAnimationFrame(glide);
    };
    const onTouchCancel = () => { touchY = null; velocity = 0; stopGlide(); };
    frame.addEventListener('touchstart', onTouchStart, { passive: true });
    frame.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    frame.addEventListener('touchend', onTouchEnd);
    frame.addEventListener('touchcancel', onTouchCancel);

    connect();

    return () => {
      closedByUs = true;
      if (retry) clearTimeout(retry);
      if (bootTimer) clearTimeout(bootTimer);
      if (bootCheck) clearTimeout(bootCheck);
      if (resyncTimer) clearTimeout(resyncTimer);
      persistPreview();
      ro.disconnect();
      host.removeEventListener('pointerdown', onPointerDown, true);
      host.removeEventListener('paste', onPaste, true);
      host.removeEventListener('dragenter', onDragEnter, true);
      host.removeEventListener('dragover', onDragOver, true);
      host.removeEventListener('dragleave', onDragLeave, true);
      host.removeEventListener('drop', onDrop, true);
      document.removeEventListener('copy', onCopy, true);
      frame.removeEventListener('touchstart', onTouchStart);
      frame.removeEventListener('touchmove', onTouchMove, true);
      frame.removeEventListener('touchend', onTouchEnd);
      frame.removeEventListener('touchcancel', onTouchCancel);
      stopGlide();
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onVisible);
      dataSub.dispose();
      keySub.dispose();
      scrollSub.dispose();
      selSub.dispose();
      try { ws?.close(); } catch { /* ignore */ }
      term.dispose();
      termRef.current = null;
      resyncRef.current = () => {};
      reconcileScrollRef.current = () => {};
      claimRef.current = () => {};
      uploadImagesRef.current = () => {};
      if (imageStatusTimerRef.current) window.clearTimeout(imageStatusTimerRef.current);
    };
  }, [session.id]);

  // Switch theme live without tearing down the terminal / connection.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[theme];
  }, [theme]);

  // Font size and PTY geometry move together. The controller asks the server
  // for the grid that actually fits this pane; the confirmed grid then resizes
  // every viewer in order with the PTY output stream.
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    const changed = previousZoomRef.current !== zoom;
    previousZoomRef.current = zoom;
    // Zoom is an explicit interaction outside the terminal element. If this
    // pane is a watcher, take the geometry lease before reporting its newly
    // fitted size; otherwise only the local glyphs grow and the canonical grid
    // remains too large, clipping the bottom/right of the pane.
    if (changed && active) claimRef.current();
    t.options.fontSize = Math.round((13 * zoom) / 100);
    if (active) resyncRef.current();
  }, [zoom, active]);

  // A retained pane can receive output while display:none. Reconcile xterm's
  // logical and DOM scroll positions as soon as any cached tile becomes visible,
  // including non-focused panes in a group.
  useLayoutEffect(() => {
    if (!visible) return;
    reconcileScrollRef.current();
  }, [visible]);

  // Move keyboard focus into the terminal whenever this pane becomes the active
  // one (e.g. selected from the sidebar, or newly created).
  useEffect(() => {
    if (!active) return;
    // A retained pane may have spent time under display:none. Reclaim and
    // remeasure only after its grid cell has layout again; hidden panes never
    // get to resize the canonical PTY.
    const t = setTimeout(() => {
      claimRef.current();
      resyncRef.current();
      focusTerm();
    }, 0);
    return () => clearTimeout(t);
  }, [active]);

  // In reader mode the terminal is covered but still mounted — and a mounted xterm
  // with focus swallows every keystroke into the agent's TTY, invisibly. Hand
  // focus back when the terminal is on top again.
  useEffect(() => {
    // The glide too: a flick left coasting under the reader keeps moving a
    // viewport nobody can see, and no touch can catch it — the handler that
    // would stop it now stands down in this mode.
    if (reading) {
      termRef.current?.blur();
      stopGlideRef.current();
      imageUploadAbortRef.current?.abort();
    }
    else if (focused) termRef.current?.focus();
  }, [reading, focused]);

  // Focused panes tint toward THEIR agent's brand color, not the app accent.
  const tint = cli?.color;
  const pathLabel = workspaceLabel(session.path);
  const group = groupLabel(groupName);
  return (
    <div
      className={`slot${focused ? ' focused' : ''}`}
      style={focused && tint ? { borderColor: `color-mix(in srgb, ${tint} 45%, var(--border))` } : undefined}
      onMouseDown={() => onFocus?.()}
    >
      {/* preventDefault so clicking the (non-focusable) header keeps keyboard
          focus in the terminal instead of the browser blurring it — except when
          the header doubles as a drag handle, where it would block dragstart. */}
      <div
        className={`pane-head${dragId ? ' draggable' : ''}`}
        style={focused && tint ? { background: `color-mix(in srgb, ${tint} 8%, var(--panel))` } : undefined}
        draggable={!!dragId}
        onDragStart={dragId ? (e) => { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; onDragActive?.(true); } : undefined}
        onDragEnd={dragId ? () => onDragActive?.(false) : undefined}
        onMouseDown={(e) => { if (!dragId) e.preventDefault(); onFocus?.(); focusTerm(); }}
      >
        <div className="ph-left">
          {onBack && (
            // Sits in the header rather than in a bar of its own above it: a
            // phone pays for that bar in the one dimension the terminal needs.
            <button
              className="mini-btn ph-back"
              title="Back to list"
              aria-label="Back to list"
              draggable={false}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onBack(); }}
            >
              <BackGlyph />
            </button>
          )}
          <Logo cli={session.cli} size={16} tint={tint} />
          {/* Where the agent runs, beside what it is. It was on the right, in
              among the controls; it is not a control. Still hidden on a phone —
              moving it did not create room — where the `i` panel carries it
              instead (see TraceInfo's Folder line). */}
          <span className="ph-path" title={pathLabel}>{pathLabel}</span>
        </div>
        {editing ? (
          <input
            className="ph-title-input" autoFocus value={draft}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setEditing(false); }}
          />
        ) : (
          // Two spans, not one string: the group is a prefix that must give way
          // before the agent's own name does (see .ph-group in styles.css), and
          // the rename below still edits the name alone.
          <span
            className="ph-title"
            title={`${sessionTitle(session.name, groupName)} · ${pathLabel} · double-click to rename`}
            onDoubleClick={() => { setDraft(session.name); setEditing(true); }}
          >
            {/* The state mark reads as part of the name now: what this agent is
                doing, immediately left of who it is, both centred together. */}
            <span className={`status ${session.state}`} title={`${STATE_LABEL[session.state]} · ${conn}`} />
            {group && <span className="ph-group">[{group}]</span>}
            <span className="ph-name">{session.name}</span>
          </span>
        )}
        <div className="ph-right">
          {/* One style for all four: no boxes, one size, even spacing (.ph-btn).
              The attachment picker belongs to whichever view is showing — the
              terminal's insert flow, or the reader's composer, which registers
              its own opener below. */}
          {attach && (
            <button
              className="ph-btn ph-image"
              title={attach.reason || 'Attach files'}
              aria-label="Attach files"
              disabled={attach.disabled}
              draggable={false}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); attach.open(); }}
            >
              <svg viewBox="0 0 18 18" aria-hidden="true">
                <path d="M6.2 9.7 10.8 5a2.5 2.5 0 0 1 3.6 3.5l-6.2 6.3a4 4 0 0 1-5.7-5.7l6-6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          )}
          {supportsAttachments && !reading && (
            <input
              ref={imagePickerRef}
              className="image-file-input"
              type="file"
              multiple
              disabled={!canAttachFiles}
              onChange={(event) => {
                uploadImagesRef.current(Array.from(event.currentTarget.files || []));
                event.currentTarget.value = '';
              }}
            />
          )}
          {/* Search searches the TRANSCRIPT, so it is offered where there is one
              to search. Closing it clears the query — a search filters the
              reader to matching turns, and leaving that filter in place with no
              visible search box is a reader that looks broken. */}
          {reading && (
            <button
              className={`ph-btn ph-search${searchOpen ? ' on' : ''}`}
              title={searchOpen ? 'Hide search' : 'Search this conversation'}
              aria-label={searchOpen ? 'Hide search' : 'Search this conversation'}
              aria-expanded={searchOpen}
              draggable={false}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); setSearchOpen((open) => !open); }}
            >
              <SearchGlyph />
            </button>
          )}
          {!isRemote(session.cli) && (
            <TraceInfo
              session={session}
              facts={reading ? readerFacts : undefined}
              turnsLoaded={reading ? readerLoaded : undefined}
              folder={pathLabel}
              onShare={onShare}
            />
          )}
          <button className="ph-btn ph-close" title="Close" aria-label="Close" onClick={(e) => { e.stopPropagation(); onClose(); }}><CloseGlyph /></button>
        </div>
      </div>
      {/* `reading` releases the frame's touch-action: the phone rule pins it to
          `none` so the drag handler above owns terminal panning, and that also
          forbids the browser from panning anything nested inside — including
          the reader's own scroller. */}
      <div className={`term-host${reading ? ' reading' : ''}${imageDrop && !reading ? ' image-drop' : ''}`} ref={frameRef}>
        <div className="term-fill" ref={hostRef} />
        {/* Reader mode draws OVER the terminal rather than replacing it: xterm needs
            layout to fit, and detaching tmux costs a repaint and can trip the
            handoff path. The terminal stays mounted and connected underneath. */}
        {reading && visible !== false && (
          // The zoom is one number for both modes: the terminal spends it on its
          // font size, the reader on --cx-base — the size every type size in the
          // conversation grammar is expressed against (conversation.css). Same
          // 13px at 100%, so the two forms of the same session read alike.
          <div
            className="pane-reader"
            style={{ '--cx-base': `${(13 * zoom) / 100}px` } as CSSProperties}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {readerEnabled === false
              ? <div className="cxv-empty mono">reading the trace…</div>
              : <ConversationView
                  session={session}
                  isMobile={isMobile}
                  searchOpen={searchOpen}
                  onCloseSearch={() => setSearchOpen(false)}
                  onAttachPicker={setReaderAttach}
                  onHead={(head) => { setReaderFacts(head); setReaderLoaded(head?.loaded); }}
                  onReady={onReaderReady}
                  readyKey={readerReadyKey}
                />}
          </div>
        )}
      </div>
      {imageStatus && !reading && (
        <div
          className={`term-image-status ${imageStatus.kind}${pendingInsert.length || imageUploadCancelable ? ' has-action' : ''} mono`}
          role={imageStatus.kind === 'error' ? 'alert' : 'status'}
          aria-live={imageStatus.kind === 'error' ? 'assertive' : 'polite'}
        >
          <span>{imageStatus.text}</span>
          {imageUploadCancelable && (
            <button type="button" onClick={() => imageUploadAbortRef.current?.abort()}>cancel</button>
          )}
          {pendingInsert.length > 0 && (
            <>
              <button type="button" onClick={retryTerminalInsert} disabled={imageUploadBusy || conn !== 'connected' || !hasInputControl}>retry</button>
              <button type="button" onClick={discardTerminalInsert} disabled={imageUploadBusy}>remove</button>
            </>
          )}
        </div>
      )}
      {isMobile && conn === 'connected' && !reading && (
        // Control keys the phone keyboard lacks — needed for TUI menus (model
        // pickers, etc.). preventDefault keeps terminal focus so the keyboard
        // stays up; the send also refocuses the terminal.
        <div className="term-keybar mono" onPointerDown={(e) => e.preventDefault()}>
          {([
            ['esc', '\x1b'], ['tab', '\t'],
            ['←', '\x1b[D'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['→', '\x1b[C'],
            ['⏎', '\r'], ['^C', '\x03'],
          ] as [string, string][]).map(([label, seq]) => (
            <button
              key={label}
              className="tk-btn"
              onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); sendKeyRef.current(seq); focusTerm(); }}
            >{label}</button>
          ))}
          {/* Unlike the key buttons this must NOT preventDefault: the clipboard
              read needs a real click gesture. stopPropagation keeps the bar's
              own preventDefault (which preserves terminal focus) off this one. */}
          <button
            className="tk-btn tk-paste"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); requestPaste(); }}
          >paste</button>
        </div>
      )}
      {!reading && pasteOpen && (
        // Reached when the clipboard read was blocked (cross-origin iframe) or
        // came back empty. The textarea is the whole point: long-press inside it
        // and the OS offers Paste, which fires a `paste` event we can read.
        <div className="term-paste" onPointerDown={(e) => e.stopPropagation()}>
          <textarea
            className="tp-input mono"
            autoFocus
            rows={1}
            // The instruction lives IN the field, because the field IS the
            // target and a separate hint line only raised the question "below
            // what?". Focusing it makes iOS/Android offer Paste on their own
            // (that callout is what usually gets tapped); long-press is the
            // manual backup when they don't.
            placeholder="tap Paste — or long-press here"
            onPaste={(e) => {
              const files = filesFromTransfer(e.clipboardData);
              if (supportsAttachments && files.length) {
                e.preventDefault(); setPasteOpen(false); uploadImagesRef.current(files);
                return;
              }
              const text = e.clipboardData.getData('text/plain');
              if (text) { e.preventDefault(); commitPaste(text); }
            }}
            // Typed text (or a paste some browsers deliver as plain input) still
            // needs a way out; Enter sends, Shift+Enter keeps the newline.
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setPasteOpen(false); focusTerm(); }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitPaste((e.target as HTMLTextAreaElement).value);
              }
            }}
          />
          <button className="tp-x" onClick={() => { setPasteOpen(false); focusTerm(); }}>cancel</button>
        </div>
      )}
      {/* The terminal's own covers — restoring, booting, exited — belong to the
          terminal. Reader mode is a complete surface over it, reading a file
          that does not care whether the PTY is reconnecting, and these paint
          ABOVE the overlay (z-index 4 vs 3): a reconnect turned the reader
          into a terminal screen with a reader toolbar on top. */}
      {!reading && booting && preview && conn !== 'exited' && (
        <div className="term-preview mono" aria-label="Restoring terminal">
          <pre style={{ fontSize: `${Math.round((13 * zoom) / 100)}px` }}>{preview.rows.join('\n')}</pre>
          <span>restoring last view…</span>
        </div>
      )}
      {!reading && booting && !preview && conn !== 'exited' && (
        <div className="term-boot mono">
          {conn === 'connecting' ? 'connecting' : `starting ${cli?.label || session.cli}`}<span className="et-cursor" />
        </div>
      )}
      {!reading && conn === 'exited' && (
        <div className="term-exit mono">
          <div className="tx-row">
            <span>{cli?.label || session.cli} stopped · output preserved</span>
            <button
              className="tx-btn"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); reconnectRef.current(); }}
            ><RefreshGlyph /> restart</button>
          </div>
        </div>
      )}
    </div>
  );
}
