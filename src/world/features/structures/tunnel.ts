/**
 * Twin-tube cut-and-cover tunnel: tube interiors (per tunnel chunk), monumental portals on the
 * first / last chunk of the run, and approach retaining walls on the chunks before / after.
 * The light of the ceiling strips is simulated by LightField (road shader + baked into these
 * meshes through addBent); here we only build the fixtures.
 */
import { BoxGeometry } from 'three';
import type { IChunkBuilder, Placement } from '../../../core/types';
import { noise1, smoothstep } from '../../../core/math';
import { BARRIER_RIGHT_D, CHUNK_LENGTH, LANE_CENTERS, MEDIAN_D, TUNNEL_CEILING_Y, TUNNEL_LIGHT_D, TUNNEL_LIGHT_Y, TUNNEL_WALL_RIGHT_D, mirrorD } from '../../roadProfile';
import { Geo, addGeo, addPosts } from './geom';
import type { AuxFn, GeoStats, Vec3 } from './geom';
import { ATLAS, TUNNEL_FIT_LEN, TUNNEL_FIT_OFFSET, TUNNEL_FIT_PITCH, structureMaterials } from './materials';

/**
 * Wall-shader rhythm input: (s, effective distance to the nearest luminaire line). The scale
 * < 1 stands in for the fittings' asymmetric (wall-washing) distribution: scallops on the upper
 * walls, nearly even light low down.
 */
const RHYTHM_R_SCALE = 0.32;
const _aux: [number, number] = [0, 0];
function tunnelAux(s0: number): AuxFn {
  return (x, y, z) => {
    const opp = x < MEDIAN_D;
    let r = 1e9;
    for (const L of TUNNEL_LIGHT_D) {
      const ld = opp ? mirrorD(L) : L;
      r = Math.min(r, Math.hypot(x - ld, y - TUNNEL_LIGHT_Y));
    }
    _aux[0] = s0 - z;
    _aux[1] = Math.max(0.25, r * RHYTHM_R_SCALE);
    return _aux;
  };
}

const WR = TUNNEL_WALL_RIGHT_D; // 10.9
/** Face of the shared centre wall on our side (0.5 m thick wall centred on the median). */
export const TUNNEL_CENTRE_FACE_D = MEDIAN_D + 0.25; // -8.75
const WL = TUNNEL_CENTRE_FACE_D;
const CEIL = TUNNEL_CEILING_Y;
const KERB_Y = 0.3;
const PLINTH_Y = 0.95;
const TILE_TOP = 3.2;
const HAUNCH = 0.45;
/** Portal headwall extents. */
const HW_X0 = -45;
const HW_X1 = 28;
const HW_TOP = 13;
const HW_FACE = 1.2;
/** Approach walls. */
const APPROACH_LEN = 60;
const APPROACH_D = 12.6;
const APPROACH_H = 10;

const LENS_LEN = TUNNEL_FIT_LEN;
const LENS_PITCH = TUNNEL_FIT_PITCH;
/** Entrance (threshold) zone with doubled fittings, metres from the portal. */
const THRESHOLD_LEN = 110;
let lensGeo: BoxGeometry | null = null;

/**
 * Luminaire centres (s) in this chunk for one tube: global pitch, plus the in-between fittings
 * of the entrance (threshold) zone — at the run start for our tube, at the run end for the
 * opposite tube (its traffic enters there).
 */
function fittingS(b: IChunkBuilder, opp: boolean): number[] {
  const sp = b.spec;
  const out: number[] = [];
  const P = LENS_PITCH;
  const first = Math.ceil((sp.s0 - TUNNEL_FIT_OFFSET) / P) * P + TUNNEL_FIT_OFFSET;
  const runStart = sp.s0 - sp.zoneIndex * CHUNK_LENGTH;
  const runEnd = runStart + sp.zoneLength * CHUNK_LENGTH;
  for (let s = first; s < sp.s1; s += P) {
    out.push(s);
    const sh = s + P / 2;
    if (sh >= sp.s1) continue;
    if (!opp ? sh < runStart + THRESHOLD_LEN : sh > runEnd - THRESHOLD_LEN) out.push(sh);
  }
  return out;
}

/** Tube interior for one tunnel chunk. */
export function buildTunnelTubes(b: IChunkBuilder, stats?: GeoStats): void {
  if (b.spec.zone !== 'tunnel') return;
  const M = structureMaterials(b.materials);
  const z0 = 0;
  const z1 = -CHUNK_LENGTH;
  const s0 = b.spec.s0;
  const tun = new Geo(0.25, 4);
  const tiles = new Geo(0.25, 4);
  const steel = new Geo(0.5, 4);
  const glow = new Geo();
  const signs = new Geo();

  tun.auxFn = tunnelAux(s0);
  tiles.auxFn = tun.auxFn;
  for (const opp of [false, true]) {
    for (const g of [tun, tiles, steel]) g.transform(opp ? -1 : 1, opp ? 2 * MEDIAN_D : 0);
    // Long-wave variation along the tube so the walls are not perfectly uniform.
    const vary = (z: number) => 0.86 + 0.14 * noise1((s0 - z) / 13, opp ? 3 : 1);
    // Raised kerb / walkway on the right, its face painted yellow.
    tun.tint(0.95, 0.68, 0.12);
    tun.shade = (_x, _y, z) => 0.8 * vary(z);
    tun.extrude([BARRIER_RIGHT_D, 0, BARRIER_RIGHT_D, KERB_Y], z0, z1);
    tun.tint(1);
    tun.shade = (_x, _y, z) => 0.66 * vary(z);
    tun.extrude([BARRIER_RIGHT_D, KERB_Y, WR, KERB_Y], z0, z1);
    // Safety plinth on the centre wall.
    tun.shade = (_x, y, z) => (0.4 + 0.3 * smoothstep(0, PLINTH_Y, y)) * vary(z);
    tun.extrude([WL, PLINTH_Y, WL + 0.05, PLINTH_Y, WL + 0.05, 0], z0, z1);
    // Upper walls + haunches + ceiling: soot-darkened concrete, darkest above the lanes.
    tun.shade = (x, y, z) => (y > CEIL - 0.01 ? 0.17 + 0.05 * Math.abs(Math.sin(x * 0.7)) : 0.4 - 0.18 * smoothstep(TILE_TOP, CEIL, y)) * vary(z);
    tun.extrude([WR, TILE_TOP + 0.12, WR, CEIL - HAUNCH, WR - HAUNCH, CEIL, WL + HAUNCH, CEIL, WL, CEIL - HAUNCH, WL, TILE_TOP + 0.12], z0, z1);
    // Enamel panel band: spray / brake-dust grime towards the kerb, soot towards the top.
    tiles.shade = (_x, y, z) => (0.38 + 0.62 * smoothstep(0.25, 2.3, y)) * (1 - 0.22 * smoothstep(2.3, TILE_TOP, y)) * vary(z);
    tiles.extrude([WR, KERB_Y, WR, TILE_TOP], z0, z1);
    tiles.extrude([WL, TILE_TOP, WL, PLINTH_Y], z0, z1);
    tiles.shade = (_x, _y, z) => 0.22 * vary(z);
    tiles.extrude([WR, TILE_TOP, WR - 0.04, TILE_TOP, WR - 0.04, TILE_TOP + 0.12, WR, TILE_TOP + 0.12], z0, z1);
    tiles.extrude([WL, TILE_TOP + 0.12, WL + 0.04, TILE_TOP + 0.12, WL + 0.04, TILE_TOP, WL, TILE_TOP], z0, z1);
    // Luminaire trunking.
    steel.tint(0.42, 0.43, 0.45);
    // Cable trunking (continuous, slim) carrying the individual fittings.
    for (const L of TUNNEL_LIGHT_D) steel.box(L - 0.09, L + 0.09, TUNNEL_LIGHT_Y + 0.17, CEIL, z1, z0, 8);
    // Fitting housings at the luminaire pitch (global so the rhythm continues across chunks).
    steel.tint(0.2, 0.2, 0.21);
    for (const s of fittingS(b, opp)) {
      const zc = -(s - s0);
      for (const L of TUNNEL_LIGHT_D) steel.box(L - 0.24, L + 0.24, TUNNEL_LIGHT_Y + 0.02, TUNNEL_LIGHT_Y + 0.17, zc - LENS_LEN / 2 - 0.08, zc + LENS_LEN / 2 + 0.08, 8);
    }
    steel.tint(0.42, 0.43, 0.45);
    if (!opp) {
      // Cable trays on both walls.
      steel.tint(0.36, 0.37, 0.39);
      steel.extrude([WR - 0.02, 5.25, WR - 0.46, 5.25, WR - 0.46, 5.42, WR - 0.43, 5.42, WR - 0.43, 5.31, WR - 0.02, 5.31], z0, z1);
      steel.extrude([WL + 0.02, 5.31, WL + 0.43, 5.31, WL + 0.43, 5.42, WL + 0.46, 5.42, WL + 0.46, 5.25, WL + 0.02, 5.25], z0, z1);
      steel.tint(0.08, 0.08, 0.085);
      steel.extrude([WR - 0.42, 5.31, WR - 0.42, 5.37, WR - 0.05, 5.37], z0, z1);
      steel.extrude([WL + 0.05, 5.37, WL + 0.39, 5.37, WL + 0.39, 5.31], z0, z1);
    }
  }
  for (const g of [tun, tiles, steel]) g.identity();
  tun.shade = null;
  tiles.shade = null;

  // Amber wall reflectors every 11 m (global pitch so they continue across chunks).
  const amber: [number, number, number] = [1.0 * 1.4, 0.5 * 1.4, 0.08 * 1.4];
  glow.tint(amber[0], amber[1], amber[2]);
  for (let s = Math.ceil(s0 / 11) * 11; s < b.spec.s1; s += 11) {
    const z = -(s - s0);
    glow.box(WR - 0.02, WR, 0.95, 1.09, z - 0.05, z + 0.05, 2);
    glow.box(WL + 0.05, WL + 0.07, 0.66, 0.8, z - 0.05, z + 0.05, 1);
  }

  // Jet fans (pairs) every 110 m.
  for (const zf of [-40, -150]) {
    for (const x of [-1.0, 2.4]) {
      const yc = CEIL - 0.3 - 0.6;
      const pz = [2.35, 2.2, 1.7, -1.7, -2.2, -2.35];
      const pr = [0.66, 0.62, 0.6, 0.6, 0.62, 0.66];
      steel.tint(0.5, 0.51, 0.52);
      steel.tube(pz.map((dz) => [x, yc, zf + dz] as Vec3), pr, 18);
      steel.tint(0.05, 0.05, 0.055);
      steel.tube([[x, yc, zf + 2.25], [x, yc, zf - 2.25]], 0.55, 12, true, true);
      steel.tint(0.3, 0.3, 0.32);
      for (const dz of [-1.2, 1.2]) steel.box(x - 0.05, x + 0.05, yc + 0.55, CEIL, zf + dz - 0.06, zf + dz + 0.06, 8);
      steel.box(x - 0.35, x + 0.35, CEIL - 0.06, CEIL, zf - 1.4, zf + 1.4, 8);
    }
  }

  // Emergency exits (right wall) every 110 m, SOS niches in between.
  for (const zd of [-95, -205]) {
    tun.tint(0.8, 0.8, 0.78);
    tun.box(WR - 0.12, WR, KERB_Y, 2.78, zd - 0.95, zd + 0.95, 2 | 4);
    steel.tint(0.03, 0.3, 0.12);
    steel.box(WR - 0.15, WR - 0.12, KERB_Y + 0.03, 2.5, zd - 0.62, zd + 0.62, 2);
    steel.tint(0.7, 0.7, 0.7);
    steel.box(WR - 0.2, WR - 0.15, 1.05, 1.1, zd - 0.45, zd + 0.3, 2);
    const [u0, v0, u1, v1] = ATLAS.exit;
    signs.tint(3);
    // Flat sign above the door (faces −x; viewer looking +x has +z on the right).
    const xs = WR - 0.125;
    signs.uvQuad([xs, 2.82, zd - 0.42], [xs, 2.82, zd + 0.42], [xs, 3.24, zd + 0.42], [xs, 3.24, zd - 0.42], [-1, 0, 0], u0, v0, u1, v1);
    // Flag sign sticking out of the wall, readable from both directions.
    const xa = WR - 0.95;
    const xb = WR - 0.15;
    const zs = zd + 1.4;
    signs.uvQuad([xa, 3.55, zs + 0.03], [xb, 3.55, zs + 0.03], [xb, 3.95, zs + 0.03], [xa, 3.95, zs + 0.03], [0, 0, 1], u0, v0, u1, v1);
    signs.uvQuad([xb, 3.55, zs - 0.03], [xa, 3.55, zs - 0.03], [xa, 3.95, zs - 0.03], [xb, 3.95, zs - 0.03], [0, 0, -1], u0, v0, u1, v1);
    steel.tint(0.25);
    steel.box(xa - 0.02, WR, 3.53, 3.97, zs - 0.025, zs + 0.025);
    steel.box(xb, WR, 3.95, 4.05, zs - 0.03, zs + 0.03);
    // Green glow strips framing the door.
    glow.tint(0.05 * 3, 1.0 * 3, 0.35 * 3);
    for (const dz of [-1.0, 1.0]) glow.box(WR - 0.14, WR - 0.12, 0.6, 2.6, zd + dz - 0.03, zd + dz + 0.03, 2);
  }
  for (const zn of [-40, -150]) {
    tun.tint(0.12);
    tun.box(WR - 0.04, WR, 0.9, 2.2, zn - 0.7, zn + 0.7, 2);
    steel.tint(0.6, 0.28, 0.06);
    steel.box(WR - 0.07, WR - 0.04, 0.95, 2.15, zn - 0.6, zn + 0.6, 2);
    const [u0, v0, u1, v1] = ATLAS.sos;
    signs.tint(2.2);
    const xs = WR - 0.075;
    signs.uvQuad([xs, 2.3, zn - 0.45], [xs, 2.3, zn + 0.45], [xs, 2.75, zn + 0.45], [xs, 2.75, zn - 0.45], [-1, 0, 0], u0, v0, u1, v1);
  }
  tun.tint(1);
  tun.auxFn = null;
  tiles.auxFn = null;

  // Lane-control gantries (our tube): green arrows over the lanes, red cross over the hard
  // shoulder, and a back-lit speed limit next to the fast lane.
  const face = (key: keyof typeof ATLAS, xc: number, yc: number, z: number, w: number, h: number) => {
    const [u0, v0, u1, v1] = ATLAS[key];
    signs.uvQuad([xc - w / 2, yc - h / 2, z], [xc + w / 2, yc - h / 2, z], [xc + w / 2, yc + h / 2, z], [xc - w / 2, yc + h / 2, z], [0, 0, 1], u0, v0, u1, v1);
  };
  for (const zg of [-20, -130]) {
    steel.tint(0.3, 0.31, 0.33);
    steel.box(WL + 0.1, WR - 0.1, CEIL - 0.24, CEIL, zg - 0.12, zg + 0.12, 8);
    const heads: Array<[number, keyof typeof ATLAS]> = [...LANE_CENTERS.map((d) => [d, 'lcsArrow'] as [number, keyof typeof ATLAS]), [8.9, 'lcsCross'], [-7.85, 'speed']];
    for (const [x, key] of heads) {
      steel.tint(0.09, 0.09, 0.1);
      steel.box(x - 0.44, x + 0.44, 5.0, 5.88, zg - 0.18, zg + 0.18);
      steel.tint(0.25, 0.26, 0.28);
      steel.box(x - 0.05, x + 0.05, 5.88, CEIL - 0.24, zg - 0.05, zg + 0.05, 4 | 8);
      signs.tint(key === 'speed' ? 1.4 : 4.5);
      face(key, x, 5.44, zg + 0.185, 0.74, 0.74);
    }
  }
  // Tunnel-exit distance signs (flag signs over the walkway, facing traffic).
  {
    const runEnd = s0 + (b.spec.zoneLength - b.spec.zoneIndex) * CHUNK_LENGTH;
    const keys: Array<[number, keyof typeof ATLAS]> = [
      [200, 'dist200'],
      [400, 'dist400'],
      [600, 'dist600'],
      [800, 'dist800'],
    ];
    for (const [m, key] of keys) {
      const sd = runEnd - m;
      if (sd < s0 + 2 || sd > b.spec.s1 - 2) continue;
      const zs = -(sd - s0);
      steel.tint(0.22);
      steel.box(WR - 1.86, WR, 3.88, 4.42, zs - 0.03, zs + 0.03);
      steel.box(WR - 0.12, WR, 3.8, 4.5, zs - 0.08, zs + 0.08);
      signs.tint(1.3);
      face(key, WR - 0.96, 4.15, zs + 0.035, 1.7, 0.32);
    }
  }
  // Expansion joints: dark sealed bands across walls and ceiling every 44 m.
  steel.tint(0.05, 0.05, 0.055);
  for (let s = Math.ceil(s0 / 44) * 44 + 3; s < b.spec.s1; s += 44) {
    const z = -(s - s0);
    steel.box(WR - 0.012, WR - 0.002, KERB_Y, CEIL - HAUNCH, z - 0.06, z + 0.06, 2 | 4 | 8);
    steel.box(WL + 0.002, WL + 0.012, PLINTH_Y, CEIL - HAUNCH, z - 0.06, z + 0.06, 1 | 4 | 8);
    steel.box(WL + HAUNCH, WR - HAUNCH, CEIL - 0.012, CEIL - 0.002, z - 0.06, z + 0.06, 8);
  }
  // Fire main along the right wall with brackets.
  steel.tint(0.34, 0.06, 0.045);
  const main: Vec3[] = [];
  for (let z = z0; z >= z1 - 0.01; z -= 4) main.push([WR - 0.26, 4.72, z]);
  steel.tube(main, 0.1, 8);
  steel.tint(0.25);
  for (let s = Math.ceil(s0 / LENS_PITCH) * LENS_PITCH; s < b.spec.s1; s += LENS_PITCH) {
    const z = -(s - s0);
    steel.box(WR - 0.4, WR, 4.58, 4.62, z - 0.04, z + 0.04, 2);
  }

  addGeo(b, tun, M.tunnel, { name: 'tunnel-concrete' }, stats);
  addGeo(b, tiles, M.tiles, { name: 'tunnel-tiles' }, stats);
  addGeo(b, steel, M.steel, { name: 'tunnel-steel', noProbe: true }, stats);
  addGeo(b, glow, M.glow, { name: 'tunnel-glow', bake: false, noProbe: true }, stats);
  addGeo(b, signs, M.signs, { name: 'tunnel-signs', bake: false, noProbe: true }, stats);

  // Luminaire lenses: one instanced draw for all four strips.
  if (!lensGeo) {
    lensGeo = new BoxGeometry(0.34, 0.06, LENS_LEN);
    lensGeo.translate(0, 0.03, 0);
  }
  const pl: Placement[] = [];
  for (const opp of [false, true]) {
    const ss = fittingS(b, opp);
    for (const L of TUNNEL_LIGHT_D) {
      const d = opp ? mirrorD(L) : L;
      for (const s of ss) pl.push({ s, d, y: TUNNEL_LIGHT_Y + 0.01 });
    }
  }
  const lens = b.addInstances(lensGeo, M.tunnelLens, pl, { bake: false, sharedGeometry: true, name: 'tunnel-lenses' });
  lens.instanceColor = null; // emissive: no baked tint
  if (stats) {
    stats.calls++;
    stats.tris += pl.length * 12;
  }
}

/** Portal headwalls on the first / last chunk of a tunnel run. */
export function buildTunnelPortals(b: IChunkBuilder, stats?: GeoStats): void {
  const sp = b.spec;
  if (sp.zone !== 'tunnel') return;
  const ends: boolean[] = [];
  if (sp.zoneIndex === 0) ends.push(false);
  if (sp.zoneIndex === sp.zoneLength - 1) ends.push(true);
  if (!ends.length) return;
  const M = structureMaterials(b.materials);
  const panel = new Geo(0.25, 4);
  const dark = new Geo(0.25, 4);
  const glow = new Geo();
  const signs = new Geo();
  for (const atEnd of ends) {
    // Local z ≥ 0 is outside the tunnel; the exit portal is mirrored onto s1.
    const sz = atEnd ? -1 : 1;
    const oz = atEnd ? -(sp.s1 - sp.s0) : 0;
    for (const g of [panel, dark, glow, signs]) g.transform(1, 0, sz, oz);
    const outward = sz; // sign of the transformed outward normal's z
    // Flood wash from fittings under the coping, plus a little from the road below.
    panel.light = (_x, y, _z, _nx, _ny, nz) => (nz * outward > 0.5 ? 5.0 * Math.exp(-(HW_TOP + 0.3 - y) / 3.2) + 1.0 * Math.exp(-y / 2.5) : 0);
    panel.lightColor = [1.0, 0.9, 0.76];
    panel.shade = (_x, y) => 0.62 + 0.3 * smoothstep(0, 3, y) - 0.12 * smoothstep(11.5, 13, y);
    const zb = -0.6;
    panel.box(HW_X0, -28.9, 0, HW_TOP, zb, HW_FACE, 4);
    panel.box(WR, HW_X1, 0, HW_TOP, zb, HW_FACE, 4);
    panel.box(mirrorD(WL), WL, 0, CEIL, zb, HW_FACE, 4 | 8);
    panel.box(-28.9, WR, CEIL, HW_TOP, zb, HW_FACE, 0);
    // Coping cornice and vertical pilasters.
    panel.box(HW_X0 - 0.5, HW_X1 + 0.5, HW_TOP, HW_TOP + 0.6, zb - 0.2, HW_FACE + 0.45, 0);
    for (const x of [HW_X0, -30.3, WR, HW_X1 - 1.4]) panel.box(x, x + 1.4, 0, HW_TOP, HW_FACE, HW_FACE + 0.3, 4 | 16);
    // Opening frames (lintel beams).
    for (const [xa, xc] of [
      [WL, WR],
      [-28.9, mirrorD(WL)],
    ]) panel.box(xa - 0.4, xc + 0.4, CEIL, CEIL + 0.75, HW_FACE, HW_FACE + 0.3, 16);
    panel.light = null;
    // Wing walls flaring outwards, sloping down.
    panel.shade = (_x, y) => 0.6 + 0.3 * smoothstep(0, 3, y);
    for (const side of [1, -1]) {
      const px = side > 0 ? HW_X1 + 0.4 : HW_X0 - 0.4;
      const qx = px + side * 12;
      const pz = HW_FACE;
      const qz = 31;
      const t = 0.45;
      const wing = (y0p: number, y1p: number, y0q: number, y1q: number, w: number): Vec3[] => [
        [px - w, y0p, pz],
        [px + w, y0p, pz],
        [qx + w, y0q, qz],
        [qx - w, y0q, qz],
        [px - w, y1p, pz],
        [px + w, y1p, pz],
        [qx + w, y1q, qz],
        [qx - w, y1q, qz],
      ];
      panel.hexa(wing(0, HW_TOP, 0, 3, t), 4 | 16);
      panel.hexa(wing(HW_TOP, HW_TOP + 0.35, 3, 3.35, t + 0.12), 16);
    }
    // Earth-covered roof slab behind the headwall (seen from high cameras).
    dark.shade = (_x, y) => (y > HW_TOP - 0.1 ? 0.16 : 0.4);
    dark.box(HW_X0, HW_X1, CEIL, HW_TOP, -46, zb, 4 | 32);
    dark.shade = null;
    // Name / clearance bands over both openings.
    for (const xc of [1.0, mirrorD(1.0)]) {
      dark.tint(0.18);
      dark.box(xc - 6.3, xc + 6.3, 7.55, 9.45, HW_FACE, HW_FACE + 0.15, 16);
      dark.tint(1);
      const [u0, v0, u1, v1] = ATLAS.tunnelName;
      const z = HW_FACE + 0.16;
      signs.tint(1.1);
      // Viewer looks at the face from outside; mirrored z flips handedness.
      const xa = atEnd ? xc + 6 : xc - 6;
      const xb = atEnd ? xc - 6 : xc + 6;
      signs.uvQuad([xa, 7.75, z], [xb, 7.75, z], [xb, 9.25, z], [xa, 9.25, z], [0, 0, 1], u0, v0, u1, v1);
    }
    // Small wash fittings under the coping.
    glow.tint(18, 15, 11);
    for (let x = HW_X0 + 3; x < HW_X1 - 1; x += 6.5) glow.box(x - 0.3, x + 0.3, HW_TOP - 0.12, HW_TOP, HW_FACE + 0.45, HW_FACE + 0.65, 8);

    // Entrance hoods: canopy slabs projecting over both openings, with a row of downlights
    // (the portal lighting zone continues the threshold fittings out into the night).
    const HOOD_Z = HW_FACE + 3.6;
    const HOOD_Y0 = CEIL + 0.75;
    panel.shade = (_x, y) => (y < HOOD_Y0 + 0.05 ? 0.5 : 0.8);
    panel.light = (_x, _y, _z, _nx, ny) => (ny < -0.5 ? 1.6 : 0.5);
    panel.lightColor = [1.0, 0.9, 0.76];
    for (const [xa, xc] of [
      [WL, WR],
      [-28.9, mirrorD(WL)],
    ]) {
      panel.box(xa - 0.4, xc + 0.4, HOOD_Y0, HOOD_Y0 + 0.55, HW_FACE + 0.3, HOOD_Z, 16);
      panel.box(xa - 0.4, xc + 0.4, HOOD_Y0 - 0.35, HOOD_Y0, HOOD_Z - 0.35, HOOD_Z, 8 | 16);
      glow.tint(16, 14, 10.5);
      for (let x = xa + 1.6; x < xc - 0.8; x += 3.2) glow.box(x - 0.35, x + 0.35, HOOD_Y0 - 0.03, HOOD_Y0, HW_FACE + 1.6, HW_FACE + 1.9, 8);
    }
    panel.light = null;

    // Vegetation line on the earth-covered roof behind the coping: an irregular dark hedge.
    dark.tint(0.07, 0.1, 0.05);
    dark.shade = null;
    for (let x = HW_X0 + 0.4; x < HW_X1 - 0.4; x += 1.7) {
      const ha = 0.6 + b.rand() * 1.8;
      const hb = 0.6 + b.rand() * 1.8;
      const za = -1.2 - b.rand() * 1.2;
      const zb = za - 1.6 - b.rand() * 2.2;
      const x1 = Math.min(HW_X1 - 0.4, x + 2.1);
      dark.hexa(
        [
          [x, HW_TOP, zb],
          [x1, HW_TOP, zb],
          [x1, HW_TOP, za],
          [x, HW_TOP, za],
          [x + 0.35, HW_TOP + ha, zb + 0.5],
          [x1 - 0.35, HW_TOP + hb, zb + 0.5],
          [x1 - 0.35, HW_TOP + hb * 0.85, za - 0.4],
          [x + 0.35, HW_TOP + ha * 0.85, za - 0.4],
        ],
        4,
      );
    }
    dark.tint(1);
  }
  addGeo(b, panel, M.panel, { name: 'portal-walls' }, stats);
  addGeo(b, dark, M.plain, { name: 'portal-dark' }, stats);
  addGeo(b, glow, M.glow, { name: 'portal-glow', bake: false }, stats);
  addGeo(b, signs, M.signs, { name: 'portal-signs', bake: false }, stats);
}

/** Retaining walls rising towards a portal on the chunk before / after a tunnel run. */
export function buildTunnelApproach(b: IChunkBuilder, stats?: GeoStats): void {
  const sp = b.spec;
  if (sp.zone === 'tunnel') return;
  const ends: boolean[] = [];
  if (sp.nextZone === 'tunnel') ends.push(false); // portal at s1
  if (sp.prevZone === 'tunnel') ends.push(true); // portal at s0
  if (!ends.length) return;
  const M = structureMaterials(b.materials);
  const panel = new Geo(0.25, 4);
  const steel = new Geo(0.5, 4);
  const L = sp.s1 - sp.s0;
  const segs = 20;
  const posts: Placement[] = [];
  for (const afterTunnel of ends) {
    for (const opp of [false, true]) {
      // Local z: 0 at the portal, growing away from it (towards the open road).
      const sz = afterTunnel ? -1 : 1;
      const oz = afterTunnel ? 0 : -L;
      for (const g of [panel, steel]) g.transform(opp ? -1 : 1, opp ? 2 * MEDIAN_D : 0, sz, oz);
      const h = (t: number) => 1.0 + (APPROACH_H - 1.0) * Math.pow(1 - t / APPROACH_LEN, 1.6);
      panel.shade = (_x, y) => 0.55 + 0.35 * smoothstep(0, 2.5, y);
      const x0 = APPROACH_D;
      const x1 = APPROACH_D + 0.6;
      for (let i = 0; i < segs; i++) {
        const ta = (i / segs) * APPROACH_LEN;
        const tb = ((i + 1) / segs) * APPROACH_LEN;
        const ha = h(ta);
        const hb = h(tb);
        const skip = 4 | (i > 0 ? 16 : 0) | (i < segs - 1 ? 32 : 0);
        panel.hexa(
          [
            [x0, 0, ta],
            [x1, 0, ta],
            [x1, 0, tb],
            [x0, 0, tb],
            [x0, ha, ta],
            [x1, ha, ta],
            [x1, hb, tb],
            [x0, hb, tb],
          ],
          skip,
        );
        panel.hexa(
          [
            [x0 - 0.15, ha, ta],
            [x1 + 0.1, ha, ta],
            [x1 + 0.1, hb, tb],
            [x0 - 0.15, hb, tb],
            [x0 - 0.15, ha + 0.3, ta],
            [x1 + 0.1, ha + 0.3, ta],
            [x1 + 0.1, hb + 0.3, tb],
            [x0 - 0.15, hb + 0.3, tb],
          ],
          i > 0 ? 16 : 0,
        );
      }
      // Safety fence on the coping.
      steel.tint(0.4, 0.42, 0.44);
      const xf = (x0 + x1) / 2;
      const rail: Vec3[] = [];
      for (let t = 0; t <= APPROACH_LEN + 0.01; t += 3) {
        const y = h(t) + 0.3;
        posts.push({ s: afterTunnel ? sp.s0 + t : sp.s1 - t, d: opp ? mirrorD(xf) : xf, y, scale: [0.08, 1.3, 0.08] });
        rail.push([xf, y + 1.3, t]);
      }
      steel.tube(rail, 0.035, 5);
      steel.tube(
        rail.map((p) => [p[0], p[1] - 0.6, p[2]] as Vec3),
        0.025,
        5,
      );
    }
  }
  addGeo(b, panel, M.panel, { name: 'approach-walls' }, stats);
  addGeo(b, steel, M.steel, { name: 'approach-fence', noProbe: true }, stats);
  addPosts(b, M.steel, posts, stats);
}

