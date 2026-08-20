# Bundled fonts

Self-hosted on purpose: a CDN would leave the Space rendering a fallback, and a
study of a typeface you cannot see is worthless. Every file here is a Latin
subset of the upstream release, downloaded and committed — no build step fetches
anything.

| File | Family | Version | Licence |
|---|---|---|---|
| `Geist.woff2`, `GeistMono.woff2` | Geist, Geist Mono (Vercel) | as vendored before this change | SIL Open Font License 1.1 |
| `DepartureMono.woff2` | Departure Mono 1.500 (Helena Zhang) | 1.500 | SIL Open Font License 1.1 |
| `JetBrainsMono.woff2`, `JetBrainsMono-SemiBold.woff2` | JetBrains Mono (JetBrains) | 2.304 | SIL Open Font License 1.1 |
| `IBMPlexSans.woff2`, `IBMPlexSans-SemiBold.woff2`, `IBMPlexMono.woff2` | IBM Plex Sans, IBM Plex Mono (IBM) | 1.1.0 | SIL Open Font License 1.1 |

All four families are OFL 1.1, which permits bundling and serving them from this
Space. The OFL requires that the fonts not be sold on their own and that any
modified version be renamed; neither applies here — the files are unmodified
subsets, served as part of the application.

Licence texts as shipped upstream:

- Departure Mono — https://github.com/rektdeckard/departure-mono/blob/main/LICENSE
- JetBrains Mono — https://github.com/JetBrains/JetBrainsMono/blob/master/OFL.txt
- IBM Plex — https://github.com/IBM/plex/blob/master/LICENSE.txt
- Geist — https://github.com/vercel/geist-font/blob/main/LICENSE.TXT

## Subsets

The JetBrains Mono and IBM Plex files are the `latin` subsets published by
Google Fonts (21–24 KB each) rather than the full upstream releases (46–95 KB
each), which carry Cyrillic, Greek and Vietnamese this interface never renders.
Departure Mono ships one file for the whole family, 22 KB, so it is vendored
whole.

**None of these fonts — including the Geist Mono already here — contains the
braille glyphs the status marks are drawn from.** Measured in Chromium: `⠿` at
12.5px has an identical 5.5625 × 8.8125px ink box under all four, which is the
system fallback rendering it every time. What does change with the typeface is
where that fallback glyph sits: its ink starts 1.1875px from the top of the cell
under Geist Mono and 2.1875px under IBM Plex Mono. That is why the mark cell
reads `--font-mark` and not `--font-mono`.
