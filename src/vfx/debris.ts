/**
 * Debris: instanced low-poly irregular shards / bent panels / chunks (one draw call), dark charred
 * metal lit by the nearest lamps + explosion flashes (lighting.patchDynamic). Ballistic with air
 * drag, tumbling, ground bounce with energy loss, sliding friction on y = 0, then settles flat.
 */
import {
  BufferGeometry,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Sphere,
  Vector3,
  DynamicDrawUsage,
  Color,
} from 'three';
import { LAYERS } from '../core/types';
import type { ILighting } from '../core/types';
import { makeRng } from '../core/math';

export interface DebrisHooks {
  /** Called while a piece trails smoke/fire (position, its age, its scale). */
  trail(x: number, y: number, z: number, vx: number, vy: number, vz: number, age: number, size: number, burning: boolean): void;
}

const F = Float32Array;
const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();

/** Irregular convex-ish shard: a jittered octahedron-like hull, flat shaded. */
function shardGeometry(seed: number): BufferGeometry {
  const rnd = makeRng(seed);
  // 8 jittered vertices on a squashed sphere, connected as an irregular bipyramid around a ring of 6.
  const ring = 6;
  const v: number[][] = [];
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2 + (rnd() - 0.5) * 0.6;
    const r = 0.38 + rnd() * 0.22;
    v.push([Math.cos(a) * r, (rnd() - 0.5) * 0.25, Math.sin(a) * r]);
  }
  const top = [(rnd() - 0.5) * 0.2, 0.32 + rnd() * 0.2, (rnd() - 0.5) * 0.2];
  const bot = [(rnd() - 0.5) * 0.2, -0.3 - rnd() * 0.2, (rnd() - 0.5) * 0.2];
  const pos: number[] = [];
  for (let i = 0; i < ring; i++) {
    const a = v[i];
    const b = v[(i + 1) % ring];
    pos.push(...top, ...b, ...a);
    pos.push(...bot, ...a, ...b);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Bent panel: two quads with a crease (sheet metal), thin box-ish (double-sided via thickness). */
function panelGeometry(seed: number): BufferGeometry {
  const rnd = makeRng(seed);
  const t = 0.05;
  const bend = 0.25 + rnd() * 0.35;
  const w = 0.5;
  const pts = (y: number): number[][] => [
    [-w, y, -0.5 + (rnd() - 0.5) * 0.15],
    [0, y + bend * 0.3, -0.5],
    [w * (0.8 + rnd() * 0.3), y + bend * (0.2 + rnd() * 0.2), -0.42],
    [-w * (0.9 + rnd() * 0.2), y, 0.5],
    [0, y + bend * 0.3, 0.5 + (rnd() - 0.5) * 0.2],
    [w, y + bend * 0.25, 0.38],
  ];
  const a = pts(t);
  const b = a.map((p) => [p[0], p[1] - 2 * t, p[2]]);
  const pos: number[] = [];
  const quad = (p0: number[], p1: number[], p2: number[], p3: number[]) => pos.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
  // top (0 1 4 3) (1 2 5 4), bottom reversed
  quad(a[0], a[3], a[4], a[1]);
  quad(a[1], a[4], a[5], a[2]);
  quad(b[0], b[1], b[4], b[3]);
  quad(b[1], b[2], b[5], b[4]);
  // rim
  const rim = [0, 1, 2, 5, 4, 3];
  for (let i = 0; i < rim.length; i++) {
    const i0 = rim[i];
    const i1 = rim[(i + 1) % rim.length];
    quad(a[i0], a[i1], b[i1], b[i0]);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Two instanced meshes (chunky shards, bent sheet-metal panels): ≤ 2 draw calls while debris exists. */
export class DebrisSystem {
  readonly meshes: InstancedMesh[];
  readonly capacity: number;
  count = 0;
  peak = 0;
  hooks: DebrisHooks | null = null;
  private material: MeshStandardMaterial;
  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private qx: Float32Array;
  private qy: Float32Array;
  private qz: Float32Array;
  private qw: Float32Array;
  private wx: Float32Array;
  private wy: Float32Array;
  private wz: Float32Array;
  private sx: Float32Array;
  private sy: Float32Array;
  private sz: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private trail: Float32Array;
  private trailAcc: Float32Array;
  private burn: Uint8Array;
  private type: Uint8Array;
  private tint: Float32Array;
  private rest: Uint8Array;
  private rnd = makeRng(0x5eed);
  private counts = new Int32Array(2);
  private floats: Float32Array[];

  constructor(capacity: number, lighting: ILighting) {
    this.capacity = capacity;
    const n = capacity;
    this.px = new F(n);
    this.py = new F(n);
    this.pz = new F(n);
    this.vx = new F(n);
    this.vy = new F(n);
    this.vz = new F(n);
    this.qx = new F(n);
    this.qy = new F(n);
    this.qz = new F(n);
    this.qw = new F(n);
    this.wx = new F(n);
    this.wy = new F(n);
    this.wz = new F(n);
    this.sx = new F(n);
    this.sy = new F(n);
    this.sz = new F(n);
    this.age = new F(n);
    this.life = new F(n);
    this.trail = new F(n);
    this.trailAcc = new F(n);
    this.burn = new Uint8Array(n);
    this.type = new Uint8Array(n);
    this.tint = new F(n);
    this.rest = new Uint8Array(n);
    this.floats = [this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.qx, this.qy, this.qz, this.qw, this.wx, this.wy, this.wz, this.sx, this.sy, this.sz, this.age, this.life, this.trail, this.trailAcc, this.tint];

    this.material = lighting.patchDynamic(
      new MeshStandardMaterial({ name: 'vfx_debris', color: 0xffffff, roughness: 0.78, metalness: 0.25, flatShading: true, envMapIntensity: 0.4 }),
    );
    const shard = shardGeometry(11);
    const panel = panelGeometry(23);
    this.meshes = [shard, panel].map((g, k) => {
      const m = new InstancedMesh(g, this.material, n);
      m.name = k === 0 ? 'vfx_debris_shards' : 'vfx_debris_panels';
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.layers.set(LAYERS.NO_PROBE);
      m.visible = false;
      m.setColorAt(0, _c.setRGB(0.05, 0.05, 0.05));
      (m.instanceColor as { setUsage(u: number): unknown }).setUsage(DynamicDrawUsage);
      g.boundingSphere = new Sphere(new Vector3(), 1e4);
      return m;
    });
  }

  /**
   * Spawn one piece. size ≈ longest dimension (m). type 0 = chunk/shard, 1 = bent panel.
   */
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, type: number, trail: number, burning: boolean, life = 22): void {
    let i = this.count;
    if (i >= this.capacity) {
      // overwrite the oldest
      let oldest = 0;
      for (let k = 1; k < this.count; k++) if (this.age[k] > this.age[oldest]) oldest = k;
      i = oldest;
    } else this.count++;
    const r = this.rnd;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    // random orientation
    _q.set(r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    this.qx[i] = _q.x;
    this.qy[i] = _q.y;
    this.qz[i] = _q.z;
    this.qw[i] = _q.w;
    const spin = (6 + r() * 14) / Math.max(0.35, size);
    this.wx[i] = (r() - 0.5) * spin;
    this.wy[i] = (r() - 0.5) * spin;
    this.wz[i] = (r() - 0.5) * spin;
    if (type === 1) {
      this.sx[i] = size * (0.7 + r() * 0.5);
      this.sy[i] = size * (0.6 + r() * 0.6);
      this.sz[i] = size * (0.8 + r() * 0.5);
    } else {
      this.sx[i] = size * (0.6 + r() * 0.6);
      this.sy[i] = size * (0.4 + r() * 0.5);
      this.sz[i] = size * (0.7 + r() * 0.6);
    }
    this.age[i] = 0;
    this.life[i] = life;
    this.trail[i] = trail;
    this.trailAcc[i] = 0;
    this.burn[i] = burning ? 1 : 0;
    this.type[i] = type;
    this.tint[i] = 0.018 + r() * 0.03;
    this.rest[i] = 0;
  }

  clear(): void {
    this.count = 0;
    for (const m of this.meshes) {
      m.count = 0;
      m.visible = false;
    }
  }

  update(dt: number): void {
    let n = this.count;
    if (n === 0) {
      for (const m of this.meshes) m.visible = false;
      return;
    }
    const hooks = this.hooks;
    for (let i = 0; i < n; i++) {
      const a = this.age[i] + dt;
      if (a >= this.life[i]) {
        n--;
        if (i < n) {
          this.copy(n, i);
          i--;
        }
        continue;
      }
      this.age[i] = a;
      const half = 0.5 * Math.min(this.sx[i], this.sy[i], this.sz[i]) * 0.35 + 0.02;
      if (!this.rest[i]) {
        const drag = Math.exp(-0.25 * dt);
        this.vx[i] *= drag;
        this.vz[i] *= drag;
        this.vy[i] = this.vy[i] * drag - 9.81 * dt;
        this.px[i] += this.vx[i] * dt;
        this.py[i] += this.vy[i] * dt;
        this.pz[i] += this.vz[i] * dt;
        if (this.py[i] < half) {
          this.py[i] = half;
          if (this.vy[i] < -1.2) {
            // bounce: lose energy, convert some into spin
            this.vy[i] = -this.vy[i] * 0.32;
            this.vx[i] *= 0.62;
            this.vz[i] *= 0.62;
            this.wx[i] = this.wx[i] * 0.5 + this.vz[i] * 0.8;
            this.wz[i] = this.wz[i] * 0.5 - this.vx[i] * 0.8;
          } else {
            // sliding on the road
            this.vy[i] = 0;
            const f = Math.exp(-2.6 * dt);
            this.vx[i] *= f;
            this.vz[i] *= f;
            this.wx[i] *= Math.exp(-6 * dt);
            this.wy[i] *= Math.exp(-3 * dt);
            this.wz[i] *= Math.exp(-6 * dt);
            // settle: tilt towards lying flat
            const qx = this.qx[i];
            const qz = this.qz[i];
            const k = Math.min(1, 4 * dt);
            this.qx[i] = qx * (1 - k);
            this.qz[i] = qz * (1 - k);
            const len = Math.hypot(this.qx[i], this.qy[i], this.qz[i], this.qw[i]) || 1;
            this.qx[i] /= len;
            this.qy[i] /= len;
            this.qz[i] /= len;
            this.qw[i] /= len;
            if (this.vx[i] * this.vx[i] + this.vz[i] * this.vz[i] < 0.02) this.rest[i] = 1;
          }
        }
        // integrate rotation q += 0.5 * (w ⊗ q) dt
        const wx = this.wx[i];
        const wy = this.wy[i];
        const wz = this.wz[i];
        const qx = this.qx[i];
        const qy = this.qy[i];
        const qz = this.qz[i];
        const qw = this.qw[i];
        const h = 0.5 * dt;
        let nx = qx + h * (wx * qw + wy * qz - wz * qy);
        let ny = qy + h * (wy * qw + wz * qx - wx * qz);
        let nz = qz + h * (wz * qw + wx * qy - wy * qx);
        let nw = qw - h * (wx * qx + wy * qy + wz * qz);
        const l = Math.hypot(nx, ny, nz, nw) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
        nw /= l;
        this.qx[i] = nx;
        this.qy[i] = ny;
        this.qz[i] = nz;
        this.qw[i] = nw;
      }
      if (hooks && a < this.trail[i]) {
        this.trailAcc[i] += dt;
        if (this.trailAcc[i] > 0.028) {
          this.trailAcc[i] = 0;
          hooks.trail(this.px[i], this.py[i], this.pz[i], this.vx[i], this.vy[i], this.vz[i], a, Math.max(this.sx[i], this.sz[i]), this.burn[i] === 1);
        }
      }
    }
    this.count = n;
    if (n > this.peak) this.peak = n;
    const c0 = this.counts;
    c0[0] = 0;
    c0[1] = 0;
    for (let i = 0; i < n; i++) {
      const t = this.type[i];
      const m = this.meshes[t];
      const k = c0[t]++;
      // sink into the road at the very end of life
      const sink = Math.max(0, this.age[i] - (this.life[i] - 1.2)) / 1.2;
      _p.set(this.px[i], this.py[i] - sink * 0.4, this.pz[i]);
      _q.set(this.qx[i], this.qy[i], this.qz[i], this.qw[i]);
      const shrink = 1 - sink * 0.8;
      _s.set(this.sx[i] * shrink, this.sy[i] * shrink, this.sz[i] * shrink);
      _m.compose(_p, _q, _s);
      m.setMatrixAt(k, _m);
      // charred dark metal, hot pieces glow faintly red for a few seconds (via colour tint)
      const v = this.tint[i];
      const glow = this.burn[i] ? Math.max(0, 1 - this.age[i] / 4) : 0;
      m.setColorAt(k, _c.setRGB(v + glow * 0.5, v + glow * 0.08, v));
    }
    for (let t = 0; t < 2; t++) {
      const m = this.meshes[t];
      m.count = c0[t];
      m.visible = c0[t] > 0;
      if (c0[t] > 0) {
        m.instanceMatrix.clearUpdateRanges();
        m.instanceMatrix.addUpdateRange(0, c0[t] * 16);
        m.instanceMatrix.needsUpdate = true;
        const ic = m.instanceColor!;
        ic.clearUpdateRanges();
        ic.addUpdateRange(0, c0[t] * 3);
        ic.needsUpdate = true;
      }
    }
  }

  private copy(s: number, d: number): void {
    for (const a of this.floats) a[d] = a[s];
    this.burn[d] = this.burn[s];
    this.type[d] = this.type[s];
    this.rest[d] = this.rest[s];
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      m.removeFromParent();
      m.dispose();
    }
    this.material.dispose();
  }
}
