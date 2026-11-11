/**
 * Tiny mesh accumulator for furniture: everything is authored in straight road space
 * (x = d, y = up, z = -(s - s0)) and merged per material into one BufferGeometry per chunk.
 */
import { BufferAttribute, BufferGeometry, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _n = new Vector3();
const _m = new Matrix4();
const _nm = new Matrix3();
const _q = new Quaternion();
const _s = new Vector3();
const _p = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dir = new Vector3();

export type RGB = readonly [number, number, number];

export class Geo {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  /** Current vertex colour. */
  r = 1;
  g = 1;
  b = 1;

  get count(): number {
    return this.pos.length / 3;
  }

  color(c: RGB): this {
    this.r = c[0];
    this.g = c[1];
    this.b = c[2];
    return this;
  }

  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, w: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, w);
    this.col.push(this.r, this.g, this.b);
    return this.pos.length / 3 - 1;
  }

  /** Triangle, flipped if its geometric normal disagrees with the vertex normals. */
  tri(i0: number, i1: number, i2: number): void {
    const p = this.pos;
    _a.set(p[i1 * 3] - p[i0 * 3], p[i1 * 3 + 1] - p[i0 * 3 + 1], p[i1 * 3 + 2] - p[i0 * 3 + 2]);
    _b.set(p[i2 * 3] - p[i0 * 3], p[i2 * 3 + 1] - p[i0 * 3 + 1], p[i2 * 3 + 2] - p[i0 * 3 + 2]);
    _c.crossVectors(_a, _b);
    const n = this.nor;
    const dot =
      _c.x * (n[i0 * 3] + n[i1 * 3] + n[i2 * 3]) + _c.y * (n[i0 * 3 + 1] + n[i1 * 3 + 1] + n[i2 * 3 + 1]) + _c.z * (n[i0 * 3 + 2] + n[i1 * 3 + 2] + n[i2 * 3 + 2]);
    if (dot >= 0) this.idx.push(i0, i1, i2);
    else this.idx.push(i0, i2, i1);
  }

  quad(i0: number, i1: number, i2: number, i3: number): void {
    this.tri(i0, i1, i2);
    this.tri(i0, i2, i3);
  }

  /** Flat quad from 4 corner points (in order around the face) with a given normal. */
  face(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    x3: number, y3: number, z3: number,
    nx: number, ny: number, nz: number,
    uv: readonly [number, number, number, number] = [0, 0, 1, 1],
  ): void {
    const a = this.v(x0, y0, z0, nx, ny, nz, uv[0], uv[1]);
    const b = this.v(x1, y1, z1, nx, ny, nz, uv[2], uv[1]);
    const c = this.v(x2, y2, z2, nx, ny, nz, uv[2], uv[3]);
    const d = this.v(x3, y3, z3, nx, ny, nz, uv[0], uv[3]);
    this.quad(a, b, c, d);
  }

  /**
   * Append a three.js primitive transformed by `m` (normals by its normal matrix).
   * `uvScale` > 0 replaces its UVs by a box projection in metres (for tiling textures).
   */
  prim(g: BufferGeometry, m: Matrix4, uvScale = 0): void {
    const pa = g.getAttribute('position');
    const na = g.getAttribute('normal');
    const ua = g.getAttribute('uv');
    _nm.getNormalMatrix(m);
    const base = this.count;
    for (let i = 0; i < pa.count; i++) {
      _p.set(pa.getX(i), pa.getY(i), pa.getZ(i)).applyMatrix4(m);
      _n.set(na.getX(i), na.getY(i), na.getZ(i)).applyMatrix3(_nm).normalize();
      let u = ua ? ua.getX(i) : 0;
      let w = ua ? ua.getY(i) : 0;
      if (uvScale > 0) {
        const ax = Math.abs(_n.x);
        const ay = Math.abs(_n.y);
        const az = Math.abs(_n.z);
        if (ay >= ax && ay >= az) {
          u = _p.x / uvScale;
          w = _p.z / uvScale;
        } else if (ax >= az) {
          u = _p.z / uvScale;
          w = _p.y / uvScale;
        } else {
          u = _p.x / uvScale;
          w = _p.y / uvScale;
        }
      }
      this.v(_p.x, _p.y, _p.z, _n.x, _n.y, _n.z, u, w);
    }
    const ix = g.getIndex();
    const det = m.determinant();
    if (ix) {
      for (let i = 0; i < ix.count; i += 3) {
        const a = base + ix.getX(i);
        const b = base + ix.getX(i + 1);
        const c = base + ix.getX(i + 2);
        if (det >= 0) this.idx.push(a, b, c);
        else this.idx.push(a, c, b);
      }
    } else {
      for (let i = 0; i < pa.count; i += 3) {
        if (det >= 0) this.idx.push(base + i, base + i + 1, base + i + 2);
        else this.idx.push(base + i, base + i + 2, base + i + 1);
      }
    }
  }

  /** Append an indexed geometry (position, normal, uv, optional color) translated by (dx, dy, dz). */
  append(g: BufferGeometry, dx: number, dy: number, dz: number): void {
    const pa = g.getAttribute('position');
    const na = g.getAttribute('normal');
    const ua = g.getAttribute('uv');
    const ca = g.getAttribute('color');
    const base = this.count;
    for (let i = 0; i < pa.count; i++) {
      if (ca) {
        this.r = ca.getX(i);
        this.g = ca.getY(i);
        this.b = ca.getZ(i);
      }
      this.v(pa.getX(i) + dx, pa.getY(i) + dy, pa.getZ(i) + dz, na.getX(i), na.getY(i), na.getZ(i), ua ? ua.getX(i) : 0, ua ? ua.getY(i) : 0);
    }
    const ix = g.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
    else for (let i = 0; i < pa.count; i++) this.idx.push(base + i);
  }

  /** Primitive placed at (x,y,z) with scale and an optional yaw (rad, around Y). */
  primAt(g: BufferGeometry, x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw = 0, uvScale = 0): void {
    _q.setFromAxisAngle(_up, yaw);
    _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
    this.prim(g, _m, uvScale);
  }

  /**
   * A unit primitive aligned along +Y (e.g. CylinderGeometry(1,1,1) / BoxGeometry(1,1,1))
   * stretched between two points with cross-section (w, d).
   */
  member(g: BufferGeometry, ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, d = w, uvScale = 0): void {
    _dir.set(bx - ax, by - ay, bz - az);
    const len = _dir.length();
    if (len < 1e-5) return;
    _dir.multiplyScalar(1 / len);
    _q.setFromUnitVectors(_up, _dir);
    _m.compose(_p.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5), _q, _s.set(w, len, d));
    this.prim(g, _m, uvScale);
  }

  /**
   * Swept tube along a polyline (radius per point). Radial normals; UV u = around, v = along (m / uvScale).
   */
  tube(pts: ReadonlyArray<readonly [number, number, number]>, radii: readonly number[], sides: number, uvScale = 1): void {
    const n = pts.length;
    const t = new Vector3();
    const ref = new Vector3();
    const nrm = new Vector3();
    const bin = new Vector3();
    let along = 0;
    let prevRing = -1;
    // Initial reference perpendicular to the first tangent.
    t.set(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]).normalize();
    ref.set(0, 0, 1);
    if (Math.abs(t.dot(ref)) > 0.9) ref.set(1, 0, 0);
    nrm.crossVectors(t, ref).normalize();
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (i > 0) {
        const q = pts[i - 1];
        along += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      }
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      t.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      // Parallel transport of the normal.
      nrm.addScaledVector(t, -nrm.dot(t)).normalize();
      bin.crossVectors(t, nrm).normalize();
      const ring = this.count;
      for (let k = 0; k <= sides; k++) {
        const ang = (k / sides) * Math.PI * 2;
        const cx = Math.cos(ang);
        const sx = Math.sin(ang);
        const nx = nrm.x * cx + bin.x * sx;
        const ny = nrm.y * cx + bin.y * sx;
        const nz = nrm.z * cx + bin.z * sx;
        const r = radii[i];
        this.v(p[0] + nx * r, p[1] + ny * r, p[2] + nz * r, nx, ny, nz, k / sides, along / uvScale);
      }
      if (prevRing >= 0) {
        for (let k = 0; k < sides; k++) this.quad(prevRing + k, prevRing + k + 1, ring + k + 1, ring + k);
      }
      prevRing = ring;
    }
  }

  /**
   * Extrude a 2D profile (x, y) along -Z from z0 to z1 (z0 > z1) in steps ≤ `step`.
   * `xform(z, out)` may move/scale each ring: out = [dx, yScale, yOffset]. `flat` gives hard
   * edges between profile segments. Normals come from the 2D profile (`normalSign` = ±1 picks the side).
   * UV: u = profile arc / uvScale, v = (vBase - z) / uvScale.
   */
  extrude(
    profile: ReadonlyArray<readonly [number, number]>,
    z0: number,
    z1: number,
    step: number,
    opts: { flat?: boolean; normalSign?: number; uvScale?: number; vBase?: number; xform?: (z: number, out: [number, number, number]) => void } = {},
  ): void {
    const flat = opts.flat ?? false;
    const sign = opts.normalSign ?? 1;
    const uvS = opts.uvScale ?? 1;
    const vBase = opts.vBase ?? 0;
    const segs = Math.max(1, Math.ceil(Math.abs(z0 - z1) / step));
    const np = profile.length;
    // Profile arc lengths and normals.
    const arc: number[] = [0];
    for (let i = 1; i < np; i++) arc.push(arc[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
    const segN: Array<[number, number]> = [];
    for (let i = 0; i < np - 1; i++) {
      const dx = profile[i + 1][0] - profile[i][0];
      const dy = profile[i + 1][1] - profile[i][1];
      const l = Math.hypot(dx, dy) || 1;
      segN.push([(-dy / l) * sign, (dx / l) * sign]);
    }
    const ptN: Array<[number, number]> = [];
    for (let i = 0; i < np; i++) {
      const a = segN[Math.max(0, i - 1)];
      const b = segN[Math.min(np - 2, i)];
      const x = a[0] + b[0];
      const y = a[1] + b[1];
      const l = Math.hypot(x, y) || 1;
      ptN.push([x / l, y / l]);
    }
    const xf: [number, number, number] = [0, 1, 0];
    // Column layout: for smooth, one column per profile point; for flat, two per segment.
    const cols = flat ? (np - 1) * 2 : np;
    let prev = -1;
    for (let j = 0; j <= segs; j++) {
      const z = z0 + ((z1 - z0) * j) / segs;
      xf[0] = 0;
      xf[1] = 1;
      xf[2] = 0;
      opts.xform?.(z, xf);
      const ring = this.count;
      const vv = (vBase - z) / uvS;
      if (flat) {
        for (let i = 0; i < np - 1; i++) {
          const n = segN[i];
          for (let e = 0; e < 2; e++) {
            const p = profile[i + e];
            this.v(p[0] + xf[0], p[1] * xf[1] + xf[2], z, n[0], n[1], 0, arc[i + e] / uvS, vv);
          }
        }
      } else {
        for (let i = 0; i < np; i++) {
          const p = profile[i];
          this.v(p[0] + xf[0], p[1] * xf[1] + xf[2], z, ptN[i][0], ptN[i][1], 0, arc[i] / uvS, vv);
        }
      }
      if (prev >= 0) {
        if (flat) {
          for (let i = 0; i < np - 1; i++) this.quad(prev + i * 2, prev + i * 2 + 1, ring + i * 2 + 1, ring + i * 2);
        } else {
          for (let i = 0; i < np - 1; i++) this.quad(prev + i, prev + i + 1, ring + i + 1, ring + i);
        }
      }
      prev = ring;
      void cols;
    }
  }

  /** Build a BufferGeometry (position, normal, uv, color). `attrs` adds extra per-vertex attributes. */
  build(extra?: Record<string, { data: Float32Array; size: number }>): BufferGeometry | null {
    if (this.idx.length === 0) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    if (extra) for (const k in extra) g.setAttribute(k, new BufferAttribute(extra[k].data, extra[k].size));
    const n = this.count;
    g.setIndex(new BufferAttribute(n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    return g;
  }
}
