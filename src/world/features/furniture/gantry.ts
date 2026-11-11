/**
 * Overhead sign gantry: steel box-truss portal over our carriageway with 2–3 guide signs
 * (canvas atlas) and, on some gantries, an amber LED variable-message sign.
 */
import type { BufferGeometry } from 'three';
import type { ChunkSpec, IChunkBuilder } from '../../../core/types';
import { makeRng } from '../../../core/math';
import { BARRIER_RIGHT_D, MEDIAN_D } from '../../roadProfile';
import { BOX, CYL6O, CYL8 } from './barriers';
import { Geo } from './geo';
import type { RGB } from './geo';
import { signMaterial } from './materials';
import { getSignAtlas } from './signAtlas';
import type { UvRect } from './signAtlas';

const STEEL: RGB = [0.8, 0.8, 0.78];
const STEEL_DARK: RGB = [0.5, 0.5, 0.48];
const PANEL: RGB = [0.42, 0.43, 0.44];
const VMS_BOX: RGB = [0.16, 0.16, 0.17];

const LEG_L = MEDIAN_D + 0.9;
const LEG_R = BARRIER_RIGHT_D + 1.6;
const BEAM_Y0 = 6.6;
const BEAM_Y1 = 7.6;
const BEAM_HD = 0.45; // half depth along s

interface SignSlot {
  d: number;
  w: number;
  h: number;
  y: number;
  uv: UvRect;
  vms: boolean;
}

/** Square truss between (x, y) corners: 4 chords + lacing. Axis along `axis`. */
function legTruss(g: Geo, x: number, z: number, y0: number, y1: number): void {
  const hw = 0.3;
  const corners: Array<[number, number]> = [
    [x - hw, z - hw],
    [x + hw, z - hw],
    [x + hw, z + hw],
    [x - hw, z + hw],
  ];
  g.color(STEEL);
  for (const [cx, cz] of corners) g.member(CYL8, cx, y0, cz, cx, y1, cz, 0.07, 0.07, 1);
  g.color(STEEL_DARK);
  const panels = Math.round((y1 - y0) / 0.9);
  for (let p = 0; p < panels; p++) {
    const ya = y0 + ((y1 - y0) * p) / panels;
    const yb = y0 + ((y1 - y0) * (p + 1)) / panels;
    for (let f = 0; f < 4; f++) {
      const a = corners[f];
      const c = corners[(f + 1) % 4];
      g.member(CYL6O, a[0], ya, a[1], c[0], ya, c[1], 0.028, 0.028);
      if ((p + f) % 2 === 0) g.member(CYL6O, a[0], ya, a[1], c[0], yb, c[1], 0.026, 0.026);
      else g.member(CYL6O, c[0], ya, c[1], a[0], yb, a[1], 0.026, 0.026);
    }
  }
  // Base plate.
  g.color(STEEL_DARK);
  g.primAt(BOX, x, y0 + 0.02, z, 0.86, 0.04, 0.86);
}

interface Layout {
  key: string;
  slots: Array<Omit<SignSlot, 'uv'> & { exit: boolean }>;
}

const LAYOUTS: Layout[] = [
  {
    key: 'vms3',
    slots: [
      { d: -3.8, w: 6.0, h: 1.6, y: 7.1, vms: true, exit: false },
      { d: 2.7, w: 4.6, h: 2.76, y: 7.15, vms: false, exit: false },
      { d: 7.6, w: 3.9, h: 2.34, y: 7.2, vms: false, exit: true },
    ],
  },
  {
    key: 'vms2',
    slots: [
      { d: -3.8, w: 6.0, h: 1.6, y: 7.1, vms: true, exit: false },
      { d: 2.7, w: 4.6, h: 2.76, y: 7.15, vms: false, exit: false },
    ],
  },
  {
    key: 'guide3',
    slots: [
      { d: -4.4, w: 5.0, h: 3.0, y: 7.1, vms: false, exit: false },
      { d: 1.0, w: 5.0, h: 3.0, y: 7.1, vms: false, exit: false },
      { d: 6.5, w: 4.2, h: 2.52, y: 7.15, vms: false, exit: true },
    ],
  },
  {
    key: 'guide2',
    slots: [
      { d: -3.2, w: 5.6, h: 3.36, y: 7.1, vms: false, exit: false },
      { d: 3.6, w: 5.0, h: 3.0, y: 7.1, vms: false, exit: true },
    ],
  },
];

const ZF = BEAM_HD + 0.16; // sign face plane (local z, towards approaching traffic)
const trussCache = new Map<string, BufferGeometry>();

/** Truss + sign back panels for a layout, gantry-local (x = d, z = 0 at the gantry). Shared. */
function trussGeometry(layout: Layout): BufferGeometry {
  // (merged into the guardrail mesh by the barriers feature: one draw call less, per-vertex lamp bake)
  let g = trussCache.get(layout.key);
  if (g) return g;
  const met = new Geo();
  const z = 0;
  legTruss(met, LEG_L, z, 0.18, BEAM_Y1 + 0.1);
  legTruss(met, LEG_R, z, 0.37, BEAM_Y1 + 0.1);
  const x0 = LEG_L - 0.3;
  const x1 = LEG_R + 0.3;
  const zs = [z - BEAM_HD, z + BEAM_HD];
  const ys = [BEAM_Y0, BEAM_Y1];
  met.color(STEEL);
  for (const yy of ys) for (const zz of zs) met.member(CYL8, x0, yy, zz, x1, yy, zz, 0.085, 0.085, 1);
  const panels = Math.round((x1 - x0) / 1.0);
  met.color(STEEL_DARK);
  for (let p = 0; p <= panels; p++) {
    const xa = x0 + ((x1 - x0) * p) / panels;
    for (const zz of zs) met.member(CYL6O, xa, BEAM_Y0, zz, xa, BEAM_Y1, zz, 0.03, 0.03);
    for (const yy of ys) met.member(CYL6O, xa, yy, zs[0], xa, yy, zs[1], 0.03, 0.03);
    if (p === panels) break;
    const xb = x0 + ((x1 - x0) * (p + 1)) / panels;
    const flip = p % 2 === 0;
    for (const zz of zs) met.member(CYL6O, xa, flip ? BEAM_Y0 : BEAM_Y1, zz, xb, flip ? BEAM_Y1 : BEAM_Y0, zz, 0.028, 0.028);
    for (const yy of ys) met.member(CYL6O, xa, yy, flip ? zs[0] : zs[1], xb, yy, flip ? zs[1] : zs[0], 0.026, 0.026);
  }
  // Maintenance walkway + handrail on the approach side.
  met.color(STEEL_DARK);
  met.primAt(BOX, (x0 + x1) * 0.5, BEAM_Y0 - 0.05, z + BEAM_HD + 0.35, x1 - x0 - 0.8, 0.04, 0.7);
  met.member(CYL6O, x0 + 0.4, BEAM_Y0 + 1.0, z + BEAM_HD + 0.68, x1 - 0.4, BEAM_Y0 + 1.0, z + BEAM_HD + 0.68, 0.025, 0.025);
  for (const s of layout.slots) {
    const hw = s.w * 0.5;
    const hh = s.h * 0.5;
    met.color(s.vms ? VMS_BOX : PANEL);
    const depth = s.vms ? 0.42 : 0.06;
    met.primAt(BOX, s.d, s.y, ZF - 0.005 - depth * 0.5, s.w + 0.04, s.h + 0.04, depth);
    met.color(STEEL_DARK);
    for (const hx of [s.d - hw + 0.5, s.d + hw - 0.5]) {
      met.primAt(BOX, hx, s.y, ZF - depth - 0.06, 0.08, s.h + 0.1, 0.08);
    }
    if (s.vms) {
      met.color(VMS_BOX);
      met.primAt(BOX, s.d, s.y + hh + 0.04, ZF + 0.12, s.w + 0.04, 0.03, 0.26);
    }
  }
  g = met.build()!;
  g.computeBoundingSphere();
  trussCache.set(layout.key, g);
  return g;
}

/** Layout of this chunk's gantry, decided from the spec so the barriers feature (which merges the truss) agrees. */
function gantryLayout(spec: ChunkSpec): Layout {
  const r = makeRng((spec.seed ^ 0x2c1b3c6d) >>> 0)();
  return r < 0.25 ? LAYOUTS[0] : r < 0.4 ? LAYOUTS[1] : r < 0.75 ? LAYOUTS[2] : LAYOUTS[3];
}

/** Truss + sign back panels of the chunk's gantry (gantry-local, z = 0 at spec.gantryS), or null. */
export function gantryTruss(spec: ChunkSpec): BufferGeometry | null {
  return spec.gantryS === null ? null : trussGeometry(gantryLayout(spec));
}

export function buildGantry(b: IChunkBuilder): void {
  const spec = b.spec;
  if (spec.gantryS === null) return;
  const atlas = getSignAtlas();
  const layout = gantryLayout(spec);
  const normal = atlas.guide.map((_, i) => i).filter((i) => !atlas.exitGuide.includes(i));
  const used = new Set<number>();
  const pick = (pool: number[]) => {
    let i = pool[Math.floor(b.rand() * pool.length) % pool.length];
    for (let k = 0; k < pool.length && used.has(i); k++) i = pool[(pool.indexOf(i) + 1) % pool.length];
    used.add(i);
    return atlas.guide[i];
  };
  const sig = new Geo();
  const z = -(spec.gantryS - spec.s0);
  const zf = z + ZF;
  for (const s of layout.slots) {
    const uv: UvRect = s.vms ? atlas.vms[Math.floor(b.rand() * atlas.vms.length) % atlas.vms.length] : pick(s.exit ? atlas.exitGuide : normal);
    const hw = s.w * 0.5;
    const hh = s.h * 0.5;
    sig.face(s.d - hw, s.y - hh, zf, s.d + hw, s.y - hh, zf, s.d + hw, s.y + hh, zf, s.d - hw, s.y + hh, zf, 0, 0, 1, [uv.u0, uv.v0, uv.u1, uv.v1]);
  }
  const sg = sig.build();
  if (sg) b.addBent(sg, signMaterial(b), { name: 'furn-gantry-signs' });
}
