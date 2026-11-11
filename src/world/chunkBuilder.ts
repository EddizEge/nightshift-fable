import {
  BufferAttribute,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
} from 'three';
import type { BufferGeometry, Material, Object3D } from 'three';
import { LAYERS } from '../core/types';
import type { AddOpts, ChunkSpec, IChunkBuilder, IRoadPath, IWorldMaterials, Placement, QualitySettings, RoadFrame } from '../core/types';
import { makeRng } from '../core/math';
import type { LightField } from './lightField';
import type { WorldMaterials } from './materials';

const _frame: RoadFrame = { s: 0, x: 0, z: 0, h: 0, k: 0, tx: 0, tz: -1, rx: 1, rz: 0 };
const _color = new Color();
const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _up = new Vector3(0, 1, 0);

export class Chunk {
  readonly group = new Group();
  readonly updaters: Array<(time: number, dt: number) => void> = [];
  readonly disposers: Array<() => void> = [];
  /** Feature jobs still to run (time-sliced). */
  jobs: Array<() => void> = [];
  built = false;

  constructor(readonly spec: ChunkSpec) {
    this.group.name = `chunk${spec.index}`;
    this.group.matrixAutoUpdate = false;
  }

  dispose(): void {
    for (const d of this.disposers) {
      try {
        d();
      } catch (e) {
        console.warn('[ns] chunk dispose error', e);
      }
    }
    this.disposers.length = 0;
    this.updaters.length = 0;
    this.jobs.length = 0;
    this.group.removeFromParent();
  }
}

export class ChunkBuilder implements IChunkBuilder {
  readonly spec: ChunkSpec;
  readonly group: Object3D;
  private rng: () => number;

  constructor(
    private chunk: Chunk,
    readonly road: IRoadPath,
    readonly quality: QualitySettings,
    private lighting: LightField,
    private mats: WorldMaterials,
    featureSeed: number,
  ) {
    this.spec = chunk.spec;
    this.group = chunk.group;
    this.rng = makeRng(chunk.spec.seed * 31 + featureSeed);
  }

  get materials(): IWorldMaterials {
    return this.mats;
  }

  rand(): number {
    return this.rng();
  }

  private applyLayers(o: Object3D, opts: AddOpts): void {
    if (opts.noReflect) o.layers.set(LAYERS.MAIN_ONLY);
    else if (opts.noProbe) o.layers.set(LAYERS.NO_PROBE);
  }

  private trackDisposal(geometry: BufferGeometry | null, material: Material | Material[] | null): void {
    this.chunk.disposers.push(() => {
      geometry?.dispose();
      if (material) {
        for (const m of Array.isArray(material) ? material : [material]) {
          if (!this.mats.shared.has(m)) m.dispose();
        }
      }
    });
  }

  addBent(geometry: BufferGeometry, material: Material | Material[], opts: AddOpts = {}): Mesh {
    const pos = geometry.getAttribute('position') as BufferAttribute;
    const nor = geometry.getAttribute('normal') as BufferAttribute | undefined;
    const n = pos.count;
    const bake = opts.bake !== false;
    const baked = bake ? new Float32Array(n * 3) : null;
    const s0 = this.spec.s0;
    const road = this.road;
    for (let i = 0; i < n; i++) {
      const d = pos.getX(i);
      const y = pos.getY(i);
      const s = s0 - pos.getZ(i);
      let nx = 0;
      let ny = 1;
      let nz = 0;
      if (nor) {
        nx = nor.getX(i);
        ny = nor.getY(i);
        nz = nor.getZ(i);
      }
      if (baked) {
        this.lighting.irradianceAt(s, d, y, nx, ny, nz, _color);
        baked[i * 3] = _color.r;
        baked[i * 3 + 1] = _color.g;
        baked[i * 3 + 2] = _color.b;
      }
      const f = road.frameAt(s, _frame);
      pos.setXYZ(i, f.x + f.rx * d, y, f.z + f.rz * d);
      // Straight-space +Z is "backwards" (−tangent).
      if (nor) nor.setXYZ(i, f.rx * nx - f.tx * nz, ny, f.rz * nx - f.tz * nz);
    }
    pos.needsUpdate = true;
    if (nor) nor.needsUpdate = true;
    const tan = geometry.getAttribute('tangent') as BufferAttribute | undefined;
    if (tan) {
      // Tangents only feed normal mapping: rotating them by the chunk's mid heading is plenty.
      const f = road.frameAt((this.spec.s0 + this.spec.s1) * 0.5, _frame);
      for (let i = 0; i < n; i++) {
        const tx = tan.getX(i);
        const tz = tan.getZ(i);
        tan.setXYZW(i, f.rx * tx - f.tx * tz, tan.getY(i), f.rz * tx - f.tz * tz, tan.getW(i));
      }
      tan.needsUpdate = true;
    }
    geometry.setAttribute('bakedLight', new BufferAttribute(baked ?? new Float32Array(n * 3), 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = opts.castShadow ?? false;
    mesh.receiveShadow = false;
    if (opts.name) mesh.name = opts.name;
    this.applyLayers(mesh, opts);
    this.group.add(mesh);
    this.trackDisposal(geometry, material);
    return mesh;
  }

  addInstances(geometry: BufferGeometry, material: Material, placements: Placement[], opts: AddOpts = {}): InstancedMesh {
    const count = placements.length;
    const mesh = new InstancedMesh(geometry, material, Math.max(1, count));
    mesh.count = count;
    const bake = opts.bake !== false;
    for (let i = 0; i < count; i++) {
      const p = placements[i];
      const y = p.y ?? 0;
      const f = this.road.frameAt(p.s, _frame);
      _p.set(f.x + f.rx * p.d, y, f.z + f.rz * p.d);
      _q.setFromAxisAngle(_up, -(f.h + (p.yaw ?? 0)));
      if (Array.isArray(p.scale)) _s.set(p.scale[0], p.scale[1], p.scale[2]);
      else _s.setScalar(p.scale ?? 1);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      // Baked lamp light travels in instanceColor (patchStatic reads it as light, not as a tint):
      // one value per instance — light arriving on an upward surface ~1.2 m above the base.
      if (bake) this.lighting.irradianceAt(p.s, p.d, y + 1.2, 0, 1, 0, _color).multiplyScalar(0.55);
      else _color.setRGB(0, 0, 0);
      mesh.setColorAt(i, _color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = opts.castShadow ?? false;
    if (opts.name) mesh.name = opts.name;
    this.applyLayers(mesh, opts);
    this.group.add(mesh);
    this.chunk.disposers.push(() => {
      if (!opts.sharedGeometry) geometry.dispose();
      mesh.dispose();
      if (!this.mats.shared.has(material)) material.dispose();
    });
    return mesh;
  }

  addObject(object: Object3D): void {
    this.group.add(object);
  }

  onUpdate(fn: (time: number, dt: number) => void): void {
    this.chunk.updaters.push(fn);
  }

  onDispose(fn: () => void): void {
    this.chunk.disposers.push(fn);
  }
}
