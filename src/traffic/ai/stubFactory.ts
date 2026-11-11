/**
 * Stub traffic vehicle factory (sandbox / tests / fallback until the real vehicleFactory lands).
 * Merged-box bodies with vertex-coloured glass and tyres, HDR emissive head / tail / indicator lamps.
 * 5 draw calls per vehicle (body, tails, heads, indicator L, indicator R). Pooled per type.
 */
import {
  BoxGeometry,
  BufferAttribute,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type BufferGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ILighting, ITrafficVehicleFactory, ITrafficVisual, TrafficType, TrafficVehicleDef } from '../../core/types';
import { STUB_DEFS, TRAFFIC_TYPES, isHeavy } from './defs';

const PAINTS = [0x15171a, 0x8a8d91, 0xd8d8d4, 0x1b2a44, 0x5a0d10, 0x2e3a2c, 0x3a3d42, 0x6b5a3a];

function box(w: number, h: number, l: number, x: number, y: number, z: number, c: number): BufferGeometry {
  const g = new BoxGeometry(w, h, l);
  g.translate(x, y, z);
  return tint(g, c);
}
function tint(g: BufferGeometry, c: number): BufferGeometry {
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3).fill(c);
  g.setAttribute('color', new BufferAttribute(a, 3));
  return g;
}
function wheels(def: TrafficVehicleDef, r: number, axles: number[]): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (const z of axles)
    for (const sx of [-1, 1]) {
      const g = new CylinderGeometry(r, r, 0.28, 14);
      g.rotateZ(Math.PI / 2);
      g.translate(sx * (def.width / 2 - 0.16), r, z);
      out.push(tint(g, 0.05));
    }
  return out;
}

function bodyGeometry(def: TrafficVehicleDef): BufferGeometry {
  const { length: L, width: W, height: H } = def;
  const parts: BufferGeometry[] = [];
  if (def.type === 'semi' || def.type === 'tanker' || def.type === 'boxtruck') {
    const cabL = def.type === 'boxtruck' ? 2.2 : 2.5;
    const cabH = def.type === 'boxtruck' ? 2.7 : 3.2;
    const zCab = -L / 2 + cabL / 2;
    parts.push(box(W, cabH - 0.55, cabL, 0, 0.55 + (cabH - 0.55) / 2, zCab, 1));
    parts.push(box(W * 0.96, 0.9, 0.1, 0, cabH - 0.75, -L / 2 - 0.01, 0.08)); // windscreen
    const cargoL = L - cabL - 0.3;
    const zc = L / 2 - cargoL / 2;
    if (def.type === 'tanker') {
      const g = new CylinderGeometry(1.2, 1.2, cargoL, 20);
      g.rotateX(Math.PI / 2);
      g.translate(0, H - 1.2, zc);
      parts.push(tint(g, 1.4));
      parts.push(box(W * 0.9, 0.35, cargoL, 0, 1.05, zc, 0.15));
    } else {
      parts.push(box(W, H - 1.15, cargoL, 0, 1.15 + (H - 1.15) / 2, zc, 1.25));
      parts.push(box(W * 0.9, 0.3, cargoL, 0, 1.0, zc, 0.15));
    }
    const r = 0.5;
    const ax = def.type === 'boxtruck' ? [-L / 2 + 1.3, L / 2 - 1.6] : [-L / 2 + 1.3, -L / 2 + 4.2, L / 2 - 2.6, L / 2 - 1.3];
    parts.push(...wheels(def, r, ax));
  } else {
    const isVan = def.type === 'van';
    const lowH = isVan ? H * 0.5 : H * 0.52;
    parts.push(box(W, lowH - 0.25, L, 0, 0.25 + (lowH - 0.25) / 2, 0, 1));
    const cabL = isVan ? L * 0.78 : def.type === 'hatch' ? L * 0.58 : L * 0.5;
    const cabZ = isVan ? L * 0.1 : def.type === 'hatch' ? L * 0.1 : L * 0.04;
    const cabH = H - lowH;
    parts.push(box(W * 0.84, cabH, cabL, 0, lowH + cabH / 2, cabZ, 0.12)); // glasshouse
    parts.push(box(W * 0.8, 0.06, cabL * 0.9, 0, H - 0.02, cabZ, 1)); // roof skin
    const r = def.type === 'suv' ? 0.38 : 0.33;
    const wb = L * 0.3;
    parts.push(...wheels(def, r, [-wb, wb]));
  }
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return g;
}

function lampPair(def: TrafficVehicleDef, rear: boolean): BufferGeometry {
  const x = rear ? def.tailX : def.headX;
  const y = rear ? def.tailY : def.headY;
  const z = rear ? def.length / 2 + 0.02 : -def.length / 2 - 0.02;
  const w = rear ? (isHeavy(def.type) ? 0.22 : 0.34) : 0.3;
  const h = rear ? 0.12 : 0.1;
  const g = mergeGeometries([box(w, h, 0.05, -x, y, z, 1), box(w, h, 0.05, x, y, z, 1)], false)!;
  g.deleteAttribute('color');
  return g;
}
function indicatorGeo(def: TrafficVehicleDef, side: -1 | 1): BufferGeometry {
  const x = side * (Math.max(def.tailX, def.headX) + 0.12);
  const g = mergeGeometries(
    [box(0.1, 0.08, 0.05, x, def.tailY, def.length / 2 + 0.03, 1), box(0.1, 0.08, 0.05, x, def.headY + 0.05, -def.length / 2 - 0.03, 1)],
    false,
  )!;
  g.deleteAttribute('color');
  return g;
}

const hdr = (c: number, k: number): MeshBasicMaterial => {
  const m = new MeshBasicMaterial({ color: c, toneMapped: false });
  m.color.multiplyScalar(k);
  return m;
};

interface TypeGeo {
  body: BufferGeometry;
  tail: BufferGeometry;
  head: BufferGeometry;
  indL: BufferGeometry;
  indR: BufferGeometry;
}

class StubVisual implements ITrafficVisual {
  readonly object = new Group();
  private readonly body: Mesh;
  private readonly tail: Mesh;
  private readonly indL: Mesh;
  private readonly indR: Mesh;
  constructor(
    readonly def: TrafficVehicleDef,
    geo: TypeGeo,
    private readonly f: StubFactory,
  ) {
    this.body = new Mesh(geo.body, f.paint[0]);
    this.tail = new Mesh(geo.tail, f.mTail);
    const head = new Mesh(geo.head, f.mHead);
    this.indL = new Mesh(geo.indL, f.mIndOff);
    this.indR = new Mesh(geo.indR, f.mIndOff);
    this.object.add(this.body, this.tail, head, this.indL, this.indR);
    this.object.name = `traffic-${def.type}`;
  }
  private paintIdx = 0;
  setPaint(i: number): void {
    this.paintIdx = i % this.f.paint.length;
    this.body.material = this.f.paint[this.paintIdx];
  }
  setLights(brake: number, indicator: -1 | 0 | 1, time: number, hazard?: boolean): void {
    const f = this.f;
    this.tail.material = brake > 0.5 ? f.mTailBrake : f.mTail;
    const on = (time * 1.5) % 1 < 0.55;
    this.indL.material = on && (hazard || indicator < 0) ? f.mIndOn : f.mIndOff;
    this.indR.material = on && (hazard || indicator > 0) ? f.mIndOn : f.mIndOff;
  }
  reset(): void {
    this.setLights(0, 0, 0);
    this.object.position.set(0, 0, 0);
    this.object.rotation.set(0, 0, 0);
    this.object.visible = true;
  }
  setCharred(amount: number): void {
    this.body.material = amount > 0.5 ? this.f.mCharred : this.f.paint[this.paintIdx];
  }
}

export class StubFactory implements ITrafficVehicleFactory {
  readonly defs = STUB_DEFS;
  readonly paint: Material[];
  readonly mTail = hdr(0xff1408, 6);
  readonly mTailBrake = hdr(0xff1408, 20);
  readonly mHead = hdr(0xfff1dc, 40);
  readonly mIndOff = hdr(0x6b3300, 0.25);
  readonly mIndOn = hdr(0xff8a10, 24);
  readonly mCharred: Material;
  private readonly geo = new Map<TrafficType, TypeGeo>();
  private readonly pool = new Map<TrafficType, StubVisual[]>();

  constructor(lighting?: ILighting) {
    const mk = (c: number, rough: number, metal: number): Material => {
      const m = new MeshStandardMaterial({ color: c, vertexColors: true, roughness: rough, metalness: metal });
      return lighting ? lighting.patchDynamic(m) : m;
    };
    this.paint = PAINTS.map((c) => mk(c, 0.32, 0.55));
    this.mCharred = mk(0x0b0a09, 0.9, 0.2);
    for (const t of TRAFFIC_TYPES) {
      const d = STUB_DEFS[t];
      this.geo.set(t, { body: bodyGeometry(d), tail: lampPair(d, true), head: lampPair(d, false), indL: indicatorGeo(d, -1), indR: indicatorGeo(d, 1) });
      this.pool.set(t, []);
    }
  }
  async load(): Promise<void> {}
  acquire(type: TrafficType, seed: number): ITrafficVisual {
    const p = this.pool.get(type)!;
    const v = p.pop() ?? new StubVisual(STUB_DEFS[type], this.geo.get(type)!, this);
    v.reset();
    v.setPaint(Math.abs(seed | 0));
    return v;
  }
  release(v: ITrafficVisual): void {
    v.object.removeFromParent();
    v.reset();
    this.pool.get(v.def.type)?.push(v as StubVisual);
  }
}

export function createStubFactory(lighting?: ILighting): StubFactory {
  return new StubFactory(lighting);
}
