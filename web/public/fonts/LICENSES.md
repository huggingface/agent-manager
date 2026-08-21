# Bundled fonts

Self-hosted on purpose: a CDN would leave the Space rendering a fallback, and a
study of a typeface you cannot see is worthless. Every file here is committed —
no build step fetches anything at any point.

| File | Family | Version | Licence | What is in the file |
|---|---|---|---|---|
| `Geist.woff2`, `GeistMono.woff2` | Geist, Geist Mono (Vercel) | as vendored before this change | SIL Open Font License 1.1 | as previously vendored |
| `DepartureMono.woff2` | Departure Mono (Helena Zhang) | 1.500 | SIL Open Font License 1.1 | **the whole family**, unmodified — Latin, Greek, Cyrillic and symbols, 22 KB |
| `JetBrainsMono.woff2`, `JetBrainsMono-SemiBold.woff2` | JetBrains Mono (JetBrains) | 2.304 | SIL Open Font License 1.1 | Latin subset |
| `IBMPlexSans.woff2`, `IBMPlexSans-SemiBold.woff2`, `IBMPlexMono.woff2` | IBM Plex Sans, IBM Plex Mono (IBM) | 1.1.0 | SIL Open Font License 1.1 | Latin subset |

The JetBrains Mono and IBM Plex files are the `latin` subsets published by
Google Fonts (15–24 KB each) rather than the full upstream releases (46–95 KB),
which carry Cyrillic, Greek and Vietnamese this interface never renders.
Departure Mono ships as one 22 KB file for the whole family, so it is vendored
whole — it does contain Greek and Cyrillic, and subsetting it would have saved
nothing worth the extra step.

All four families are OFL 1.1, which permits bundling and serving them from this
Space. The OFL requires that the fonts not be sold on their own and that a
modified version be renamed; neither applies — these files are unmodified (the
two subsets are the upstream publisher's own), served as part of the application.

## Licence texts

The authoritative copy of each licence is **in this repository**, beside the
fonts, in `licenses/`. Each was taken from the release that the bundled file
came from:

| File | Taken from |
|---|---|
| `licenses/DepartureMono-OFL.txt` | the `DepartureMono-1.500` release archive (`departuremono.com`), byte-for-byte |
| `licenses/JetBrainsMono-OFL.txt` | the JetBrains Mono 2.304 release archive (`OFL.txt`) |
| `licenses/IBMPlex-OFL.txt` | the IBM Plex 1.1.0 release archive (`LICENSE.txt`) |

**A trap worth recording:** the Departure Mono *repository's* top-level
`LICENSE` on `main` is the **MIT licence for the project's website**, not for the
font. The font's licence is the OFL text shipped inside the release archive, which
is the file vendored here. Do not link the repository's `LICENSE` as the font's
licence — an earlier version of this file did.

Upstream, for reference: [Departure Mono](https://departuremono.com) ·
[JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) ·
[IBM Plex](https://github.com/IBM/plex) ·
[Geist](https://github.com/vercel/geist-font)

## The braille glyph, and why the marks pin their own font

**None of these fonts — including the Geist Mono already here — contains the
braille glyphs the status marks are drawn from.** Measured in the installed
Chromium, rasterised at 16× with alpha ≥ 16, `⠿` at 12.5px:

| Font | ink | ink top |
|---|---|---|
| Geist Mono | 5.5 × 8.8125px | 1.1875px |
| Departure Mono | 5.5 × 8.8125px | 2.1875px |
| JetBrains Mono | 5.5 × 8.8125px | 1.1875px |
| IBM Plex Mono | 5.5 × 8.8125px | 2.1875px |

The identical ink under four unrelated faces is the system fallback rendering it
every time. What the typeface *does* change is where that fallback glyph sits:
a 1px vertical drift between Geist Mono and IBM Plex Mono. That is why the mark
cell reads `--font-mark` and not `--font-mono`.

Those are the numbers `styles.css` and `test/statusMark.render.test.mjs` assert.
The raster itself covers 5.5625 × 8.8125px of pixels: the width is quoted as the
**span** between the outermost covered columns (89 columns at 16× spanning 88/16
= 5.5px), which is what `--mark-ink-w: 0.44em` encodes at `--mark-size: 12.5px`.
The height is quoted as the covered-row count. Two conventions in one
measurement is exactly how a 1/16px disagreement gets published, so: the numbers
above are the ones the code uses.
