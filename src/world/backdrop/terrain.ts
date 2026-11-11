/**
 * Terrain outside the paved corridor: verge, drainage ditch, gently undulating ground, river banks
 * dropping to the water next to bridges, the cutting + hill around tunnel portals and the hill
 * mass above tunnels. One bent grid mesh per chunk (baked lamp light near the road).
 *
 * The height field is a pure function of (s, d) plus the chunk's zone context, and every term that
 * depends on a neighbouring zone is evaluated identically by both chunks at their shared boundary,
 * so the seams are exact.
 */
import { BufferAttribute, BufferGeometry, Color } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Material } from 'three';
import type { ChunkSpec, IChunkBuilder, ZoneType } from '../../core/types';
import { hash01, smoothstep } from '../../core/math';
import { BRIDGE_WATER_Y, CHUNK_LENGTH, PAVED_LEFT_D, PAVED_RIGHT_D } from '../roadProfile';
import { fbm2, vnoise2, withColorFix, withNightFill } from './shared';
import { vegetationGeometry } from './roadside';

const AMP: Record<ZoneType, number> = { city: 1.4, industrial: 1.0, rural: 4.2, tunnel: 3.0, bridge: 1.0 };
/** Hill height at the portal seam (beyond the headwall facade). */
const PORTAL_H = 15;
/** Hill top above the tunnel box right behind the facade (facade top ≈ 13). */
const OVER_H = 11.5;
const RAMP_LEN = 210;
const BANK_LEN = 95;

export interface TerrainCtx {
  s0: number;
  s1: number;
  zone: ZoneType;
  prev: ZoneType;
  next: ZoneType;
  /** Tunnel run [a, b] when zone === 'tunnel'. */
  ta: number;
  tb: number;
  /** Frontage / service roads running beside the highway in this chunk. */
  fr: Frontage[];
  s0c: number;
  s1c: number;
  /** Fade-out at the chunk start / end (the road turns away and ends: zone ends, overpasses). */
  endA: boolean;
  endB: boolean;
  overpassS: number | null;
}

/** A frontage road: two-lane service road parallel to the highway (outward distance e0, half width). */
export interface Frontage {
  side: number;
  e0: number;
  half: number;
  lit: boolean;
}

/**
 * Frontage roads live on the interior chunks of city / industrial runs (zone-end chunks carry the
 * portal ramps and river banks), so the decision is identical on both sides of every chunk seam.
 */
function frontagesFor(spec: ChunkSpec, zoneStart: number): Frontage[] {
  const z = spec.zone;
  if ((z !== 'city' && z !== 'industrial') || spec.zoneIndex < 1 || spec.zoneIndex > spec.zoneLength - 2) return [];
  const out: Frontage[] = [];
  const k = Math.floor(zoneStart);
  if (z === 'city' || hash01(k * 3 + 11) < 0.6) out.push({ side: 1, e0: 16.5, half: 3.6, lit: true });
  if (hash01(k * 5 + 17) < (z === 'city' ? 0.55 : 0.3)) out.push({ side: -1, e0: 15.5, half: 3.4, lit: z === 'city' });
  return out;
}

/** Centre outward distance of a frontage road at s (detours around overpass abutments, turns away at its ends). */
export function frontageE(f: Frontage, s: number, c: TerrainCtx): number {
  let e = f.e0;
  if (c.overpassS !== null) e += 36 * (1 - smoothstep(16, 55, Math.abs(s - c.overpassS)));
  if (c.endA) e += 26 * Math.pow(1 - smoothstep(30, 95, s - c.s0c), 2);
  if (c.endB) e += 26 * Math.pow(1 - smoothstep(30, 95, c.s1c - s), 2);
  return e;
}

/** Presence weight 0..1 of a frontage road at s (0 at the faded chunk ends). */
export function frontageW(s: number, c: TerrainCtx): number {
  let w = 1;
  if (c.endA) w *= smoothstep(14, 34, s - c.s0c);
  if (c.endB) w *= smoothstep(14, 34, c.s1c - s);
  return w;
}

function frontageFlatten(s: number, d: number, e: number, y: number, c: TerrainCtx): number {
  for (const f of c.fr) {
    if ((d > 0 ? 1 : -1) !== f.side || e <= 0) continue;
    const w = frontageW(s, c);
    if (w <= 0) continue;
    const ec = frontageE(f, s, c);
    const k = w * (1 - smoothstep(f.half + 1.0, f.half + 7.5, Math.abs(e - ec)));
    if (k <= 0) continue;
    const dc = f.side > 0 ? PAVED_RIGHT_D + ec : PAVED_LEFT_D - ec;
    y += (baseHeight(s, dc, ec, c) + 0.05 - y) * k;
  }
  return y;
}

export function terrainCtx(spec: ChunkSpec): TerrainCtx {
  const ta = spec.s0 - spec.zoneIndex * CHUNK_LENGTH;
  const fr = frontagesFor(spec, ta);
  return {
    s0: spec.s0, s1: spec.s1, zone: spec.zone, prev: spec.prevZone, next: spec.nextZone, ta, tb: ta + spec.zoneLength * CHUNK_LENGTH,
    fr, s0c: spec.s0, s1c: spec.s1, endA: spec.zoneIndex === 1, endB: spec.zoneIndex === spec.zoneLength - 2, overpassS: spec.overpassS,
  };
}

/** Outward distance from the pavement edge (0 inside the corridor). */
export function outward(d: number): number {
  return d >= PAVED_RIGHT_D ? d - PAVED_RIGHT_D : d <= PAVED_LEFT_D ? PAVED_LEFT_D - d : 0;
}

function ampAt(s: number, c: TerrainCtx): number {
  const a = AMP[c.zone];
  const blend = 70;
  if (s - c.s0 < blend) return a + (0.5 * (AMP[c.prev] + a) - a) * (1 - smoothstep(0, blend, s - c.s0));
  if (c.s1 - s < blend) return a + (0.5 * (AMP[c.next] + a) - a) * (1 - smoothstep(0, blend, c.s1 - s));
  return a;
}

/** Ordinary ground (no portal / bank terms). */
function baseHeight(s: number, d: number, e: number, c: TerrainCtx): number {
  const side = d < 0 ? 1 : 0;
  // Shoulder edge slightly below the asphalt, a drainage ditch, then the field.
  let y = -0.05 - 0.22 * smoothstep(0, 4, e);
  y -= 0.75 * Math.exp(-((e - 6.2) * (e - 6.2)) / 4.4);
  const amp = ampAt(s, c);
  const n = (fbm2(s / 190, d / 170, 3 + side) - 0.5) * 2;
  const n2 = (vnoise2(s / 55, d / 48, 9) - 0.5) * 2;
  // Low causeway / embankment character varies slowly along the road.
  const cw = (vnoise2(s / 420, side * 7.3, 21) - 0.45) * 2;
  const far = smoothstep(9, 45, e);
  y += far * (amp * (n + 0.25 * n2) - cw * amp * 0.35 * smoothstep(8, 30, e));
  return y;
}

/** Portal hill shape at outward distance e (shared by approach, tunnel and exit chunks). */
function portalShape(e: number, d: number): number {
  const wall = PORTAL_H * smoothstep(3, 22, e);
  return wall + 12 * smoothstep(22, 140, e) + 3 * (vnoise2(d / 40, 0.5, 33) - 0.5);
}

function tunnelFalloff(e: number): number {
  return 1 - smoothstep(220, 420, e);
}

export function terrainHeight(s: number, d: number, c: TerrainCtx): number {
  const e = outward(d);
  if (c.zone === 'tunnel') {
    const u = Math.min(s - c.ta, c.tb - s);
    const rise = 24 * (1 - Math.exp(-u / 32)) + 20 * smoothstep(40, 260, u);
    const hill = Math.max(portalShape(e, d), OVER_H) + rise + 7 * (fbm2(s / 120, d / 110, 41) - 0.5) * smoothstep(0, 60, u);
    return hill * tunnelFalloff(e) + baseHeight(s, d, e, c) * (1 - tunnelFalloff(e));
  }
  let y = baseHeight(s, d, e, c);
  if (c.fr.length) y = frontageFlatten(s, d, e, y, c);
  if (c.next === 'tunnel') {
    const r = smoothstep(c.s1 - RAMP_LEN, c.s1, s);
    const p = portalShape(e, d) * tunnelFalloff(e) + y * (1 - tunnelFalloff(e));
    y += (p - y) * r;
  }
  if (c.prev === 'tunnel') {
    const r = 1 - smoothstep(c.s0, c.s0 + RAMP_LEN, s);
    const p = portalShape(e, d) * tunnelFalloff(e) + y * (1 - tunnelFalloff(e));
    y += (p - y) * r;
  }
  if (c.next === 'bridge') {
    const r = smoothstep(c.s1 - BANK_LEN, c.s1 - 6, s);
    y += (BRIDGE_WATER_Y - 6 - y) * r * r * (0.6 + 0.4 * smoothstep(0, 12, e));
  }
  if (c.prev === 'bridge') {
    const r = 1 - smoothstep(c.s0 + 6, c.s0 + BANK_LEN, s);
    y += (BRIDGE_WATER_Y - 6 - y) * r * r * (0.6 + 0.4 * smoothstep(0, 12, e));
  }
  // Never above the asphalt next to the pavement edge.
  if (e < 3 && y > -0.03) y = -0.03;
  return y;
}

/** Slope magnitude (rise per metre) at a point — used to keep buildings off steep ground. */
export function terrainSlope(s: number, d: number, c: TerrainCtx): number {
  const h = terrainHeight(s, d, c);
  const hs = terrainHeight(s + 4, d, c);
  const hd = terrainHeight(s, d + 4, c);
  return Math.hypot(hs - h, hd - h) / 4;
}

const COLS = [0, 0.7, 1.6, 3, 4.3, 5.4, 6.4, 7.5, 9, 11, 13.5, 16.5, 20, 24.5, 30, 37, 45, 55, 67, 82, 100, 122, 148, 178, 214, 260];
const COLS_HILL = [...COLS, 310, 365, 420];

const _c = new Color();

export function terrainMaterial(b: IChunkBuilder): Material {
  return b.materials.cached('bd.terrain', () => {
    const normal = b.materials.texture('asphalt2_normal.webp');
    const m = b.materials.standard({
      name: 'bdTerrain',
      color: 0xffffff,
      vertexColors: true,
      normalMap: normal,
      roughness: 0.92,
      // Grass / scrub is not a wet mirror: the gloss lives in the puddles (withNightFill 'ground').
      wetness: 0.4,
    });
    // Half the sky fill of the other backdrop surfaces: unlit wet grass at night is near black.
    return withNightFill(withColorFix(m, 'terrain'), 'terrain', 0.55, 'ground');
  });
}

/** Build the chunk's terrain (skipped on bridge chunks). */
export function buildTerrain(b: IChunkBuilder): void {
  const spec = b.spec;
  if (spec.zone === 'bridge') return;
  const c = terrainCtx(spec);
  const hilly = spec.zone === 'tunnel' || spec.prevZone === 'tunnel' || spec.nextZone === 'tunnel';
  const cols = hilly ? COLS_HILL : COLS;
  // Near strip (baked lamp light, e ≤ NEAR_E) and far strip (unbaked: lamps do not reach it).
  const nearCols = cols.filter((e) => e <= NEAR_E);
  const farCols = cols.filter((e) => e >= NEAR_E);
  const near: number[] = [];
  for (let i = nearCols.length - 1; i >= 0; i--) near.push(PAVED_LEFT_D - nearCols[i]);
  let gap = near.length - 1;
  if (spec.zone === 'tunnel') {
    for (let d = PAVED_LEFT_D + 5; d < PAVED_RIGHT_D - 0.1; d += 5) near.push(d);
    gap = -1;
  }
  for (const e of nearCols) near.push(PAVED_RIGHT_D + e);
  const far: number[] = [];
  for (let i = farCols.length - 1; i >= 0; i--) far.push(PAVED_LEFT_D - farCols[i]);
  const farGap = far.length - 1;
  for (const e of farCols) far.push(PAVED_RIGHT_D + e);
  const mat = terrainMaterial(b);
  let nearGeo = terrainGrid(spec, c, near, gap, hilly, 5);
  const veg = vegetationGeometry(spec, c);
  // One mesh per chunk: near strip + far strip + frontage roads + verge vegetation (same material).
  const farGeo = terrainGrid(spec, c, far, farGap, hilly, 10);
  {
    const parts = [nearGeo, farGeo, ...c.fr.map((f) => frontageRibbon(spec, c, f))];
    if (veg) parts.push(veg);
    const merged = mergeGeometries(parts);
    if (merged) {
      for (const g of parts) g.dispose();
      nearGeo = merged;
    }
  }
  // Flat terrain does not show in the road mirror; hills (portals) must, or the sky would reflect in their place.
  const noReflect = !hilly;
  b.addBent(nearGeo, mat, { name: 'bdTerrainNear', noProbe: true, noReflect });
}

const NEAR_E = 45;

function terrainGrid(spec: ChunkSpec, c: TerrainCtx, ds: number[], gap: number, hilly: boolean, step: number): BufferGeometry {
  const ny = ds.length;
  const rows = Math.round(CHUNK_LENGTH / step) + 1;
  const vcount = rows * ny;
  const pos = new Float32Array(vcount * 3);
  const uv = new Float32Array(vcount * 2);
  const col = new Float32Array(vcount * 3);
  for (let r = 0; r < rows; r++) {
    const s = spec.s0 + r * step;
    for (let j = 0; j < ny; j++) {
      const d = ds[j];
      const y = terrainHeight(s, d, c);
      const k = r * ny + j;
      pos[k * 3] = d;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = -(s - spec.s0);
      uv[k * 2] = d / 7;
      uv[k * 2 + 1] = s / 7;
      // Albedo: gravel shoulder by the rail, worn tyre tracks (verge parking / service vehicles), dark
      // wet grass with soil patches, a darker wetter drainage ditch; slopes darker. Per-pixel clumps,
      // straw and puddles come from the shader (withNightFill 'ground').
      const e = outward(d);
      const n = vnoise2(s / 23, d / 21, 5) * 0.7 + vnoise2(s / 9, d / 8, 6) * 0.3;
      const gravel = 1 - smoothstep(1.1, 2.2, e);
      const mud = smoothstep(0.52, 0.72, n);
      const track = smoothstep(0.55, 0.7, vnoise2(s / 40, d > 0 ? 1.5 : 4.5, 8)) * (Math.abs(e - 3) < 0.1 || Math.abs(e - 4.3) < 0.1 ? 1 : 0);
      const ditch = Math.exp(-((e - 6.2) * (e - 6.2)) / 1.6);
      _c.setRGB(0.026, 0.032, 0.012); // wet grass
      _c.lerp(_c2.setRGB(0.04, 0.028, 0.017), mud);
      _c.lerp(_c2.setRGB(0.034, 0.025, 0.017), track * 0.85);
      _c.lerp(_c2.setRGB(0.016, 0.019, 0.011), ditch * 0.7);
      _c.lerp(_c2.setRGB(0.055, 0.052, 0.046), gravel);
      if (spec.zone === 'tunnel' || hilly) _c.lerp(_c2.setRGB(0.03, 0.032, 0.026), smoothstep(8, 30, y) * 0.5);
      const v = 0.75 + 0.5 * vnoise2(s / 6, d / 6, 13);
      col[k * 3] = _c.r * v;
      col[k * 3 + 1] = _c.g * v;
      col[k * 3 + 2] = _c.b * v;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let j = 0; j < ny - 1; j++) {
      // Skip the gap over the paved corridor on non-tunnel chunks.
      if (j === gap) continue;
      const a = r * ny + j;
      const bq = a + 1;
      const cq = a + ny;
      const dq = cq + 1;
      // Straight-space +Z is backwards: keep faces pointing up.
      idx.push(a, bq, cq, bq, dq, cq);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const _c2 = new Color();

/** Frontage road surface: dark wet asphalt ribbon 4 cm above the flattened ground (same material as the terrain). */
function frontageRibbon(spec: ChunkSpec, c: TerrainCtx, f: Frontage): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const offs = [-f.half - 0.25, -f.half, -f.half + 0.35, f.half - 0.35, f.half, f.half + 0.25];
  const n = offs.length;
  let rows = 0;
  let prevOk = false;
  for (let s = spec.s0; s <= spec.s1 + 0.01; s += 4) {
    const w = frontageW(s, c);
    const ok = w > 0.35;
    if (ok) {
      const ec = frontageE(f, s, c);
      for (let j = 0; j < n; j++) {
        const e = ec + (f.side > 0 ? offs[j] : offs[n - 1 - j]); // d increases with j (faces up)
        const d = f.side > 0 ? PAVED_RIGHT_D + e : PAVED_LEFT_D - e;
        const edge = j === 0 || j === n - 1;
        const y = terrainHeight(s, d, c) + (edge ? 0.0 : 0.045);
        pos.push(d, y, -(s - spec.s0));
        uv.push(d / 7, s / 7);
        // Asphalt, darker wheel paths, faint worn kerb strip.
        const v = 0.85 + 0.3 * vnoise2(s / 5, e / 3, 17);
        const g = edge ? 0.05 : j === 1 || j === n - 2 ? 0.045 : 0.03;
        col.push(g * v, g * v, (g + 0.003) * v);
      }
      if (prevOk) {
        const a0 = (rows - 1) * n;
        const b0 = rows * n;
        for (let j = 0; j < n - 1; j++) idx.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
      }
      rows++;
    }
    prevOk = ok;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
