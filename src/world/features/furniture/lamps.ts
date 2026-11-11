/**
 * Street lamps for every lit slot: tapered steel poles, curved arms, cobra-head luminaires with a
 * glowing drop lens, a soft glow halo per luminaire and (quality.volumetrics) a faint haze cone
 * under our side's luminaires. Light itself is simulated by the lighting system.
 */
import { CylinderGeometry, PlaneGeometry, Sphere, SphereGeometry, Vector3 } from 'three';
import type { BufferGeometry, InstancedMesh } from 'three';
import type { IChunkBuilder, LampSlot, Placement } from '../../../core/types';
import {
  LAMP_MEDIAN_D,
  LAMP_MEDIAN_OPP_D,
  LAMP_OPP_OUTER_D,
  LAMP_OPP_OUTER_POLE_D,
  LAMP_RIGHT_D,
  LAMP_RIGHT_POLE_D,
  MEDIAN_D,
  MEDIAN_HEIGHT,
} from '../../roadProfile';
import { Geo } from './geo';
import type { RGB } from './geo';
import { coneMaterial, furnTime, haloMaterial, lampMaterial } from './materials';

const POLE: RGB = [0.86, 0.86, 0.84];
const HOUSING: RGB = [0.2, 0.2, 0.21];
const HOUSING_DARK: RGB = [0.06, 0.06, 0.065];

const HEAD_HALF = 0.42; // half length of the luminaire along its arm
const CONE_H = 9.0;

const HOUSING_TOP = new SphereGeometry(1, 12, 3, 0, Math.PI * 2, 0, Math.PI / 2);
const HOUSING_BOTTOM = new SphereGeometry(1, 12, 1, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
const LENS = new SphereGeometry(1, 12, 2, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
/** Tapered unit-height poles (radius ratio top/bottom ≈ 0.57), origin at the base. */
const POLE_GEO = new CylinderGeometry(0.57, 1, 1, 8, 4, true).translate(0, 0.5, 0);
const CAP = new SphereGeometry(1, 8, 1, 0, Math.PI * 2, 0, Math.PI / 2);
const FLANGE = new CylinderGeometry(1, 1, 1, 8, 1, false);

let haloGeo: BufferGeometry | null = null;
let coneGeo: BufferGeometry | null = null;

function haloGeometry(): BufferGeometry {
  if (!haloGeo) {
    haloGeo = new PlaneGeometry(1, 1);
    haloGeo.deleteAttribute('normal');
    haloGeo.deleteAttribute('uv');
    // The quad is expanded to ~7 m in the vertex shader: keep culling honest.
    haloGeo.boundingSphere = new Sphere(new Vector3(), 4.5);
  }
  return haloGeo;
}

function coneGeometry(): BufferGeometry {
  if (!coneGeo) {
    coneGeo = new CylinderGeometry(0.32, 4.2, CONE_H, 20, 6, true);
    coneGeo.translate(0, -CONE_H * 0.5, 0);
    coneGeo.computeBoundingSphere();
  }
  return coneGeo;
}

/** Cubic Bézier in the (d, y) plane at fixed z. */
function bezier(p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number], z: number, n: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1], z]);
  }
  return out;
}

/** Arm from the pole top to the luminaire + the luminaire head (housing in `met`, lens in `lens`). */
function armAndHead(met: Geo, lens: Geo, poleD: number, lumD: number, h: number, z: number, armY: number): void {
  const dir = Math.sign(lumD - poleD);
  const endD = lumD - dir * (HEAD_HALF - 0.04);
  const reach = endD - poleD;
  const pts = bezier([poleD, armY - 0.25], [poleD, armY + 0.55], [poleD + reach * 0.35, h + 0.12], [endD, h + 0.07], z, 7);
  const radii = pts.map((_, i) => 0.058 - 0.018 * (i / (pts.length - 1)));
  met.color(POLE);
  met.tube(pts, radii, 6, 1.2);
  // Housing: flattened upper shell + shallow belly; long axis along the arm.
  const yaw = 0;
  met.color(HOUSING);
  met.primAt(HOUSING_TOP, lumD, h + 0.02, z, HEAD_HALF, 0.11, 0.19, yaw);
  met.color(HOUSING_DARK);
  met.primAt(HOUSING_BOTTOM, lumD, h + 0.02, z, HEAD_HALF, 0.022, 0.19, yaw);
  // Drop lens (glowing bowl) under the housing.
  lens.primAt(LENS, lumD + dir * 0.03, h + 0.012, z, HEAD_HALF * 0.8, 0.06, 0.145, yaw);
}

function pole(met: Geo, d: number, y0: number, y1: number, z: number, r0: number): void {
  met.primAt(POLE_GEO, d, y0, z, r0, y1 - y0, r0, 0, 1.2);
}

/** Lamp assemblies are rigid: shared geometry in pole-local space (origin = pole base), instanced. */
let medianGeo: BufferGeometry | null = null;
let rightGeo: BufferGeometry | null = null;

function withEmit(met: Geo, lensCount: number, lens: Geo): BufferGeometry {
  // Merge the lens (emissive, aEmit = 1) into the housing geometry (aEmit = 0).
  const nMet = met.count;
  void lensCount;
  const base = met.count;
  for (let i = 0; i < lens.count; i++) {
    met.pos.push(lens.pos[i * 3], lens.pos[i * 3 + 1], lens.pos[i * 3 + 2]);
    met.nor.push(lens.nor[i * 3], lens.nor[i * 3 + 1], lens.nor[i * 3 + 2]);
    met.uv.push(lens.uv[i * 2], lens.uv[i * 2 + 1]);
    met.col.push(0.03, 0.03, 0.03);
  }
  for (const i of lens.idx) met.idx.push(base + i);
  const emit = new Float32Array(met.count);
  emit.fill(1, nMet);
  return met.build({ aEmit: { data: emit, size: 1 } })!;
}

function medianAssembly(h: number): BufferGeometry {
  if (medianGeo) return medianGeo;
  const met = new Geo();
  const lens = new Geo();
  const armY = h - 1.0;
  met.color(POLE);
  pole(met, 0, MEDIAN_HEIGHT - 0.05, armY + 0.25, 0, 0.13);
  met.primAt(FLANGE, 0, MEDIAN_HEIGHT + 0.01, 0, 0.2, 0.03, 0.2);
  met.primAt(CAP, 0, armY + 0.25, 0, 0.075, 0.06, 0.075);
  armAndHead(met, lens, 0, LAMP_MEDIAN_D - MEDIAN_D, h, 0, armY);
  armAndHead(met, lens, 0, LAMP_MEDIAN_OPP_D - MEDIAN_D, h, 0, armY);
  medianGeo = withEmit(met, 2, lens);
  medianGeo.computeBoundingSphere();
  return medianGeo;
}

function rightAssembly(h: number): BufferGeometry {
  if (rightGeo) return rightGeo;
  const met = new Geo();
  const lens = new Geo();
  const armY = h - 1.0;
  met.color(POLE);
  pole(met, 0, 0, armY + 0.25, 0, 0.13);
  met.primAt(FLANGE, 0, 0.03, 0, 0.24, 0.06, 0.24);
  met.primAt(FLANGE, 0, -0.1, 0, 0.36, 0.26, 0.36); // footing
  met.primAt(CAP, 0, armY + 0.25, 0, 0.072, 0.06, 0.072);
  armAndHead(met, lens, 0, LAMP_RIGHT_D - LAMP_RIGHT_POLE_D, h, 0, armY);
  rightGeo = withEmit(met, 1, lens);
  rightGeo.computeBoundingSphere();
  return rightGeo;
}

/** Per-instance baked light is sampled near the pole foot; poles are thin and mostly lit at grazing angles. */
const POLE_LIGHT_SCALE = 0.3;

function scaleInstanceLight(m: InstancedMesh, k: number): void {
  const c = m.instanceColor;
  if (!c) return;
  const a = c.array as Float32Array;
  for (let i = 0; i < a.length; i++) a[i] *= k;
  c.needsUpdate = true;
}

export function buildLamps(b: IChunkBuilder): void {
  const spec = b.spec;
  const lamps = spec.lamps.filter((l: LampSlot) => l.on);
  if (!lamps.length) return;
  const med: Placement[] = [];
  const right: Placement[] = [];
  const halos: Placement[] = [];
  const cones: Placement[] = [];
  const vol = b.quality.volumetrics;
  const h = lamps[0].h;
  for (const l of lamps) {
    if (l.side === 'median') {
      med.push({ s: l.s, d: MEDIAN_D });
      halos.push({ s: l.s, d: LAMP_MEDIAN_D, y: l.h - 0.06 }, { s: l.s, d: LAMP_MEDIAN_OPP_D, y: l.h - 0.06 });
      if (vol) cones.push({ s: l.s, d: LAMP_MEDIAN_D, y: l.h - 0.04 });
    } else {
      right.push({ s: l.s, d: LAMP_RIGHT_POLE_D }, { s: l.s, d: LAMP_OPP_OUTER_POLE_D, yaw: Math.PI });
      halos.push({ s: l.s, d: LAMP_RIGHT_D, y: l.h - 0.06 }, { s: l.s, d: LAMP_OPP_OUTER_D, y: l.h - 0.06 });
      if (vol) cones.push({ s: l.s, d: LAMP_RIGHT_D, y: l.h - 0.04 });
    }
  }
  const mat = lampMaterial(b);
  if (med.length) scaleInstanceLight(b.addInstances(medianAssembly(h), mat, med, { sharedGeometry: true, name: 'furn-lamps-median' }), POLE_LIGHT_SCALE);
  if (right.length) scaleInstanceLight(b.addInstances(rightAssembly(h), mat, right, { sharedGeometry: true, name: 'furn-lamps-right' }), POLE_LIGHT_SCALE);
  b.addInstances(haloGeometry(), haloMaterial(b), halos, { sharedGeometry: true, bake: false, noProbe: true, name: 'furn-halo' });
  if (cones.length) {
    b.addInstances(coneGeometry(), coneMaterial(b, CONE_H), cones, { sharedGeometry: true, bake: false, noProbe: true, name: 'furn-cone' });
    b.onUpdate((t) => {
      furnTime.value = t;
    });
  }
}
