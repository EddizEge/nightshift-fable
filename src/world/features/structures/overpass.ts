/**
 * Overpass: a road bridge crossing above us at right angles at spec.overpassS.
 * Deck + girders + fascia, median and verge piers on crossheads with bearing pads (median pier
 * behind a thickened barrier), embankment abutments with wing walls, parapets with steel rails,
 * soffit luminaires (baked into the underside), drainage collector + down-pipes, decorative
 * street lamps, passing-car lights on the deck, a retro-reflective hazard band and a height-limit
 * sign on the fascia facing traffic.
 *
 * Stage for the director's "Last-Second Escape": the tanker drives on the deck top (y =
 * OVERPASS_DECK_Y) in the lane nearest to us and leaves through the near parapet above our
 * carriageway. That stretch (RAIL_X0..RAIL_X1) is a low concrete upstand with a steel railing
 * instead of the solid parapet; breakOverpassRailing() swaps it for a torn variant.
 */
import { InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import type { BufferGeometry, Mesh } from 'three';
import type { IChunkBuilder, OverpassInfo, Placement, RoadFrame } from '../../../core/types';
import { LAYERS } from '../../../core/types';
import { BARRIER_RIGHT_D, MEDIAN_D, OVERPASS_CLEARANCE, OVERPASS_DECK_Y, OVERPASS_WIDTH, PAVED_LEFT_D, mirrorD } from '../../roadProfile';
import { Geo, addGeo, addPosts, zOf } from './geom';
import type { GeoStats, Vec3 } from './geom';
import { ATLAS, structureMaterials } from './materials';

/** Deck spans d ∈ [OVERPASS_D0, OVERPASS_D1]; abutment blocks continue to the *_END values. */
export const OVERPASS_D0 = -38;
export const OVERPASS_D1 = 20;
// Abutment blocks reach far enough for the tanker's start point (d = ±38 m + half its length).
const D_END_R = 46;
const D_END_L = -52;
/** Steel-railing stretch of the near parapet (over our carriageway, where the tanker exits). */
export const RAIL_X0 = -10.5;
export const RAIL_X1 = 12.5;
const UPSTAND_TOP = OVERPASS_DECK_Y + 0.32;
/** Torn gaps for a tanker exiting with bSide = +1 / −1. */
const GAPS: Array<[number, number]> = [
  [-4.5, 6.5],
  [-6.5, 4.5],
];
const CROSSHEAD_TOP = OVERPASS_CLEARANCE - 0.12;
/** Parapet: solid concrete to PARAPET_TOP above the deck surface, steel rail above. */
export const OVERPASS_PARAPET_TOP = 8.85;
export const OVERPASS_RAIL_TOP = 9.25;
const SLAB_BOTTOM = 6.9;
const OUTER_PIER_D = 14.5;
const LAMP_COLOR: [number, number, number] = [1.0, 0.62, 0.3];
/** Soffit luminaires: warm-white fittings between the inner girders. */
const SOFFIT_COLOR: [number, number, number] = [1.0, 0.84, 0.62];
const SOFFIT_GLOW = 9;
const SOFFIT_I = 4.2;

interface RailEntry {
  intact: Mesh | null;
  broken: Array<Mesh | null>;
}
const railings = new Map<number, RailEntry>();

/**
 * Tear the steel railing of the overpass at `s` (call when the tanker breaks through).
 * side = the director's bSide (+1: tanker heading +d, −1: heading −d). Returns false when the
 * overpass chunk is not built.
 */
export function breakOverpassRailing(s: number, side: number): boolean {
  const e = railings.get(Math.round(s));
  if (!e) return false;
  if (e.intact) e.intact.visible = false;
  const k = side > 0 ? 0 : 1;
  e.broken.forEach((m, i) => {
    if (m) m.visible = i === k;
  });
  return true;
}

/** Steel railing of the near parapet between RAIL_X0 and RAIL_X1, optionally torn open at `gap`. */
function railSection(g: Geo, zo: number, gap: [number, number] | null): void {
  const zi = zo - 0.42;
  const zw = zi + 0.12;
  const inGap = (x: number) => gap !== null && x > gap[0] - 0.3 && x < gap[1] + 0.3;
  const spans: Array<[number, number]> = gap ? [[RAIL_X0, gap[0]], [gap[1], RAIL_X1]] : [[RAIL_X0, RAIL_X1]];
  for (const [a, c] of spans) {
    // W-beam (two folds) on the deck side, an intermediate rail and the top rail.
    g.tint(0.62, 0.64, 0.66);
    g.box(a, c, UPSTAND_TOP + 0.22, UPSTAND_TOP + 0.36, zw, zw + 0.06);
    g.tint(0.48, 0.5, 0.53);
    g.box(a, c, UPSTAND_TOP + 0.36, UPSTAND_TOP + 0.5, zw + 0.03, zw + 0.09);
    g.tint(0.62, 0.64, 0.66);
    g.box(a, c, UPSTAND_TOP + 0.5, UPSTAND_TOP + 0.64, zw, zw + 0.06);
    g.tint(0.55, 0.57, 0.6);
    g.box(a, c, UPSTAND_TOP + 0.94, UPSTAND_TOP + 1.01, zo - 0.25, zo - 0.18);
    g.box(a, c, OVERPASS_RAIL_TOP - 0.1, OVERPASS_RAIL_TOP, zo - 0.3, zo - 0.14);
  }
  // Posts every 2 m with spacer blocks to the W-beam.
  g.tint(0.42, 0.44, 0.47);
  for (let x = RAIL_X0 + 0.25; x < RAIL_X1; x += 2) {
    if (inGap(x)) continue;
    g.box(x - 0.06, x + 0.06, UPSTAND_TOP, OVERPASS_RAIL_TOP - 0.1, zo - 0.3, zo - 0.14, 4);
    g.box(x - 0.05, x + 0.05, UPSTAND_TOP + 0.24, UPSTAND_TOP + 0.62, zw + 0.06, zo - 0.3, 3);
  }
  if (!gap) return;
  // Torn ends: rail stubs bent outwards (towards us) and down; a post leaning out at each edge.
  for (const [x, dir] of [
    [gap[0], 1],
    [gap[1], -1],
  ] as Array<[number, number]>) {
    g.tint(0.6, 0.62, 0.64);
    g.beam([x, UPSTAND_TOP + 0.22, zw + 0.03], [x + dir * 1.6, UPSTAND_TOP - 0.55, zo + 0.95], 0.07, 0.42);
    g.beam([x, OVERPASS_RAIL_TOP - 0.1, zo - 0.22], [x + dir * 1.3, OVERPASS_RAIL_TOP - 0.75, zo + 0.7], 0.1, 0.1);
    g.beam([x, UPSTAND_TOP + 0.94, zo - 0.22], [x + dir * 0.9, UPSTAND_TOP + 0.5, zo + 0.5], 0.07, 0.07);
    g.tint(0.4, 0.42, 0.45);
    const xp = x - dir * 0.15;
    g.beam([xp, UPSTAND_TOP, zo - 0.22], [xp + dir * 0.35, OVERPASS_RAIL_TOP - 0.35, zo + 0.55], 0.16, 0.12);
  }
  // A length of W-beam torn loose, hanging down the fascia.
  const xm = (gap[0] + gap[1]) / 2 - 1.5;
  g.tint(0.58, 0.6, 0.62);
  g.beam([xm, OVERPASS_DECK_Y - 1.9, zo + 0.3], [xm + 2.8, UPSTAND_TOP - 0.05, zo + 0.08], 0.08, 0.36);
}

/** Car-light rig: headlamps at −z (forward), tail lamps at +z, metres. */
let carLightGeo: BufferGeometry | null = null;
function carLights(): BufferGeometry {
  if (!carLightGeo) {
    const g = new Geo();
    for (const sx of [-0.68, 0.68]) {
      g.tint(14, 13, 11);
      g.box(sx - 0.14, sx + 0.14, 0.6, 0.72, -2.3, -2.22);
      g.tint(6, 0.3, 0.15);
      g.box(sx - 0.16, sx + 0.16, 0.82, 0.9, 2.22, 2.3);
    }
    carLightGeo = g.build();
    carLightGeo.computeBoundingSphere();
  }
  return carLightGeo;
}
const CAR_COUNT = 3;
const CAR_SPEED = [14.5, 12.5, 16];
const CAR_PHASE = [0.0, 0.37, 0.71];
const _m4 = new Matrix4();
const _pos = new Vector3();
const _one = new Vector3(1, 1, 1);
const _zero = new Vector3(0, 0, 0);
const _frame: RoadFrame = { s: 0, x: 0, z: 0, h: 0, k: 0, tx: 0, tz: -1, rx: 1, rz: 0 };

export function getOverpassInfo(s: number): OverpassInfo {
  return { s, clearance: OVERPASS_CLEARANCE, deckY: OVERPASS_DECK_Y, width: OVERPASS_WIDTH };
}

export function buildOverpass(b: IChunkBuilder, stats?: GeoStats): void {
  const S = b.spec.overpassS;
  if (S === null) return;
  const M = structureMaterials(b.materials);
  const zc = zOf(b.spec.s0, S);
  const hw = OVERPASS_WIDTH / 2;
  const zN = zc + hw; // face looking at us (normal +z)
  const zF = zc - hw;

  const plain = new Geo(0.25, 4);
  const panel = new Geo(0.25, 4);
  const steel = new Geo(0.5, 4);
  const glow = new Geo();
  const retro = new Geo();
  const posts: Placement[] = [];

  // ── soffit luminaires: rows between the inner girders over both carriageways ──
  const fit: Vec3[] = [];
  for (let x = PAVED_LEFT_D + 2.5; x < BARRIER_RIGHT_D; x += 4.6) {
    if (Math.abs(x - MEDIAN_D) < 1.2) continue;
    for (const dz of [-3.0, 3.0]) fit.push([x, OVERPASS_CLEARANCE - 0.01, zc + dz]); // hung under the inner girders
  }
  // Baked irradiance: direct light below the fittings + a soft halo on the soffit around them.
  const soffitLight = (x: number, y: number, z: number, nx: number, ny: number, nz: number): number => {
    let e = 0;
    for (const f of fit) {
      const dx = f[0] - x;
      const dy = f[1] - y;
      const dz = f[2] - z;
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 > 160) continue;
      const r = Math.sqrt(r2) + 1e-4;
      const cos = Math.max(0, (nx * dx + ny * dy + nz * dz) / r);
      const down = Math.max(0, -dy / r); // fittings emit downwards
      e += (SOFFIT_I * cos * (0.25 + 0.75 * down)) / (r2 + 0.5);
      if (ny < -0.5) e += 0.9 * Math.exp(-r2 / 2.5);
    }
    return e;
  };
  plain.light = soffitLight;
  plain.lightColor = SOFFIT_COLOR;
  steel.light = soffitLight;
  steel.lightColor = SOFFIT_COLOR;

  // ── deck ────────────────────────────────────────────────────────────────
  // Underside sits in permanent shadow and collects soot: darker.
  plain.shade = (_x, y) => (y < SLAB_BOTTOM + 0.05 ? 0.55 : 0.9);
  plain.box(OVERPASS_D0, OVERPASS_D1, SLAB_BOTTOM, OVERPASS_DECK_Y, zF + 0.8, zN - 0.8);
  // Edge girders / fascia (full depth) at both faces.
  for (const [a, c] of [
    [zN - 0.8, zN],
    [zF, zF + 0.8],
  ]) {
    plain.box(OVERPASS_D0, OVERPASS_D1, OVERPASS_CLEARANCE, OVERPASS_DECK_Y, a, c);
    // Drip lip / cornice casting a shadow line under the parapet.
    const out = a === zN - 0.8 ? [zN, zN + 0.22] : [zF - 0.22, zF];
    plain.box(OVERPASS_D0 - 0.2, OVERPASS_D1 + 0.2, OVERPASS_DECK_Y - 0.2, OVERPASS_DECK_Y + 0.15, out[0], out[1]);
  }
  // Inner girders (shallower).
  for (const dz of [-3.0, 0, 3.0]) plain.box(OVERPASS_D0, OVERPASS_D1, OVERPASS_CLEARANCE + 0.12, SLAB_BOTTOM, zc + dz - 0.35, zc + dz + 0.35, 8);

  // ── piers ───────────────────────────────────────────────────────────────
  plain.shade = (_x, y) => 0.62 + 0.3 * Math.min(1, y / 2.2);
  const pierCols = (d: number, r: number) => {
    for (const dz of [-3.4, 3.4]) plain.cylY(d, zc + dz, 0, OVERPASS_CLEARANCE - 0.3, r, 14, false);
    // Crosshead under the girders.
    plain.box(d - r - 0.15, d + r + 0.15, CROSSHEAD_TOP - 0.55, CROSSHEAD_TOP, zN - 0.15, zF + 0.15, 0);
    // Bearing pads (steel plinth + elastomer) under every girder line.
    for (const zg of [zN - 0.4, zc - 3.0, zc, zc + 3.0, zF + 0.4]) {
      const top = Math.abs(zg - zc) > 4 ? OVERPASS_CLEARANCE : OVERPASS_CLEARANCE + 0.12;
      steel.tint(0.14, 0.14, 0.15);
      steel.box(d - 0.32, d + 0.32, CROSSHEAD_TOP, CROSSHEAD_TOP + 0.05, zg - 0.32, zg + 0.32, 4);
      steel.tint(0.07, 0.07, 0.075);
      steel.box(d - 0.26, d + 0.26, CROSSHEAD_TOP + 0.05, top, zg - 0.26, zg + 0.26, 4 | 8);
    }
  };
  pierCols(MEDIAN_D, 0.45);
  pierCols(OUTER_PIER_D, 0.6);
  pierCols(mirrorD(OUTER_PIER_D), 0.6);

  // Thickened median barrier protecting the pier, tapering into the normal Jersey width.
  plain.shade = (_x, y) => 0.55 + 0.35 * Math.min(1, y / 1.1);
  const bw = 0.45;
  const bh = 1.15;
  const blen = 12;
  plain.box(MEDIAN_D - bw, MEDIAN_D + bw, 0, bh, zc - blen, zc + blen, 4);
  for (const dir of [1, -1]) {
    const zA = zc + dir * blen;
    const zB = zc + dir * (blen + 4);
    const nb = 0.3;
    plain.hexa(
      [
        [MEDIAN_D - bw, 0, zA],
        [MEDIAN_D + bw, 0, zA],
        [MEDIAN_D + nb, 0, zB],
        [MEDIAN_D - nb, 0, zB],
        [MEDIAN_D - bw, bh, zA],
        [MEDIAN_D + bw, bh, zA],
        [MEDIAN_D + nb, 1.05, zB],
        [MEDIAN_D - nb, 1.05, zB],
      ],
      4 | 16, // c0c1c4c5 is the face glued to the block
    );
    // Chevron marker board facing the traffic that approaches this end.
    const zm = zB + dir * 0.04;
    const [u0, v0, u1, v1] = ATLAS.chevron;
    const x0 = dir > 0 ? MEDIAN_D - 0.29 : MEDIAN_D + 0.29;
    const x1 = dir > 0 ? MEDIAN_D + 0.29 : MEDIAN_D - 0.29;
    retro.uvQuad([x0, 0.2, zm], [x1, 0.2, zm], [x1, 0.98, zm], [x0, 0.98, zm], [0, 0, dir], u0, v0, u1, v1);
  }

  // ── abutments (embankment blocks) + wing walls ─────────────────────────
  panel.shade = (_x, y) => 0.6 + 0.35 * Math.min(1, y / 3);
  for (const side of [1, -1]) {
    const xa = side > 0 ? OVERPASS_D1 : D_END_L;
    const xb = side > 0 ? D_END_R : OVERPASS_D0;
    panel.box(xa, xb, 0, OVERPASS_DECK_Y, zF, zN, 4);
    // Bearing shelf under the deck end.
    const xf = side > 0 ? OVERPASS_D1 : OVERPASS_D0;
    panel.box(xf - 0.6 * side, xf, SLAB_BOTTOM - 0.8, SLAB_BOTTOM - 0.5, zF + 0.3, zN - 0.3, 0);
    // Wing walls along our road, stepping down the embankment.
    const wx0 = side > 0 ? OVERPASS_D1 : OVERPASS_D0 - 0.7;
    const wx1 = wx0 + 0.7;
    for (const dir of [1, -1]) {
      const zA = dir > 0 ? zN : zF;
      const zB = zA + dir * 16;
      panel.hexa(
        [
          [wx0, 0, Math.min(zA, zB)],
          [wx1, 0, Math.min(zA, zB)],
          [wx1, 0, Math.max(zA, zB)],
          [wx0, 0, Math.max(zA, zB)],
          [wx0, dir > 0 ? OVERPASS_DECK_Y : 1.0, Math.min(zA, zB)],
          [wx1, dir > 0 ? OVERPASS_DECK_Y : 1.0, Math.min(zA, zB)],
          [wx1, dir > 0 ? 1.0 : OVERPASS_DECK_Y, Math.max(zA, zB)],
          [wx0, dir > 0 ? 1.0 : OVERPASS_DECK_Y, Math.max(zA, zB)],
        ],
        4,
      );
    }
  }

  // ── parapets + steel rails ──────────────────────────────────────────────
  panel.shade = (_x, y) => (y > OVERPASS_PARAPET_TOP - 0.2 ? 0.95 : 0.8);
  steel.tint(0.55, 0.57, 0.6);
  for (const face of [1, -1]) {
    const zo = face > 0 ? zN : zF; // outer face
    const zi = zo - face * 0.42;
    const zr = (zo + zi) / 2;
    // The near face is open (steel railing) above our carriageway: the tanker's exit.
    const runs: Array<[number, number]> = face > 0 ? [[D_END_L, RAIL_X0], [RAIL_X1, D_END_R]] : [[D_END_L, D_END_R]];
    for (const [xa, xb] of runs) {
      panel.box(xa, xb, OVERPASS_DECK_Y, OVERPASS_PARAPET_TOP - 0.15, Math.min(zo, zi), Math.max(zo, zi), 4);
      panel.box(xa, xb, OVERPASS_PARAPET_TOP - 0.15, OVERPASS_PARAPET_TOP, Math.min(zo + face * 0.06, zi - face * 0.05), Math.max(zo + face * 0.06, zi - face * 0.05), 4);
      for (let x = xa + 0.5; x < xb; x += 2) posts.push({ s: b.spec.s0 - zr, d: x, y: OVERPASS_PARAPET_TOP, scale: [0.08, OVERPASS_RAIL_TOP - 0.05 - OVERPASS_PARAPET_TOP, 0.08] });
      steel.box(xa, xb, OVERPASS_RAIL_TOP - 0.1, OVERPASS_RAIL_TOP, zr - 0.06, zr + 0.06);
      steel.box(xa, xb, OVERPASS_PARAPET_TOP + 0.17, OVERPASS_PARAPET_TOP + 0.23, zr - 0.035, zr + 0.035);
    }
    // Concrete upstand (deck-edge kerb) carrying the steel railing.
    if (face > 0) panel.box(RAIL_X0, RAIL_X1, OVERPASS_DECK_Y, UPSTAND_TOP, Math.min(zo, zi), Math.max(zo, zi), 4 | 1 | 2);
  }

  // ── drainage: spouts on the fascia and down-pipes on the verge piers ──
  steel.tint(0.22, 0.23, 0.24);
  for (let x = OVERPASS_D0 + 5; x < OVERPASS_D1; x += 11.5) {
    steel.box(x - 0.08, x + 0.08, OVERPASS_CLEARANCE + 0.25, OVERPASS_CLEARANCE + 0.4, zN, zN + 0.35);
    steel.box(x - 0.08, x + 0.08, OVERPASS_CLEARANCE + 0.25, OVERPASS_CLEARANCE + 0.4, zF - 0.35, zF);
  }
  for (const d of [OUTER_PIER_D, mirrorD(OUTER_PIER_D), MEDIAN_D]) {
    const xo = d + (d > MEDIAN_D ? -0.68 : d < MEDIAN_D ? 0.68 : 0.55);
    steel.cylY(xo, zc + 3.7, 0.15, SLAB_BOTTOM - 0.35, 0.09, 8, false);
    for (const y of [1.6, 3.6, 5.4]) steel.box(xo - 0.12, xo + 0.12, y, y + 0.08, zc + 3.58, zc + 3.82);
  }
  // Collector pipe under the soffit along the near inner girder, feeding the down-pipes.
  steel.tube(
    [
      [mirrorD(OUTER_PIER_D) + 0.68, SLAB_BOTTOM - 0.35, zc + 3.7],
      [MEDIAN_D, SLAB_BOTTOM - 0.35, zc + 3.7],
      [OUTER_PIER_D - 0.68, SLAB_BOTTOM - 0.35, zc + 3.7],
    ],
    0.11,
    8,
  );
  for (let x = mirrorD(OUTER_PIER_D) + 2; x < OUTER_PIER_D; x += 4) steel.box(x - 0.04, x + 0.04, SLAB_BOTTOM - 0.47, SLAB_BOTTOM, zc + 3.66, zc + 3.74);
  // Soffit luminaires: dark housings + warm lenses.
  for (const f of fit) {
    steel.tint(0.2, 0.2, 0.21);
    steel.box(f[0] - 0.36, f[0] + 0.36, f[1] + 0.03, OVERPASS_CLEARANCE + 0.12, f[2] - 0.24, f[2] + 0.24, 8);
    glow.tint(SOFFIT_COLOR[0] * SOFFIT_GLOW, SOFFIT_COLOR[1] * SOFFIT_GLOW, SOFFIT_COLOR[2] * SOFFIT_GLOW);
    glow.box(f[0] - 0.3, f[0] + 0.3, f[1], f[1] + 0.03, f[2] - 0.14, f[2] + 0.14, 8);
  }
  plain.light = null;
  steel.light = null;

  // ── decorative street lamps on the overpass ────────────────────────────
  const lamps: Array<[number, number]> = [
    [-24, 1],
    [8, 1],
    [-8, -1],
    [26, -1],
  ];
  for (const [x, face] of lamps) {
    const zp = (face > 0 ? zN : zF) - face * 0.21;
    steel.tint(0.32, 0.33, 0.35);
    steel.cylY(x, zp, OVERPASS_PARAPET_TOP, 16.4, 0.1, 8, true);
    const za = zp - face * 1.9;
    steel.box(x - 0.05, x + 0.05, 16.2, 16.32, Math.min(zp, za), Math.max(zp, za));
    steel.tint(0.18, 0.19, 0.2);
    steel.box(x - 0.26, x + 0.26, 16.05, 16.3, Math.min(za, za - face * 0.75), Math.max(za, za - face * 0.75));
    const c = LAMP_COLOR;
    glow.tint(c[0] * 40, c[1] * 40, c[2] * 40);
    glow.box(x - 0.22, x + 0.22, 16.0, 16.06, Math.min(za + face * 0.0, za - face * 0.7), Math.max(za, za - face * 0.7), 8);
  }

  // ── hazard band + height-limit sign on the fascia faces ────────────────
  const band = (x0: number, x1: number, z: number, nz: number) => {
    const [u0, v0, u1, v1] = ATLAS.hazard;
    const segLen = 7.2;
    for (let x = x0; x < x1 - 0.01; x += segLen) {
      const xe = Math.min(x1, x + segLen);
      const ue = u0 + ((xe - x) / segLen) * (u1 - u0);
      const ya = OVERPASS_CLEARANCE + 0.05;
      const yb = ya + 0.45;
      if (nz > 0) retro.uvQuad([x, ya, z], [xe, ya, z], [xe, yb, z], [x, yb, z], [0, 0, 1], u0, v0, ue, v1);
      else retro.uvQuad([xe, ya, z], [x, ya, z], [x, yb, z], [xe, yb, z], [0, 0, -1], u0, v0, ue, v1);
    }
  };
  band(MEDIAN_D + 0.4, BARRIER_RIGHT_D + 0.6, zN + 0.012, 1);
  band(PAVED_LEFT_D, MEDIAN_D - 0.4, zF - 0.012, -1);
  const sign = (xc: number, z: number, nz: number) => {
    const [u0, v0, u1, v1] = ATLAS.height;
    const h = 0.62;
    const y0 = OVERPASS_CLEARANCE + 0.6;
    const xa = xc - (nz * h) / 2;
    const xb = xc + (nz * h) / 2;
    retro.uvQuad([xa, y0, z], [xb, y0, z], [xb, y0 + h, z], [xa, y0 + h, z], [0, 0, nz], u0, v0, u1, v1);
  };
  sign(0, zN + 0.012, 1);
  sign(mirrorD(0), zF - 0.012, -1);

  addGeo(b, plain, M.plain, { name: 'overpass-deck' }, stats);
  addGeo(b, panel, M.panel, { name: 'overpass-walls' }, stats);
  addGeo(b, steel, M.steel, { name: 'overpass-steel', noProbe: true }, stats);

  // Breakable railing: intact + two torn variants (hidden until breakOverpassRailing()).
  const entry: RailEntry = { intact: null, broken: [] };
  for (const gap of [null, ...GAPS]) {
    const g = new Geo(0.5, 4);
    railSection(g, zN, gap);
    const m = addGeo(b, g, M.steel, { name: gap ? 'overpass-rail-torn' : 'overpass-rail', noProbe: true }, gap ? undefined : stats);
    if (gap) {
      if (m) m.visible = false;
      entry.broken.push(m);
    } else entry.intact = m;
  }
  const key = Math.round(S);
  railings.set(key, entry);
  b.onDispose(() => {
    if (railings.get(key) === entry) railings.delete(key);
  });

  // Passing cars on the overpass (far lane, heading −d): light rigs only, one instanced draw.
  const cars = new InstancedMesh(carLights(), M.glow, CAR_COUNT);
  cars.name = 'overpass-cars';
  cars.frustumCulled = false;
  cars.layers.set(LAYERS.NO_PROBE);
  const sLane = S + 2.6;
  const h = b.road.frameAt(sLane, _frame).h;
  const q = new Quaternion().setFromAxisAngle(_pos.set(0, 1, 0), -(h - Math.PI / 2));
  const span = D_END_R - D_END_L;
  const road = b.road;
  const place = (time: number) => {
    for (let i = 0; i < CAR_COUNT; i++) {
      const u = (time * CAR_SPEED[i]) / span + CAR_PHASE[i];
      const x = D_END_R - (u - Math.floor(u)) * span;
      road.toWorld(sLane, x, OVERPASS_DECK_Y, _pos);
      _m4.compose(_pos, q, x > D_END_L + 3 && x < D_END_R - 3 ? _one : _zero);
      cars.setMatrixAt(i, _m4);
    }
    cars.instanceMatrix.needsUpdate = true;
  };
  place(0);
  b.addObject(cars);
  b.onUpdate((time) => place(time));
  if (stats) {
    stats.calls++;
    stats.tris += CAR_COUNT * 48;
  }
  addGeo(b, glow, M.glow, { name: 'overpass-lamps', bake: false }, stats);
  addPosts(b, M.steel, posts, stats);
  const r = addGeo(b, retro, M.retro, { name: 'overpass-signs' }, stats);
  if (r) r.layers.set(LAYERS.NO_PROBE);
}
