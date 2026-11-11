/**
 * Industrial mid-field: corrugated warehouses with lit loading bays, container yards, storage tanks,
 * pipe racks, refinery tower clusters dotted with work lights, chimneys / flare stacks with red
 * beacons and steam plumes, a gas flare on some chunks and floodlight masts with haze.
 * ≈ 8 draw calls per chunk.
 */
import type { IChunkBuilder, Placement } from '../../core/types';
import { facadeMaterial } from './facade';
import { PointBatch, PointKind, blinkBeacon } from './points';
import { PlumeBatch } from './plume';
import { shared, unitBox, unitCylinder, unitPipe } from './shared';
import { boardGeometry, boardMaterial, lotBase, lotOk, sideD } from './city';
import { fillRoadside, flushRoadside, newRoadsideLists } from './roadside';
import { terrainCtx, terrainHeight, terrainSlope } from './terrain';

const WORK_WHITE: [number, number, number] = [1.0, 0.95, 0.86];
const WORK_AMBER: [number, number, number] = [1.0, 0.62, 0.28];

export function buildIndustrial(b: IChunkBuilder): void {
  const sp = b.spec;
  if (sp.zone !== 'industrial') return;
  const c = terrainCtx(sp);
  const r = () => b.rand();
  const sheds: Placement[] = [];
  const boxes: Placement[] = [];
  const conts: Placement[] = [];
  const cyls: Placement[] = [];
  const pipes: Placement[] = [];
  const pts = new PointBatch();
  const plumes = new PlumeBatch();
  const L = sp.s1 - sp.s0;
  const ground = (s: number, d: number) => terrainHeight(s, d, c);
  const work = (s: number, d: number, y: number, k: number, amber = r() < 0.35) => {
    const col = amber ? WORK_AMBER : WORK_WHITE;
    pts.add(s, d, y, col[0] * k, col[1] * k, col[2] * k, 0.12, 1.6, 0.025, 0, 0.55);
  };

  for (const side of [1, -1]) {
    // ── warehouses (two rows) ──────────────────────────────────────────
    for (const [e0, e1] of [[16, 60], [70, 130]]) {
      let s = sp.s0 + 3 + r() * 20;
      while (s < sp.s1) {
        const ls = 40 + r() * 55;
        const ld = 22 + r() * Math.min(26, e1 - e0 - 20);
        const e = e0 + ld * 0.5 + r() * Math.max(0, e1 - e0 - ld);
        const d = sideD(side, e);
        const sc = s + ls * 0.5;
        if (lotOk(b, c, sc, d, ls, ld)) {
          const h = 8 + r() * 6;
          const y = lotBase(c, sc, d, ls, ld);
          sheds.push({ s: sc, d, y, scale: [ld, h + 0.8, ls] });
          // Roof-edge work lights at the corners of the yard side.
          if (r() < 0.6) work(sc - ls * 0.45, d - side * ld * 0.5 - 0.4 * side, y + h + 0.3, 10);
        }
        s += ls + 8 + r() * 26;
      }
    }

    // ── container yard ─────────────────────────────────────────────────
    if (r() < 0.75) {
      const sc = sp.s0 + 30 + r() * (L - 60);
      const e = 140 + r() * 40;
      const rows = 3 + Math.floor(r() * 4);
      const cols = 2 + Math.floor(r() * 3);
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
          const s = sc + (j - cols / 2) * 13.2;
          const d = sideD(side, e + i * 2.9 + Math.floor(i / 2) * 3);
          if (!lotOk(b, c, s, d, 13, 3, 0.2)) continue;
          const stack = 1 + Math.floor(r() * 4);
          const y = ground(s, d) - 0.15;
          for (let k = 0; k < stack; k++) conts.push({ s, d, y: y + k * 2.6, yaw: (r() - 0.5) * 0.02, scale: [2.44, 2.59, 12.2] });
        }
      }
    }

    // ── storage tanks ──────────────────────────────────────────────────
    const nt = 2 + Math.floor(r() * 4);
    const tc = sp.s0 + 40 + r() * (L - 80);
    const te = 190 + r() * 60;
    for (let i = 0; i < nt; i++) {
      const rad = 7 + r() * 11;
      const s = tc + (i - nt / 2) * 2.4 * 13 + (r() - 0.5) * 6;
      const d = sideD(side, te + (r() - 0.5) * 40);
      if (!lotOk(b, c, s, d, rad * 2, rad * 2, 0.15)) continue;
      const h = 9 + r() * 12;
      const y = ground(s, d) - 0.4;
      cyls.push({ s, d, y, scale: [rad, h, rad] });
      // Rim lights.
      const nl = 2 + Math.floor(r() * 3);
      for (let k = 0; k < nl; k++) {
        const a = (k / nl) * Math.PI * 2 + r();
        work(s + Math.cos(a) * rad, d + Math.sin(a) * rad, y + h + 0.5, 9, false);
      }
    }
  }

  // ── pipe rack along the road (one side) ──────────────────────────────
  {
    const side = r() < 0.5 ? 1 : -1;
    const e = 9.5 + r() * 3;
    const d = sideD(side, e);
    const sa = sp.s0 + 10 + r() * 40;
    const sb = Math.min(sp.s1 - 10, sa + 90 + r() * 90);
    const hy = 5.5 + r() * 1.5;
    const okRack = (s: number) => sp.overpassS === null || Math.abs(s - sp.overpassS) > 26;
    for (let s = sa; s <= sb; s += 8) {
      if (!okRack(s)) continue;
      const y0 = ground(s, d);
      boxes.push({ s, d: d - 1.6, y: y0 - 0.3, scale: [0.35, hy + 0.3 - y0, 0.35] });
      boxes.push({ s, d: d + 1.6, y: y0 - 0.3, scale: [0.35, hy + 0.3 - y0, 0.35] });
      boxes.push({ s, d, y: hy - 0.2, scale: [3.6, 0.3, 0.3] });
    }
    const np = 3 + Math.floor(r() * 3);
    for (let s = sa; s < sb; s += 40) {
      const len = Math.min(40, sb - s);
      if (len < 4 || !okRack(s + len * 0.5)) continue;
      for (let k = 0; k < np; k++) {
        const pr = 0.18 + r() * 0.32;
        pipes.push({ s: s + len * 0.5, d: d - 1.3 + (k / Math.max(1, np - 1)) * 2.6, y: hy + 0.1 + pr, scale: [pr, pr, len] });
      }
    }
  }

  // ── refinery tower cluster with "city of lights" ─────────────────────
  const nClusters = 1 + (r() < 0.5 ? 1 : 0);
  for (let ci = 0; ci < nClusters; ci++) {
    const side = ci === 0 ? (r() < 0.5 ? 1 : -1) : -1;
    const sc = sp.s0 + 50 + r() * (L - 100);
    const ec = 95 + r() * 70;
    const dc = sideD(side, ec);
    if (terrainSlope(sc, dc, c) > 0.2) continue;
    const yb = ground(sc, dc) - 0.5;
    // Distillation columns.
    const ncol = 3 + Math.floor(r() * 4);
    for (let i = 0; i < ncol; i++) {
      const s = sc + (r() - 0.5) * 50;
      const d = dc + (r() - 0.5) * 40;
      const rad = 1.6 + r() * 2.2;
      const h = 24 + r() * 34;
      cyls.push({ s, d, y: yb, scale: [rad, h, rad] });
      for (let y = 6; y < h; y += 6 + r() * 4) {
        const a = r() * Math.PI * 2;
        work(s + Math.cos(a) * (rad + 0.6), d + Math.sin(a) * (rad + 0.6), yb + y, 11);
      }
      pts.add(s, d, yb + h + 1, 12, 0.6, 0.45, 0.22, 4, 0.03, blinkBeacon(r()), 0.45);
    }
    // Lattice frames with platforms every ~6 m, lights along the platform edges.
    const nfr = 2 + Math.floor(r() * 3);
    for (let i = 0; i < nfr; i++) {
      const s = sc + (r() - 0.5) * 60;
      const d = dc + (r() - 0.5) * 50;
      const w = 8 + r() * 8;
      const dep = 8 + r() * 6;
      const h = 18 + r() * 26;
      for (const [os, od] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) boxes.push({ s: s + os * w, d: d + od * dep, y: yb, scale: [0.5, h, 0.5] });
      for (let y = 6; y <= h; y += 6) {
        boxes.push({ s, d, y: yb + y, scale: [dep, 0.35, w] });
        const per = Math.floor(w / 3.2);
        for (let k = 0; k <= per; k++) {
          if (r() < 0.25) continue;
          const t = (k / per - 0.5) * w;
          work(s + t, d - dep * 0.5 - 0.3, yb + y + 1.1, 7 + r() * 6);
          if (r() < 0.6) work(s + t, d + dep * 0.5 + 0.3, yb + y + 1.1, 7 + r() * 6);
        }
      }
      pts.add(s, d, yb + h + 1.2, 12, 0.6, 0.45, 0.22, 4, 0.03, blinkBeacon(r()), 0.45);
    }
  }

  // ── chimneys / stacks with beacons and steam ─────────────────────────
  const nStacks = 2 + Math.floor(r() * 2);
  for (let i = 0; i < nStacks; i++) {
    const side = r() < 0.5 ? 1 : -1;
    const s = sp.s0 + 20 + r() * (L - 40);
    const e = 170 + r() * 130;
    const d = sideD(side, e);
    const rad = 2.2 + r() * 1.8;
    const h = 60 + r() * 40;
    const y = ground(s, d) - 0.5;
    cyls.push({ s, d, y, scale: [rad, h, rad] });
    const ph = r();
    pts.add(s, d, y + h + 0.8, 12, 0.6, 0.45, 0.32, 6, 0.035, blinkBeacon(ph), 0.4);
    pts.add(s, d - rad - 0.2, y + h * 0.62, 12, 0.6, 0.45, 0.25, 4, 0.03, blinkBeacon(ph + 0.5), 0.4);
    if (r() < 0.8) {
      const pw = rad * 1.4;
      plumes.steam(s, d, y + h + 0.5, pw, 55 + r() * 45, r(), 0.06, 0.012, 0.008);
      plumes.steam(s, d, y + h + 0.5, pw * 1.3, 45 + r() * 35, r() + 0.5, 0.05, 0.01, 0.006);
    }
  }

  // ── gas flare (some chunks) ──────────────────────────────────────────
  if (r() < 0.55) {
    const side = r() < 0.5 ? 1 : -1;
    const s = sp.s0 + 40 + r() * (L - 80);
    const d = sideD(side, 150 + r() * 100);
    const h = 40 + r() * 16;
    const y = ground(s, d) - 0.5;
    cyls.push({ s, d, y, scale: [0.9, h, 0.9] });
    plumes.flame(s, d, y + h, 3.4, 13 + r() * 5, r(), 20);
    plumes.steam(s, d, y + h + 9, 5, 60, r(), 0.5, 0.17, 0.05);
    pts.add(s, d, y + h + 4.5, 20 * 1.0, 20 * 0.48, 20 * 0.16, 1.2, 22, 0.012, 0, 0.45);
    pts.add(s, d, y + 0.6, 0.6, 0.24, 0.07, 0, 45, 0, 0, 0.8, PointKind.Pool);
  }

  // ── floodlight masts over the yards ──────────────────────────────────
  const nMasts = 2 + Math.floor(r() * 3);
  for (let i = 0; i < nMasts; i++) {
    const side = r() < 0.5 ? 1 : -1;
    const s = sp.s0 + 15 + r() * (L - 30);
    const d = sideD(side, 35 + r() * 110);
    if (sp.overpassS !== null && Math.abs(s - sp.overpassS) < 25) continue;
    const y = ground(s, d);
    const h = 22 + r() * 8;
    boxes.push({ s, d, y: y - 0.5, scale: [0.6, h + 0.5, 0.6] });
    boxes.push({ s, d, y: y + h, scale: [0.6, 1.1, 4.2] });
    // Four small, intense heads (metal-halide white, one a little warmer) with a tight glare only;
    // the light shows as a cone through the rain and a pool on the wet yard where it is aimed.
    const k = 55;
    for (let j = 0; j < 4; j++) {
      const w = j === 2 ? [1.0, 0.9, 0.75] : [0.92, 0.96, 1.0];
      pts.add(s + (j - 1.5) * 1.0, d - side * 0.5, y + h + 0.4, k * w[0], k * w[1], k * w[2], 0.13, 0.9, 0.02, 0, 0.55);
    }
    const aim = 9 + r() * 6;
    const ty = ground(s, d - side * aim);
    pts.beam(s, d - side * 0.6, y + h + 0.2, s, d - side * aim, ty + 0.2, 0.05, 0.053, 0.056, 0.9, 9 + r() * 3, 0.7);
    pts.add(s, d - side * aim, ty + 0.4, 0.3, 0.31, 0.32, 0, 22, 0, 0, 0.9, PointKind.Pool);
    pts.add(s, d - side * aim * 0.6, ty + 0.35, 0.12, 0.125, 0.13, 0, 38, 0, 0, 0.9, PointKind.Pool);
  }

  if (sheds.length) {
    const mat = facadeMaterial(b, { key: 'bd.warehouse', mode: 'warehouse', albedo: 'metal_corrugated_albedo.webp', normal: 'metal_corrugated_normal.webp', rough: 'metal_corrugated_rough.webp', tile: 3, roughness: 0.6, metalness: 0.4, wetness: 0.8 });
    b.addInstances(unitBox(), mat, sheds, { sharedGeometry: true, noProbe: true, name: 'bdWarehouses' });
  }
  if (conts.length) {
    const mat = facadeMaterial(b, { key: 'bd.container', mode: 'container', normal: 'metal_corrugated_normal.webp', tile: 1.4, roughness: 0.55, metalness: 0.3, wetness: 0.9 });
    b.addInstances(unitBox(), mat, conts, { sharedGeometry: true, noProbe: true, name: 'bdContainers' });
  }
  if (cyls.length) {
    const mat = facadeMaterial(b, { key: 'bd.tank', mode: 'tank', albedo: 'metal_galv_albedo.webp', normal: 'metal_galv_normal.webp', tile: 4, roughness: 0.45, metalness: 0.6, wetness: 0.8, cylinder: true });
    b.addInstances(unitCylinder(), mat, cyls, { sharedGeometry: true, noProbe: true, name: 'bdTanks' });
  }
  const equip = facadeMaterial(b, { key: 'bd.equip', mode: 'plain', albedo: 'metal_galv_albedo.webp', tile: 3, color: 0x6a6c70, roughness: 0.55, metalness: 0.5, wetness: 0.8 });
  // Roadside band (fences, cabinets, frontage lamps, parked cars, billboards) shares the frame / light batches.
  const RL = { ...newRoadsideLists(), props: boxes, pts };
  fillRoadside(sp, c, RL, r, 'props');
  flushRoadside(b, RL, () => boardMaterial(b), boardGeometry, { props: false, pts: false });
  if (boxes.length) b.addInstances(unitBox(), equip, boxes, { sharedGeometry: true, noProbe: true, name: 'bdFrames' });
  if (pipes.length) b.addInstances(unitPipe(), equip, pipes, { sharedGeometry: true, noProbe: true, name: 'bdPipes' });
  pts.build(b, 'bdIndustryLights');
  plumes.build(b);
  b.onUpdate((t) => shared.uTime.value < t && (shared.uTime.value = t));
}
