/**
 * The 2–60 m band outside both carriageways (what the crash / game-over cameras see):
 *   verge grass tufts and shrubs, utility cabinets with status LEDs, fences (city railings,
 *   industrial security fence, rural post-and-rail), frontage roads (surface is in terrain.ts)
 *   with their own dim lamps, street trees and parked cars, billboards on lattice legs.
 *
 * The zone builders (city, industrial, rural) call fillRoadside / flushRoadside so box props and
 * lights share their existing batches; extra draws per chunk: parked cars, lattice legs, boards.
 */
import { BufferAttribute, BufferGeometry, CylinderGeometry, ExtrudeGeometry, IcosahedronGeometry, Shape } from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Material } from 'three';
import type { ChunkSpec, IChunkBuilder, Placement } from '../../core/types';
import { hash01, makeRng } from '../../core/math';
import { PAVED_LEFT_D, PAVED_RIGHT_D } from '../roadProfile';
import { facadeMaterial } from './facade';
import { PointBatch, PointKind } from './points';
import { beam, blobTree } from './rural';
import { unitBox } from './shared';
import { frontageE, frontageW, terrainHeight, terrainSlope } from './terrain';
import type { TerrainCtx } from './terrain';

export interface RoadsideLists {
  /** Unit boxes in the shared galvanised equipment material. */
  props: Placement[];
  cars: Placement[];
  tufts: Placement[];
  shrubs: Placement[];
  /** Street trees along frontage roads (blob tree). */
  trees: Placement[];
  lattice: Placement[];
  /** Billboards / signs (city boardMaterial; scale.z = 1 artwork, ≥ 2 sign word). */
  boards: Placement[];
  pts: PointBatch;
}

export const newRoadsideLists = (): RoadsideLists => ({ props: [], cars: [], tufts: [], shrubs: [], trees: [], lattice: [], boards: [], pts: new PointBatch() });

const dOf = (side: number, e: number) => (side > 0 ? PAVED_RIGHT_D + e : PAVED_LEFT_D - e);

// ── shared geometries ───────────────────────────────────────────────────────

let _car: BufferGeometry | null = null;
/** Generic hatchback / saloon silhouette (no brand features): extruded side profile + wheels. ≈ 270 tris. */
export function carGeometry(): BufferGeometry {
  if (_car) return _car;
  const sh = new Shape();
  sh.moveTo(-2.22, 0.34);
  sh.lineTo(-2.25, 0.78);
  sh.quadraticCurveTo(-2.22, 0.95, -1.95, 0.99);
  sh.lineTo(-1.5, 1.01);
  sh.quadraticCurveTo(-1.1, 1.4, -0.75, 1.42);
  sh.lineTo(0.35, 1.44);
  sh.quadraticCurveTo(0.75, 1.42, 1.25, 1.03);
  sh.lineTo(2.0, 0.92);
  sh.quadraticCurveTo(2.24, 0.86, 2.26, 0.7);
  sh.lineTo(2.24, 0.34);
  sh.lineTo(1.79, 0.34);
  sh.absarc(1.4, 0.34, 0.39, 0, Math.PI, false);
  sh.lineTo(-1.01, 0.34);
  sh.absarc(-1.4, 0.34, 0.39, 0, Math.PI, false);
  sh.lineTo(-2.22, 0.34);
  const W = 1.62;
  const body = new ExtrudeGeometry(sh, { depth: W, bevelEnabled: false, curveSegments: 3 });
  body.translate(0, 0, -W / 2);
  body.rotateY(Math.PI / 2); // profile +x (front) → −Z (forward)
  body.deleteAttribute('uv');
  const parts: BufferGeometry[] = [body];
  for (const [x, z] of [[-0.78, -1.4], [0.78, -1.4], [-0.78, 1.4], [0.78, 1.4]]) {
    const w = new CylinderGeometry(0.33, 0.33, 0.24, 8, 1, false).toNonIndexed();
    w.rotateZ(Math.PI / 2);
    w.translate(x, 0.33, z);
    w.deleteAttribute('uv');
    parts.push(w);
  }
  const part: number[][] = parts.map((g, i) => new Array<number>(g.getAttribute('position').count).fill(i === 0 ? 0 : 1));
  parts.forEach((g, i) => g.setAttribute('bdPart', new BufferAttribute(new Float32Array(part[i]), 1)));
  _car = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)))!;
  return _car;
}

let _tuft: BufferGeometry | null = null;
/**
 * Rough verge grass clump: 5 thin blades (1.5–3 cm wide), each bent in two segments and leaning
 * outwards by a different amount, two-sided. 30 tris. Height ≈ 0.2–0.5 m before instance scale.
 */
function tuftGeometry(): BufferGeometry {
  if (_tuft) return _tuft;
  const p: number[] = [];
  const rng = makeRng(4242);
  const tri = (a: number[], b: number[], c: number[]) => {
    p.push(...a, ...b, ...c);
    p.push(...b, ...a, ...c);
  };
  const N = 5;
  for (let i = 0; i < N; i++) {
    const a = i * 2.39996 + rng() * 0.6;
    const r0 = 0.015 + rng() * 0.06;
    const cx = Math.cos(a) * r0;
    const cz = Math.sin(a) * r0;
    const h = 0.2 + rng() * 0.3;
    const lean = (0.25 + rng() * 0.55) * h;
    const w = 0.008 + rng() * 0.007;
    // Blade plane faces roughly across its lean direction (with a twist).
    const ta = a + Math.PI / 2 + (rng() - 0.5) * 0.9;
    const px = Math.cos(ta) * w;
    const pz = Math.sin(ta) * w;
    const ox = Math.cos(a);
    const oz = Math.sin(a);
    // Base, mid (55 % height, 25 % of the lean), tip (full lean, drooping slightly).
    const mh = h * 0.55;
    const ml = lean * 0.25;
    const b0 = [cx - px, 0, cz - pz];
    const b1 = [cx + px, 0, cz + pz];
    const m0 = [cx + ox * ml - px * 0.75, mh, cz + oz * ml - pz * 0.75];
    const m1 = [cx + ox * ml + px * 0.75, mh, cz + oz * ml + pz * 0.75];
    const t = [cx + ox * lean, h * (0.92 - 0.25 * (lean / h - 0.25)), cz + oz * lean];
    tri(b0, b1, m1);
    tri(b0, m1, m0);
    tri(m0, m1, t);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(p), 3));
  g.computeVertexNormals();
  _tuft = g;
  return g;
}

let _shrub: BufferGeometry | null = null;
/**
 * Verge scrub bush (metres at scale 1: ≈ 1.9 m wide, 1.2 m tall): a small dark core lump with ~26
 * long leaf blades / twigs fanning out of it in all directions (a spiky, broken outline: lit by a
 * headlight or a fire it reads as foliage, not as a smooth boulder). Blade normals point out of the
 * bush (both faces alike), the classic foliage-card trick, so the crown shades as one leafy volume.
 * Non-indexed, normals included. 72 tris.
 */
function shrubGeometry(): BufferGeometry {
  if (_shrub) return _shrub;
  const rng = makeRng(9191);
  const C = [0, 0.42, 0];
  const core = new IcosahedronGeometry(1, 0);
  core.deleteAttribute('uv');
  core.deleteAttribute('normal');
  const p = core.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = (Math.round(x * 50) * 73856093) ^ (Math.round(y * 50) * 19349663) ^ (Math.round(z * 50) * 83492791);
    const f = 0.42 * (0.7 + hash01(k) * 0.5);
    p.setXYZ(i, C[0] + x * f * 1.2, Math.max(-0.05, C[1] + y * f * 0.8), C[2] + z * f * 1.2);
  }
  const coreW = mergeVertices(core);
  coreW.computeVertexNormals();
  const pos: number[] = [];
  const nor: number[] = [];
  const NB = 26;
  for (let i = 0; i < NB; i++) {
    // Direction: golden-angle spiral over the upper ~3/4 sphere, jittered.
    const t = (i + 0.5) / NB;
    const el = Math.asin(Math.min(1, -0.35 + 1.25 * t + (rng() - 0.5) * 0.25));
    const az = i * 2.39996 + (rng() - 0.5) * 0.7;
    const dx = Math.cos(el) * Math.cos(az);
    const dy = Math.sin(el);
    const dz = Math.cos(el) * Math.sin(az);
    const r0 = 0.12 + rng() * 0.2;
    const len = 0.55 + rng() * 0.55;
    const w = 0.1 + rng() * 0.12;
    // Side vector across the blade (horizontal), twisted a little.
    const tw = (rng() - 0.5) * 1.2;
    let sx = -dz * Math.cos(tw);
    let sy = Math.sin(tw) * 0.6;
    let sz = dx * Math.cos(tw);
    const sl = Math.hypot(sx, sy, sz) || 1;
    sx /= sl; sy /= sl; sz /= sl;
    const bx = C[0] + dx * r0;
    const by = C[1] + dy * r0 * 0.8;
    const bz = C[2] + dz * r0;
    // Tip droops under its own weight.
    const tx = bx + dx * len;
    const ty = Math.max(0.02, by + dy * len - 0.12 * len * len);
    const tz = bz + dz * len;
    const mx = bx + dx * len * 0.45;
    const my = by + dy * len * 0.45;
    const mz = bz + dz * len * 0.45;
    const A = [bx - sx * w * 0.3, by - sy * w * 0.3, bz - sz * w * 0.3];
    const M0 = [mx - sx * w, my - sy * w, mz - sz * w];
    const M1 = [mx + sx * w, my + sy * w, mz + sz * w];
    const T = [tx, ty, tz];
    // Kite-shaped leaf: (A, M1, M0) + (M0, M1, T) both windings; normals radial (+ a bit up).
    const nx = dx;
    const ny = dy * 0.6 + 0.5;
    const nz = dz;
    const nl = Math.hypot(nx, ny, nz);
    for (const tri of [[A, M1, M0], [M0, M1, T], [A, M0, M1], [M0, T, M1]]) {
      for (const v of tri) {
        pos.push(v[0], v[1], v[2]);
        nor.push(nx / nl, ny / nl, nz / nl);
      }
    }
  }
  const bl = new BufferGeometry();
  bl.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  bl.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  _shrub = mergeGeometries([coreW.toNonIndexed(), bl])!;
  return _shrub;
}

let _lattice: BufferGeometry | null = null;
/** Square lattice leg, 9 m tall (scale y = height / 9), 0.7 m wide. ≈ 300 tris. */
function latticeGeometry(): BufferGeometry {
  if (_lattice) return _lattice;
  const parts: BufferGeometry[] = [];
  const h = 0.35;
  const H = 9;
  for (const [x, z] of [[-h, -h], [h, -h], [h, h], [-h, h]]) beam(parts, x, 0, z, x, H, z, 0.1);
  for (let y = 0, k = 0; y < H - 0.1; y += 1.5, k++) {
    const y1 = Math.min(H, y + 1.5);
    const f = k % 2 ? 1 : -1;
    beam(parts, -h * f, y, -h, h * f, y1, -h, 0.055);
    beam(parts, -h * f, y, h, h * f, y1, h, 0.055);
    beam(parts, -h, y, -h * f, -h, y1, h * f, 0.055);
    beam(parts, h, y, -h * f, h, y1, h * f, 0.055);
  }
  _lattice = mergeGeometries(parts)!;
  return _lattice;
}

// ── content ─────────────────────────────────────────────────────────────────

/**
 * Billboard on two lattice legs with a catwalk and uplights (city boardMaterial artwork).
 * `yaw` turns the face towards oncoming traffic.
 */
export function addBillboard(L: RoadsideLists, c: TerrainCtx, s: number, d: number, side: number, w: number, r: () => number): void {
  const hgt = w * (0.3 + r() * 0.1);
  const yb = terrainHeight(s, d, c);
  const y0 = yb + 6.5 + r() * 4;
  const yaw = side > 0 ? 0.42 : -0.42;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  L.boards.push({ s, d, y: y0, yaw, scale: [w, hgt, 1] });
  // Back plate (behind the panel = against its normal), legs, catwalk.
  L.props.push({ s: s + cy * 0.3, d: d + sy * 0.3, y: y0 - 0.25, yaw, scale: [w + 0.4, hgt + 0.5, 0.3] });
  for (const t of [-0.3, 0.3]) {
    const ls = s + cy * 0.9 - t * w * sy;
    const ld = d + sy * 0.9 + t * w * cy;
    const yl = terrainHeight(ls, ld, c) - 0.4;
    L.lattice.push({ s: ls, d: ld, y: yl, yaw, scale: [1, (y0 - yl + 0.2) / 9, 1] });
  }
  L.props.push({ s: s - cy * 0.55, d: d - sy * 0.55, y: y0 - 0.55, yaw, scale: [w * 0.96, 0.08, 1.0] });
  L.props.push({ s: s - cy * 1.0, d: d - sy * 1.0, y: y0 - 0.5, yaw, scale: [w * 0.96, 0.9, 0.04] });
  // Uplights in front of the lower edge.
  for (let k = 0; k < 3; k++) {
    const t = (k - 1) * 0.36 * w;
    L.pts.add(s - cy * 1.0 - t * sy, d - sy * 1.0 + t * cy, y0 - 0.45, 7, 6.4, 5.6, 0.12, 1.4, 0.02, 0, 0.6);
  }
}

/** Everything in the roadside band for this chunk (not the frontage surface: terrain.ts). */
export function fillRoadside(sp: ChunkSpec, c: TerrainCtx, L: RoadsideLists, r: () => number, mode: 'veg' | 'props'): void {
  const zone = sp.zone;
  if (zone === 'bridge' || zone === 'tunnel') return;
  const len = sp.s1 - sp.s0;
  const tunnelish = sp.prevZone === 'tunnel' || sp.nextZone === 'tunnel';
  const bridgeish = sp.prevZone === 'bridge' || sp.nextZone === 'bridge';
  const rural = zone === 'rural';
  const okS = (s: number, m = 0) => {
    if (s < sp.s0 + 0.5 + m || s > sp.s1 - 0.5 - m) return false;
    if (sp.overpassS !== null && Math.abs(s - sp.overpassS) < 20) return false;
    if (sp.nextZone === 'tunnel' && s > sp.s1 - 150) return false;
    if (sp.prevZone === 'tunnel' && s < sp.s0 + 150) return false;
    if (sp.nextZone === 'bridge' && s > sp.s1 - 70) return false;
    if (sp.prevZone === 'bridge' && s < sp.s0 + 70) return false;
    return true;
  };
  const fr = (side: number) => c.fr.find((f) => f.side === side) ?? null;
  /** Is outward distance e on this side on (or right next to) a frontage road at s? */
  const onRoad = (s: number, side: number, e: number, pad: number) => {
    const f = fr(side);
    if (!f || frontageW(s, c) <= 0.05) return false;
    return Math.abs(e - frontageE(f, s, c)) < f.half + pad;
  };
  const groundY = (s: number, d: number) => terrainHeight(s, d, c);

  for (const side of [1, -1]) {
    const far = side < 0; // the opposite verge: further away, sparser
    const F = fr(side);
    // ── verge tufts: clumps of 2–4 overlapping tufts (fewer, fuller; the shader breaks up the ground between) ──
    const nT = mode === 'veg' ? Math.round((rural ? 58 : 66) * (far ? 0.22 : 1) * (tunnelish ? 0.6 : 1)) : 0;
    for (let i = 0; i < nT; i++) {
      const s0 = sp.s0 + r() * len;
      const e0 = 1.4 + Math.pow(r(), 1.6) * (rural ? 13 : 10);
      const n = 2 + Math.floor(r() * 2.6);
      const k0 = 0.9 + r() * 0.8;
      for (let j = 0; j < n; j++) {
        const s = s0 + (r() - 0.5) * 0.7;
        const e = Math.max(1.2, e0 + (r() - 0.5) * 0.6);
        if (s < sp.s0 + 0.3 || s > sp.s1 - 0.3 || onRoad(s, side, e, 0.4)) continue;
        if (tunnelish && !okS(s) && e > 3) continue;
        const d = dOf(side, e);
        const k = k0 * (0.75 + r() * 0.5);
        L.tufts.push({ s, d, y: groundY(s, d) - 0.03, yaw: r() * 6.283, scale: [k, k * (0.7 + r() * 0.7), k] });
      }
    }
    if (tunnelish && sp.zone !== 'rural') {
      // Cuttings: tufts only.
      continue;
    }
    // ── shrubs on the embankment beyond the ditch ──
    const nS = mode === 'veg' ? Math.round((rural ? 24 : 13) * (far ? 0.6 : 1)) : 0;
    for (let i = 0; i < nS; i++) {
      const s = sp.s0 + r() * len;
      const e = 7.5 + r() * (F ? 4 : 9);
      if (!okS(s) || onRoad(s, side, e, 1.5) || terrainSlope(s, dOf(side, e), c) > 0.6) continue;
      const d = dOf(side, e);
      const k = 0.65 + r() * 0.6;
      L.shrubs.push({ s, d, y: groundY(s, d) - 0.12, yaw: r() * 6.283, scale: [k * (0.9 + r() * 0.4), k * (0.7 + r() * 0.5), k * (0.9 + r() * 0.4)] });
    }
    if (mode === 'veg') {
      // Street trees along the frontage road's outer verge.
      if (F && zone === 'city') {
        for (let s = sp.s0 + r() * 8; s < sp.s1; s += 11 + r() * 6) {
          if (frontageW(s, c) < 0.8 || r() < 0.35 || !okS(s)) continue;
          const e = frontageE(F, s, c) + F.half + 3.0;
          const d = dOf(side, e);
          const k = 0.48 + r() * 0.24;
          L.trees.push({ s, d, y: groundY(s, d) - 0.3, yaw: r() * 6.283, scale: [k, k * (0.9 + r() * 0.25), k] });
        }
      }
      continue;
    }
    // ── utility cabinets with a status LED (city / industrial) ──
    if (!rural && !far) {
      for (let s = sp.s0 + 30 + r() * 60; s < sp.s1 - 10; s += 90 + r() * 80) {
        if (!okS(s)) continue;
        const e = 3.0 + r() * 0.6;
        const d = dOf(side, e);
        const y = groundY(s, d);
        const wide = r() < 0.4;
        L.props.push({ s, d, y: y - 0.05, scale: [0.75, 0.22, wide ? 1.9 : 1.1] });
        L.props.push({ s, d, y: y + 0.1, scale: [0.5, 1.25 + r() * 0.3, wide ? 1.7 : 0.9] });
        const led = r() < 0.7;
        if (led) L.pts.add(s - (wide ? 0.87 : 0.47), d, y + 1.05, 0.15, 1.6, 0.35, 0.025, 0, 0, 0, 0.6);
      }
    }
    // ── fences ──
    const postRun = (e: number, pitch: number, h: number, t: number, rails: number[], s0: number, s1: number) => {
      let prev: [number, number, number] | null = null;
      for (let s = s0; s < s1; s += pitch) {
        if (!okS(s) || onRoad(s, side, e, 1.2)) {
          prev = null;
          continue;
        }
        const d = dOf(side, e);
        const y = groundY(s, d);
        L.props.push({ s, d, y: y - 0.3, scale: [t, h + 0.3, t] });
        if (prev) {
          const [ps, pd, py] = prev;
          const yaw = Math.atan2(d - pd, s - ps);
          for (const ry of rails) L.props.push({ s: (s + ps) / 2, d: (d + pd) / 2, y: (y + py) / 2 + ry, yaw, scale: [0.045, 0.05, Math.hypot(s - ps, d - pd)] });
        }
        prev = [s, d, y];
      }
    };
    if (zone === 'city' && F && !far) {
      // Railing behind the frontage road's outer verge, in runs.
      let s = sp.s0 + r() * 40;
      while (s < sp.s1) {
        const runL = 30 + r() * 60;
        if (r() < 0.6) {
          const e = F.e0 + F.half + 5.6;
          postRun(e, 2.5, 1.15, 0.06, [1.1, 0.55], s, Math.min(sp.s1, s + runL));
        }
        s += runL + 10 + r() * 30;
      }
    } else if (zone === 'industrial') {
      // Security fence along the yards: tall posts, top / bottom rails, barbed-wire strand.
      const e = F ? F.e0 + F.half + 4.2 : 9.4 + r() * 1.5;
      postRun(e, 3.0, 2.4, 0.08, [2.35, 2.55, 0.15], sp.s0 + 1, sp.s1);
    } else if (rural && r() < 0.75) {
      // Post-and-rail field fence.
      const e = 12 + r() * 4;
      postRun(e, 3.3, 1.15, 0.11, [1.05, 0.6], sp.s0 + r() * 2, sp.s1);
    }
    // ── frontage road: dim lamps, street trees, parked cars ──
    if (F) {
      const lampPitch = 34;
      const ph = r() * lampPitch;
      for (let s = sp.s0 + ph; s < sp.s1; s += lampPitch) {
        if (frontageW(s, c) < 0.9 || !F.lit) continue;
        const ec = frontageE(F, s, c);
        const e = ec + F.half + 0.9;
        const d = dOf(side, e);
        const y = groundY(s, d);
        const hh = 7.2;
        L.props.push({ s, d, y: y - 0.3, scale: [0.17, hh + 0.3, 0.17] });
        const da = dOf(side, e - 1.0);
        L.props.push({ s, d: da, y: y + hh - 0.1, scale: [2.0, 0.13, 0.32] });
        const dh = dOf(side, e - 1.8);
        const led = zone === 'industrial' ? r() < 0.3 : r() < 0.4;
        const [cr, cg, cb] = led ? [0.9, 0.92, 1.0] : [1.0, 0.56, 0.25];
        const k = 13;
        L.pts.add(s, dh, y + hh - 0.22, cr * k, cg * k, cb * k, 0.2, 3.2, 0.012, 0, 0.6);
        L.pts.add(s, dh, y + 0.25, cr * 0.8, cg * 0.8, cb * 0.8, 0, 12.5, 0, 0, 1, PointKind.Pool);
      }
      // Kerbside parking on the outer lane, in clusters; vans now and then.
      let s = sp.s0 + r() * 20;
      while (s < sp.s1 - 3) {
        const n = 1 + Math.floor(r() * 6);
        for (let i = 0; i < n && s < sp.s1 - 3; i++) {
          const w = frontageW(s, c);
          const ec = frontageE(F, s, c);
          const slope = (frontageE(F, s + 2, c) - frontageE(F, s - 2, c)) / 4;
          if (w > 0.95 && Math.abs(slope) < 0.25 && r() < 0.85) {
            const d = dOf(side, ec + F.half - 1.15);
            const van = r() < 0.13;
            const yaw = Math.atan(side * slope) + (r() < 0.82 ? 0 : Math.PI) + (r() - 0.5) * 0.04;
            L.cars.push({ s, d, y: groundY(s, d) + 0.04, yaw, scale: van ? [1.1, 1.38, 1.18] : [1, 0.96 + r() * 0.1, 0.95 + r() * 0.1] });
          }
          s += 5.6 + r() * 1.2;
        }
        s += 12 + r() * 40;
      }
    }
    // ── a billboard on lattice legs (industrial / rural: city places its own) ──
    if (zone !== 'city' && !far && r() < (rural ? 0.5 : 0.45)) {
      const s = sp.s0 + 30 + r() * (len - 60);
      const e = (F ? F.e0 + F.half + 7 : 14) + r() * 12;
      const d = dOf(side, e);
      if (okS(s, 10) && terrainSlope(s, d, c) < 0.25) addBillboard(L, c, s, d, side, 11 + r() * 4, r);
    }
  }
  void bridgeish;
}

/** Add the meshes for the collected lists (props → shared equipment material). */
export function flushRoadside(b: IChunkBuilder, L: RoadsideLists, boardMat: (() => Material) | null, boardGeo: (() => BufferGeometry) | null, own = { props: true, pts: true }): void {
  if (own.props && L.props.length) {
    const mat = facadeMaterial(b, { key: 'bd.equip', mode: 'plain', albedo: 'metal_galv_albedo.webp', tile: 3, color: 0x6a6c70, roughness: 0.55, metalness: 0.5, wetness: 0.8 });
    b.addInstances(unitBox(), mat, L.props, { sharedGeometry: true, noProbe: true, noReflect: true, name: 'bdCityEquip' });
  }
  if (L.lattice.length) {
    const mat = facadeMaterial(b, { key: 'bd.equip', mode: 'plain', albedo: 'metal_galv_albedo.webp', tile: 3, color: 0x6a6c70, roughness: 0.55, metalness: 0.5, wetness: 0.8 });
    b.addInstances(latticeGeometry(), mat, L.lattice, { sharedGeometry: true, noProbe: true, noReflect: true, name: 'bdLattice' });
  }
  if (L.cars.length) {
    const mat = facadeMaterial(b, { key: 'bd.car', mode: 'car', roughness: 0.3, metalness: 0.55, wetness: 0.95 });
    b.addInstances(carGeometry(), mat, L.cars, { sharedGeometry: true, noProbe: true, noReflect: true, name: 'bdParkedCars' });
  }
  if (L.boards.length && boardMat && boardGeo) b.addInstances(boardGeo(), boardMat(), L.boards, { sharedGeometry: true, bake: false, noProbe: true, name: 'bdBillboards' });
  if (own.pts) L.pts.build(b, 'bdRoadsideLights');
}

// ── vegetation merged into the terrain mesh (same vertex-coloured material: no extra draw call) ──

const _veg = { p: [] as number[], n: [] as number[], c: [] as number[], uv: [] as number[] };

function appendInstance(src: BufferGeometry, pl: Placement, s0: number, col: (y: number) => [number, number, number]): void {
  const P = src.getAttribute('position');
  const N = src.getAttribute('normal');
  const sc = Array.isArray(pl.scale) ? pl.scale : [pl.scale ?? 1, pl.scale ?? 1, pl.scale ?? 1];
  const cy = Math.cos(pl.yaw ?? 0);
  const sy = Math.sin(pl.yaw ?? 0);
  const ox = pl.d;
  const oy = pl.y ?? 0;
  const oz = -(pl.s - s0);
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i) * sc[0];
    const y = P.getY(i) * sc[1];
    const z = P.getZ(i) * sc[2];
    const wx = x * cy + z * sy;
    const wz = -x * sy + z * cy;
    _veg.p.push(ox + wx, oy + y, oz + wz);
    const nx = N.getX(i) / sc[0];
    const ny = N.getY(i) / sc[1];
    const nz = N.getZ(i) / sc[2];
    const l = Math.hypot(nx, ny, nz) || 1;
    _veg.n.push((nx * cy + nz * sy) / l, ny / l, (-nx * sy + nz * cy) / l);
    const [r, g, b] = col(P.getY(i));
    _veg.c.push(r, g, b);
    _veg.uv.push((ox + wx) / 2, (oy + y) / 2);
  }
}

/**
 * Verge grass tufts, embankment shrubs and street trees for this chunk as one straight-space
 * geometry (position / normal / uv / color), merged into the near terrain mesh by terrain.ts.
 */
export function vegetationGeometry(sp: ChunkSpec, c: TerrainCtx): BufferGeometry | null {
  const L = newRoadsideLists();
  fillRoadside(sp, c, L, makeRng((sp.seed ^ 0x5a17) >>> 0), 'veg');
  if (!L.tufts.length && !L.shrubs.length && !L.trees.length) return null;
  _veg.p.length = _veg.n.length = _veg.c.length = _veg.uv.length = 0;
  const tuft = tuftGeometry();
  const blob = blobTree();
  for (const pl of L.tufts) {
    const h = (((pl.s * 7.31 + pl.d * 3.17) % 1) + 1) % 1;
    // Green-olive clumps with some dry straw ones; darker at the root, paler tips.
    const dry = h > 0.72 ? (h - 0.72) / 0.28 : 0;
    appendInstance(tuft, pl, sp.s0, (y) => {
      const t = Math.min(1, y / 0.4);
      const k = 0.85 + 0.3 * h;
      const r = (0.02 + 0.05 * t) * k + dry * 0.035 * t;
      const g = (0.026 + 0.05 * t) * k + dry * 0.02 * t;
      const b = (0.013 + 0.02 * t) * k;
      return [r, g, b];
    });
  }
  const shrub = shrubGeometry();
  for (const pl of L.shrubs) {
    // Per bush: dark olive, some browner / greyer; near black at the base and inside the lower crown.
    const h = (((pl.s * 5.13 + pl.d * 1.77) % 1) + 1) % 1;
    const h2 = (((pl.s * 2.71 + pl.d * 3.91) % 1) + 1) % 1;
    appendInstance(shrub, pl, sp.s0, (y) => {
      const t = Math.min(1, Math.max(0, (y - 0.05) / 0.9));
      const k = 0.3 + 0.7 * t;
      return [(0.014 + 0.012 * h2) * k, (0.021 + 0.009 * h) * k, (0.008 + 0.004 * h) * k];
    });
  }
  for (const pl of L.trees) {
    const h = (((pl.s * 5.13 + pl.d * 1.77) % 1) + 1) % 1;
    appendInstance(blob, pl, sp.s0, (y) => (y < 2.4 ? [0.03, 0.024, 0.018] : [0.018 + 0.012 * h, 0.028 + 0.01 * h, 0.014]));
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(_veg.p), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(_veg.n), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(_veg.uv), 2));
  g.setAttribute('color', new BufferAttribute(new Float32Array(_veg.c), 3));
  const n = _veg.p.length / 3;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setIndex(new BufferAttribute(idx, 1));
  return g;
}
