/**
 * City mid-field: apartment / office blocks 40–300 m from the road on both sides, commercial sheds
 * near the road, rooftop equipment, antenna masts with beacons, lit billboards (abstract, brand-free)
 * and parking-lot lamp clusters. ≈ 5 draw calls per chunk.
 */
import { PlaneGeometry, ShaderMaterial, UniformsLib, UniformsUtils } from 'three';
import type { BufferGeometry } from 'three';
import type { IChunkBuilder, Placement } from '../../core/types';
import { PAVED_LEFT_D, PAVED_RIGHT_D } from '../roadProfile';
import { facadeMaterial } from './facade';
import { PointKind, blinkBeacon } from './points';
import { addBillboard, fillRoadside, flushRoadside, newRoadsideLists } from './roadside';
import { GLSL_FOG, GLSL_HASH, shared, unitBox } from './shared';
import { frontageE, frontageW, outward, terrainCtx, terrainHeight, terrainSlope } from './terrain';
import type { TerrainCtx } from './terrain';
import { SIGN_ASPECT, signAtlas, signCode } from './signs';
import type { SignWord } from './signs';

/** Building kinds decoded by the city facade shader. */
export const KIND_GROUND = 0;
/** Upper section (setback / tower on a podium): no shop floor. */
export const KIND_UPPER = 1;
/** Retail podium: shopfronts + fascia. */
export const KIND_PODIUM = 2;

/**
 * Pack building kind and facade style (0 punched, 1 ribbon office, 2 curtain wall, 3 residential)
 * into the centimetres of the instance height (decoded in facade.ts: floor(fract(H·10)·16)).
 */
export function packHeight(h: number, kind: number, style: number): number {
  return Math.floor(h * 10) / 10 + (kind * 4 + style + 0.5) / 160;
}

const ROOF_WORDS: SignWord[] = ['HOTEL', 'OFFICES', 'HOTEL', 'MOTEL', 'PARKING', 'RENTALS'];
const WALL_WORDS: SignWord[] = ['PHARMACY', 'PARKING', '24H', 'DINER', 'GYM', 'BAR', 'HOTEL', 'OPEN 24H', 'LAUNDRY'];
const PYLON_WORDS: SignWord[] = ['24H', 'MOTEL', 'DINER', 'CAR WASH', 'STORAGE', 'GARAGE', 'OPEN 24H', 'TAXI', 'PARKING', 'RENTALS'];

interface CityLot extends Lot {
  e: number;
  side: number;
}

interface Section {
  ls: number;
  ld: number;
  y: number;
  h: number;
  kind: number;
}

export interface Lot {
  s: number;
  d: number;
  /** extent along s and along d */
  ls: number;
  ld: number;
  h: number;
  yaw: number;
  y: number;
}

/** Can a footprint stand here? (inside the chunk, clear of overpasses, not on steep ground). */
export function lotOk(b: IChunkBuilder, c: TerrainCtx, s: number, d: number, ls: number, ld: number, maxSlope = 0.12): boolean {
  const sp = b.spec;
  if (s - ls * 0.5 < sp.s0 + 1.5 || s + ls * 0.5 > sp.s1 - 1.5) return false;
  if (sp.overpassS !== null && Math.abs(s - sp.overpassS) < ls * 0.5 + 24) return false;
  if (sp.nextZone === 'bridge' && s > sp.s1 - 130) return false;
  if (sp.prevZone === 'bridge' && s < sp.s0 + 130) return false;
  // Keep clear of frontage roads (incl. their detours / turn-aways).
  const e = outward(d);
  for (const f of c.fr) {
    if ((d > 0 ? 1 : -1) !== f.side) continue;
    for (const ss of [s - ls * 0.5, s, s + ls * 0.5]) {
      if (frontageW(ss, c) <= 0) continue;
      const ec = frontageE(f, ss, c);
      if (e + ld * 0.5 > ec - f.half - 3 && e - ld * 0.5 < ec + f.half + 4) return false;
    }
  }
  if (terrainSlope(s, d, c) > maxSlope) return false;
  if (terrainSlope(s + ls * 0.4, d + ld * 0.4, c) > maxSlope) return false;
  if (terrainSlope(s - ls * 0.4, d - ld * 0.4, c) > maxSlope) return false;
  return true;
}

/** Base height: lowest terrain point under the footprint, sunk a little. */
export function lotBase(c: TerrainCtx, s: number, d: number, ls: number, ld: number): number {
  let y = terrainHeight(s, d, c);
  y = Math.min(y, terrainHeight(s + ls * 0.5, d + ld * 0.5, c), terrainHeight(s - ls * 0.5, d - ld * 0.5, c));
  y = Math.min(y, terrainHeight(s + ls * 0.5, d - ld * 0.5, c), terrainHeight(s - ls * 0.5, d + ld * 0.5, c));
  return y - 0.8;
}

/** d of a point `e` metres outward on a side (+1 right, −1 left). */
export const sideD = (side: number, e: number) => (side > 0 ? PAVED_RIGHT_D + e : PAVED_LEFT_D - e);

interface Band {
  e0: number;
  e1: number;
  h0: number;
  h1: number;
  ls0: number;
  ls1: number;
  gap0: number;
  gap1: number;
}
const BANDS: Band[] = [
  { e0: 25, e1: 50, h0: 5, h1: 9.5, ls0: 20, ls1: 42, gap0: 18, gap1: 70 }, // commercial sheds behind the frontage road
  { e0: 56, e1: 88, h0: 14, h1: 42, ls0: 16, ls1: 34, gap0: 6, gap1: 22 },
  { e0: 90, e1: 150, h0: 18, h1: 70, ls0: 16, ls1: 32, gap0: 5, gap1: 18 },
  { e0: 160, e1: 230, h0: 22, h1: 105, ls0: 16, ls1: 30, gap0: 5, gap1: 16 },
  { e0: 240, e1: 300, h0: 26, h1: 135, ls0: 18, ls1: 34, gap0: 4, gap1: 14 },
];

export function buildCity(b: IChunkBuilder): void {
  const sp = b.spec;
  if (sp.zone !== 'city') return;
  const c = terrainCtx(sp);
  const r = () => b.rand();
  const lots: CityLot[] = [];
  // Box props, signs and lights share the roadside lists (one equipment / board / light batch per chunk).
  const RL = newRoadsideLists();
  const equip = RL.props;
  const boards = RL.boards;
  const pts = RL.pts;

  for (const side of [1, -1]) {
    for (let bi = 0; bi < BANDS.length; bi++) {
      const band = BANDS[bi];
      let s = sp.s0 + 2 + r() * band.gap1;
      while (s < sp.s1) {
        const ls = band.ls0 + r() * (band.ls1 - band.ls0);
        const ld = Math.min(band.e1 - band.e0, 14 + r() * 22);
        const e = band.e0 + r() * Math.max(0, band.e1 - band.e0 - ld) + ld * 0.5;
        const d = sideD(side, e);
        const sc = s + ls * 0.5;
        // Taller towards the far bands; a few towers.
        let h = band.h0 + Math.pow(r(), 1.6) * (band.h1 - band.h0);
        if (bi >= 2 && r() < 0.12) h *= 1.5;
        // Opening (menu / hero) view: keep the near blocks lower so the skyline reads down the road.
        if (sp.index <= 1 && bi >= 1 && bi <= 2) h *= 0.6;
        if (lotOk(b, c, sc, d, ls, ld)) {
          const yaw = bi === 0 ? 0 : (r() - 0.5) * 0.12;
          const y = lotBase(c, sc, d, ls, ld);
          lots.push({ s: sc, d, ls, ld, h: h + 0.8, yaw, y, e, side });
        }
        s += ls + band.gap0 + r() * (band.gap1 - band.gap0);
      }
    }
  }

  const blds: Placement[] = [];
  let tallest: Lot | null = null;
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length) % a.length];
  for (const L of lots) {
    const near = L.e < 125;
    const toward = -L.side; // across-road direction pointing at the carriageway
    const cy = Math.cos(L.yaw);
    const sy = Math.sin(L.yaw);
    // Building-local offset (a along the road, b across) → road space.
    const at = (a: number, b: number): [number, number] => [L.s + a * cy - b * sy, L.d + a * sy + b * cy];
    const rs = r();
    const style = L.h < 11 ? 0 : rs < 0.3 ? 3 : rs < 0.55 ? 0 : rs < 0.8 ? 1 : 2;
    // Massing: retail podium + tower, setbacks (near blocks are seen large: no plain boxes).
    const secs: Section[] = [];
    if (L.h > 22 && r() < (near ? 0.55 : 0.2)) {
      const ph = 5.2 + r() * 3.2;
      secs.push({ ls: L.ls, ld: L.ld, y: L.y, h: ph + 0.8, kind: KIND_PODIUM });
      secs.push({ ls: L.ls * (0.6 + r() * 0.25), ld: L.ld * (0.58 + r() * 0.25), y: L.y + ph + 0.75, h: L.h - ph - 0.75, kind: KIND_UPPER });
    } else secs.push({ ls: L.ls, ld: L.ld, y: L.y, h: L.h, kind: KIND_GROUND });
    const last = secs[secs.length - 1];
    if (last.h > 30 && r() < (near ? 0.6 : 0.3)) {
      const h1 = last.h * (0.55 + r() * 0.22);
      const h2 = Math.max(9, last.h - h1);
      last.h = h1;
      secs.push({ ls: last.ls * (0.62 + r() * 0.2), ld: last.ld * (0.62 + r() * 0.2), y: last.y + h1 - 0.05, h: h2 + 0.05, kind: KIND_UPPER });
    }
    for (const S of secs) {
      // Scale: x = across the road (ld), z = along (ls).
      blds.push({ s: L.s, d: L.d, y: S.y, yaw: L.yaw, scale: [S.ld, packHeight(S.h, S.kind, style), S.ls] });
      // Balconies on near residential blocks (floor height 3.0 m in the shader): slab + railing.
      if (style === 3 && near && S.kind !== KIND_PODIUM && S.h > 9) {
        const nf = Math.floor((S.h - 1.2) / 3.0);
        const k0 = S.kind === KIND_GROUND ? 1 : 1;
        for (let k = k0; k < nf; k++) {
          const yk = S.y + k * 3.0 - 0.12;
          const wv = S.ls - 1.6;
          let [s1, d1] = at(0, toward * (S.ld * 0.5 + 0.6));
          equip.push({ s: s1, d: d1, y: yk, yaw: L.yaw, scale: [1.2, 0.2, wv] });
          [s1, d1] = at(0, toward * (S.ld * 0.5 + 1.17));
          equip.push({ s: s1, d: d1, y: yk + 0.2, yaw: L.yaw, scale: [0.06, 0.95, wv] });
          if (L.e < 85) {
            const wa = S.ld - 1.6;
            [s1, d1] = at(-S.ls * 0.5 - 0.6, 0);
            equip.push({ s: s1, d: d1, y: yk, yaw: L.yaw, scale: [wa, 0.2, 1.2] });
            [s1, d1] = at(-S.ls * 0.5 - 1.17, 0);
            equip.push({ s: s1, d: d1, y: yk + 0.2, yaw: L.yaw, scale: [wa, 0.95, 0.06] });
          }
        }
      }
    }
    const T = secs[secs.length - 1];
    const top = T.y + T.h;
    if (!tallest || L.h > tallest.h) tallest = L;
    if (L.h > 11) {
      // Roof plant: AC units, lift overrun, a water tank frame.
      const n = 1 + Math.floor(r() * (near ? 4.5 : 3.5));
      for (let i = 0; i < n; i++) {
        const w = 2 + r() * 5;
        const dd = 1.5 + r() * 3.5;
        const ht = 1.4 + r() * 3.2;
        const [s1, d1] = at((r() - 0.5) * Math.max(0, T.ls - w - 3), (r() - 0.5) * Math.max(0, T.ld - dd - 3));
        equip.push({ s: s1, d: d1, y: top - 0.1, yaw: L.yaw, scale: [dd, ht, w] });
      }
    }
    if (L.h > 45) {
      // Aviation obstruction lights on the roof corners.
      const ph = r();
      for (const [cs, cd] of [[-0.45, -0.45], [0.45, 0.45]]) {
        const [s1, d1] = at(cs * T.ls, cd * T.ld);
        pts.add(s1, d1, top + 0.6, 12, 0.6, 0.45, 0.25, 4, 0.03, blinkBeacon(ph + cs * 0.5), 0.45);
      }
    }
    if (!near) continue;
    // Rooftop sign on some near towers, angled towards oncoming traffic.
    if (L.h > 18 && r() < 0.32) {
      const w = Math.min(T.ls * 0.75, 15);
      const hg = w / SIGN_ASPECT;
      const [s1, d1] = at(0, toward * T.ld * 0.25);
      const yaw = L.side > 0 ? 1.0 : -1.0;
      boards.push({ s: s1, d: d1, y: top + 0.9, yaw, scale: [w, hg, signCode(pick(ROOF_WORDS))] });
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      equip.push({ s: s1 + c * 0.35, d: d1 + sn * 0.35, y: top - 0.1, yaw, scale: [w * 0.9, 1.0, 0.25] });
      for (const t of [-0.35, 0.35]) equip.push({ s: s1 + c * 0.35 - t * w * sn, d: d1 + sn * 0.35 + t * w * c, y: top - 0.1, yaw, scale: [0.2, hg + 1.0, 0.2] });
    }
    // Wall sign on the podium / shed fascia (flat on the road-facing wall).
    const S0 = secs[0];
    if ((S0.kind === KIND_PODIUM || L.h < 11) && r() < 0.6) {
      const hg = 1.0 + r() * 0.5;
      const w = hg * SIGN_ASPECT;
      if (w < S0.ls - 2) {
        const [s1, d1] = at((r() - 0.5) * (S0.ls - w - 2), toward * (S0.ld * 0.5 + 0.12));
        boards.push({ s: s1, d: d1, y: S0.y + S0.h - hg - 0.45, yaw: L.yaw + (L.side > 0 ? Math.PI / 2 : -Math.PI / 2), scale: [w, hg, signCode(pick(WALL_WORDS))] });
      }
    }
    // Pylon sign by commercial sheds.
    if (L.h < 11 && r() < 0.5) {
      const [s1, d1] = at(-L.ls * 0.5 + 2, toward * (L.ld * 0.5 + 3.5));
      const yb = terrainHeight(s1, d1, c);
      const ph = 6.5 + r() * 4;
      const w = 4.4;
      const yaw = L.side > 0 ? 0.5 : -0.5;
      equip.push({ s: s1, d: d1, y: yb - 0.4, scale: [0.45, ph + 0.4, 0.45] });
      equip.push({ s: s1 + Math.cos(yaw) * 0.25, d: d1 + Math.sin(yaw) * 0.25, y: yb + ph - 0.15, yaw, scale: [w + 0.3, w / SIGN_ASPECT + 0.3, 0.3] });
      boards.push({ s: s1, d: d1, y: yb + ph, yaw, scale: [w, w / SIGN_ASPECT, signCode(pick(PYLON_WORDS))] });
    }
  }
  // Antenna mast on the tallest block.
  if (tallest && tallest.h > 30) {
    const mh = 10 + r() * 18;
    const top = tallest.y + tallest.h;
    equip.push({ s: tallest.s, d: tallest.d, y: top, scale: [0.5, mh, 0.5] });
    pts.add(tallest.s, tallest.d, top + mh + 0.3, 12, 0.6, 0.45, 0.3, 5, 0.035, blinkBeacon(r()), 0.4);
    pts.add(tallest.s, tallest.d, top + mh * 0.55, 10, 0.5, 0.35, 0.22, 0, 0, blinkBeacon(r()), 0.4);
  }

  const insideLot = (s: number, d: number, pad: number) =>
    lots.some((L) => Math.abs(s - L.s) < L.ls * 0.5 + pad && Math.abs(d - L.d) < L.ld * 0.5 + pad);

  // Lit billboards on lattice legs behind the frontage road (0–2 per chunk), facing oncoming drivers.
  const nBoards = Math.floor(r() * 2.6);
  for (let i = 0; i < nBoards; i++) {
    const side = r() < 0.55 ? 1 : -1;
    const s = sp.s0 + 25 + r() * (sp.s1 - sp.s0 - 50);
    const e = 22 + r() * 14;
    const d = sideD(side, e);
    if (!lotOk(b, c, s, d, 14, 4, 0.2) || insideLot(s, d, 9)) continue;
    addBillboard(RL, c, s, d, side, 11 + r() * 5, r);
  }

  // Shed forecourts: a row of nose-in parked cars between the frontage road and the shop fronts.
  for (const L of lots) {
    if (L.h > 11.5 || r() < 0.35) continue;
    const front = L.e - L.ld * 0.5;
    if (front < 27) continue;
    const toward = -L.side;
    const n = Math.floor((L.ls - 3) / 2.7);
    for (let i = 0; i < n; i++) {
      if (r() < 0.38) continue;
      const a = -L.ls * 0.5 + 2 + i * 2.7;
      const bb = toward * (L.ld * 0.5 + 2.9);
      const s1 = L.s + a * Math.cos(L.yaw) - bb * Math.sin(L.yaw);
      const d1 = L.d + a * Math.sin(L.yaw) + bb * Math.cos(L.yaw);
      const yaw = L.yaw + (r() < 0.75 ? -toward : toward) * Math.PI * 0.5 + (r() - 0.5) * 0.08;
      RL.cars.push({ s: s1, d: d1, y: terrainHeight(s1, d1, c) + 0.04, yaw, scale: [1, 0.95 + r() * 0.12, 0.95 + r() * 0.1] });
    }
  }

  // Parking-lot lamp cluster with parked cars (one in ~60% of chunks), clear of the blocks.
  if (r() < 0.6) {
    const side = r() < 0.5 ? 1 : -1;
    const sc = sp.s0 + 40 + r() * (sp.s1 - sp.s0 - 80);
    const ec = 54 + r() * 25;
    const sodium = r() < 0.45;
    const [cr, cg, cb] = sodium ? [1.0, 0.55, 0.24] : [0.95, 0.92, 0.85];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        const s = sc + (i - 1) * 24 + (r() - 0.5) * 2;
        const d = sideD(side, ec + j * 22);
        if (sp.overpassS !== null && Math.abs(s - sp.overpassS) < 24) continue;
        if (s < sp.s0 + 3 || s > sp.s1 - 3 || terrainSlope(s, d, c) > 0.15 || insideLot(s, d, 6)) continue;
        const yb = terrainHeight(s, d, c);
        const hh = 9;
        equip.push({ s, d, y: yb - 0.3, scale: [0.22, hh + 0.3, 0.22] });
        equip.push({ s, d, y: yb + hh - 0.1, scale: [1.6, 0.18, 0.5] });
        const k = 26;
        pts.add(s, d - 0.5, yb + hh - 0.2, cr * k, cg * k, cb * k, 0.26, 4.5, 0.012, 0, 0.6);
        pts.add(s, d + 0.5, yb + hh - 0.2, cr * k, cg * k, cb * k, 0.26, 4.5, 0.012, 0, 0.6);
        pts.add(s, d, yb + 0.35, cr * 0.11, cg * 0.11, cb * 0.11, 0, 13, 0, 0, 1, PointKind.Pool);
        // Two facing rows of parked cars around the lamp.
        for (const off of j === 0 ? [-3.2, 3.2] : []) {
          for (let q = -3; q <= 3; q++) {
            if (r() < 0.45) continue;
            const s2 = s + q * 2.7;
            const d2 = d + off;
            if (insideLot(s2, d2, 1.5) || s2 < sp.s0 + 2 || s2 > sp.s1 - 2) continue;
            const yaw = (off > 0 ? 1 : -1) * Math.PI * 0.5 + (r() - 0.5) * 0.1;
            RL.cars.push({ s: s2, d: d2, y: terrainHeight(s2, d2, c) + 0.04, yaw, scale: [1, 0.95 + r() * 0.12, 0.95 + r() * 0.1] });
          }
        }
      }
    }
  }

  if (blds.length) {
    const mat = facadeMaterial(b, { key: 'bd.city', mode: 'city', albedo: 'concrete_panel_albedo.webp', normal: 'concrete_panel_normal.webp', tile: 6, roughness: 0.85, wetness: 0.55 });
    b.addInstances(unitBox(), mat, blds, { sharedGeometry: true, noProbe: true, name: 'bdCityBlocks' });
  }
  fillRoadside(sp, c, RL, r, 'props');
  flushRoadside(b, RL, () => boardMaterial(b), boardGeometry);
  b.onUpdate((t) => shared.uTime.value < t && (shared.uTime.value = t));
}

let _board: BufferGeometry | null = null;
export function boardGeometry(): BufferGeometry {
  if (!_board) {
    _board = new PlaneGeometry(1, 1);
    _board.translate(0, 0.5, 0);
  }
  return _board;
}

export function boardMaterial(b: IChunkBuilder): ShaderMaterial {
  return b.materials.cached('bd.billboard', () => {
    const m = new ShaderMaterial({
      name: 'bdBillboard',
      uniforms: UniformsUtils.merge([UniformsLib.fog, {}]),
      fog: true,
      vertexShader: /* glsl */ `
${GLSL_HASH}
varying vec2 vUv;
flat varying float vSeed;
varying float vDist;
flat varying float vKind;
void main() {
  vUv = uv;
  vSeed = bdHash(mod(floor(instanceMatrix[3].xz), 4096.0));
  vKind = length(instanceMatrix[2].xyz);
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vDist = length(wp.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`,
      fragmentShader: /* glsl */ `
${GLSL_FOG}
uniform float uTime;
uniform sampler2D uSign;
varying vec2 vUv;
flat varying float vSeed;
varying float vDist;
flat varying float vKind;
vec3 pal(float h) {
  if (h < 0.2) return vec3(0.9, 0.18, 0.12);
  if (h < 0.4) return vec3(0.1, 0.35, 0.95);
  if (h < 0.55) return vec3(0.95, 0.6, 0.1);
  if (h < 0.7) return vec3(0.1, 0.75, 0.6);
  if (h < 0.85) return vec3(0.7, 0.2, 0.8);
  return vec3(0.92, 0.9, 0.86);
}
vec3 signCol(float h) {
  if (h < 0.22) return vec3(1.0, 0.16, 0.1);
  if (h < 0.4) return vec3(0.2, 0.5, 1.0);
  if (h < 0.55) return vec3(1.0, 0.62, 0.22);
  if (h < 0.68) return vec3(1.0, 0.25, 0.55);
  if (h < 0.8) return vec3(0.25, 0.95, 0.85);
  return vec3(1.0, 0.93, 0.82);
}
void main() {
  vec2 uv = vUv;
  float h = vSeed;
  float fogF = bdFogFactor(vDist, 0.75);
  if (vKind > 1.5) {
    // Generic word sign from the atlas: neon / channel letters (no backing) or a lightbox panel.
    float idx = floor(vKind - 2.0 + 0.5);
    vec2 cell = vec2(mod(idx, 2.0), floor(idx / 2.0));
    vec2 cuv = vec2((cell.x + uv.x) * 0.5, 1.0 - (cell.y + 1.0 - uv.y) * 0.125);
    vec2 tx = texture2D(uSign, cuv).rg;
    vec3 sc = signCol(fract(h * 5.31));
    vec3 col;
    if (fract(h * 2.71) < 0.62) {
      if (tx.g < 0.03) discard;
      float fl = fract(h * 9.1) < 0.12 ? step(0.08, fract(sin(floor(uTime * 9.0) * 12.9898 + h * 78.2) * 43758.5)) : 1.0;
      col = sc * (tx.r * 2.4 + tx.g * 0.35) * fl;
    } else {
      float edge = step(0.012, uv.x) * step(uv.x, 0.988) * step(0.05, uv.y) * step(uv.y, 0.95);
      vec3 panel = fract(h * 3.3) < 0.5 ? vec3(0.95, 0.93, 0.88) : sc;
      // White lightboxes stay below clipping (text and tint survive the tone mapping up close).
      float pk = fract(h * 3.3) < 0.5 ? 0.62 : 1.0;
      col = mix(panel * 1.1 * pk * (0.8 + 0.3 * uv.y), sc * 0.05, tx.r) * mix(0.15, 1.0, edge);
    }
    gl_FragColor = vec4(mix(col, fogColor, fogF), 1.0);
    return;
  }
  vec3 c1 = pal(fract(h * 3.1));
  vec3 c2 = pal(fract(h * 7.7 + 0.3));
  vec3 col = mix(c1 * 0.35, c2, smoothstep(0.1, 0.95, uv.x * 0.8 + uv.y * 0.35 + 0.1 * sin(uv.y * 6.0 + h * 9.0)));
  // Abstract hero shape (disc / arc / wedge) and "copy" blocks (no lettering).
  float t = fract(h * 13.0);
  vec2 p = (uv - vec2(0.72, 0.5)) * vec2(3.2, 1.0);
  float shape = t < 0.33 ? 1.0 - smoothstep(0.36, 0.38, length(p)) : (t < 0.66 ? smoothstep(0.02, 0.0, abs(length(p) - 0.32) - 0.05) : step(abs(p.y), 0.42 - abs(p.x) * 0.5));
  col = mix(col, vec3(1.0, 0.97, 0.92), shape * 0.85);
  vec2 q = uv * vec2(1.0, 1.0);
  float blk = step(0.07, q.x) * step(q.x, 0.45) * (step(0.62, q.y) * step(q.y, 0.74) + step(0.42, q.y) * step(q.y, 0.48) * step(q.x, 0.33));
  col = mix(col, vec3(0.98), blk * 0.9);
  // Frame edge, uplight falloff.
  float edge = step(0.015, uv.x) * step(uv.x, 0.985) * step(0.03, uv.y) * step(uv.y, 0.97);
  col *= edge * (0.75 + 0.45 * (1.0 - uv.y));
  col *= 1.5;
  gl_FragColor = vec4(mix(col, fogColor, fogF), 1.0);
}`,
    });
    m.uniforms.uTime = shared.uTime;
    m.uniforms.uSign = { value: signAtlas() };
    return m;
  }) as ShaderMaterial;
}
