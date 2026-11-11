/**
 * Procedural far-city panorama, generated once at startup into two 4096×256 RGBA8 textures:
 *   mask:    R = near layer, G = mid layer, B = far layer silhouettes
 *   windows: R/G/B = window intensity of the near/mid/far layer, A = colour code
 *            (0..0.9 warm→cool temperature, ≥ 0.96 red aviation beacon, 0.92..0.95 crown light)
 * u spans azimuth −SKY_AZ..+SKY_AZ around −Z, v spans elevation 0..SKY_EL (radians).
 */
import { DataTexture, LinearFilter, RGBAFormat, UnsignedByteType, ClampToEdgeWrapping } from 'three';
import { makeRng } from '../../core/math';

export const SKY_W = 4096;
export const SKY_H = 256;
/** Half azimuth range covered by the panorama (rad). */
export const SKY_AZ = (120 * Math.PI) / 180;
/** Elevation covered (rad). */
export const SKY_EL = (9 * Math.PI) / 180;

interface Layer {
  ch: 0 | 1 | 2;
  R: number; // nominal distance (m) for metre→pixel conversion
  density: (az: number) => number;
  hMin: number;
  hMax: number;
  wMin: number;
  wMax: number;
  lit: number;
  count: number;
}

export function generateSkyline(seed = 7): { mask: DataTexture; windows: DataTexture } {
  const rng = makeRng(seed);
  const r = () => rng();
  const mask = new Uint8Array(SKY_W * SKY_H * 4);
  const win = new Uint8Array(SKY_W * SKY_H * 4);
  const pxPerRadU = SKY_W / (2 * SKY_AZ);
  const pxPerRadV = SKY_H / SKY_EL;
  const g = (x: number, c: number, w: number) => Math.exp(-((x - c) * (x - c)) / (w * w));
  const deg = Math.PI / 180;
  const layers: Layer[] = [
    {
      ch: 2,
      R: 2700,
      density: (a) => 0.08 + 1.0 * g(a, -6 * deg, 16 * deg) + 0.45 * g(a, 38 * deg, 9 * deg) + 0.3 * g(a, -48 * deg, 8 * deg),
      hMin: 40,
      hMax: 330,
      wMin: 18,
      wMax: 60,
      lit: 0.2,
      count: 0,
    },
    {
      ch: 1,
      R: 2100,
      density: (a) => 0.18 + 0.85 * g(a, -2 * deg, 34 * deg) + 0.4 * g(a, 60 * deg, 14 * deg) + 0.35 * g(a, -75 * deg, 16 * deg),
      hMin: 22,
      hMax: 170,
      wMin: 16,
      wMax: 70,
      lit: 0.22,
      count: 0,
    },
    {
      ch: 0,
      R: 1600,
      density: (a) => 0.3 + 0.7 * g(a, 0, 70 * deg),
      hMin: 10,
      hMax: 70,
      wMin: 14,
      wMax: 90,
      lit: 0.17,
      count: 0,
    },
  ];

  const setMask = (x: number, y: number, ch: number) => {
    if (x < 0 || x >= SKY_W || y < 0 || y >= SKY_H) return;
    mask[(y * SKY_W + x) * 4 + ch] = 255;
  };
  const setWin = (x: number, y: number, ch: number, v: number, code: number) => {
    if (x < 0 || x >= SKY_W || y < 0 || y >= SKY_H) return;
    const i = (y * SKY_W + x) * 4;
    win[i + ch] = Math.max(win[i + ch], Math.round(v * 255));
    win[i + 3] = Math.round(code * 255);
  };
  // Row 0 = ground (texture flipY = false, v = 0 at the bottom).
  const rect = (x0: number, x1: number, y0: number, y1: number, ch: number) => {
    for (let y = Math.max(0, y0); y < Math.min(SKY_H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(SKY_W, x1); x++) setMask(x, y, ch);
  };

  for (const L of layers) {
    const mPerPxU = L.R / pxPerRadU;
    const mPerPxV = L.R / pxPerRadV;
    const hpx = (m: number) => Math.atan(m / L.R) * pxPerRadV;
    let x = 0;
    while (x < SKY_W) {
      const az = (x / SKY_W - 0.5) * 2 * SKY_AZ;
      const dens = L.density(az);
      // Gaps where the city thins out.
      if (r() > Math.min(1, dens * 1.25)) {
        x += Math.max(2, Math.round((8 + r() * 40) / mPerPxU));
        continue;
      }
      const wm = L.wMin + r() * (L.wMax - L.wMin) * (0.6 + 0.4 * (1 - Math.min(1, dens)));
      const w = Math.max(2, Math.round(wm / mPerPxU));
      let hm = L.hMin + Math.pow(r(), 2.2 - Math.min(1.2, dens)) * (L.hMax - L.hMin) * Math.min(1, 0.25 + dens);
      if (r() < 0.05 * dens) hm *= 1.35;
      const h = Math.max(2, Math.round(hpx(hm)));
      const x0 = x;
      const x1 = x + w;
      rect(x0, x1, 0, h, L.ch);
      let top = h;
      // Setback tower on top.
      if (hm > 70 && r() < 0.45) {
        const inset = Math.max(1, Math.round(w * (0.15 + r() * 0.2)));
        const extra = Math.round(h * (0.12 + r() * 0.3));
        rect(x0 + inset, x1 - inset, h, h + extra, L.ch);
        top = h + extra;
        if (r() < 0.4 && w - inset * 2 > 3) {
          const inset2 = inset + Math.max(1, Math.round(w * 0.12));
          const extra2 = Math.round(h * (0.05 + r() * 0.12));
          rect(x0 + inset2, x1 - inset2, top, top + extra2, L.ch);
          top += extra2;
        }
      } else if (hm > 40 && r() < 0.12) {
        // Slanted roof.
        const rise = Math.round(w * (0.3 + r() * 0.6) * (mPerPxU / mPerPxV));
        for (let i = 0; i < w; i++) rect(x0 + i, x0 + i + 1, h, h + Math.round((rise * i) / w), L.ch);
        top = h + rise;
      }
      // Spire / antenna with an aviation beacon.
      const cx = Math.round((x0 + x1) / 2);
      if (hm > 110 && r() < 0.55) {
        const sh = Math.round(hpx(14 + r() * 40));
        rect(cx, cx + 1, top, top + sh, L.ch);
        setWin(cx, top + sh, L.ch, 1, 0.98);
        setWin(cx, top + Math.round(sh * 0.5), L.ch, 0.7, 0.98);
      } else if (hm > 90 && r() < 0.6) {
        setWin(x0 + 1, top, L.ch, 0.9, 0.98);
        setWin(x1 - 2, top, L.ch, 0.9, 0.98);
      }
      // Crown light band.
      if (hm > 80 && r() < 0.3) {
        const cool = r() < 0.6;
        for (let xx = x0; xx < x1; xx++) setWin(xx, h - 2, L.ch, 0.8, cool ? 0.935 : 0.925);
      }
      // Windows: floors every ~3.6 m, bays every ~3.5 m (1 px dots), building-level lit fraction.
      const floorPx = Math.max(2, Math.round(3.6 / mPerPxV));
      const bayPx = Math.max(1, Math.round(3.5 / mPerPxU));
      const litB = L.lit * (0.35 + r() * 1.3);
      const temp = r();
      const office = r() < 0.4;
      for (let y = 1; y < h - 1; y += floorPx) {
        const floorLit = office && r() < 0.1 ? 0.8 : litB;
        for (let xx = x0 + 1; xx < x1 - 1; xx += bayPx) {
          if (r() < floorLit) {
            const t = Math.min(0.9, Math.max(0, temp * 0.6 + r() * 0.5 - 0.1));
            setWin(xx, y, L.ch, 0.35 + r() * 0.65, t);
          }
        }
      }
      L.count++;
      x = x1 + (r() < 0.55 ? 0 : Math.round((r() * 14) / mPerPxU));
    }
  }

  const make = (data: Uint8Array) => {
    const t = new DataTexture(data, SKY_W, SKY_H, RGBAFormat, UnsignedByteType);
    t.minFilter = LinearFilter;
    t.magFilter = LinearFilter;
    t.wrapS = ClampToEdgeWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.flipY = false;
    t.needsUpdate = true;
    return t;
  };
  return { mask: make(mask), windows: make(win) };
}
