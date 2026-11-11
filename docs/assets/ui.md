# UI assets (agent: ui)

The interface (src/ui/**) is plain TypeScript + CSS. The only third-party assets are two fonts.
No icons/images: arrows in key caps are inline SVG paths written by hand (src/ui/dom.ts).

| File (public/assets/fonts/) | Title | Author | Source | Licence | Changes |
| --- | --- | --- | --- | --- | --- |
| `saira-latin-var.woff2` | Saira (variable, wght 100–900, wdth 50–125) | Omnibus-Type / The Saira Project Authors | npm `@fontsource-variable/saira@5.3.0` → `files/saira-latin-standard-normal.woff2` (https://fontsource.org/fonts/saira, upstream https://github.com/Omnibus-Type/Saira) | SIL OFL 1.1 (`OFL-Saira.txt` shipped next to the font) | Renamed only. Registered under the family name "NS Display". |
| `inter-latin-var.woff2` | Inter (variable, wght 100–900) | Rasmus Andersson / The Inter Project Authors | npm `@fontsource-variable/inter@5.3.0` → `files/inter-latin-wght-normal.woff2` (https://fontsource.org/fonts/inter, upstream https://github.com/rsms/inter) | SIL OFL 1.1 (`OFL-Inter.txt` shipped next to the font) | Renamed only. Registered under the family name "NS Text". |

Both are latin subsets (basic Latin + Latin-1 + common punctuation, includes ×, —, ·, tabular figures).
Arrows (← →) are not used as glyphs for that reason; key caps use SVG.

Downloaded tarballs are kept (untrusted, never executed) in `assets-src/ui/dl/`.
Fonts are loaded at runtime with the FontFace API from a URL relative to `import.meta.env.BASE_URL`
(src/ui/fonts.ts); CSS falls back to Segoe UI / system-ui until they arrive.
