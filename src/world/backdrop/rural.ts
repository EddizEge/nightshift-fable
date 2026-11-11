/**
 * Rural + tunnel-hill vegetation and high-voltage pylons.
 *   rural:  hedgerow tree lines, forest patches, pylon line with red beacons, a rare farm light.
 *   tunnel: trees on the hill above / beside the tunnel and on the approach cuttings.
 * Trees: two shared instanced geometries (irregular blob canopy, conifer), dark wet foliage.
 */
import { BoxGeometry, ConeGeometry, CylinderGeometry, IcosahedronGeometry, Object3D } from 'three';
import type { BufferGeometry, Material } from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ChunkSpec, IChunkBuilder, Placement } from '../../core/types';
import { hash01, makeRng } from '../../core/math';
import { PointBatch, PointKind, blinkBeacon, blinkCar } from './points';
import { shared, vnoise2, withColorFix, withNightFill } from './shared';
import { outward, terrainCtx, terrainHeight, terrainSlope } from './terrain';
import { boardGeometry, boardMaterial, sideD } from './city';
import { fillRoadside, flushRoadside, newRoadsideLists } from './roadside';
import type { RoadsideLists } from './roadside';
import type { TerrainCtx } from './terrain';

let _blob: BufferGeometry | null = null;
let _conifer: BufferGeometry | null = null;
let _pylon: BufferGeometry | null = null;

export function blobTree(): BufferGeometry {
  if (_blob) return _blob;
  const rng = makeRng(77);
  const canopy = new IcosahedronGeometry(1, 1);
  const p = canopy.getAttribute('position');
  // Lumpy, irregular crown (same displacement for coincident vertices: keyed by rounded position).
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = Math.round(x * 50) * 73856093 ^ Math.round(y * 50) * 19349663 ^ Math.round(z * 50) * 83492791;
    const f = 0.78 + hash01(k) * 0.42;
    p.setXYZ(i, x * f * 3.2, y * f * 3.6 + 6.2, z * f * 3.2);
  }
  void rng;
  canopy.deleteAttribute('uv');
  canopy.deleteAttribute('normal');
  // Welded crown: smooth normals (the lumps read as foliage masses, not faceted rock).
  const crown = mergeVertices(canopy);
  crown.computeVertexNormals();
  const trunk = new CylinderGeometry(0.18, 0.28, 4.2, 5, 1, true);
  trunk.translate(0, 2.1, 0);
  trunk.deleteAttribute('uv');
  // Non-indexed: vegetationGeometry (roadside.ts) appends it vertex by vertex.
  _blob = mergeGeometries([crown, trunk])!.toNonIndexed();
  return _blob;
}

function coniferTree(): BufferGeometry {
  if (_conifer) return _conifer;
  const parts: BufferGeometry[] = [];
  const c1 = new ConeGeometry(2.6, 7, 7, 1, true);
  c1.translate(0, 5.2, 0);
  const c2 = new ConeGeometry(1.9, 6, 7, 1, true);
  c2.translate(0, 8.6, 0);
  c2.rotateY(0.45);
  const c3 = new ConeGeometry(1.1, 4.6, 6, 1, true);
  c3.translate(0, 11.6, 0);
  const trunk = new CylinderGeometry(0.15, 0.25, 2.6, 5, 1, true);
  trunk.translate(0, 1.3, 0);
  for (const g of [c1, c2, c3, trunk]) {
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    // Smooth tiers (welded), normals tilted up like a real fir's drooping branches.
    const w = mergeVertices(g);
    w.computeVertexNormals();
    parts.push(w);
  }
  _conifer = mergeGeometries(parts)!;
  return _conifer;
}

const _o = new Object3D();
export function beam(list: BufferGeometry[], ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number): void {
  const len = Math.hypot(bx - ax, by - ay, bz - az);
  const g = new BoxGeometry(t, t, len);
  _o.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  _o.lookAt(bx, by, bz);
  _o.updateMatrix();
  g.applyMatrix4(_o.matrix);
  g.deleteAttribute('uv');
  list.push(g);
}

/** Lattice transmission tower (~40 m), arms across the line (local X). */
function pylonGeometry(): BufferGeometry {
  if (_pylon) return _pylon;
  const parts: BufferGeometry[] = [];
  const H = 40;
  const half = (y: number) => 4.2 * (1 - y / H) + 0.7 * (y / H);
  const levels = [0, 7, 13.5, 19.5, 25, 30, 34.5, H];
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let li = 0; li < levels.length - 1; li++) {
    const y0 = levels[li];
    const y1 = levels[li + 1];
    const h0 = half(y0);
    const h1 = half(y1);
    for (let c = 0; c < 4; c++) {
      const [cx, cz] = corners[c];
      const [nx, nz] = corners[(c + 1) % 4];
      beam(parts, cx * h0, y0, cz * h0, cx * h1, y1, cz * h1, 0.32);
      // X bracing on each face.
      beam(parts, cx * h0, y0, cz * h0, nx * h1, y1, nz * h1, 0.12);
      beam(parts, nx * h0, y0, nz * h0, cx * h1, y1, cz * h1, 0.12);
      beam(parts, cx * h1, y1, cz * h1, nx * h1, y1, nz * h1, 0.14);
    }
  }
  // Cross arms (two tiers) and earth-wire peak.
  for (const [y, w] of [[25, 11], [31, 8.5]] as Array<[number, number]>) {
    const hh = half(y);
    beam(parts, -w, y, -0.6, w, y, -0.6, 0.3);
    beam(parts, -w, y, 0.6, w, y, 0.6, 0.3);
    beam(parts, -w, y, 0, -hh, y + 2.2, 0, 0.14);
    beam(parts, w, y, 0, hh, y + 2.2, 0, 0.14);
    // Insulator strings.
    for (const x of [-w + 0.5, w - 0.5]) beam(parts, x, y, 0, x, y - 2.4, 0, 0.22);
  }
  beam(parts, 0, H, 0, 0, H + 3, 0, 0.25);
  _pylon = mergeGeometries(parts)!;
  return _pylon;
}

export function foliageMaterial(b: IChunkBuilder): Material {
  return b.materials.cached('bd.foliage', () =>
    withNightFill(withColorFix(b.materials.standard({ name: 'bdFoliage', color: 0x1c2618, roughness: 0.62, wetness: 0.8 }), 'foliage'), 'foliage', 1, true),
  );
}
function pylonMaterial(b: IChunkBuilder): Material {
  return b.materials.cached('bd.pylon', () =>
    withNightFill(withColorFix(b.materials.standard({ name: 'bdPylon', color: 0x505458, roughness: 0.5, metalness: 0.7, wetness: 0.6 }), 'pylon'), 'pylon', 2),
  );
}

const PYLON_LINES = [
  { e: 92, side: 1, pitch: 285, off: 40 },
  { e: 175, side: -1, pitch: 310, off: 150 },
];

export function buildRural(b: IChunkBuilder): void {
  const sp = b.spec;
  const tunnelish = sp.zone === 'tunnel' || sp.nextZone === 'tunnel' || sp.prevZone === 'tunnel';
  if (!(sp.zone === 'rural' || sp.zone === 'tunnel' || (tunnelish && sp.zone !== 'bridge'))) return;
  const c = terrainCtx(sp);
  const r = () => b.rand();
  const blobs: Placement[] = [];
  const firs: Placement[] = [];
  const pts = new PointBatch();
  const L = sp.s1 - sp.s0;
  const portalA = sp.zone === 'tunnel' ? c.ta : sp.nextZone === 'tunnel' ? sp.s1 : null;
  const portalB = sp.zone === 'tunnel' ? c.tb : sp.prevZone === 'tunnel' ? sp.s0 : null;
  const nearPortal = (s: number, d: number) => {
    for (const p of [portalA, portalB]) if (p !== null && Math.abs(s - p) < 16 && d > -55 && d < 38) return true;
    return false;
  };
  const plant = (s: number, d: number, scale: number) => {
    if (s < sp.s0 + 0.5 || s > sp.s1 - 0.5) return;
    if (sp.overpassS !== null && Math.abs(s - sp.overpassS) < 20) return;
    if (nearPortal(s, d)) return;
    const e = outward(d);
    const inCorridor = e === 0;
    if (inCorridor && sp.zone !== 'tunnel') return;
    if (!inCorridor && e < 14) return;
    if (terrainSlope(s, d, c) > 0.9) return;
    const y = terrainHeight(s, d, c) - 0.4;
    if (sp.zone === 'tunnel' && inCorridor && y < 9) return;
    const sx = scale * (0.8 + r() * 0.45);
    const sy = scale * (0.75 + r() * 0.6);
    const p: Placement = { s, d, y, yaw: r() * 6.283, scale: [sx, sy, sx * (0.85 + r() * 0.3)] };
    if (r() < (sp.zone === 'rural' ? 0.32 : 0.55)) firs.push(p);
    else blobs.push(p);
  };

  const rural = sp.zone === 'rural';
  for (const side of [1, -1]) {
    if (rural) {
      // Hedgerow tree lines with gaps; the outer lines (fogged silhouettes) use fewer, larger trees.
      for (const [li, e0] of [26 + r() * 10, 70 + r() * 20, 130 + r() * 40].entries()) {
        const far = li > 0;
        let s = sp.s0 + r() * 8;
        while (s < sp.s1) {
          if (vgap(s, e0, side)) {
            s += 10 + r() * 30;
            continue;
          }
          plant(s, sideD(side, e0 + (r() - 0.5) * 4), (0.75 + r() * 0.6) * (far ? 1.3 : 1));
          s += far ? 6.5 + r() * 9 : 3.5 + r() * 6;
        }
      }
      // Forest patch far out.
      if (r() < 0.7) {
        const sc = sp.s0 + r() * L;
        const ec = 200 + r() * 50;
        for (let i = 0; i < 32; i++) plant(sc + (r() - 0.5) * 120, sideD(side, ec + (r() - 0.5) * 70), 1.1 + r() * 0.8);
      }
    } else {
      // Tunnel hill / cuttings: scattered woodland.
      const n = sp.zone === 'tunnel' ? 120 : 60;
      for (let i = 0; i < n; i++) {
        const e = 16 + Math.pow(r(), 0.8) * 300;
        plant(sp.s0 + r() * L, sideD(side, e), 0.8 + r() * 0.7);
      }
    }
  }
  if (sp.zone === 'tunnel') {
    // Over the tunnel box itself.
    for (let i = 0; i < 40; i++) plant(sp.s0 + r() * L, -29 + r() * 40, 0.8 + r() * 0.6);
  }

  // Pylons (rural only).
  const pylons: Placement[] = [];
  if (rural) {
    for (const line of PYLON_LINES) {
      const k0 = Math.ceil((sp.s0 - line.off) / line.pitch);
      for (let k = k0; ; k++) {
        const s = line.off + k * line.pitch;
        if (s >= sp.s1) break;
        if (s < sp.s0) continue;
        const d = sideD(line.side, line.e);
        const y = terrainHeight(s, d, c) - 0.3;
        pylons.push({ s, d, y, yaw: Math.PI / 2 + (hash01(k * 31 + line.e) - 0.5) * 0.1, scale: 1 });
        if (hash01(k * 7 + line.e) < 0.7) pts.add(s, d, y + 43.4, 12, 0.6, 0.45, 0.28, 1.6, 0.025, blinkBeacon(hash01(k)), 0.4);
      }
    }
  }

  if (blobs.length) b.addInstances(blobTree(), foliageMaterial(b), blobs, { sharedGeometry: true, noProbe: true, name: 'bdTrees' });
  if (firs.length) b.addInstances(coniferTree(), foliageMaterial(b), firs, { sharedGeometry: true, noProbe: true, name: 'bdConifers' });
  if (pylons.length) b.addInstances(pylonGeometry(), pylonMaterial(b), pylons, { sharedGeometry: true, noProbe: true, name: 'bdPylons' });
  if (rural) {
    // Roadside band: field fences, the odd billboard (props get their own box batch).
    const RL = { ...newRoadsideLists(), pts };
    fillRoadside(sp, c, RL, r, 'props');
    const houses: Placement[] = [];
    ruralLandmarks(sp, c, r, RL, houses);
    flushRoadside(b, RL, () => boardMaterial(b), boardGeometry, { props: true, pts: false });
    if (houses.length) b.addInstances(houseGeometry(), farmMaterial(b), houses, { sharedGeometry: true, noProbe: true, noReflect: true, name: 'bdFarms' });
  }
  pts.build(b, 'bdRuralLights');
  if (pts.count) b.onUpdate((t) => shared.uTime.value < t && (shared.uTime.value = t));
}

/** Deterministic gaps in hedgerows (field entrances). */
function vgap(s: number, e: number, side: number): boolean {
  return hash01(Math.floor(s / 37) * 131 + Math.floor(e) * 7 + side * 3) < 0.22;
}

let _house: BufferGeometry | null = null;
/** Unit house: 1 × 1 × 1 box (base at 0) with a gable roof (ridge along local Z, ≈ +0.4 high, small eaves). */
function houseGeometry(): BufferGeometry {
  if (_house) return _house;
  const body = new BoxGeometry(1, 1, 1).toNonIndexed();
  body.translate(0, 0.5, 0);
  body.deleteAttribute('uv');
  // Triangular prism along Z, apex up: a 3-sided cylinder lying along Z, one corner pointing +Y.
  const roof = new CylinderGeometry(1, 1, 1.06, 3, 1, false).toNonIndexed();
  // rotateX(-90°) maps the corner at +Z to +Y: apex up at y = 1, base corners at y = -0.5, x = ±0.866.
  roof.rotateX(-Math.PI / 2);
  roof.scale(0.62, 0.28, 1);
  roof.translate(0, 1.0 + 0.14, 0);
  roof.deleteAttribute('uv');
  _house = mergeGeometries([body, roof])!;
  _house.computeVertexNormals();
  return _house;
}

function farmMaterial(b: IChunkBuilder): Material {
  return b.materials.cached('bd.farm', () =>
    withNightFill(withColorFix(b.materials.standard({ name: 'bdFarm', color: 0x4a4540, roughness: 0.7, wetness: 0.85 }), 'farm'), 'farm'),
  );
}

/**
 * Light anchors of the unlit countryside: farmsteads (house + barn silhouettes, yard lamp with its
 * pool, a few lit windows on the road-facing wall), a distant village glitter, a radio mast with red
 * obstruction lights, a far road with a string of moving car lights, greenhouse glow on the horizon,
 * and faint ground mist pooled in hollows. Points go to the chunk's light batch, houses to one
 * instanced batch, the mast to the lattice batch.
 */
function ruralLandmarks(sp: ChunkSpec, c: TerrainCtx, r: () => number, RL: RoadsideLists, houses: Placement[]): void {
  const pts = RL.pts;
  const L = sp.s1 - sp.s0;
  const ground = (s: number, d: number) => terrainHeight(s, d, c);
  const lowest = (s: number, d: number, hw: number, hl: number) =>
    Math.min(ground(s - hl, d - hw), ground(s + hl, d - hw), ground(s - hl, d + hw), ground(s + hl, d + hw), ground(s, d));
  const warmWin = (k: number): [number, number, number] => {
    const h = r();
    return h < 0.7 ? [k, k * 0.6, k * 0.3] : h < 0.9 ? [k, k * 0.74, k * 0.48] : [k * 0.62, k * 0.75, k];
  };

  // ── farmsteads ──
  const nFarms = Math.floor(r() * 2.6);
  for (let i = 0; i < nFarms; i++) {
    const side = r() < 0.5 ? 1 : -1;
    const s = sp.s0 + 30 + r() * (L - 60);
    const e = 60 + r() * 200;
    const d = sideD(side, e);
    const sodium = r() < 0.6;
    const [lr, lg, lb] = sodium ? [1.0, 0.55, 0.24] : [0.85, 0.9, 1.0];
    // House: road-facing long wall, 2 floors.
    const hw = 7 + r() * 3;
    const hl = 10 + r() * 5;
    const hh = 5.6 + r() * 1.2;
    const hs = s + 9 + r() * 6;
    const hd = d + side * (2 + r() * 6);
    const hy = lowest(hs, hd, hw / 2, hl / 2) - 0.25;
    houses.push({ s: hs, d: hd, y: hy, yaw: (r() - 0.5) * 0.12, scale: [hw, hh, hl] });
    const wallD = hd - side * (hw / 2 + 0.06);
    const nw = 1 + Math.floor(r() * 3.2);
    for (let w = 0; w < nw; w++) {
      const ws = hs + (r() - 0.5) * (hl - 3);
      const up = r() < 0.4;
      const [wr, wg, wb] = warmWin(1.6 + r() * 1.4);
      pts.add(ws, wallD, hy + 0.25 + (up ? 4.0 : 1.5), wr, wg, wb, 0.42, 0, 0, 0, 0.45);
    }
    // Barn / shed behind, darker, sometimes with a dim lamp over its door.
    const bw = 10 + r() * 6;
    const bl = 16 + r() * 10;
    const bh = 6 + r() * 2.5;
    const bs = s - 10 - r() * 8;
    const bd = d + side * (6 + r() * 8);
    const by = lowest(bs, bd, bw / 2, bl / 2) - 0.3;
    houses.push({ s: bs, d: bd, y: by, yaw: (r() - 0.5) * 0.1, scale: [bw, bh, bl] });
    if (r() < 0.55) pts.add(bs, bd - side * (bw / 2 + 0.3), by + 4.4, 4, 2.6, 1.2, 0.18, 1.2, 0.02, 0, 0.5);
    // Yard lamp on a pole between them + its pool on the wet yard.
    const y = ground(s, d);
    const k = 14 + r() * 8;
    RL.props.push({ s, d, y: y - 0.2, scale: [0.14, 6.2, 0.14] });
    pts.add(s, d, y + 6, lr * k, lg * k, lb * k, 0.2, 3, 0.03, 0, 0.5);
    pts.add(s, d, y + 0.35, lr * 0.14, lg * 0.14, lb * 0.14, 0, 16, 0, 0, 1, PointKind.Pool);
  }

  // ── distant village: a cluster of window lights and a few sodium street lamps ──
  if (r() < 0.42) {
    const side = r() < 0.5 ? 1 : -1;
    const sc = sp.s0 + r() * L;
    const ec = 380 + r() * 240;
    const ang = (r() - 0.5) * 1.2;
    const n = 26 + Math.floor(r() * 26);
    for (let i = 0; i < n; i++) {
      // Along a main street (direction ang) with a little scatter.
      const t = (r() - 0.5) * 170;
      const o = (r() - 0.5) * (r() < 0.7 ? 26 : 80);
      const s = sc + Math.cos(ang) * t - Math.sin(ang) * o;
      const d = sideD(side, Math.max(300, ec + Math.sin(ang) * t + Math.cos(ang) * o));
      const [wr, wg, wb] = warmWin(1.4 + r() * 1.6);
      pts.add(s, d, ground(s, d) + 1.5 + (r() < 0.35 ? 2.8 : 0), wr, wg, wb, 0.4, 0, 0, 0, 0.32);
    }
    const nl = 4 + Math.floor(r() * 5);
    for (let i = 0; i < nl; i++) {
      const t = ((i + 0.5) / nl - 0.5) * 170;
      const s = sc + Math.cos(ang) * t;
      const d = sideD(side, Math.max(300, ec + Math.sin(ang) * t));
      pts.add(s, d, ground(s, d) + 6, 9, 5, 2.2, 0.2, 2.5, 0.03, 0, 0.32);
    }
    // A floodlit church tower: a warm vertical pair.
    if (r() < 0.6) {
      const s = sc + (r() - 0.5) * 40;
      const d = sideD(side, ec + 20);
      const y = ground(s, d);
      pts.add(s, d, y + 14, 3.5, 2.6, 1.6, 1.2, 4, 0.05, 0, 0.32);
      pts.add(s, d, y + 22, 2.5, 1.9, 1.2, 0.9, 3, 0.05, 0, 0.32);
    }
  }

  // ── radio mast with obstruction lights (top flashing, lower tiers steady) ──
  if (r() < 0.3) {
    const side = r() < 0.5 ? 1 : -1;
    const s = sp.s0 + 20 + r() * (L - 40);
    const d = sideD(side, 170 + r() * 110);
    const y = ground(s, d) - 0.4;
    const H = 55 + r() * 25;
    RL.lattice.push({ s, d, y, yaw: r() * 6.283, scale: [1.7, H / 9, 1.7] });
    pts.add(s, d, y + H + 0.6, 14, 0.7, 0.5, 0.25, 1.4, 0.025, blinkBeacon(r()), 0.4);
    for (const f of [0.36, 0.68]) pts.add(s, d + 0.6, y + H * f, 4.5, 0.2, 0.12, 0.2, 1.2, 0.02, 0, 0.4);
  }

  // ── far road with moving car lights (continuous across chunks: presence from a slow noise in s) ──
  {
    const e = 330;
    const edge = sp.zoneIndex === 0 ? 0 : sp.zoneIndex === sp.zoneLength - 1 ? 1 : -1;
    for (let s = Math.ceil(sp.s0 / 3) * 3; s < sp.s1; s += 3) {
      const on = vnoise2(s / 900, 0.5, 61);
      if (on < 0.42) continue;
      let k = Math.min(1, (on - 0.42) / 0.08);
      if (edge === 0) k *= Math.min(1, (s - sp.s0) / L);
      if (edge === 1) k *= Math.min(1, (sp.s1 - s) / L);
      const wob = 18 * (vnoise2(s / 260, 0.3, 62) - 0.5);
      const d = sideD(1, e + wob);
      const y = ground(s, d) + 0.8;
      pts.add(s, d, y, 2.4 * k, 2.0 * k, 1.4 * k, 0.16, 0, 0, blinkCar(s, false), 0.3);
      pts.add(s, d + 4, y, 1.7 * k, 0.16 * k, 0.08 * k, 0.14, 0, 0, blinkCar(s + 211, true), 0.3);
    }
  }

  // ── greenhouse glow on the horizon (orange-pink grow lights lighting the low cloud) ──
  if (r() < 0.3) {
    const side = r() < 0.5 ? 1 : -1;
    const s = sp.s0 + r() * L;
    const d = sideD(side, 650 + r() * 250);
    const k = 0.012 + r() * 0.008;
    pts.add(s, d, 6, 1.0 * k, 0.5 * k, 0.36 * k, 48, 0, 0, 0, 0.12);
    pts.add(s + 50, d, 14, 0.7 * k, 0.36 * k, 0.28 * k, 70, 0, 0, 0, 0.12);
  }

  // ── ground mist in hollows (flat soft discs just above the lowest ground, catching the glow) ──
  for (const side of [1, -1]) {
    const cand: Array<[number, number, number]> = [];
    for (let i = 0; i < 24; i++) {
      const s = sp.s0 + 25 + r() * (L - 50);
      const d = sideD(side, 35 + r() * 190);
      cand.push([s, d, ground(s, d)]);
    }
    cand.sort((a, b) => a[2] - b[2]);
    for (const [s, d, y] of cand.slice(0, 3)) {
      // Only real hollows: lower than the ground ~25 m around.
      const rim = Math.min(ground(s + 25, d), ground(s - 25, d), ground(s, d + 25), ground(s, d - 25));
      if (rim - y < 0.6) continue;
      const rad = 16 + r() * 14;
      pts.add(s, d, y + 0.7, 0.007, 0.008, 0.011, 0, rad, 0, 0, 1, PointKind.Pool);
      pts.add(s + 4, d, y + 1.5, 0.005, 0.006, 0.008, 0, rad * 0.75, 0, 0, 1, PointKind.Pool);
    }
  }
}
