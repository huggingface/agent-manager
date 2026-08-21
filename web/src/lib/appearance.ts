// What the whole interface looks like: one palette and one typeface, chosen in
// Settings and applied at the root.
//
// Both are just data attributes on <html>. Everything in the app already reads
// its colours from custom properties (--bg, --panel, --accent, --text, …) and
// its type from --font-sans / --font-mono, so a palette is a block of property
// values in styles.css and a typeface is two font stacks. No component knows
// which one is active, and none should.
//
// The status marks are the exception, and deliberately so: the spinner cell
// draws its braille glyph from --font-mark, which is pinned to the bundled
// Geist Mono rather than following --font-mono. See styles.css — the frames the
// static states draw are measured from that glyph's ink, so letting the
// typeface move it would break the sidebar and the Overview.
import { readStored, writeStored } from './stored';

export type PaletteId = 'teal' | 'indigo' | 'paper' | 'phosphor' | 'plum' | 'mono';
export type TypefaceId = 'geist' | 'departure' | 'jetbrains' | 'plex';

export interface Palette {
  id: PaletteId;
  name: string;
  note: string;
  /** Swatch for the chooser: [background, panel, accent] in the light theme. */
  swatch: [string, string, string];
  swatchDark: [string, string, string];
}

export interface Typeface {
  id: TypefaceId;
  name: string;
  note: string;
  /** Rendered in the chooser using the typeface itself. */
  sample: string;
}

export const PALETTES: Palette[] = [
  {
    id: 'teal', name: 'Teal', note: 'What the app has always been.',
    swatch: ['#eef1f3', '#ffffff', '#0e7c86'], swatchDark: ['#0b0f13', '#11181e', '#2bb3bd'],
  },
  {
    id: 'indigo', name: 'Indigo', note: 'Cooler and quieter, with the accent doing the work.',
    swatch: ['#edeff7', '#ffffff', '#4b45d4'], swatchDark: ['#0b0c14', '#14161f', '#9a9bfb'],
  },
  {
    id: 'paper', name: 'Paper', note: 'Warm and low-contrast, like reading off paper.',
    swatch: ['#f2ece1', '#fbf7f0', '#a94a17'], swatchDark: ['#16130f', '#1d1915', '#e58f52'],
  },
  {
    id: 'phosphor', name: 'Phosphor', note: 'A terminal that got out. Green on near-black.',
    swatch: ['#e7efe9', '#ffffff', '#0f7040'], swatchDark: ['#05080a', '#0a1013', '#3fdd86'],
  },
  {
    id: 'plum', name: 'Plum', note: 'Neutral greys with one loud colour in them.',
    swatch: ['#f3eef4', '#ffffff', '#9c2189'], swatchDark: ['#100b12', '#181320', '#e884d6'],
  },
  {
    // No hue anywhere, the accent and danger included. What hue used to do,
    // lightness does: the accent is the extreme of the one channel there is
    // (21:1 on panel, 3.7:1 clear of muted, where a hued palette separates
    // those two by 1.0–1.5:1 and leans on colour for the rest).
    id: 'mono', name: 'Mono', note: 'Black and white. No hue at all — lightness does every job.',
    swatch: ['#eeeeee', '#ffffff', '#000000'], swatchDark: ['#0a0a0a', '#141414', '#ffffff'],
  },
];

export const TYPEFACES: Typeface[] = [
  {
    id: 'geist', name: 'Geist', note: 'The current pair — Geist and Geist Mono.',
    sample: 'agent-manager 0123',
  },
  {
    id: 'departure', name: 'Departure Mono', note: 'A pixel font, everywhere. The whole app reads like a terminal.',
    sample: 'agent-manager 0123',
  },
  {
    id: 'jetbrains', name: 'JetBrains Mono', note: 'A taller mono for the terminal, Geist for prose.',
    sample: 'agent-manager 0123',
  },
  {
    id: 'plex', name: 'IBM Plex', note: 'Plex Sans and Plex Mono: warmer, a little more formal.',
    sample: 'agent-manager 0123',
  },
];

const PALETTE_IDS = PALETTES.map((p) => p.id);
const TYPEFACE_IDS = TYPEFACES.map((t) => t.id);

export const DEFAULT_PALETTE: PaletteId = 'teal';
export const DEFAULT_TYPEFACE: TypefaceId = 'geist';

export const readPalette = (): PaletteId => {
  const v = readStored('am-palette');
  return (PALETTE_IDS as string[]).includes(v || '') ? (v as PaletteId) : DEFAULT_PALETTE;
};

export const readTypeface = (): TypefaceId => {
  const v = readStored('am-typeface');
  return (TYPEFACE_IDS as string[]).includes(v || '') ? (v as TypefaceId) : DEFAULT_TYPEFACE;
};

export const writePalette = (v: PaletteId) => writeStored('am-palette', v);
export const writeTypeface = (v: TypefaceId) => writeStored('am-typeface', v);

/**
 * Put the choice on <html>, from wherever it is decided.
 *
 * Called from main.tsx before the first render and from the setters, NOT only
 * from an effect: React runs a child's effects before its parent's, so a
 * component that reads the resolved tokens — TerminalPane, which has to hand
 * xterm real colour values because a canvas inherits nothing — would otherwise
 * read the previous palette on the render that changed it. Setting the
 * attribute at the moment the value is decided keeps the DOM ahead of everyone
 * who reads it, and doing it before the first render avoids a frame of teal.
 */
export const applyAppearance = (palette: PaletteId, typeface: TypefaceId) => {
  const root = document.documentElement;
  root.dataset.palette = palette;
  root.dataset.typeface = typeface;
};

/** One root token, resolved, with a fallback for a denied or odd computed style. */
export const token = (name: string, fallback: string): string => {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
};

/**
 * The same colour with an alpha suffix, for the handful of places that need a
 * translucent version of a token (xterm's selection). Only #rrggbb is extended;
 * anything else is returned untouched, because xterm parses its own colours and
 * a `color-mix()` string is not something it understands.
 */
export const withAlpha = (colour: string, alphaHex: string): string =>
  (/^#[0-9a-f]{6}$/i.test(colour) ? `${colour}${alphaHex}` : colour);
