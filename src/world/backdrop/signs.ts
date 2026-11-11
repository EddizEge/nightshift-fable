/**
 * Generic illuminated sign words (no brands) rendered once into a canvas atlas:
 * 2 × 8 cells of 512 × 128 px. R = letter core, G = soft glow halo (for neon / channel letters).
 * The atlas is mip-mapped so small, distant signs average out instead of shimmering.
 */
import { CanvasTexture, LinearMipmapLinearFilter } from 'three';
import type { Texture } from 'three';

export const SIGN_WORDS = [
  'HOTEL', 'PARKING', '24H', 'MOTEL', 'DINER', 'OPEN 24H', 'GARAGE', 'PHARMACY',
  'OFFICES', 'GYM', 'LAUNDRY', 'RENTALS', 'CAR WASH', 'STORAGE', 'TAXI', 'BAR',
] as const;
export type SignWord = (typeof SIGN_WORDS)[number];

/** Instance scale.z code for a sign word (billboards use 1). */
export const signCode = (w: SignWord): number => 2 + SIGN_WORDS.indexOf(w);
/** Width / height of the word cell (for sizing the panel). */
export const SIGN_ASPECT = 4;

let _atlas: Texture | null = null;

export function signAtlas(): Texture {
  if (_atlas) return _atlas;
  const W = 1024;
  const H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  if (g) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    SIGN_WORDS.forEach((word, i) => {
      const cx = (i % 2) * 512 + 256;
      const cy = Math.floor(i / 2) * 128 + 64;
      let size = 82;
      g.font = `700 ${size}px "Arial Narrow", Arial, Helvetica, sans-serif`;
      const wpx = g.measureText(word).width;
      if (wpx > 430) size = Math.floor((size * 430) / wpx);
      g.font = `700 ${size}px "Arial Narrow", Arial, Helvetica, sans-serif`;
      // Halo (green channel), then crisp core (red channel).
      g.shadowColor = '#00ff00';
      g.shadowBlur = 16;
      g.fillStyle = '#00ff00';
      g.fillText(word, cx, cy + 3);
      g.fillText(word, cx, cy + 3);
      g.shadowBlur = 0;
      g.fillStyle = '#ff0000';
      g.fillText(word, cx, cy + 3);
    });
  }
  const t = new CanvasTexture(cv);
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  _atlas = t;
  return t;
}
