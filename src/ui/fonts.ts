/**
 * Self-hosted UI fonts (OFL-1.1, see docs/assets/ui.md):
 *   - "NS Display": Saira variable (wght 100–900, wdth 50–125%) — wordmark, numerals, labels.
 *   - "NS Text":    Inter variable (wght 100–900) — body copy, settings rows.
 *
 * Registered through the FontFace API instead of CSS @font-face so the URL can be resolved
 * against Vite's BASE_URL at runtime ('/' in dev, './' in the relative production build).
 */

const FILES = {
  display: 'assets/fonts/saira-latin-var.woff2',
  text: 'assets/fonts/inter-latin-var.woff2',
} as const;

let loading: Promise<void> | null = null;

export function assetUrl(rel: string): string {
  return new URL(import.meta.env.BASE_URL + rel, document.baseURI).href;
}

/** Idempotent. Resolves when both faces are ready (or failed — the CSS has system fallbacks). */
export function loadUiFonts(): Promise<void> {
  if (loading) return loading;
  if (typeof FontFace === 'undefined' || !document.fonts) return (loading = Promise.resolve());
  const faces = [
    new FontFace('NS Display', `url("${assetUrl(FILES.display)}") format("woff2")`, {
      weight: '100 900',
      stretch: '50% 125%',
      style: 'normal',
      display: 'swap',
    }),
    new FontFace('NS Text', `url("${assetUrl(FILES.text)}") format("woff2")`, {
      weight: '100 900',
      style: 'normal',
      display: 'swap',
    }),
  ];
  for (const f of faces) document.fonts.add(f);
  loading = Promise.all(faces.map((f) => f.load().catch((err) => console.warn('[ui] font failed', f.family, err)))).then(() => undefined);
  return loading;
}
