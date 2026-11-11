/**
 * Volumetric billboard puffs: fire, soot smoke, water spray / dust, the flash core and nitro licks,
 * all in ONE instanced draw call (premultiplied "blend add": rgb = emission + smoke·alpha) sorted
 * back to front with a counting sort (no allocations), so fire and smoke interleave correctly.
 *
 * Each billboard is shaded procedurally (no flipbooks): tiling noise (R/G fbm, B Worley) with a
 * per-particle offset / rotation / scroll erodes its alpha from the edges over life, the noise
 * gradient gives a fake volume normal that is lit by the nearest street lamps, explosion flashes,
 * the headlight and the fire light slots (self-illumination), and a temperature ramp gives the
 * fire emission (white-hot core → yellow → orange → deep red → soot).
 */
import {
  BufferAttribute,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';
import type { Camera, Texture } from 'three';
import { LAYERS } from '../core/types';
import type { ILighting, IParticleShared } from '../core/types';
import { GLSL_FIRE_LIGHTS, GLSL_RAMPS, WIND, premultipliedBlend } from './common';
import type { FireLightUniforms } from './common';

export const KIND_FIRE = 0; // fire that cools into soot smoke (also plain smoke with heat 0)
export const KIND_SPRAY = 1; // water mist / dust: bright albedo, no emission
export const KIND_FLASH = 2; // white-hot detonation core
export const KIND_NITRO = 3; // blue afterburner licks
export const KIND_FLAME = 4; // licking flame tongue (vertical, hot base → red tip, mostly additive)

/** Spawn template: fill the fields, then call PuffSystem.emit(). Reused, never reallocated. */
export class PuffSpawn {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  life = 1;
  /** Start / end radius (m) and growth rate (1/s, exponential approach). */
  size0 = 1;
  size1 = 2;
  grow = 2;
  rot = 0;
  rotV = 0;
  /** 0..1.3 temperature at spawn and cooling rate (1/s, exponential). */
  heat = 0;
  cool = 1;
  /** Smoke optical density 0..1. */
  dens = 0.8;
  /** Smoke albedo (soot ≈ 0.05, spray ≈ 0.5). */
  albedo = 0.06;
  /** Upward acceleration (m/s²) at heat 1 (scaled by 0.3 + 0.7·heat). */
  buoy = 0;
  /** Linear drag towards the wind-carried air velocity (1/s). */
  drag = 1;
  /** 0..1 how much the wind carries this puff once it has cooled. */
  wind = 0.5;
  /** Turbulent swirl amplitude (m/s²). */
  turb = 0;
  kind = KIND_FIRE;
  /** Elongation of the billboard: > 1 vertical (flames); < -1 along (dirX, dirY, dirZ) by |stretch|. */
  stretch = 1;
  dirX = 0;
  dirY = 1;
  dirZ = 0;
  /** Fade-in time (s). */
  fadeIn = 0.05;
  /** Erosion: threshold at birth and at death (0..1, higher = more broken up). */
  erode0 = 0.08;
  erode1 = 0.7;
  /** Noise frequency on the billboard (lower = bigger lobes). */
  noise = 0.32;
  /** Ground floor height for the centre as a fraction of the radius. */
  floor = 0.35;
}

const F = Float32Array;

export class PuffSystem {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  readonly spawn = new PuffSpawn();
  /** Hard capacity (allocated); `budget` is the active cap (quality-scaled). */
  readonly capacity: number;
  budget: number;
  count = 0;
  /** Running statistics (sandbox). */
  peak = 0;

  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private grow: Float32Array;
  private rot: Float32Array;
  private rotV: Float32Array;
  private heat: Float32Array;
  private cool: Float32Array;
  private dens: Float32Array;
  private alb: Float32Array;
  private buoy: Float32Array;
  private drag: Float32Array;
  private wind: Float32Array;
  private turb: Float32Array;
  private kind: Float32Array;
  private stretch: Float32Array;
  private yaw: Float32Array;
  private pitch: Float32Array;
  private fadeIn: Float32Array;
  private seed: Float32Array;
  private er0: Float32Array;
  private er1: Float32Array;
  private nfreq: Float32Array;
  private floor: Float32Array;
  private size: Float32Array;

  // sorting
  private depth: Float32Array;
  private attrs: InstancedBufferAttribute[];
  private keys: Uint16Array;
  private order: Uint16Array;
  private hist = new Uint32Array(1024);

  private aA: InstancedBufferAttribute;
  private aB: InstancedBufferAttribute;
  private aC: InstancedBufferAttribute;
  private aD: InstancedBufferAttribute;
  private geometry: InstancedBufferGeometry;
  private seedCounter = 0;
  private readonly camPos = new Vector3();
  private readonly camDir = new Vector3();

  constructor(capacity: number, lighting: ILighting, particles: IParticleShared, fire: FireLightUniforms, noise: Texture) {
    this.capacity = capacity;
    this.budget = capacity;
    const n = capacity;
    this.px = new F(n);
    this.py = new F(n);
    this.pz = new F(n);
    this.vx = new F(n);
    this.vy = new F(n);
    this.vz = new F(n);
    this.age = new F(n);
    this.life = new F(n);
    this.s0 = new F(n);
    this.s1 = new F(n);
    this.grow = new F(n);
    this.rot = new F(n);
    this.rotV = new F(n);
    this.heat = new F(n);
    this.cool = new F(n);
    this.dens = new F(n);
    this.alb = new F(n);
    this.buoy = new F(n);
    this.drag = new F(n);
    this.wind = new F(n);
    this.turb = new F(n);
    this.kind = new F(n);
    this.stretch = new F(n);
    this.yaw = new F(n);
    this.pitch = new F(n);
    this.fadeIn = new F(n);
    this.seed = new F(n);
    this.er0 = new F(n);
    this.er1 = new F(n);
    this.nfreq = new F(n);
    this.floor = new F(n);
    this.size = new F(n);
    this.depth = new F(n);
    this.keys = new Uint16Array(n);
    this.order = new Uint16Array(n);

    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(new F([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = () => {
      const a = new InstancedBufferAttribute(new F(n * 4), 4);
      a.setUsage(DynamicDrawUsage);
      return a;
    };
    this.aA = mk();
    this.aB = mk();
    this.aC = mk();
    this.aD = mk();
    this.attrs = [this.aA, this.aB, this.aC, this.aD];
    g.setAttribute('iA', this.aA);
    g.setAttribute('iB', this.aB);
    g.setAttribute('iC', this.aC);
    g.setAttribute('iD', this.aD);
    g.instanceCount = 0;
    g.boundingSphere = new Sphere(new Vector3(), 1);
    this.geometry = g;

    this.material = premultipliedBlend(
      new ShaderMaterial({
        name: 'vfx_puffs',
        side: DoubleSide,
        uniforms: {
          ...lighting.uniforms,
          ...particles.uniforms,
          ...fire,
          uNoise: { value: noise },
        },
        vertexShader: VERT(lighting.glslLampField),
        fragmentShader: FRAG(lighting.glslLampField, particles.glsl),
      }),
    );
    this.mesh = new Mesh(g, this.material);
    this.mesh.name = 'vfx_puffs';
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYERS.PARTICLES);
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
  }

  /** Emit one puff from `this.spawn`. Returns false when the budget is exhausted. */
  emit(): boolean {
    let i = this.count;
    if (i >= this.budget) {
      // Recycle the oldest-relative particle among a few candidates (cheap, no scan of the whole pool).
      let best = -1;
      let bestT = -1;
      for (let k = 0; k < 8; k++) {
        const j = (this.seedCounter * 7 + k * 131) % this.count;
        const t = this.age[j] / this.life[j];
        if (t > bestT) {
          bestT = t;
          best = j;
        }
      }
      if (bestT < 0.45) return false;
      i = best;
    } else this.count++;
    const s = this.spawn;
    this.px[i] = s.x;
    this.py[i] = s.y;
    this.pz[i] = s.z;
    this.vx[i] = s.vx;
    this.vy[i] = s.vy;
    this.vz[i] = s.vz;
    this.age[i] = 0;
    this.life[i] = Math.max(0.02, s.life);
    this.s0[i] = s.size0;
    this.s1[i] = s.size1;
    this.grow[i] = s.grow;
    this.rot[i] = s.rot;
    this.rotV[i] = s.rotV;
    this.heat[i] = s.heat;
    this.cool[i] = s.cool;
    this.dens[i] = s.dens;
    this.alb[i] = s.albedo;
    this.buoy[i] = s.buoy;
    this.drag[i] = s.drag;
    this.wind[i] = s.wind;
    this.turb[i] = s.turb;
    this.kind[i] = s.kind;
    this.stretch[i] = s.stretch;
    if (s.stretch < 0) {
      const l = Math.hypot(s.dirX, s.dirY, s.dirZ) || 1;
      this.yaw[i] = Math.atan2(s.dirX, s.dirZ);
      this.pitch[i] = Math.asin(Math.max(-1, Math.min(1, s.dirY / l)));
    }
    this.fadeIn[i] = Math.max(1e-3, s.fadeIn);
    this.seed[i] = ((this.seedCounter++ * 0.618034) % 1 + 1) % 1;
    this.er0[i] = s.erode0;
    this.er1[i] = s.erode1;
    this.nfreq[i] = s.noise;
    this.floor[i] = s.floor;
    this.size[i] = s.size0;
    return true;
  }

  clear(): void {
    this.count = 0;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  update(dt: number, camera: Camera): void {
    const n0 = this.count;
    if (n0 === 0) {
      this.mesh.visible = false;
      return;
    }
    const { px, py, pz, vx, vy, vz, age, life, heat } = this;
    const wx = WIND.x;
    const wz = WIND.z;
    // ── simulate (swap-remove dead) ──
    let n = n0;
    for (let i = 0; i < n; i++) {
      let a = age[i] + dt;
      if (a >= life[i]) {
        n--;
        if (i < n) {
          this.copy(n, i);
          i--;
        }
        continue;
      }
      age[i] = a;
      const h = heat[i] * Math.exp(-this.cool[i] * dt);
      heat[i] = h;
      const e = Math.exp(-this.drag[i] * dt);
      const wc = this.wind[i] * (1 - Math.min(1, h * 1.5));
      const ax = wx * wc;
      const az = wz * wc;
      let nvx = ax + (vx[i] - ax) * e;
      let nvy = vy[i] * e + this.buoy[i] * (0.3 + 0.7 * Math.min(1.2, h)) * dt;
      let nvz = az + (vz[i] - az) * e;
      const tb = this.turb[i];
      if (tb > 0) {
        const sd = this.seed[i] * 40;
        nvx += tb * Math.sin(a * 1.9 + sd) * dt;
        nvz += tb * Math.cos(a * 1.6 + sd * 1.3) * dt;
        nvy += tb * 0.4 * Math.sin(a * 2.7 + sd * 0.7) * dt;
      }
      vx[i] = nvx;
      vy[i] = nvy;
      vz[i] = nvz;
      px[i] += nvx * dt;
      let y = py[i] + nvy * dt;
      const sz = this.s1[i] + (this.s0[i] - this.s1[i]) * Math.exp(-this.grow[i] * a);
      this.size[i] = sz;
      const fl = sz * this.floor[i];
      if (y < fl) {
        y = fl;
        if (vy[i] < 0) vy[i] = 0;
      }
      py[i] = y;
      pz[i] += nvz * dt;
      this.rot[i] += this.rotV[i] * dt;
    }
    this.count = n;
    if (n === 0) {
      this.geometry.instanceCount = 0;
      this.mesh.visible = false;
      return;
    }
    if (n > this.peak) this.peak = n;

    // ── sort back to front (counting sort on quantised view depth) ──
    camera.getWorldPosition(this.camPos);
    camera.getWorldDirection(this.camDir);
    const cx = this.camPos.x;
    const cy = this.camPos.y;
    const cz = this.camPos.z;
    const dx = this.camDir.x;
    const dy = this.camDir.y;
    const dz = this.camDir.z;
    let dmin = 1e9;
    let dmax = -1e9;
    let bx0 = 1e9, by0 = 1e9, bz0 = 1e9, bx1 = -1e9, by1 = -1e9, bz1 = -1e9;
    const size = this.size;
    const depth = this.depth;
    for (let i = 0; i < n; i++) {
      const d = (px[i] - cx) * dx + (py[i] - cy) * dy + (pz[i] - cz) * dz;
      depth[i] = d;
      if (d < dmin) dmin = d;
      if (d > dmax) dmax = d;
      const r = size[i];
      if (px[i] - r < bx0) bx0 = px[i] - r;
      if (py[i] - r < by0) by0 = py[i] - r;
      if (pz[i] - r < bz0) bz0 = pz[i] - r;
      if (px[i] + r > bx1) bx1 = px[i] + r;
      if (py[i] + r > by1) by1 = py[i] + r;
      if (pz[i] + r > bz1) bz1 = pz[i] + r;
    }
    const bs = this.geometry.boundingSphere as Sphere;
    bs.center.set((bx0 + bx1) * 0.5, (by0 + by1) * 0.5, (bz0 + bz1) * 0.5);
    bs.radius = 0.5 * Math.hypot(bx1 - bx0, by1 - by0, bz1 - bz0);
    const hist = this.hist;
    hist.fill(0);
    const span = Math.max(1e-3, dmax - dmin);
    const kscale = 1023 / span;
    const keys = this.keys;
    for (let i = 0; i < n; i++) {
      // far first → key 0 for the farthest
      const k = Math.min(1023, Math.max(0, ((dmax - depth[i]) * kscale) | 0));
      keys[i] = k;
      hist[k]++;
    }
    let acc = 0;
    for (let k = 0; k < 1024; k++) {
      const c = hist[k];
      hist[k] = acc;
      acc += c;
    }
    const order = this.order;
    for (let i = 0; i < n; i++) order[hist[keys[i]]++] = i;

    // ── write instance data ──
    const A = this.aA.array as Float32Array;
    const B = this.aB.array as Float32Array;
    const C = this.aC.array as Float32Array;
    const D = this.aD.array as Float32Array;
    for (let o = 0; o < n; o++) {
      const i = order[o];
      const j = o * 4;
      const a = age[i];
      const t = a / life[i];
      const fin = Math.min(1, a / this.fadeIn[i]);
      const fout = 1 - smoothT(0.82, 1, t);
      A[j] = px[i];
      A[j + 1] = py[i];
      A[j + 2] = pz[i];
      A[j + 3] = size[i];
      B[j] = this.rot[i];
      B[j + 1] = a;
      B[j + 2] = this.seed[i];
      B[j + 3] = this.kind[i] + Math.min(0.999, this.dens[i]);
      C[j] = heat[i];
      C[j + 1] = fin * fout;
      C[j + 2] = this.alb[i];
      C[j + 3] = this.stretch[i];
      D[j] = this.er0[i] + (this.er1[i] - this.er0[i]) * t * t * (1.6 - 0.6 * t);
      D[j + 1] = this.nfreq[i];
      D[j + 2] = this.yaw[i];
      D[j + 3] = this.pitch[i];
    }
    for (let k = 0; k < 4; k++) {
      const at = this.attrs[k];
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * 4);
      at.needsUpdate = true;
    }
    this.geometry.instanceCount = n;
    this.mesh.visible = true;
  }

  private copy(src: number, dst: number): void {
    this.px[dst] = this.px[src];
    this.py[dst] = this.py[src];
    this.pz[dst] = this.pz[src];
    this.vx[dst] = this.vx[src];
    this.vy[dst] = this.vy[src];
    this.vz[dst] = this.vz[src];
    this.age[dst] = this.age[src];
    this.life[dst] = this.life[src];
    this.s0[dst] = this.s0[src];
    this.s1[dst] = this.s1[src];
    this.grow[dst] = this.grow[src];
    this.rot[dst] = this.rot[src];
    this.rotV[dst] = this.rotV[src];
    this.heat[dst] = this.heat[src];
    this.cool[dst] = this.cool[src];
    this.dens[dst] = this.dens[src];
    this.alb[dst] = this.alb[src];
    this.buoy[dst] = this.buoy[src];
    this.drag[dst] = this.drag[src];
    this.wind[dst] = this.wind[src];
    this.turb[dst] = this.turb[src];
    this.kind[dst] = this.kind[src];
    this.stretch[dst] = this.stretch[src];
    this.yaw[dst] = this.yaw[src];
    this.pitch[dst] = this.pitch[src];
    this.fadeIn[dst] = this.fadeIn[src];
    this.seed[dst] = this.seed[src];
    this.er0[dst] = this.er0[src];
    this.er1[dst] = this.er1[src];
    this.nfreq[dst] = this.nfreq[src];
    this.floor[dst] = this.floor[src];
    this.size[dst] = this.size[src];
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}

function smoothT(a: number, b: number, x: number): number {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

const VERT = (lampField: string) => /* glsl */ `
${lampField}
${GLSL_FIRE_LIGHTS}
attribute vec4 iA; // xyz centre, w radius
attribute vec4 iB; // rot, age (s), seed, kind + density
attribute vec4 iC; // heat, fade, albedo, stretch
attribute vec4 iD; // erosion threshold, noise freq, stretch yaw, stretch pitch
uniform vec2 uResolution;
varying vec2 vUv;
varying vec4 vB;
varying vec4 vC;
varying vec4 vD;
varying vec3 vE;
varying vec4 vL;
varying float vDist;
varying float vR;
// x: near-camera fade (view depth of the billboard plane), y: on-screen magnification 0..1
// (0 = up to ~0.7 of the half screen height, 1 = ≥ 2.2× it), z: sprite radius in pixels
varying vec3 vNM;
void main() {
  vec3 c = iA.xyz;
  float r = iA.w;
  vec4 mv = viewMatrix * vec4(c, 1.0);
  vDist = length(mv.xyz);
  // Camera-facing billboards lie in a plane of constant view depth: fade them out smoothly as
  // that plane approaches the near plane (gone below 0.6 m, full by 2.5–4 m with the size).
  float zc = -mv.z;
  float nearFull = clamp(0.8 + 0.5 * r, 2.5, 4.0);
  float nearF = smoothstep(0.6, nearFull, zc);
  float rPx = r * projectionMatrix[1][1] * 0.5 * uResolution.y / max(zc, 0.05);
  float cov = r * sqrt(max(1.0, abs(iC.w))) * projectionMatrix[1][1] / max(zc, 0.05);
  vNM = vec3(nearF, smoothstep(0.7, 2.2, cov), rPx);
  if (nearF <= 0.0 || iC.y <= 0.0) {
    // invisible: collapse the quad (no fill cost for sprites at / behind the lens)
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 upV = mat3(viewMatrix) * vec3(0.0, 1.0, 0.0);
  vec2 up = upV.xy;
  float ul = length(up);
  up = ul > 1e-3 ? up / ul : vec2(0.0, 1.0);
  float st = iC.w;
  float shift = (st - 1.0) * 0.55;
  if (st < 0.0) {
    // velocity / direction aligned (foreshortened when the direction points at the camera)
    vec3 dw = vec3(cos(iD.w) * sin(iD.z), sin(iD.w), cos(iD.w) * cos(iD.z));
    vec3 dv = mat3(viewMatrix) * dw;
    float l = length(dv.xy);
    up = l > 0.02 ? dv.xy / l : up;
    st = 1.0 + (-st - 1.0) * clamp(l * 1.2, 0.0, 1.0);
    shift = 0.0;
  }
  vec2 rt = vec2(up.y, -up.x);
  vec2 off = rt * position.x * r + up * (position.y * st + shift) * r;
  mv.xy += off;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy;
  vB = iB;
  vC = iC;
  vD = iD;
  vR = r;

  // Lighting evaluated per corner (pulled 30% towards the centre) so big puffs get a gradient
  // across them (bright side near a lamp head / the fire, dark side away): irradiance + dominant
  // direction (view space).
  c += (transpose(mat3(viewMatrix)) * vec3(off, 0.0)) * 0.7;
  vec3 E = vec3(0.0);
  vec3 L = vec3(0.0);
  float rr = r * r * 0.12;
  for (int i = 0; i < NS_MAX_LAMPS; i++) {
    vec3 lv = uLampPos[i] - c;
    float d2 = dot(lv, lv);
    // cut-off luminaires: (almost) nothing above the lamp head's horizontal plane
    float down = clamp((lv.y * inversesqrt(d2 + 1e-3) + 0.12) * 2.2, 0.0, 1.0);
    vec3 e = uLampColor[i] * (down / (d2 + 4.0 + rr));
    E += e;
    L += lv * inversesqrt(d2 + 1e-3) * (e.r + e.g + e.b);
  }
  for (int i = 0; i < 2; i++) {
    vec3 lv = uFlashPos[i] - c;
    float d2 = dot(lv, lv);
    vec3 e = uFlashColor[i] / (d2 + 9.0 + rr);
    // soft-saturated: dust / smoke next to a detonation is lit hot orange, not blown to a flat
    // cream-white wall that fills the frame (the flash is ~8700 at the core)
    e *= 12.0 / (12.0 + dot(e, vec3(0.3, 0.5, 0.2)));
    E += e;
    L += lv * inversesqrt(d2 + 1e-3) * (e.r + e.g + e.b);
  }
  for (int i = 0; i < 4; i++) {
    vec3 lv = uFireL[i].xyz - c;
    float d2 = dot(lv, lv);
    vec3 e = uFireCol * (uFireL[i].w / (d2 + uFireR[i] + rr));
    E += e;
    L += lv * inversesqrt(d2 + 1e-3) * (e.r + e.g + e.b);
  }
  vec3 hl = nsHeadlight(c);
  // smoke right in front of the lamps would blow out to a white blob: soft-saturate the beam
  hl *= 10.0 / (10.0 + dot(hl, vec3(0.3, 0.5, 0.2)));
  E += hl;
  L += normalize(uHeadPos - c) * (hl.r + hl.g + hl.b);
  float tot = E.r + E.g + E.b;
  vec3 Lv = mat3(viewMatrix) * L;
  float ll = length(Lv);
  vL = vec4(ll > 1e-6 ? Lv / ll : vec3(0.0, 1.0, 0.0), clamp(ll / max(tot, 1e-6), 0.0, 1.0));
  vE = E;
}
`;

const FRAG = (lampField: string, particleGlsl: string) => /* glsl */ `
${particleGlsl}
${lampField}
${GLSL_FIRE_LIGHTS}
${GLSL_RAMPS}
uniform sampler2D uNoise;
varying vec2 vUv;
varying vec4 vB;
varying vec4 vC;
varying vec4 vD;
varying vec3 vE;
varying vec4 vL;
varying float vDist;
varying float vR;
varying vec3 vNM;
// Weight of a noise octave whose texels would be magnified past ~1.3–2.8 px on screen (bilinear
// texels then read as blocks / posterised steps): fade it to its mean instead. k = texture units
// per billboard radius.
float nsOctaveW(float k) {
  return 1.0 - smoothstep(1.3, 2.8, vNM.z / (k * 256.0));
}
void main() {
  vec2 uv = vUv;
  float r2 = dot(uv, uv);
  float kd = vB.w;
  float kind = floor(kd);
  float dens = fract(kd);
  float heat = vC.x;
  float fade = vC.y;
  float mag = vNM.y;
  float soft = nsSoftFade(vR * 0.45) * smoothstep(0.1 * vR + 0.2, 1.4 * vR + 0.3, vDist) * vNM.x;
  float fogF = 1.0 - exp(-uFogDensity * uFogDensity * vDist * vDist);

  if (kind > 1.5 && kind < 2.5) {
    // Detonation core: white-hot, purely additive. Shaped, not a flat disc: a blinding pinpoint
    // core, a steep radial falloff and uneven radial streaks (jets of burning gas / glare rays)
    // reaching out of it, over a faint warm halo — so the first frames read as a blast, not as a
    // frame-filling white-out once bloom spreads it.
    float w = max(0.0, 1.0 - r2);
    float rr = sqrt(r2);
    float a01 = atan(uv.y, uv.x) * 0.15915 + vB.z * 0.37;
    // integer tilings around the circle: seamless; explicit LOD (the atan seam would pick a coarse mip)
    float sA = textureLod(uNoise, vec2(a01 * 3.0, vB.z * 5.3), 0.0).g;
    float sB = textureLod(uNoise, vec2(a01 * 8.0, vB.z * 2.1 + 0.41), 0.0).r;
    float rays = smoothstep(0.42, 0.8, sA * 0.6 + sB * 0.4);
    rays = rays * rays * exp(-rr * 2.6) * smoothstep(0.03, 0.2, rr);
    // the sprite grows fast: the core tightens with age so the white-hot part stays small in the
    // world (≈ 1 m) instead of swelling into a flat white disc; the rays outlive the core a little
    float tight = 26.0 + vB.y * 900.0;
    float core = exp(-r2 * tight);
    float body = exp(-r2 * (6.5 + vB.y * 120.0)) * (0.28 + 0.22 * rays);
    float g = (core + body + rays * 0.42 + exp(-r2 * 2.2) * 0.035) * w * w;
    vec3 hue = mix(vec3(1.0, 0.68, 0.4), vec3(1.0, 0.93, 0.84), smoothstep(0.05, 0.6, core + 0.3 * rays));
    gl_FragColor = vec4(hue * (140.0 * dens * g * fade * soft * (1.0 - fogF) * (1.0 - 0.6 * mag)), 0.0);
    return;
  }

  float age = vB.y;
  float seed = vB.z;
  float nf = vD.y;
  vec2 o = vec2(fract(seed * 7.31), fract(seed * 3.17)) * 4.0;
  float erode = vD.x;
  if (r2 >= 1.0) discard;

  if (kind > 3.5) {
    // Flame tongue on a vertically stretched quad (uv.y = up): a teardrop body whose sides are
    // pushed around by upward-scrolling noise (more at the top → licking tips), temperature
    // falling with height: white-yellow base → orange → deep red tips. Mostly additive.
    // Shapes come from two smooth low-fbm octaves scrolling at different speeds (the second warped
    // by the first) and rounded Worley cells; the fine high-fbm octave only adds texture where its
    // texels stay below ~2 px, so close up the tongues stay smooth instead of blocky.
    float st = max(1.0, abs(vC.w));
    float h = clamp(uv.y * 0.5 + 0.5, 0.0, 1.0);
    vec2 q = vec2(uv.x, uv.y * st) * nf + o;
    float n1 = texture2D(uNoise, q * 0.55 + vec2(0.0, -age * 1.25)).r;
    float n2 = texture2D(uNoise, q * 1.2 + vec2(n1 * 0.45 + age * 0.2, -age * 2.6)).r;
    float n3 = texture2D(uNoise, q * 0.8 + o.yx + vec2(age * 0.06, -age * 1.8)).b;
    float wG = nsOctaveW(nf * st * 2.4) * 0.8;
    float nG = wG > 0.01 ? mix(0.5, texture2D(uNoise, q * 2.4 + vec2(n2 * 0.3, -age * 3.6)).g, wG) : 0.5;
    float lick = (n1 - 0.5) * 1.25 + (n2 - 0.5) * 0.7 + (nG - 0.5) * 0.25;
    float x = uv.x + lick * (0.12 + 0.9 * h) * 0.6;
    float width = mix(0.92, 0.1, pow(h, 0.75));
    float body = 1.0 - smoothstep(width * 0.15, width, abs(x));
    body *= smoothstep(0.0, 0.26, h);
    body *= 1.0 - smoothstep(0.36 + 0.4 * n1, 1.05, h + (n2 - 0.5) * 0.45);
    float dF = body * (0.5 + 0.5 * n3 + 0.35 * (n2 - 0.5) + 0.5 * (nG - 0.5));
    float aF = smoothstep(erode, erode + 0.48, dF);
    if (aF * fade < 0.003) discard;
    float tF = heat * (1.2 - 0.9 * h) * (0.72 + 0.5 * dF);
    vec3 emF = nsFireRamp(tF) * (0.3 * aF * fade * soft);
    // a tongue right in front of the lens adds less (stacked additive tongues would clip flat)
    float lF = dot(emF, vec3(0.2126, 0.7152, 0.0722));
    float kF = mix(30.0, 5.0, mag);
    emF *= kF / (kF + lF);
    float alF = aF * dens * 0.22 * fade * soft;
    gl_FragColor = vec4(emF * (1.0 - fogF) + uFogColor * (fogF * alF), alF);
    return;
  }

  float cs = cos(vB.x);
  float sn = sin(vB.x);
  vec2 ruv = vec2(cs * uv.x - sn * uv.y, sn * uv.x + cs * uv.y);
  // Large billows (Worley cells + low fbm) boiling slowly, plus fine high-frequency fbm detail.
  vec2 sA = ruv * nf + o + vec2(0.0, -age * 0.045);
  vec2 sB = ruv * (nf * 2.3) + o.yx + vec2(age * 0.03, -age * 0.11);
  vec4 nA = texture2D(uNoise, sA);
  vec4 nB = texture2D(uNoise, sB);
  // magnified billboards: the high-fbm channels fade to their mean before their texels show
  float gA = mix(0.5, nA.g, nsOctaveW(nf));
  float gB = mix(0.5, nB.g, nsOctaveW(nf * 2.3));
  // the radius itself is warped by the noise: no circular silhouettes even on young puffs
  float r2w = min(1.0, r2 * (0.66 + 0.62 * gA + 0.25 * (nB.r - 0.5)));
  float sphere = sqrt(1.0 - r2w);
  float billow = nA.b * 0.62 + nA.r * 0.38;
  float shape = sphere * (0.38 + 0.95 * billow) * (0.84 + 0.3 * gB) - r2 * 0.12;
  // ... and reaches zero before the quad's rim (no hard circular cut where r² = 1 is discarded)
  shape *= 1.0 - smoothstep(0.62, 1.0, r2);
  float holesS = 1.0;
  if (mag > 0.0) {
    // A billow that covers the screen (camera close to / inside it) is eroded by a further, finer
    // pair of smooth octaves boiling through it: holes and dark gaps drift past instead of one
    // flat fill, and it lets the billows behind it show through (depth).
    vec2 sC = ruv * (nf * 4.6) + o * 1.37 + vec2(age * 0.07, -age * 0.17);
    vec4 nC = texture2D(uNoise, sC);
    vec4 nD = texture2D(uNoise, ruv * (nf * 9.5) + o.yx * 2.1 + vec2(-age * 0.11, -age * 0.26));
    float holes = nC.b * 0.5 + nC.r * 0.3 + nD.r * 0.2 + (mix(0.5, nD.g, nsOctaveW(nf * 9.5)) - 0.5) * 0.2;
    holesS = smoothstep(0.32, 0.8, holes);
    shape *= mix(1.0, 0.3 + 1.0 * holesS, mag);
    erode += 0.06 * mag;
  }
  float edge = kind > 0.5 ? 0.4 : 0.3;
  float a = smoothstep(erode, erode + edge, shape);
  if (a * fade < 0.002) discard;

  // Volume lighting without screen-space derivatives (those facet into 2×2 blocks / texel-sized
  // flat patches on magnified noise): march one step towards the light in the billboard plane and
  // attenuate by the density found there (side light), by the puff's own thickness when the light
  // is behind it (thin rims glow: forward scattering), and barely at all when it is front-lit.
  float lightTerm = 1.0;
  float sideL = length(vL.xy);
  float backL = max(0.0, -vL.z);
  if (heat < 0.75 && kind < 2.5) {
    vec2 ld = vL.xy * 0.34;
    vec2 lr = vec2(cs * ld.x - sn * ld.y, sn * ld.x + cs * ld.y);
    vec2 uvL = uv + ld;
    vec4 nAL = texture2D(uNoise, sA + lr * nf);
    vec4 nBL = texture2D(uNoise, sB + lr * (nf * 2.3));
    float r2L = min(1.0, dot(uvL, uvL) * (0.66 + 0.62 * mix(0.5, nAL.g, nsOctaveW(nf)) + 0.25 * (nBL.r - 0.5)));
    float shapeL = sqrt(1.0 - r2L) * (0.38 + 0.95 * (nAL.b * 0.62 + nAL.r * 0.38)) * (0.84 + 0.3 * mix(0.5, nBL.g, nsOctaveW(nf * 2.3))) - r2L * 0.12;
    float occ = max(0.0, shapeL) * sideL * 1.2 + max(0.0, shape) * backL * 1.3;
    float lit = exp(-1.9 * occ) * 1.5 + 0.1 + (1.0 - a) * backL * 0.15;
    lightTerm = mix(1.0, lit, vL.w * 0.9);
  }
  // Thicker interior is self-shadowed against the ambient / omni part too.
  float selfShadow = 1.0 - 0.3 * smoothstep(0.35, 1.1, shape);
  // Sky / city glow: the overcast night sky (lit from below by the city) is a large dim dome that
  // reaches smoke everywhere. Where no street lamp, flash, fire or headlight reaches the puff (unlit
  // rural stretches) it is the only light, so it is lifted to a believable minimum there (the engine's
  // night adaptation only reaches materials lit through three's lights) and fades out where the
  // local lights dominate (no milky smoke under street lamps). The top of a billow (facing the sky)
  // is brighter than its underside; the rain mist around it adds multiple scattering, so even soot
  // never goes to a flat black silhouette (effective albedo floor).
  float lumE = dot(vE, vec3(0.3, 0.5, 0.2));
  float skyW = 0.35 / (0.35 + lumE);
  float topF = 0.62 + 0.38 * clamp(uv.y * 0.55 + 0.5, 0.0, 1.0);
  // (the overcast is lit by the city's sodium / LED glow: warm-neutral grey, not the cool fill)
  vec3 skyCol = mix(uAmbient, vec3(dot(uAmbient, vec3(0.3, 0.5, 0.2))) * vec3(1.12, 0.98, 0.82), 0.75 * skyW);
  vec3 skyIrr = skyCol * ((3.0 + 28.0 * skyW) * topF * selfShadow);
  vec3 irr = vE * lightTerm * selfShadow;
  float alb = vC.z;
  float albSky = alb + 0.07 * (1.0 - alb);
  // slightly warm grey-brown smoke (unburnt fuel, oil, rubber)
  vec3 smokeCol = (alb * irr + albSky * skyIrr) * (0.3183 * vec3(1.0, 0.94, 0.86));

  vec3 emis = vec3(0.0);
  float alpha;
  if (kind < 0.5 || kind > 2.5) {
    // Local temperature: hotter where the puff is dense, cooler at its eroded edges.
    float tn = nA.r * 0.55 + gB * 0.45;
    // Strong spatial contrast: only the hot spots of the dense interior reach white-yellow; the
    // rest of the billow stays orange, its thin parts deep red (no uniform pale-peach fill).
    float hot = smoothstep(0.32, 0.74, tn);
    float t = heat * clamp(0.2 + shape * (0.42 + 0.78 * hot), 0.0, 1.12);
    // soot veins: the fire is broken up by darker filaments of unburnt fuel smoke
    float veins = 0.2 + 0.8 * smoothstep(0.24, 0.66, tn);
    // seen from inside: the flame is concentrated in turbulent filaments (hot → yellow, their
    // rims cooler → orange / deep red) with the soot between them left dark
    t *= mix(1.0, 0.45 + 0.75 * holesS, mag);
    veins *= mix(1.0, holesS * 1.2, mag);
    emis = (kind > 2.5 ? nsNitroRamp(t) : nsFireRamp(t) * veins) * a;
    // Fireballs are optically thick: hot puffs stay fairly opaque so the front layer dominates
    // (no additive white-out); nitro licks are purely additive.
    float soot = kind > 2.5 ? 0.0 : 1.0 - 0.38 * smoothstep(0.45, 1.0, heat);
    alpha = a * dens * soot;
  } else {
    alpha = a * dens;
  }
  // A billow filling the screen is thinned (see-through to the layers behind) and its emission is
  // soft-limited, so stacked fire layers roll off towards a bright core instead of clipping to one
  // flat tone-mapped colour: white-yellow only where it is really hot, orange / deep red around it.
  float thin = 1.0 - 0.4 * mag;
  alpha *= fade * soft * thin;
  emis *= fade * soft * thin;
  float lE = dot(emis, vec3(0.2126, 0.7152, 0.0722));
  float kE = mix(80.0, 5.0, mag);
  emis *= kE / (kE + lE);
  vec3 rgb = (emis + smokeCol * alpha) * (1.0 - fogF) + uFogColor * (fogF * alpha);
  gl_FragColor = vec4(rgb, alpha);
}
`;
