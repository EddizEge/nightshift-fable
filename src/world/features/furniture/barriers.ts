/**
 * Median concrete barrier (F-shape), steel W-beam guardrails with posts and buried terminals,
 * plus the metalwork of the verge furniture (sign posts, phone box, drain grates).
 */
import { BoxGeometry, CylinderGeometry } from 'three';
import type { BufferGeometry } from 'three';
import type { IChunkBuilder, Placement } from '../../../core/types';
import {
  BARRIER_RIGHT_D,
  GUARDRAIL_HEIGHT,
  MEDIAN_D,
  MEDIAN_HALF,
  MEDIAN_HEIGHT,
  mirrorD,
} from '../../roadProfile';
import { Geo } from './geo';
import type { RGB } from './geo';
import { gantryTruss } from './gantry';
import { concreteMaterial, railMaterial } from './materials';
import { TERMINAL_LEN, planFor } from './plan';

export const BOX = new BoxGeometry(1, 1, 1);
export const CYL8 = new CylinderGeometry(1, 1, 1, 8, 1, false);
export const CYL6O = new CylinderGeometry(1, 1, 1, 6, 1, true);

/** F-shape half profile from the traffic-side base to the top (offsets from the centre line). */
const MH = MEDIAN_HALF;
const MEDIAN_PROFILE: Array<[number, number]> = [
  [-MH - 0.004, -0.02],
  [-MH, 0.075],
  [-0.19, 0.255],
  [-0.088, MEDIAN_HEIGHT - 0.04],
  [-0.06, MEDIAN_HEIGHT],
  [0.06, MEDIAN_HEIGHT],
  [0.088, MEDIAN_HEIGHT - 0.04],
  [0.19, 0.255],
  [MH, 0.075],
  [MH + 0.004, -0.02],
].map(([x, y]) => [MEDIAN_D + x, y]);

/**
 * W-beam (AASHTO-like): 310 mm tall, 83 mm deep, two crests towards the traffic, rolled-back
 * edge lips. Profile x = offset away from the traffic face (0 = crest front), bottom → top.
 */
export const RAIL_TOP = GUARDRAIL_HEIGHT - 0.04;
const W_H = 0.31;
const W_DEPTH = 0.083;
const W_BOTTOM = RAIL_TOP - W_H;
/** Offset of the beam at height fraction t (flat-ish crests / valley, straight webs). */
function wOff(t: number): number {
  const c = Math.cos(4 * Math.PI * t);
  return W_DEPTH * (0.5 + 0.5 * Math.sign(c) * Math.pow(Math.abs(c), 0.55));
}
function wProfile(back: number, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [[W_DEPTH + 0.014 + back, W_BOTTOM + 0.006]];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([wOff(t) + back, W_BOTTOM + W_H * t]);
  }
  out.push([W_DEPTH + 0.014 + back, RAIL_TOP - 0.006]);
  return out;
}
const W_FRONT = wProfile(0, 16);
const W_BACK = wProfile(0.004, 6);
/** Low-detail beam for the far (opposite carriageway) rail. */
const W_FRONT_LO = wProfile(0, 4);

const GALV: RGB = [1, 1, 1];
const GALV_DARK: RGB = [0.62, 0.6, 0.56];
const GALV_POST: RGB = [0.8, 0.79, 0.76];
const BOLT: RGB = [0.55, 0.54, 0.5];
const RUSTY: RGB = [0.72, 0.6, 0.48];
const DARK: RGB = [0.08, 0.08, 0.08];
const ORANGE: RGB = [0.95, 0.38, 0.06];
const CONCRETE_GREY: RGB = [0.55, 0.54, 0.51];

/** Beam back (valley) → blockout → post. */
const BLOCK_DEPTH = 0.15;
const POST_W = 0.1; // along the road
const POST_D = 0.06; // flange depth
const PLATE = 0.008; // steel thickness (a little over the real 5 mm: holds up at pixel ratio 0.7)
const BLOCK_H = 0.3;

/**
 * Sigma/C post (web towards the beam, flanges away from it) with a steel blockout, authored at
 * road-space (x0 = back of the beam, z). `side` = +1 right rail (posts at larger d), −1 mirrored.
 */
function addPost(g: Geo, side: number, x0: number, z: number, top: number, detail: boolean): void {
  const yb = -0.06;
  const xb = x0 + side * BLOCK_DEPTH; // post web (beam side)
  const ym = W_BOTTOM + W_H * 0.5;
  if (!detail) {
    // Far rail (across the other carriageway): three visible faces of the post only (12 vertices).
    const xa = xb;
    const xc = xb + side * POST_D;
    const hz = POST_W * 0.5;
    g.color(GALV_POST);
    g.face(xa, yb, z + hz, xa, yb, z - hz, xa, top, z - hz, xa, top, z + hz, -side, 0, 0, [0, 0, 0.1, 0.8]);
    g.face(xa, yb, z + hz, xc, yb, z + hz, xc, top, z + hz, xa, top, z + hz, 0, 0, 1, [0, 0, 0.06, 0.8]);
    g.face(xa, yb, z - hz, xc, yb, z - hz, xc, top, z - hz, xa, top, z - hz, 0, 0, -1, [0, 0, 0.06, 0.8]);
    void ym;
    return;
  }
  const h = top - yb;
  const yc = (yb + top) * 0.5;
  g.color(GALV_POST);
  // Web.
  g.primAt(BOX, xb + side * PLATE * 0.5, yc, z, PLATE, h, POST_W, 0, 0.5);
  // Flanges.
  for (const e of [-1, 1]) g.primAt(BOX, xb + side * POST_D * 0.5, yc, z + e * (POST_W - PLATE) * 0.5, POST_D, h, PLATE, 0, 0.5);
  // Blockout: a short channel (web across, flanges against the beam and against the post).
  g.color(GALV_DARK);
  g.primAt(BOX, x0 + side * BLOCK_DEPTH * 0.5, ym, z, BLOCK_DEPTH - 0.004, BLOCK_H, PLATE, 0, 0.5);
  for (const e of [0.006, BLOCK_DEPTH - 0.006]) g.primAt(BOX, x0 + side * e, ym, z, PLATE * 1.5, BLOCK_H, 0.09, 0, 0.5);
}

/** Domed bolt head on the traffic face of the beam (6 triangles), pointing towards the road. */
function bolt(g: Geo, side: number, x: number, y: number, z: number, r = 0.015): void {
  g.color(BOLT);
  const apex = g.v(x - side * r * 0.55, y, z, -side, 0, 0, 0.5, 0.5);
  const ring: number[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const cy = Math.cos(a);
    const cz = Math.sin(a);
    ring.push(g.v(x, y + cy * r, z + cz * r, -side * 0.6, cy * 0.8, cz * 0.8, 0.5 + cy * 0.5, 0.5 + cz * 0.5));
  }
  for (let k = 0; k < 6; k++) g.tri(apex, ring[k], ring[(k + 1) % 6]);
}

/** Post centre offset behind the beam face (x0 of addPost, relative to the crest front). */
const X0 = W_DEPTH + 0.006;
const YM = W_BOTTOM + W_H * 0.5;

/** Lapped splice (overlapping beam end 5 mm proud + 8 bolts) at local (x = beam face, z). */
function addSplice(g: Geo, side: number, face: number, z: number): void {
  g.color(GALV);
  const lap = (_z: number, out: [number, number, number]) => {
    out[0] = face - side * 0.005;
    out[1] = 1;
    out[2] = 0;
  };
  const prof = W_FRONT.map(([x, y]) => [x * side, y] as [number, number]);
  g.extrude(prof, z + 0.16, z - 0.16, 1, { normalSign: side, uvScale: 1.5, vBase: 0.37, xform: lap });
  for (const ty of [0.36, 0.64]) {
    const y = W_BOTTOM + W_H * ty;
    const bx = face + side * (wOff(ty) - 0.007);
    for (const dz of [-0.12, -0.04, 0.04, 0.12]) bolt(g, side, bx, y, z + dz);
  }
}

/**
 * Rigid 4 m guardrail unit for instancing (curves of R ≥ 500 m bend < 4 mm over it):
 * posts at z = 0 and z = −2 (s and s + 2), splice + bolts at z = 0. Beam face at x = 0, right side.
 */
let unitGeo: BufferGeometry | null = null;
function railUnitGeometry(): BufferGeometry {
  if (unitGeo) return unitGeo;
  const g = new Geo();
  for (const z of [0, -2]) {
    addPost(g, 1, X0, z, RAIL_TOP - 0.05, true);
    bolt(g, 1, wOff(0.5) - 0.002, YM, z, 0.017);
  }
  addSplice(g, 1, 0, 0);
  unitGeo = g.build()!;
  unitGeo.computeBoundingSphere();
  return unitGeo;
}

export function buildBarriers(b: IChunkBuilder): void {
  const spec = b.spec;
  const plan = planFor(spec, b.road);
  const s0 = spec.s0;
  const zOf = (s: number) => -(s - s0);
  const L = spec.s1 - spec.s0;

  // ── concrete: median barrier, lamp plinths, gantry footings ──
  const con = new Geo();
  if (plan.median) {
    con.extrude(MEDIAN_PROFILE, 0, -L, 4, { flat: true, uvScale: 2, vBase: s0 % 512, normalSign: 1 });
    for (const l of spec.lamps) {
      if (!l.on || l.side !== 'median') continue;
      // Widened plinth around the mast foot.
      con.primAt(BOX, MEDIAN_D, MEDIAN_HEIGHT * 0.5 - 0.01, zOf(l.s), 0.66, MEDIAN_HEIGHT + 0.02, 1.5, 0, 2);
    }
  }
  if (spec.gantryS !== null) {
    const z = zOf(spec.gantryS);
    con.primAt(BOX, BARRIER_RIGHT_D + 1.6, 0.12, z, 1.3, 0.5, 1.3, 0, 2);
    con.primAt(BOX, MEDIAN_D + 0.9, 0.08, z, 0.9, 0.2, 1.1, 0, 2);
  }
  if (con.count) {
    // Weathering coordinates (s mod 512, height) before bending.
    const n = con.count;
    const w = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      w[i * 2] = (s0 % 512) - con.pos[i * 3 + 2];
      w[i * 2 + 1] = con.pos[i * 3 + 1];
    }
    const g = con.build({ nsW: { data: w, size: 2 } })!;
    b.addBent(g, concreteMaterial(b), { name: 'furn-concrete' });
  }

}

/** Guardrails + gantry truss + verge metalwork (separate feature job from the median: time slicing). */
export function buildRails(b: IChunkBuilder): void {
  const spec = b.spec;
  const plan = planFor(spec, b.road);
  const s0 = spec.s0;
  const zOf = (s: number) => -(s - s0);
  // ── metal: W-beam guardrails (lapped 4 m beams, bolts, C posts every 2 m, buried terminals) ──
  // Posts are merged (not instanced) so every face gets its own Lambert-baked lamp light.
  const met = new Geo();
  const units: Placement[] = [];
  if (plan.rail) {
    const zA = zOf(plan.railA);
    const zB = zOf(plan.railB);
    // Terminal ramp: t = 1 at the end; the beam flares outwards and dives into the ground.
    const ramp = (s: number): number => {
      let t = 0;
      if (plan.termA) t = Math.max(t, 1 - (s - plan.railA) / TERMINAL_LEN);
      if (plan.termB) t = Math.max(t, 1 - (plan.railB - s) / TERMINAL_LEN);
      return Math.min(1, Math.max(0, t));
    };
    const flare = (t: number) => 0.75 * t * t;
    const dive = (t: number) => -(RAIL_TOP + 0.05) * Math.pow(t, 1.3);
    for (const side of [1, -1]) {
      const near = side > 0;
      const face = near ? BARRIER_RIGHT_D : mirrorD(BARRIER_RIGHT_D);
      const xform = (z: number, out: [number, number, number]) => {
        const t = ramp(s0 - z);
        out[0] = face + side * flare(t);
        out[1] = 1;
        out[2] = dive(t);
      };
      const prof = (p: Array<[number, number]>) => p.map(([x, y]) => [x * side, y] as [number, number]);
      const nF = near ? 1 : -1;
      met.color(GALV);
      // Front (traffic) face normals point towards the road: -side.
      met.extrude(prof(near ? W_FRONT : W_FRONT_LO), zA, zB, 5, { normalSign: nF, uvScale: 1.5, vBase: s0 % 512, xform });
      met.color(GALV_DARK);
      met.extrude(prof(W_BACK), zA, zB, 5, { normalSign: -nF, uvScale: 1.5, vBase: s0 % 512, xform });
      // 4 m units (2 posts + splice) instanced on the global 4 m grid; terminal posts merged.
      const single = (s: number) => {
        const t = ramp(s);
        const top = RAIL_TOP - 0.05 + dive(t);
        if (top < 0.12 || s < plan.railA || s > plan.railB) return;
        const z = zOf(s);
        addPost(met, side, face + side * (X0 + flare(t)), z, top, near);
        if (near) bolt(met, side, face + side * (wOff(0.5) - 0.002 + flare(t)), YM + dive(t), z, 0.017);
      };
      for (let s = Math.ceil(spec.s0 / 4) * 4; s < spec.s1; s += 4) {
        if (near && s >= plan.railA && s + 2 <= plan.railB && ramp(s) === 0 && ramp(s + 2) === 0 && s - 0.17 > plan.railA - (plan.termA ? 0 : 1)) {
          units.push({ s, d: face });
        } else {
          single(s);
          single(s + 2);
        }
      }
      // End anchors: a short concrete footing where the beam enters the ground.
      if (plan.termA) met.color(CONCRETE_GREY).primAt(BOX, face + side * 0.78, 0.0, zOf(plan.railA), 0.5, 0.12, 0.8, 0, 0.5);
      if (plan.termB) met.color(CONCRETE_GREY).primAt(BOX, face + side * 0.78, 0.0, zOf(plan.railB), 0.5, 0.12, 0.8, 0, 0.5);
    }
  }

  // Gantry truss (merged here: per-vertex lamp bake, one draw call less than its own mesh).
  const truss = gantryTruss(spec);
  if (truss && spec.gantryS !== null) met.append(truss, 0, 0, zOf(spec.gantryS));

  // Verge metalwork.
  for (const sg of plan.signs) {
    const z = zOf(sg.s);
    const top = sg.y + sg.h * 0.5;
    met.color(GALV_DARK);
    for (const pd of sg.postD) {
      if (sg.d < MEDIAN_D + 0.5) {
        // On the median barrier: short post on a base plate.
        met.primAt(CYL8, pd, MEDIAN_HEIGHT + (top - MEDIAN_HEIGHT) * 0.5, z - 0.04, 0.035, top - MEDIAN_HEIGHT, 0.035);
      } else {
        met.primAt(CYL8, pd, top * 0.5 - 0.1, z - 0.06, 0.04, top + 0.2, 0.04);
      }
    }
    // Back plate (slightly larger than the face, behind it).
    met.color(GALV);
    const back = (sg.kind === 'speed100' || sg.kind === 'speed80') ? CYL8 : BOX;
    if (back === CYL8) met.member(CYL8, sg.d, sg.y, z - 0.005, sg.d, sg.y, z - 0.035, sg.w * 0.5, sg.w * 0.5);
    else met.primAt(BOX, sg.d, sg.y, z - 0.02, sg.w + 0.02, sg.h + 0.02, 0.025, sg.yaw);
  }
  for (const s of plan.hecto) {
    const z = zOf(s);
    met.color(GALV_DARK).primAt(CYL8, 11.55, 0.75, z - 0.03, 0.025, 1.6, 0.025);
  }
  if (plan.phoneS !== null) {
    const z = zOf(plan.phoneS);
    const d = 12.1;
    met.color(GALV_DARK).primAt(CYL8, d, 0.55, z, 0.06, 1.1, 0.06);
    met.color(ORANGE).primAt(BOX, d, 1.35, z, 0.36, 0.62, 0.28);
    met.color(DARK).primAt(BOX, d - 0.002, 1.42, z + 0.145, 0.26, 0.3, 0.012);
    met.color(ORANGE).primAt(BOX, d, 1.7, z, 0.42, 0.06, 0.34);
    // Hard-standing slab.
    met.color(CONCRETE_GREY).primAt(BOX, d - 0.2, 0.02, z, 1.4, 0.06, 1.6);
  }
  if (plan.cameraS !== null) {
    // Traffic camera: 7 m galvanised pole, short outrigger over the shoulder, housing + sun shield.
    const z = zOf(plan.cameraS);
    met.color(GALV_DARK).primAt(CYL8, 12.5, 0.15, z, 0.32, 0.3, 0.32);
    met.color(GALV_POST).primAt(CYL8, 12.5, 3.6, z, 0.085, 7.2, 0.085);
    met.member(CYL8, 12.5, 7.0, z, 10.9, 7.0, z, 0.05, 0.05);
    met.color(DARK).primAt(BOX, 12.5, 2.2, z - 0.1, 0.3, 0.45, 0.16);
    met.color([0.34, 0.34, 0.33]).primAt(BOX, 11.0, 6.82, z + 0.05, 0.2, 0.2, 0.5);
    met.color(GALV).primAt(BOX, 11.0, 6.95, z + 0.1, 0.26, 0.015, 0.62);
    met.color([0.02, 0.02, 0.02]).primAt(BOX, 11.0, 6.82, z + 0.305, 0.12, 0.12, 0.01);
  }
  // Drain grates in the gutters (right shoulder and along the median).
  for (const s of plan.grates) {
    const z = zOf(s);
    for (const gd of [BARRIER_RIGHT_D - 0.35, MEDIAN_D + MEDIAN_HALF + 0.3]) {
      // Flat frame + bars (top faces only: seen from above, a few mm proud of the asphalt).
      met.color(DARK);
      met.face(gd - 0.23, 0.006, z + 0.43, gd + 0.23, 0.006, z + 0.43, gd + 0.23, 0.006, z - 0.43, gd - 0.23, 0.006, z - 0.43, 0, 1, 0);
      met.color(RUSTY);
      for (let k = -3; k <= 3; k++) {
        const zz = z + k * 0.11;
        met.face(gd - 0.21, 0.011, zz + 0.018, gd + 0.21, 0.011, zz + 0.018, gd + 0.21, 0.011, zz - 0.018, gd - 0.21, 0.011, zz - 0.018, 0, 1, 0);
      }
    }
  }
  if (met.count) {
    // Weathering coordinates (s, height) before bending.
    const n = met.count;
    const w = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      w[i * 2] = s0 - met.pos[i * 3 + 2];
      w[i * 2 + 1] = met.pos[i * 3 + 1];
    }
    const mg = met.build({ nsW: { data: w, size: 2 } });
    if (mg) b.addBent(mg, railMaterial(b), { name: 'furn-rail' });
  }
  if (units.length) {
    b.addInstances(railUnitGeometry(), railMaterial(b), units, { sharedGeometry: true, name: 'furn-posts' });
  }
}
