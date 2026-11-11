/**
 * NIGHTSHIFT — traffic vehicle sandbox (sandbox/traffic.html), built on the kit (use car=0).
 *
 * Query (plus every kit parameter):
 *   type=<TrafficType>|all   all = the eight types spread over the four lanes (default)
 *   view=rear|front|side|chase|rq|fq|far|farf  camera framing for a single type (all: kit camera / cam=free)
 *   brake=1  ind=-1|1  hazard=1  charred=0..1  seed=<n> paint seed  dist=<m> camera distance
 * window.__traffic.show(type, view) re-frames at runtime (used by tools/traffic/sheet.mjs).
 */
import { Vector3 } from 'three';
import { createKit } from './kit';
import { createTrafficVehicleFactory, TRAFFIC_TYPES } from '../traffic/vehicleFactory';
import type { ITrafficVisual, TrafficType } from '../core/types';
import { LANE_CENTERS } from '../world/roadProfile';

const kit = createKit();
const q = kit.params;
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const factory = createTrafficVehicleFactory({ lighting: kit.lighting, envMap: kit.engine.envMap, quality: kit.ctx.quality.settings });
kit.engine.onEnvMap((tex) => factory.setEnvMap(tex));
await factory.load();

interface Placed {
  v: ITrafficVisual;
  s: number;
  d: number;
}
const placed: Placed[] = [];
const seed = num('pseed', 7);
// "all" layout: [type, s ahead of the player, lane]
const LAYOUT: Array<[TrafficType, number, number]> = [
  ['sedan', 16, 1], ['hatch', 22, 2], ['suv', 28, 3], ['sports', 24, 0],
  ['van', 38, 1], ['boxtruck', 44, 2], ['semi', 56, 3], ['tanker', 54, 0],
];
for (const [t, ds, lane] of LAYOUT) {
  const v = factory.acquire(t, seed + placed.length * 31);
  kit.engine.scene.add(v.object);
  placed.push({ v, s: ds, d: LANE_CENTERS[lane] });
}

let single: TrafficType | null = null;
let view = q.get('view') ?? 'rear';
function show(type: TrafficType | 'all', v?: string): void {
  single = type === 'all' ? null : type;
  if (v) view = v;
  kit.headlights.on = (view !== 'front' && view !== 'fq' && view !== 'farf') || q.get('head') === '1';
  for (const p of placed) {
    p.v.object.visible = !single || p.v.def.type === single;
    if (single && p.v.def.type === single) {
      p.s = 20;
      p.d = LANE_CENTERS[2];
    }
  }
}
show((q.get('type') as TrafficType | 'all') || 'all');

const brake = num('brake', 0);
const ind = num('ind', 0) as -1 | 0 | 1;
const hazard = q.get('hazard') === '1';
const charred = num('charred', 0);
const pos = new Vector3();
const look = new Vector3();
const cars: Array<{ x: number; z: number; heading: number; halfWidth: number; halfLength: number; height: number }> = [];

kit.onFrame((_dt, time) => {
  const ps = kit.player.s;
  cars.length = 0;
  for (const p of placed) {
    const o = p.v.object;
    if (!o.visible) continue;
    const s = ps + p.s;
    kit.ctx.road.toWorld(s, p.d, 0, o.position);
    const h = kit.ctx.road.headingAt(s);
    o.rotation.set(0, -h, 0);
    p.v.setLights(brake, ind, time, hazard);
    p.v.setCharred(charred);
    const def = p.v.def;
    cars.push({ x: o.position.x, z: o.position.z, heading: h, halfWidth: def.width / 2, halfLength: def.length / 2, height: def.height });
  }
  kit.surface.setCars(cars);
  if (single) {
    const p = placed.find((x) => x.v.def.type === single)!;
    const L = p.v.def.length;
    const H = p.v.def.height;
    const dist = num('dist', Math.max(7.5, L * 0.5 + 4));
    const s = ps + p.s;
    const fr: Record<string, [number, number, number, number]> = {
      // [ds, dd, height, look height] relative to the vehicle centre
      rear: [-(L / 2 + dist * 0.82), dist * 0.5, Math.max(1.5, H * 0.75), H * 0.42],
      front: [L / 2 + dist * 0.82, -dist * 0.5, Math.max(1.4, H * 0.7), H * 0.42],
      side: [0, dist * 1.2, Math.max(1.3, H * 0.5), H * 0.42],
      chase: [-(L / 2 + 9), -1.0, 1.4, H * 0.5],
      // close three-quarter views (detail review)
      rq: [-(L / 2 + 3.5), dist * 0.42, Math.max(1.6, H * 0.6), H * 0.4],
      fq: [L / 2 + 3.5, -dist * 0.42, Math.max(1.6, H * 0.6), H * 0.4],
      // straight behind / ahead at `dist` (lamp readability at range, e.g. dist=150)
      far: [-(L / 2 + dist), -1.2, 1.3, H * 0.45],
      farf: [L / 2 + dist, 1.2, 1.3, H * 0.45],
    };
    const f = fr[view] ?? fr.rear;
    kit.ctx.road.toWorld(s + f[0], p.d + f[1], f[2], pos);
    kit.ctx.road.toWorld(s, p.d, f[3], look);
    kit.engine.camera.position.copy(pos);
    kit.engine.camera.lookAt(look);
  }
});

(window as unknown as { __traffic: unknown }).__traffic = { show, factory, placed };
await kit.start();
for (const t of TRAFFIC_TYPES) {
  const d = factory.defs[t];
  console.log(`[ns] def ${t} L=${d.length} W=${d.width} H=${d.height} tail=${d.tailY}/${d.tailX} head=${d.headY}/${d.headX}`);
}
