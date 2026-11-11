/**
 * Tiny mesh builder for straight-road-space structures (x = d, y = up, z = -(s - s0)).
 * Every face is subdivided so no edge is longer than `step` metres: that keeps the bend smooth
 * and gives the baked lamp light enough vertices. UVs are planar box-mapped from the final
 * (transformed) position unless given explicitly, so textures line up across pieces and chunks.
 * A per-vertex `shade` multiplier (vertex colour) carries tint / dirt / ambient occlusion and an
 * optional `light` function adds extra baked irradiance (architectural flood lights).
 */
import { BufferAttribute, BufferGeometry } from 'three';
import type { Material, Mesh } from 'three';
import type { AddOpts, IChunkBuilder, Placement } from '../../../core/types';

export type Vec3 = [number, number, number];
export type ShadeFn = (x: number, y: number, z: number) => number;
export type LightFn = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => number;
/** Per-vertex auxiliary pair (straight space) written to the `stAux` vec2 attribute. */
export type AuxFn = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => readonly [number, number];

const _a: Vec3 = [0, 0, 0];
const _b: Vec3 = [0, 0, 0];

export class Geo {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly ext: number[] = [];
  readonly idx: number[] = [];
  readonly aux: number[] = [];
  private sx = 1;
  private ox = 0;
  private sz = 1;
  private oz = 0;
  private cr = 1;
  private cg = 1;
  private cb = 1;
  shade: ShadeFn | null = null;
  light: LightFn | null = null;
  lightColor: Vec3 = [1, 1, 1];
  hasLight = false;
  /** Optional per-vertex aux attribute (see AuxFn); vertices added while null get (0, 0). */
  auxFn: AuxFn | null = null;
  hasAux = false;

  /**
   * @param step     max edge length along z (the bend direction)
   * @param latStep  max edge length across (x / y): only affects how finely the light is baked
   */
  constructor(
    public uvScale = 0.25,
    public step = 4,
    public latStep = step,
  ) {}

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** Local → straight space: x' = sx·x + ox, z' = sz·z + oz (sx, sz = ±1). */
  transform(sx: number, ox: number, sz = 1, oz = 0): this {
    this.sx = sx;
    this.ox = ox;
    this.sz = sz;
    this.oz = oz;
    return this;
  }

  identity(): this {
    return this.transform(1, 0, 1, 0);
  }

  tint(r: number, g = r, b = r): this {
    this.cr = r;
    this.cg = g;
    this.cb = b;
    return this;
  }

  /** Add one vertex (local coordinates). */
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u?: number, w?: number): number {
    const X = this.sx * x + this.ox;
    const Z = this.sz * z + this.oz;
    const NX = nx * this.sx;
    const NZ = nz * this.sz;
    const i = this.pos.length / 3;
    this.pos.push(X, y, Z);
    this.nor.push(NX, ny, NZ);
    if (u === undefined || w === undefined) {
      const k = this.uvScale;
      const ax = Math.abs(NX);
      const ay = Math.abs(ny);
      const az = Math.abs(NZ);
      if (ay > ax && ay > az) {
        u = X * k;
        w = -Z * k;
      } else if (ax >= az) {
        u = (NX > 0 ? -Z : Z) * k;
        w = y * k;
      } else {
        u = (NZ > 0 ? X : -X) * k;
        w = y * k;
      }
    }
    this.uv.push(u, w);
    const s = this.shade ? this.shade(X, y, Z) : 1;
    this.col.push(this.cr * s, this.cg * s, this.cb * s);
    if (this.light) {
      const e = this.light(X, y, Z, NX, ny, NZ);
      const c = this.lightColor;
      this.ext.push(c[0] * e, c[1] * e, c[2] * e);
      this.hasLight = true;
    } else this.ext.push(0, 0, 0);
    if (this.auxFn) {
      const a = this.auxFn(X, y, Z, NX, ny, NZ);
      this.aux.push(a[0], a[1]);
      this.hasAux = true;
    } else this.aux.push(0, 0);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Quad a-b-c-d (around the edge); winding chosen so the face agrees with a's normal. */
  quad(a: number, b: number, c: number, d: number): void {
    const p = this.pos;
    const n = this.nor;
    const e1x = p[c * 3] - p[a * 3];
    const e1y = p[c * 3 + 1] - p[a * 3 + 1];
    const e1z = p[c * 3 + 2] - p[a * 3 + 2];
    const e2x = p[d * 3] - p[b * 3];
    const e2y = p[d * 3 + 1] - p[b * 3 + 1];
    const e2z = p[d * 3 + 2] - p[b * 3 + 2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const dot = cx * n[a * 3] + cy * n[a * 3 + 1] + cz * n[a * 3 + 2];
    if (dot >= 0) this.idx.push(a, b, c, a, c, d);
    else this.idx.push(a, c, b, a, d, c);
  }

  /**
   * Bilinear patch p00 → p10 (u) and p00 → p01 (v). `n` = face normal, or null to compute it
   * (then `hint` picks the side). nu/nv default to the edge length / step.
   */
  patch(p00: Vec3, p10: Vec3, p01: Vec3, p11: Vec3, n: Vec3 | null, hint?: Vec3, nu?: number, nv?: number): void {
    let nx: number;
    let ny: number;
    let nz: number;
    if (n) {
      [nx, ny, nz] = n;
    } else {
      const ux = p10[0] - p00[0] + (p11[0] - p01[0]);
      const uy = p10[1] - p00[1] + (p11[1] - p01[1]);
      const uz = p10[2] - p00[2] + (p11[2] - p01[2]);
      const vx = p01[0] - p00[0] + (p11[0] - p10[0]);
      const vy = p01[1] - p00[1] + (p11[1] - p10[1]);
      const vz = p01[2] - p00[2] + (p11[2] - p10[2]);
      nx = uy * vz - uz * vy;
      ny = uz * vx - ux * vz;
      nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      if (hint && nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
    }
    const NU = nu ?? this.segs(p00, p10, p01, p11);
    const NV = nv ?? this.segs(p00, p01, p10, p11);
    const base = this.pos.length / 3;
    for (let j = 0; j <= NV; j++) {
      const tv = j / NV;
      for (let i = 0; i <= NU; i++) {
        const tu = i / NU;
        lerp3(p00, p10, tu, _a);
        lerp3(p01, p11, tu, _b);
        this.v(_a[0] + (_b[0] - _a[0]) * tv, _a[1] + (_b[1] - _a[1]) * tv, _a[2] + (_b[2] - _a[2]) * tv, nx, ny, nz);
      }
    }
    const row = NU + 1;
    for (let j = 0; j < NV; j++) {
      for (let i = 0; i < NU; i++) {
        const a = base + j * row + i;
        this.quad(a, a + 1, a + row + 1, a + row);
      }
    }
  }

  /** Segments for the edge pair a→b, c→d: ≤ step along z, ≤ latStep overall. */
  private segs(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
    const dz = Math.max(Math.abs(b[2] - a[2]), Math.abs(d[2] - c[2]));
    const l = Math.max(dist(a, b), dist(c, d));
    return Math.max(1, Math.ceil(dz / this.step - 1e-6), Math.ceil(l / this.latStep - 1e-6));
  }

  /** Axis-aligned box. `skip` bitmask: 1 −x, 2 +x, 4 −y, 8 +y, 16 −z, 32 +z. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, skip = 0): void {
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (y0 > y1) [y0, y1] = [y1, y0];
    if (z0 > z1) [z0, z1] = [z1, z0];
    if (!(skip & 1)) this.patch([x0, y0, z1], [x0, y0, z0], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]);
    if (!(skip & 2)) this.patch([x1, y0, z0], [x1, y0, z1], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]);
    if (!(skip & 4)) this.patch([x0, y0, z0], [x1, y0, z0], [x0, y0, z1], [x1, y0, z1], [0, -1, 0]);
    if (!(skip & 8)) this.patch([x0, y1, z1], [x1, y1, z1], [x0, y1, z0], [x1, y1, z0], [0, 1, 0]);
    if (!(skip & 16)) this.patch([x1, y0, z0], [x0, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1]);
    if (!(skip & 32)) this.patch([x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1], [0, 0, 1]);
  }

  /**
   * General hexahedron. Corners: bottom c0(−x,−z) c1(+x,−z) c2(+x,+z) c3(−x,+z), top c4..c7 likewise.
   */
  hexa(c: Vec3[], skip = 0): void {
    const cen: Vec3 = [0, 0, 0];
    for (const p of c) {
      cen[0] += p[0] / 8;
      cen[1] += p[1] / 8;
      cen[2] += p[2] / 8;
    }
    const face = (a: Vec3, b: Vec3, d: Vec3, e: Vec3) => {
      const h: Vec3 = [(a[0] + b[0] + d[0] + e[0]) / 4 - cen[0], (a[1] + b[1] + d[1] + e[1]) / 4 - cen[1], (a[2] + b[2] + d[2] + e[2]) / 4 - cen[2]];
      this.patch(a, b, d, e, null, h);
    };
    if (!(skip & 1)) face(c[0], c[3], c[4], c[7]);
    if (!(skip & 2)) face(c[1], c[2], c[5], c[6]);
    if (!(skip & 4)) face(c[0], c[1], c[3], c[2]);
    if (!(skip & 8)) face(c[4], c[5], c[7], c[6]);
    if (!(skip & 16)) face(c[0], c[1], c[4], c[5]);
    if (!(skip & 32)) face(c[3], c[2], c[7], c[6]);
  }

  /** Straight beam from p to q: w across (horizontal, ⟂ to the beam), h vertical. */
  beam(p: Vec3, q: Vec3, w: number, h: number, skip = 0): void {
    let sx = -(q[2] - p[2]);
    let sz = q[0] - p[0];
    const l = Math.hypot(sx, sz);
    if (l < 1e-6) {
      sx = 1;
      sz = 0;
    } else {
      sx /= l;
      sz /= l;
    }
    const hw = w / 2;
    const c = (o: Vec3, k: number, y: number): Vec3 => [o[0] + sx * hw * k, o[1] + y, o[2] + sz * hw * k];
    this.hexa([c(p, -1, 0), c(q, -1, 0), c(q, 1, 0), c(p, 1, 0), c(p, -1, h), c(q, -1, h), c(q, 1, h), c(p, 1, h)], skip);
  }

  /**
   * Extrude a 2D profile (x, y pairs) along z from z0 to z1. Each segment's outward normal is
   * on the LEFT of the travel direction as seen from +z (looking forward): going up faces −x.
   */
  extrude(profile: readonly number[], z0: number, z1: number): void {
    for (let i = 0; i + 3 < profile.length; i += 2) {
      const xa = profile[i];
      const ya = profile[i + 1];
      const xb = profile[i + 2];
      const yb = profile[i + 3];
      const ex = xb - xa;
      const ey = yb - ya;
      const l = Math.hypot(ex, ey);
      if (l < 1e-6) continue;
      this.patch([xa, ya, z0], [xb, yb, z0], [xa, ya, z1], [xb, yb, z1], [-ey / l, ex / l, 0]);
    }
  }

  /** Smooth tube through `path` with radius r (constant or per point). */
  tube(path: readonly Vec3[], r: number | readonly number[], sides: number, capStart = false, capEnd = false): void {
    const n = path.length;
    const base = this.pos.length / 3;
    let along = 0;
    let rx = 0;
    let ry = 0;
    let rz = 0;
    for (let k = 0; k < n; k++) {
      const p = path[k];
      const a = path[Math.max(0, k - 1)];
      const b = path[Math.min(n - 1, k + 1)];
      let tx = b[0] - a[0];
      let ty = b[1] - a[1];
      let tz = b[2] - a[2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      if (k === 0) {
        // Reference vector perpendicular to the tangent.
        if (Math.abs(ty) < 0.9) [rx, ry, rz] = [0, 1, 0];
        else [rx, ry, rz] = [1, 0, 0];
      }
      // n1 = normalize(ref × t), n2 = t × n1
      let ax = ry * tz - rz * ty;
      let ay = rz * tx - rx * tz;
      let az = rx * ty - ry * tx;
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al;
      ay /= al;
      az /= al;
      const bx = ty * az - tz * ay;
      const by = tz * ax - tx * az;
      const bz = tx * ay - ty * ax;
      if (k > 0) along += dist(p, path[k - 1]);
      const rr = typeof r === 'number' ? r : r[k];
      for (let i = 0; i <= sides; i++) {
        const t = (i / sides) * Math.PI * 2;
        const c = Math.cos(t);
        const s = Math.sin(t);
        const nx = ax * c + bx * s;
        const ny = ay * c + by * s;
        const nz = az * c + bz * s;
        this.v(p[0] + nx * rr, p[1] + ny * rr, p[2] + nz * rr, nx, ny, nz, (i / sides) * rr * Math.PI * 2 * this.uvScale, along * this.uvScale);
      }
    }
    const row = sides + 1;
    for (let k = 0; k < n - 1; k++) {
      for (let i = 0; i < sides; i++) {
        const a = base + k * row + i;
        this.quad(a, a + 1, a + row + 1, a + row);
      }
    }
    if (capStart) this.cap(path[0], path[1], typeof r === 'number' ? r : r[0], sides);
    if (capEnd) this.cap(path[n - 1], path[n - 2], typeof r === 'number' ? r : r[n - 1], sides);
  }

  /** Flat disc closing a tube end at `p`; `inner` is the neighbouring path point (normal points away from it). */
  private cap(p: Vec3, inner: Vec3, r: number, sides: number): void {
    let nx = p[0] - inner[0];
    let ny = p[1] - inner[1];
    let nz = p[2] - inner[2];
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    let ax: number;
    let ay: number;
    let az: number;
    if (Math.abs(ny) < 0.9) [ax, ay, az] = [nz, 0, -nx];
    else [ax, ay, az] = [0, -nz, ny];
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al;
    ay /= al;
    az /= al;
    const bx = ny * az - nz * ay;
    const by = nz * ax - nx * az;
    const bz = nx * ay - ny * ax;
    const c0 = this.v(p[0], p[1], p[2], nx, ny, nz);
    const first = this.pos.length / 3;
    for (let i = 0; i < sides; i++) {
      const t = (i / sides) * Math.PI * 2;
      const c = Math.cos(t) * r;
      const s = Math.sin(t) * r;
      this.v(p[0] + ax * c + bx * s, p[1] + ay * c + by * s, p[2] + az * c + bz * s, nx, ny, nz);
    }
    for (let i = 0; i < sides; i++) {
      const a = first + i;
      const b = first + ((i + 1) % sides);
      // orient with the normal
      this.quad(c0, a, b, b);
    }
  }

  /** Vertical cylinder. */
  cylY(x: number, z: number, y0: number, y1: number, r: number, sides: number, capTop = true): void {
    this.tube([[x, y0, z], [x, y1, z]], r, sides, false, capTop);
  }

  /** Quad with explicit UVs (signs / atlas). Corners in order bottom-left, bottom-right, top-right, top-left as seen from the front. */
  uvQuad(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, n: Vec3, u0: number, v0: number, u1: number, v1: number): void {
    const a = this.v(p0[0], p0[1], p0[2], n[0], n[1], n[2], u0, v0);
    const b = this.v(p1[0], p1[1], p1[2], n[0], n[1], n[2], u1, v0);
    const c = this.v(p2[0], p2[1], p2[2], n[0], n[1], n[2], u1, v1);
    const d = this.v(p3[0], p3[1], p3[2], n[0], n[1], n[2], u0, v1);
    this.quad(a, b, c, d);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    if (this.hasAux) g.setAttribute('stAux', new BufferAttribute(new Float32Array(this.aux), 2));
    const n = this.pos.length / 3;
    g.setIndex(new BufferAttribute(n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    return g;
  }
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function lerp3(a: Vec3, b: Vec3, t: number, out: Vec3): Vec3 {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

export interface GeoStats {
  calls: number;
  tris: number;
}

/** Bend + bake + add; then adds the geo's extra (flood light) irradiance on top of the lamp bake. */
/** Debug counters (sandbox bench): milliseconds spent inside addBent and vertices bent. */
export const geoTiming = { bentMs: 0, verts: 0 };

export function addGeo(b: IChunkBuilder, g: Geo, mat: Material, opts?: AddOpts, stats?: GeoStats): Mesh | null {
  if (!g.idx.length) return null;
  const t0 = performance.now();
  const mesh = b.addBent(g.build(), mat, opts);
  geoTiming.bentMs += performance.now() - t0;
  geoTiming.verts += g.vertexCount;
  if (g.hasLight) {
    const attr = mesh.geometry.getAttribute('bakedLight') as BufferAttribute;
    const arr = attr.array as Float32Array;
    const ext = g.ext;
    for (let i = 0; i < arr.length; i++) arr[i] += ext[i];
    attr.needsUpdate = true;
  }
  if (stats) {
    stats.calls++;
    stats.tris += g.idx.length / 3;
  }
  return mesh;
}

let postGeo: BufferGeometry | null = null;
/** Unit post (1 × 1 × 1, base at y = 0) with a steel-grey vertex colour, shared by every chunk. */
function unitPost(): BufferGeometry {
  if (!postGeo) {
    const g = new Geo(1, 10);
    g.tint(0.46, 0.47, 0.5);
    g.box(-0.5, 0.5, 0, 1, -0.5, 0.5, 4);
    postGeo = g.build();
    postGeo.computeBoundingSphere();
  }
  return postGeo;
}

/** Railing / fence posts as one instanced draw (one baked light value per post). */
export function addPosts(b: IChunkBuilder, mat: Material, pl: Placement[], stats?: GeoStats): void {
  if (!pl.length) return;
  b.addInstances(unitPost(), mat, pl, { sharedGeometry: true, noProbe: true, name: 'posts' });
  if (stats) {
    stats.calls++;
    stats.tris += pl.length * 10;
  }
}

/** Helper: s → straight-space z for a chunk. */
export const zOf = (s0: number, s: number): number => -(s - s0);
