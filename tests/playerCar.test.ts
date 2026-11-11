/**
 * Player car: the procedural textures that replace the model's textures (paint flake, carbon weave, rain beads,
 * hexagonal metal mesh) are deterministic, tile without seams and have the right scale; the drawn body attitude
 * never sinks a corner into its arch. Pure data, no WebGL.
 */
import { describe, expect, it } from 'vitest';
import { Euler, Vector3 } from 'three';
import {
  channelMean, hexTileHeight, limitAttitude, makeCarbonWeaveData, makeFlakeNormalData, makeHexMeshData, makeRainBeadData,
  twillWarpOver,
} from '../src/vehicle/playerCarVisual';

const px = (data: Uint8Array, size: number, x: number, y: number) => {
  const xx = ((x % size) + size) % size, yy = ((y % size) + size) % size;
  const o = (yy * size + xx) * 4;
  return [data[o], data[o + 1], data[o + 2], data[o + 3]];
};

/** Largest channel difference between `a` and `b` shifted by (sx, sy) pixels (cyclic). */
function maxShiftDiff(a: Uint8Array, b: Uint8Array, size: number, sx: number, sy: number): number {
  let m = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const p = px(a, size, x - sx, y - sy), q = px(b, size, x, y);
      for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(p[c] - q[c]));
    }
  return m;
}

/** Top-left crop of a bigger RGBA image. */
function crop(data: Uint8Array, size: number, w: number): Uint8Array {
  const out = new Uint8Array(w * w * 4);
  for (let y = 0; y < w; y++) out.set(data.subarray(y * size * 4, (y * size + w) * 4), y * w * 4);
  return out;
}

/** Pixel of a w × h RGBA image, wrapping around the edges. */
const pxr = (data: Uint8Array, w: number, h: number, x: number, y: number) => {
  const o = ((((y % h) + h) % h) * w + (((x % w) + w) % w)) * 4;
  return [data[o], data[o + 1], data[o + 2], data[o + 3]];
};

/** Largest channel difference between a w × h image shifted by (sx, sy) and `b` (cyclic). */
function maxShiftDiffRect(a: Uint8Array, b: Uint8Array, w: number, h: number, sx: number, sy: number): number {
  let m = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = pxr(a, w, h, x - sx, y - sy), q = pxr(b, w, h, x, y);
      for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(p[c] - q[c]));
    }
  return m;
}

function normalsValid(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i += 4) {
    const x = data[i] / 127.5 - 1, y = data[i + 1] / 127.5 - 1, z = data[i + 2] / 127.5 - 1;
    if (z <= 0 || Math.abs(Math.hypot(x, y, z) - 1) > 0.02 || data[i + 3] !== 255) return false;
  }
  return true;
}

describe('carbon twill weave', () => {
  it('2/2 twill: every tow goes over two and under two, the pattern steps diagonally with period 4', () => {
    for (let i = -4; i < 8; i++)
      for (let j = -4; j < 8; j++) {
        expect(twillWarpOver(i + 4, j)).toBe(twillWarpOver(i, j));
        expect(twillWarpOver(i, j + 4)).toBe(twillWarpOver(i, j));
        expect(twillWarpOver(i + 1, j + 1)).toBe(twillWarpOver(i, j));
      }
    for (let k = 0; k < 4; k++) {
      let row = 0, col = 0;
      for (let n = 0; n < 4; n++) {
        if (twillWarpOver(n, k)) row++;
        if (twillWarpOver(k, n)) col++;
      }
      expect(row).toBe(2);
      expect(col).toBe(2);
    }
    // the over-spans are two cells long: over, over, under, under along a warp tow
    expect([0, 1, 2, 3].map((j) => twillWarpOver(0, j))).toEqual([true, true, false, false]);
  });

  it('is deterministic', () => {
    const a = makeCarbonWeaveData(16, 4), b = makeCarbonWeaveData(16, 4);
    expect(a.size).toBe(64);
    expect(Buffer.from(a.albedo).equals(Buffer.from(b.albedo))).toBe(true);
    expect(Buffer.from(a.normal).equals(Buffer.from(b.normal))).toBe(true);
  });

  it('repeats every 4 tows and not before (both maps)', () => {
    const tow = 16;
    const w = makeCarbonWeaveData(tow, 8); // two periods each way
    for (const map of [w.albedo, w.normal]) {
      expect(maxShiftDiff(map, map, w.size, 4 * tow, 0)).toBe(0);
      expect(maxShiftDiff(map, map, w.size, 0, 4 * tow)).toBe(0);
      expect(maxShiftDiff(map, map, w.size, tow, tow)).toBe(0); // the twill diagonal
      for (const k of [1, 2, 3]) expect(maxShiftDiff(map, map, w.size, k * tow, 0)).toBeGreaterThan(20);
    }
  });

  it('tiles without a seam: the one-period tile equals the same area cut out of a larger weave', () => {
    // edge pixels of the small tile see their wrapped neighbours, those of the crop see real ones
    const small = makeCarbonWeaveData(16, 4), big = makeCarbonWeaveData(16, 12);
    expect(maxShiftDiff(crop(big.normal, big.size, small.size), small.normal, small.size, 0, 0)).toBe(0);
    expect(maxShiftDiff(crop(big.albedo, big.size, small.size), small.albedo, small.size, 0, 0)).toBe(0);
  });

  it('has a valid normal map with real relief and a subtle albedo', () => {
    const w = makeCarbonWeaveData();
    expect(normalsValid(w.normal)).toBe(true);
    let maxTilt = 0, lo = 255, hi = 0;
    for (let i = 0; i < w.normal.length; i += 4) {
      maxTilt = Math.max(maxTilt, Math.abs(w.normal[i] - 128), Math.abs(w.normal[i + 1] - 128));
      lo = Math.min(lo, w.albedo[i]);
      hi = Math.max(hi, w.albedo[i]);
    }
    expect(maxTilt).toBeGreaterThan(40); // tows are rounded, not flat
    expect(lo).toBeGreaterThan(60); // gaps darker, never black: the material colour sets the level
    expect(hi).toBeGreaterThan(230);
  });
});

describe('paint flake', () => {
  it('is deterministic, depends on the seed and holds valid normals', () => {
    const a = makeFlakeNormalData(64, 2, 7), b = makeFlakeNormalData(64, 2, 7), c = makeFlakeNormalData(64, 2, 8);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
    expect(normalsValid(a)).toBe(true);
  });

  it('is made of whole flakes, also along the edges (so the tile border is just another flake border)', () => {
    const size = 64, f = 2;
    const d = makeFlakeNormalData(size, f);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) expect(px(d, size, x, y)).toEqual(px(d, size, x - (x % f), y - (y % f)));
    // and flakes differ from each other
    const seen = new Set<string>();
    for (let y = 0; y < size; y += f) for (let x = 0; x < size; x += f) seen.add(px(d, size, x, y).join());
    expect(seen.size).toBeGreaterThan((size / f) ** 2 * 0.6);
  });
});

describe('rain beads', () => {
  it('is deterministic and holds valid normals', () => {
    const a = makeRainBeadData(128, 150, 3), b = makeRainBeadData(128, 150, 3);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(normalsValid(a)).toBe(true);
  });

  it('wraps around the edges: moving every bead moves the whole tile cyclically', () => {
    // a bead cut off at an edge would not survive the move unchanged
    const size = 128;
    const base = makeRainBeadData(size, 150, 3);
    const moved = makeRainBeadData(size, 150, 3, [37, 101]);
    expect(maxShiftDiff(base, moved, size, 37, 101)).toBeLessThanOrEqual(1);
    // beads really do cross the tile border
    let onEdge = 0;
    for (let k = 0; k < size; k++) if (px(base, size, 0, k)[2] < 250 || px(base, size, k, 0)[2] < 250) onEdge++;
    expect(onEdge).toBeGreaterThan(0);
  });
});

describe('hexagonal metal mesh', () => {
  const maps = (d: ReturnType<typeof makeHexMeshData>) => [d.albedo, d.normal, d.orm];

  it('is one cell wide and two rows tall (aspect √3, even height)', () => {
    const d = makeHexMeshData(32);
    expect(d.width).toBe(32);
    expect(d.height).toBe(hexTileHeight(32));
    expect(d.height % 2).toBe(0);
    expect(Math.abs(d.height / d.width - Math.sqrt(3))).toBeLessThan(0.05);
  });

  it('is deterministic', () => {
    const a = makeHexMeshData(32), b = makeHexMeshData(32);
    for (const [i, m] of maps(a).entries()) expect(Buffer.from(m).equals(Buffer.from(maps(b)[i]))).toBe(true);
  });

  it('tiles without a seam: the tile equals the same area of a 3 × 3 sheet', () => {
    const small = makeHexMeshData(32), big = makeHexMeshData(32, undefined, 3);
    const w = small.width, h = small.height;
    for (const [i, m] of maps(big).entries()) {
      const cut = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) cut.set(m.subarray(y * big.width * 4, (y * big.width + w) * 4), y * w * 4);
      expect(maxShiftDiffRect(cut, maps(small)[i], w, h, 0, 0)).toBe(0);
    }
  });

  it('is a hexagonal lattice: moving by half a cell and one row maps the pattern onto itself', () => {
    const d = makeHexMeshData(32);
    for (const m of maps(d)) {
      expect(maxShiftDiffRect(m, m, d.width, d.height, d.width / 2, d.height / 2)).toBeLessThanOrEqual(1);
      // but not by half a cell alone
      expect(maxShiftDiffRect(m, m, d.width, d.height, d.width / 2, 0)).toBeGreaterThan(20);
    }
  });

  it('has valid normals, bright wires over dark holes and the far-away means in range', () => {
    const d = makeHexMeshData();
    expect(normalsValid(d.normal)).toBe(true);
    let wire = 0, lo = 255, hi = 0;
    for (let i = 0; i < d.albedo.length; i += 4) {
      if (d.albedo[i] > 128) wire++;
      lo = Math.min(lo, d.albedo[i]);
      hi = Math.max(hi, d.albedo[i]);
    }
    const share = wire / (d.albedo.length / 4);
    expect(share).toBeGreaterThan(0.2); // about 1.9 mm wire on an 11 mm cell
    expect(share).toBeLessThan(0.45);
    expect(lo).toBeLessThan(40);
    expect(hi).toBeGreaterThan(230);
    // far away: an even dark satin metal (roughness and metalness between hole and wire)
    expect(channelMean(d.orm, 1)).toBeGreaterThan(0.35);
    expect(channelMean(d.orm, 1)).toBeLessThan(0.62);
    expect(channelMean(d.orm, 2)).toBeGreaterThan(0.2);
    expect(channelMean(d.orm, 2)).toBeLessThan(0.6);
  });
});

describe('drawn body attitude', () => {
  const wheels = [{ x: -0.87, z: -1.4 }, { x: 0.87, z: -1.4 }, { x: -0.88, z: 1.4 }, { x: 0.88, z: 1.4 }];
  /** Real drop of a body point over each wheel (pivot-relative height 0.45 m) under the attitude group. */
  const drops = (a: { heave: number; pitch: number; roll: number }) =>
    wheels.map((w) => {
      const p = new Vector3(w.x, 0.45, w.z).applyEuler(new Euler(a.pitch, 0, -a.roll, 'XYZ'));
      return 0.45 - p.y + a.heave;
    });

  it('leaves small motions alone', () => {
    const a = { heave: 0.01, pitch: 0.005, roll: -0.004 };
    limitAttitude(a, wheels, 0.035);
    expect(a).toEqual({ heave: 0.01, pitch: 0.005, roll: -0.004 });
  });

  it('keeps every corner within the limit under hard braking and cornering, scaling all three together', () => {
    // logged by the critic: braking at 162 km/h, about 6 cm at the front
    for (const a0 of [{ heave: 0.003, pitch: -0.044, roll: 0 }, { heave: 0.02, pitch: -0.03, roll: 0.03 }, { heave: 0.045, pitch: 0, roll: -0.02 }]) {
      const before = Math.max(...drops(a0));
      expect(before).toBeGreaterThan(0.035);
      const a = { ...a0 };
      limitAttitude(a, wheels, 0.035);
      expect(Math.max(...drops(a))).toBeLessThan(0.0365); // small-angle formula vs the real rotation
      expect(Math.max(...drops(a))).toBeGreaterThan(0.033);
      const k = a.pitch !== 0 ? a.pitch / a0.pitch : a.roll / a0.roll;
      expect(a.heave).toBeCloseTo(a0.heave * k, 9);
    }
  });
});
