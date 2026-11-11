/**
 * Small roadside stuff: raised reflective road studs, median-top delineators, guardrail
 * reflector tabs, verge delineator posts, hectometre plates and verge sign faces.
 */
import type { BufferGeometry } from 'three';
import type { IChunkBuilder, Placement } from '../../../core/types';
import {
  BARRIER_RIGHT_D,
  GUARDRAIL_HEIGHT,
  LANES_HALF,
  LANE_WIDTH,
  MEDIAN_D,
  MEDIAN_HEIGHT,
  mirrorD,
} from '../../roadProfile';
import { BOX, RAIL_TOP } from './barriers';
import { Geo } from './geo';
import type { RGB } from './geo';
import { plasticMaterial, reflectorMaterial, vergeSignMaterial } from './materials';
import { planFor } from './plan';
import { getSignAtlas } from './signAtlas';

const WHITE: RGB = [0.95, 0.95, 0.92];
const AMBER: RGB = [1.0, 0.5, 0.06];
const RED: RGB = [0.9, 0.05, 0.03];
const BODY: RGB = [0.32, 0.32, 0.3];

/** Stud phase: in the middle of the 7.4 m gap between 3.6 m dashes (period 11 m). */
const STUD_PHASE = 7.3;
const STUD_STEP = 11;

/** Raised stud: a low frustum body with two sloped reflector faces (front +Z / back -Z). */
function stud(g: Geo, x: number, z: number, front: RGB, back: RGB): void {
  const hw = 0.06;
  const hl = 0.08;
  const tw = 0.045;
  const tl = 0.035;
  const h = 0.022;
  g.color(BODY);
  // Top.
  g.face(x - tw, h, z + tl, x + tw, h, z + tl, x + tw, h, z - tl, x - tw, h, z - tl, 0, 1, 0);
  // Sides.
  g.face(x - hw, 0, z + hl, x - tw, h, z + tl, x - tw, h, z - tl, x - hw, 0, z - hl, -0.8, 0.6, 0);
  g.face(x + hw, 0, z - hl, x + tw, h, z - tl, x + tw, h, z + tl, x + hw, 0, z + hl, 0.8, 0.6, 0);
  // Reflective faces.
  g.color(front);
  g.face(x - hw, 0, z + hl, x + hw, 0, z + hl, x + tw, h, z + tl, x - tw, h, z + tl, 0, 0.55, 0.83);
  g.color(back);
  g.face(x + hw, 0, z - hl, x - hw, 0, z - hl, x - tw, h, z - tl, x + tw, h, z - tl, 0, 0.55, -0.83);
}

/** Small vertical reflector plate facing ±Z. */
function plate(g: Geo, x: number, y: number, z: number, w: number, h: number, nz: number, c: RGB): void {
  g.color(c);
  const hw = w * 0.5;
  const hh = h * 0.5;
  g.face(x - hw, y - hh, z, x + hw, y - hh, z, x + hw, y + hh, z, x - hw, y + hh, z, 0, 0, nz);
}

let rowGeo: BufferGeometry | null = null;
/** Every stud across both carriageways at one s (x = d). Rigid, so it is instanced per row. */
function studRowGeometry(): BufferGeometry {
  if (rowGeo) return rowGeo;
  const g = new Geo();
  const edgeL = -(LANES_HALF - 0.12);
  const edgeR = LANES_HALF - 0.12;
  for (const d of [-LANE_WIDTH, 0, LANE_WIDTH]) {
    stud(g, d, 0, WHITE, WHITE);
    stud(g, mirrorD(d), 0, WHITE, WHITE);
  }
  stud(g, edgeL, 0, AMBER, AMBER);
  stud(g, edgeR, 0, RED, RED);
  stud(g, mirrorD(edgeL), 0, AMBER, AMBER);
  stud(g, mirrorD(edgeR), 0, RED, RED);
  rowGeo = g.build()!;
  rowGeo.computeBoundingSphere();
  return rowGeo;
}

let postGeo: BufferGeometry | null = null;
/** Delineator post: 1.05 m white post with a black band; reflector added separately. */
function delineatorGeometry(): BufferGeometry {
  if (postGeo) return postGeo;
  const g = new Geo();
  g.color(WHITE);
  g.primAt(BOX, 0, 0.36, 0, 0.1, 0.8, 0.12);
  g.color([0.03, 0.03, 0.03]);
  g.primAt(BOX, 0, 0.9, 0, 0.1, 0.28, 0.12);
  g.color(WHITE);
  g.primAt(BOX, 0, 1.06, 0, 0.1, 0.04, 0.12);
  postGeo = g.build()!;
  return postGeo;
}

export function buildSmall(b: IChunkBuilder): void {
  const spec = b.spec;
  const plan = planFor(spec, b.road);
  const s0 = spec.s0;
  const zOf = (s: number) => -(s - s0);
  const ref = new Geo();
  const sig = new Geo();
  const posts: Placement[] = [];

  // ── road studs on both carriageways (also in tunnels): one shared row geometry per 11 m ──
  const rows: Placement[] = [];
  for (let s = Math.ceil((s0 - STUD_PHASE) / STUD_STEP) * STUD_STEP + STUD_PHASE; s < spec.s1; s += STUD_STEP) {
    if (s >= s0) rows.push({ s, d: 0 });
  }
  // ── delineators on top of the median barrier every 22 m ──
  if (plan.median) {
    for (let s = Math.ceil(s0 / 22) * 22 + 11; s < spec.s1; s += 22) {
      const z = zOf(s);
      ref.color(BODY);
      ref.primAt(BOX, MEDIAN_D, MEDIAN_HEIGHT + 0.1, z, 0.03, 0.2, 0.05);
      plate(ref, MEDIAN_D, MEDIAN_HEIGHT + 0.13, z + 0.027, 0.09, 0.12, 1, AMBER);
      plate(ref, MEDIAN_D, MEDIAN_HEIGHT + 0.13, z - 0.027, 0.09, 0.12, -1, WHITE);
    }
  }

  // ── guardrail reflector tabs on every 6th post (12 m), clipped on top of the blockout ──
  if (plan.rail) {
    for (let s = Math.ceil(Math.max(plan.railA + 14, s0) / 12) * 12; s < Math.min(plan.railB - 14, spec.s1); s += 12) {
      const z = zOf(s);
      for (const side of [1, -1]) {
        const face = side > 0 ? BARRIER_RIGHT_D : mirrorD(BARRIER_RIGHT_D);
        const x = face + side * 0.16;
        ref.color(BODY);
        ref.primAt(BOX, x, RAIL_TOP + 0.05, z, 0.025, 0.14, 0.04);
        plate(ref, x, RAIL_TOP + 0.08, z + side * 0.021, 0.07, 0.06, side, WHITE);
      }
    }
  }

  // ── verge delineator posts (both outer edges) ──
  if (plan.verge) {
    for (const s of plan.delineators) {
      const z = zOf(s);
      const dR = BARRIER_RIGHT_D + 0.85;
      const dL = mirrorD(dR);
      posts.push({ s, d: dR }, { s, d: dL, yaw: Math.PI });
      plate(ref, dR, 0.9, z + 0.062, 0.05, 0.16, 1, RED);
      plate(ref, dL, 0.9, z - 0.062, 0.05, 0.16, -1, RED);
      // Back side: white (seen by the other carriageway).
      plate(ref, dR, 0.9, z - 0.062, 0.04, 0.05, -1, WHITE);
      plate(ref, dL, 0.9, z + 0.062, 0.04, 0.05, 1, WHITE);
    }
  }

  // ── sign faces ──
  const atlas = getSignAtlas();
  for (const sg of plan.signs) {
    const uv = atlas.small[sg.kind];
    const z = zOf(sg.s);
    const hw = sg.w * 0.5;
    const hh = sg.h * 0.5;
    const c = Math.cos(sg.yaw);
    const sn = Math.sin(sg.yaw);
    // Rotate the face corners around the sign centre by yaw (normal (sin, 0, cos)).
    const px = (lx: number) => sg.d + lx * c;
    const pz = (lx: number) => z - lx * sn;
    const u0 = sg.flipU ? uv.u1 : uv.u0;
    const u1 = sg.flipU ? uv.u0 : uv.u1;
    const isRound = sg.kind === 'speed100' || sg.kind === 'speed80';
    const zoff = isRound ? 0 : 0.0;
    sig.face(px(-hw), sg.y - hh, pz(-hw) + zoff, px(hw), sg.y - hh, pz(hw) + zoff, px(hw), sg.y + hh, pz(hw) + zoff, px(-hw), sg.y + hh, pz(-hw) + zoff, sn, 0, c, [
      u0,
      uv.v0,
      u1,
      uv.v1,
    ]);
  }
  // Hectometre plates: "12.4"-style km readings, glyph quads on a short post.
  for (const s of plan.hecto) {
    const z = zOf(s) + 0.005;
    const km = (s + 12000) / 1000;
    const label = 'L' + km.toFixed(1) + 'R';
    const gw = 0.075;
    const gh = 0.16;
    const total = label.length * gw;
    let x = 11.55 - total / 2;
    for (const ch of label) {
      const uv = atlas.glyph[ch] ?? atlas.glyph[' '];
      sig.face(x, 1.45, z, x + gw, 1.45, z, x + gw, 1.45 + gh, z, x, 1.45 + gh, z, 0, 0, 1, [uv.u0, uv.v0, uv.u1, uv.v1]);
      x += gw;
    }
  }
  if (plan.phoneS !== null) {
    const uv = atlas.small.sos;
    const z = zOf(plan.phoneS);
    sig.face(11.92, 1.78, z + 0.1, 12.28, 1.78, z + 0.1, 12.28, 2.14, z + 0.1, 11.92, 2.14, z + 0.1, 0, 0, 1, [uv.u0, uv.v0, uv.u1, uv.v1]);
    ref.color(BODY);
    ref.primAt(BOX, 12.1, 1.96, z + 0.08, 0.38, 0.38, 0.02);
  }

  if (rows.length) b.addInstances(studRowGeometry(), reflectorMaterial(b), rows, { sharedGeometry: true, noProbe: true, name: 'furn-studs' });
  const rg = ref.build();
  if (rg) b.addBent(rg, reflectorMaterial(b), { name: 'furn-reflectors', noProbe: true });
  if (posts.length) b.addInstances(delineatorGeometry(), plasticMaterial(b), posts, { sharedGeometry: true, noProbe: true, name: 'furn-delineators' });
  const sgeo = sig.build();
  if (sgeo) b.addBent(sgeo, vergeSignMaterial(b), { name: 'furn-signs', noProbe: true });
}
