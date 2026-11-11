/**
 * Cable-stayed river bridge (zone 'bridge'): parapets, walkways and maintenance railings,
 * deck fascia + under-deck girders, expansion joints every 110 m, one H-pylon per chunk
 * (legs outside both deck edges) with two semi-fans of stay cables per leg, red aircraft
 * beacons, white architectural flood light (baked into the pylon) and abutments.
 */
import { Vector3 } from 'three';
import type { MeshBasicMaterial } from 'three';
import type { IChunkBuilder, Placement, RoadFrame } from '../../../core/types';
import { smoothstep } from '../../../core/math';
import { BARRIER_RIGHT_D, BRIDGE_WATER_Y, CHUNK_LENGTH, MEDIAN_D, PAVED_LEFT_D, PAVED_RIGHT_D, mirrorD } from '../../roadProfile';
import { Geo, addGeo, addPosts } from './geom';
import type { GeoStats, Vec3 } from './geom';
import { ATLAS, BEACON_COLOR, BEACON_INTENSITY, CABLE_RADIUS, structureMaterials } from './materials';

const PARAPET_TOP = 1.1;
const WALK_IN = 10.92;
const WALK_OUT = 12.6;
const WALK_Y = 0.15;
const EDGE_D = 13.8;
const EDGE_TOP = 0.3;
const SLAB_BOTTOM = -0.7;
const GIRDER_BOTTOM = -2.6;
const ANCHOR_D = 13.15;
/** Pylon legs: centre at the deck level ≈ 16.4, leaning inwards slightly. */
const LEG_BOTTOM_Y = -30;
const LEG_TOP_Y = 72;
const LEG_X_BOTTOM = 16.6;
const LEG_X_TOP = 15.8;
const CABLES_PER_FAN = 12;
const CABLE_R = CABLE_RADIUS;
const PYLON_Z = -110;
/** Expansion joints relative to the chunk start (bridge runs start on chunk boundaries). */
const JOINTS = [55, 165];

const cableLight = (_x: number, y: number): number => 0.5 + 4.5 * Math.exp(-y / 16) + 2.5 * Math.exp(-(LEG_TOP_Y - 4 - y) / 8);
const _w0 = new Vector3();
const _w1 = new Vector3();
const _frame: RoadFrame = { s: 0, x: 0, z: 0, h: 0, k: 0, tx: 0, tz: -1, rx: 1, rz: 0 };

/** Deck furniture, joints and abutments. */
export function buildBridgeDeck(b: IChunkBuilder, stats?: GeoStats): void {
  const sp = b.spec;
  if (sp.zone !== 'bridge') return;
  const M = structureMaterials(b.materials);
  const z0 = 0;
  const z1 = -CHUNK_LENGTH;
  const panel = new Geo(0.25, 4);
  const plain = new Geo(0.25, 4);
  const steel = new Geo(0.5, 4);
  const retro = new Geo();
  const under = new Geo(0.25, 4, 14);
  const posts: Placement[] = [];

  for (const opp of [false, true]) {
    for (const g of [panel, plain, steel]) g.transform(opp ? -1 : 1, opp ? 2 * MEDIAN_D : 0);
    // Solid safety-shape parapet (face at BARRIER_RIGHT_D).
    panel.shade = (_x, y) => 0.55 + 0.4 * smoothstep(0, 0.9, y);
    const P = BARRIER_RIGHT_D;
    panel.extrude([P, 0, P, 0.08, P + 0.15, 0.3, P + 0.18, PARAPET_TOP, WALK_IN, PARAPET_TOP, WALK_IN, WALK_Y], z0, z1);
    // Walkway, anchor strip, fascia, underside of the edge girder.
    plain.shade = (_x, y) => (y < 0 ? 0.5 : 0.75);
    plain.extrude([WALK_IN, WALK_Y, WALK_OUT, WALK_Y, WALK_OUT, EDGE_TOP, EDGE_D, EDGE_TOP, EDGE_D, GIRDER_BOTTOM, 12.4, GIRDER_BOTTOM, 12.4, SLAB_BOTTOM], z0, z1);
    // Parapet top rail.
    steel.tint(0.5, 0.52, 0.55);
    const xr = P + 0.35;
    for (let s = sp.s0 + 1.25; s < sp.s1; s += 2.5) posts.push({ s, d: opp ? mirrorD(xr) : xr, y: PARAPET_TOP, scale: [0.07, 0.32, 0.1] });
    steel.box(xr - 0.07, xr + 0.07, PARAPET_TOP + 0.3, PARAPET_TOP + 0.38, z1, z0);
    // Maintenance railing on the outer edge of the walkway.
    steel.tint(0.42, 0.44, 0.46);
    const xm = WALK_OUT - 0.08;
    for (let s = sp.s0 + 1; s < sp.s1; s += 2) posts.push({ s, d: opp ? mirrorD(xm) : xm, y: WALK_Y, scale: [0.06, 1.1, 0.06] });
    steel.box(xm - 0.04, xm + 0.04, 1.2, 1.27, z1, z0);
    steel.box(xm - 0.025, xm + 0.025, 0.68, 0.73, z1, z0, 4);
  }
  for (const g of [panel, plain, steel]) g.identity();
  panel.shade = null;

  // Slab underside + longitudinal box girders + diaphragms (seen from the side / below).
  // (Never reached by lamp light: not baked, coarse across.)
  under.tint(0.4);
  under.extrude([12.4, SLAB_BOTTOM, mirrorD(12.4), SLAB_BOTTOM], z0, z1);
  for (const xc of [1.5, MEDIAN_D, mirrorD(1.5)]) {
    const a = xc - 2.4;
    const c = xc + 2.4;
    under.extrude([c, SLAB_BOTTOM, c, -3.0, a, -3.0, a, SLAB_BOTTOM], z0, z1);
  }
  for (let z = z0 - 11; z > z1; z -= 22) under.box(mirrorD(12.4), 12.4, GIRDER_BOTTOM + 0.3, SLAB_BOTTOM, z - 0.18, z + 0.18, 8);

  // Expansion joints: steel finger plates with dark seals, across the full paved width.
  const joints = [...JOINTS];
  if (sp.zoneIndex === 0) joints.push(0.6);
  if (sp.zoneIndex === sp.zoneLength - 1) joints.push(CHUNK_LENGTH - 0.6);
  for (const j of joints) {
    const z = -j;
    steel.tint(0.32, 0.33, 0.34);
    steel.box(PAVED_LEFT_D, PAVED_RIGHT_D, 0.004, 0.018, z - 0.28, z + 0.28, 4);
    steel.tint(0.04);
    for (const dz of [-0.1, 0.1]) steel.box(PAVED_LEFT_D, PAVED_RIGHT_D, 0.018, 0.022, z + dz - 0.03, z + dz + 0.03, 4);
    steel.tint(0.4);
    for (const opp of [false, true]) {
      const x0 = opp ? mirrorD(EDGE_D) : WALK_IN;
      const x1 = opp ? mirrorD(WALK_IN) : EDGE_D;
      steel.box(x0, x1, EDGE_TOP + 0.005, EDGE_TOP + 0.02, z - 0.3, z + 0.3, 4);
    }
  }

  // Abutments on the first / last chunk (local z ≥ 0 is the land side).
  const ends: boolean[] = [];
  if (sp.zoneIndex === 0) ends.push(false);
  if (sp.zoneIndex === sp.zoneLength - 1) ends.push(true);
  for (const atEnd of ends) {
    const sz = atEnd ? -1 : 1;
    const oz = atEnd ? -CHUNK_LENGTH : 0;
    plain.transform(1, 0, sz, oz);
    panel.transform(1, 0, sz, oz);
    plain.shade = (_x, y) => 0.45 + 0.3 * smoothstep(BRIDGE_WATER_Y, -2, y);
    plain.box(mirrorD(EDGE_D) - 1, EDGE_D + 1, BRIDGE_WATER_Y - 2, SLAB_BOTTOM, -1.2, 9, 8 | 4);
    for (const x of [EDGE_D + 1, mirrorD(EDGE_D) - 1.8]) plain.box(x, x + 0.8, BRIDGE_WATER_Y - 2, EDGE_TOP + 0.4, -1.2, 16, 4);
    // Massive parapet end blocks.
    panel.shade = () => 0.85;
    for (const opp of [false, true]) {
      panel.transform(opp ? -1 : 1, opp ? 2 * MEDIAN_D : 0, sz, oz);
      panel.box(BARRIER_RIGHT_D, WALK_IN + 0.3, 0, 1.45, -1.0, 2.0, 4);
    }
    plain.identity();
    panel.identity();
    // Bridge name plate on posts, facing the traffic that enters here.
    retro.transform(atEnd ? -1 : 1, atEnd ? 2 * MEDIAN_D : 0, sz, oz);
    steel.transform(atEnd ? -1 : 1, atEnd ? 2 * MEDIAN_D : 0, sz, oz);
    const [u0, v0, u1, v1] = ATLAS.plate;
    const zp = 7;
    retro.uvQuad([11.4, 1.45, zp + 0.04], [13.8, 1.45, zp + 0.04], [13.8, 2.05, zp + 0.04], [11.4, 2.05, zp + 0.04], [0, 0, 1], u0, v0, u1, v1);
    steel.tint(0.3);
    steel.box(11.4, 13.8, 1.43, 2.07, zp - 0.02, zp + 0.035);
    for (const x of [11.7, 13.5]) steel.box(x - 0.04, x + 0.04, 0, 1.45, zp - 0.04, zp + 0.04, 4);
    retro.identity();
    steel.identity();
  }
  plain.shade = null;
  panel.shade = null;

  addGeo(b, panel, M.panel, { name: 'bridge-parapets' }, stats);
  addGeo(b, plain, M.plain, { name: 'bridge-deck' }, stats);
  addGeo(b, under, M.plain, { name: 'bridge-underside', bake: false }, stats);
  addPosts(b, M.steel, posts, stats);
  addGeo(b, steel, M.steel, { name: 'bridge-steel', noProbe: true }, stats);
  addGeo(b, retro, M.retro, { name: 'bridge-plate', noProbe: true }, stats);
}

/** One H-pylon per bridge chunk with stay cables, beacons and flood light. */
export function buildBridgePylon(b: IChunkBuilder, stats?: GeoStats): void {
  const sp = b.spec;
  if (sp.zone !== 'bridge') return;
  const M = structureMaterials(b.materials);
  const con = new Geo(0.2, 4);
  const cab = new Geo(0.5, 4);
  const glow = new Geo();
  const bea = new Geo();
  const zp = PYLON_Z;
  const legX = (y: number) => LEG_X_BOTTOM + ((LEG_X_TOP - LEG_X_BOTTOM) * (y - LEG_BOTTOM_Y)) / (LEG_TOP_Y - LEG_BOTTOM_Y);
  const cool: Vec3 = [0.82, 0.9, 1.0];

  // Architectural flood light: strong at the deck, fading up the shaft, with a lit crown.
  con.lightColor = cool;
  con.light = (_x, y, _z, _nx, ny) => {
    const side = ny > 0.5 ? 0.5 : ny < -0.5 ? 0.15 : 1;
    if (y < -0.5) return side * 3.2 * Math.exp((y + 0.5) / 9);
    return side * (10 * Math.exp(-y / 22) + 1.1 + 8 * Math.exp(-(LEG_TOP_Y - y) / 5));
  };
  con.shade = (_x, y) => 0.72 + 0.2 * smoothstep(BRIDGE_WATER_Y, 10, y);
  for (const opp of [false, true]) {
    con.transform(opp ? -1 : 1, opp ? 2 * MEDIAN_D : 0);
    const yb = LEG_BOTTOM_Y;
    const yt = LEG_TOP_Y;
    const xb = LEG_X_BOTTOM;
    const xt = LEG_X_TOP;
    const hxb = 1.7;
    const hzb = 2.4;
    const hxt = 1.0;
    const hzt = 1.45;
    con.hexa([
      [xb - hxb, yb, zp - hzb],
      [xb + hxb, yb, zp - hzb],
      [xb + hxb, yb, zp + hzb],
      [xb - hxb, yb, zp + hzb],
      [xt - hxt, yt, zp - hzt],
      [xt + hxt, yt, zp - hzt],
      [xt + hxt, yt, zp + hzt],
      [xt - hxt, yt, zp + hzt],
    ], 4);
    // Pile cap at the waterline.
    con.box(xb - 3.4, xb + 3.4, BRIDGE_WATER_Y - 3, BRIDGE_WATER_Y + 1.6, zp - 4.6, zp + 4.6, 4);
  }
  con.identity();
  // Cross-beams: under the deck, mid strut, crown beam.
  const beam = (y0: number, y1: number, hz: number) => {
    const xi = legX((y0 + y1) / 2) - 0.9;
    con.box(mirrorD(xi), xi, y0, y1, zp - hz, zp + hz);
  };
  beam(-6.6, SLAB_BOTTOM - 0.05, 2.0);
  beam(38, 41.5, 1.6);
  beam(66, 69.2, 1.35);
  con.light = null;
  con.shade = null;

  // Stay cables: straight in WORLD space (projected back into road space point by point).
  cab.tint(0.5, 0.52, 0.54);
  cab.lightColor = cool;
  cab.light = cableLight;
  const s0 = sp.s0;
  for (const opp of [false, true]) {
    for (let i = 0; i < CABLES_PER_FAN; i++) {
      const yTop = 44 + i * 2;
      const reach = 16 + i * 7.6;
      for (const dir of [1, -1]) {
        const dTop = opp ? mirrorD(legX(yTop)) : legX(yTop);
        const dDeck = opp ? mirrorD(ANCHOR_D) : ANCHOR_D;
        const sTop = s0 - zp;
        const sDeck = sTop + dir * reach;
        b.road.toWorld(sTop, dTop, yTop, _w0);
        b.road.toWorld(sDeck, dDeck, EDGE_TOP + 0.35, _w1);
        const n = Math.max(2, Math.ceil(reach / 4) + 1);
        const path: Vec3[] = [];
        for (let k = 0; k < n; k++) {
          // Point on the straight WORLD chord, expressed in road space to first order around
          // the linearly interpolated (s, d): the bend then maps it back onto the chord.
          const t = k / (n - 1);
          const sl = sTop + (sDeck - sTop) * t;
          const dl = dTop + (dDeck - dTop) * t;
          const f = b.road.frameAt(sl, _frame);
          const ex = _w0.x + (_w1.x - _w0.x) * t - (f.x + f.rx * dl);
          const ez = _w0.z + (_w1.z - _w0.z) * t - (f.z + f.rz * dl);
          const sc = sl + ex * f.tx + ez * f.tz;
          const dc = dl + ex * f.rx + ez * f.rz;
          path.push([dc, _w0.y + (_w1.y - _w0.y) * t, -(sc - s0)]);
        }
        cab.tube(path, CABLE_R, 6);
        // Anchor housing on the deck.
        const zd = -(sDeck - s0);
        cab.tint(0.3);
        cab.light = null;
        cab.box(dDeck - 0.28, dDeck + 0.28, EDGE_TOP, EDGE_TOP + 0.45, zd - 0.5, zd + 0.5, 4);
        cab.tint(0.5, 0.52, 0.54);
        cab.light = cableLight;
      }
    }
  }

  // Flood light fittings (emissive) at the leg feet and under the crown.
  glow.tint(cool[0] * 22, cool[1] * 22, cool[2] * 22);
  for (const opp of [false, true]) {
    glow.transform(opp ? -1 : 1, opp ? 2 * MEDIAN_D : 0);
    for (const dz of [-3.1, 3.1]) {
      glow.box(EDGE_D - 0.55, EDGE_D - 0.15, EDGE_TOP, EDGE_TOP + 0.16, zp + dz - 0.2, zp + dz + 0.2, 4);
    }
    // Beacons on the leg tops and at mid height (outer face).
    bea.transform(opp ? -1 : 1, opp ? 2 * MEDIAN_D : 0);
    const xt = LEG_X_TOP;
    bea.box(xt - 0.22, xt + 0.22, LEG_TOP_Y, LEG_TOP_Y + 0.5, zp - 0.22, zp + 0.22, 4);
    const xm = legX(40) + 1.25;
    bea.box(xm, xm + 0.3, 39.6, 40.0, zp - 0.18, zp + 0.18, 1);
  }
  glow.identity();
  bea.identity();

  addGeo(b, con, M.plain, { name: 'pylon' }, stats);
  addGeo(b, cab, M.cable, { name: 'pylon-cables', noProbe: true, bake: false }, stats);
  addGeo(b, glow, M.glow, { name: 'pylon-floods', bake: false, noProbe: true }, stats);
  addGeo(b, bea, M.beacon, { name: 'pylon-beacons', bake: false }, stats);
  // Slow synchronous blink (shared material: every chunk writes the same value).
  const mat = M.beacon as MeshBasicMaterial;
  b.onUpdate((time) => {
    const ph = (time % 2.0) / 2.0;
    const k = ph < 0.42 ? smoothstep(0, 0.06, ph) * (1 - smoothstep(0.34, 0.42, ph)) : 0;
    mat.color.copy(BEACON_COLOR).multiplyScalar(BEACON_INTENSITY * (0.04 + 0.96 * k));
  });
}
