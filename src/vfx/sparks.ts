/**
 * Hot streaks: metal sparks (velocity-stretched quads, gravity, air drag, ground bounce with
 * energy loss, colour cooling yellow → orange → red, HDR ≈ 30 → 3), floating embers and glass
 * glitter (lamp/headlight-lit glints). One instanced, additive draw call.
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
import { LAYERS } from '../core/types';
import type { ILighting, IParticleShared } from '../core/types';
import { WIND, premultipliedBlend } from './common';

export const SPARK = 0;
export const EMBER = 1;
export const GLASS = 2;

export class SparkSpawn {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  life = 1;
  heat = 1;
  /** Cooling rate (1/s). */
  cool = 1.2;
  /** Streak half-width (m). */
  size = 0.018;
  drag = 0.5;
  /** Gravity multiplier (embers float: < 0.2). */
  grav = 1;
  /** Restitution on ground bounce. */
  bounce = 0.35;
  kind = SPARK;
}

const F = Float32Array;

export class SparkSystem {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  readonly spawn = new SparkSpawn();
  readonly capacity: number;
  budget: number;
  count = 0;
  peak = 0;
  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private heat: Float32Array;
  private cool: Float32Array;
  private size: Float32Array;
  private drag: Float32Array;
  private grav: Float32Array;
  private bounce: Float32Array;
  private kind: Float32Array;
  private seed: Float32Array;
  private aP: InstancedBufferAttribute;
  private aV: InstancedBufferAttribute;
  private aK: InstancedBufferAttribute;
  private geometry: InstancedBufferGeometry;
  private seedCounter = 0;

  constructor(capacity: number, lighting: ILighting, particles: IParticleShared) {
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
    this.heat = new F(n);
    this.cool = new F(n);
    this.size = new F(n);
    this.drag = new F(n);
    this.grav = new F(n);
    this.bounce = new F(n);
    this.kind = new F(n);
    this.seed = new F(n);
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(new F([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = () => {
      const a = new InstancedBufferAttribute(new F(n * 4), 4);
      a.setUsage(DynamicDrawUsage);
      return a;
    };
    this.aP = mk();
    this.aV = mk();
    this.aK = mk();
    g.setAttribute('iP', this.aP);
    g.setAttribute('iV', this.aV);
    g.setAttribute('iK', this.aK);
    g.instanceCount = 0;
    g.boundingSphere = new Sphere(new Vector3(), 1);
    this.geometry = g;
    this.material = premultipliedBlend(
      new ShaderMaterial({
        name: 'vfx_sparks',
        side: DoubleSide,
        uniforms: { ...lighting.uniforms, ...particles.uniforms, uShutter: { value: 0.028 }, uVfxTime: { value: 0 } },
        vertexShader: VERT(lighting.glslLampField),
        fragmentShader: FRAG(lighting.glslLampField, particles.glsl),
      }),
    );
    this.mesh = new Mesh(g, this.material);
    this.mesh.name = 'vfx_sparks';
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYERS.PARTICLES);
    this.mesh.renderOrder = 11;
    this.mesh.visible = false;
  }

  emit(): boolean {
    let i = this.count;
    if (i >= this.budget) {
      i = (this.seedCounter * 13) % this.count; // overwrite an arbitrary one (sparks are short-lived)
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
    this.heat[i] = s.heat;
    this.cool[i] = s.cool;
    this.size[i] = s.size;
    this.drag[i] = s.drag;
    this.grav[i] = s.grav;
    this.bounce[i] = s.bounce;
    this.kind[i] = s.kind;
    this.seed[i] = ((this.seedCounter++ * 0.754877) % 1 + 1) % 1;
    return true;
  }

  clear(): void {
    this.count = 0;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  update(dt: number, time: number): void {
    (this.material.uniforms.uVfxTime as { value: number }).value = time;
    let n = this.count;
    if (n === 0) {
      this.mesh.visible = false;
      return;
    }
    const { px, py, pz, vx, vy, vz, age, life, heat } = this;
    const P = this.aP.array as Float32Array;
    const V = this.aV.array as Float32Array;
    const K = this.aK.array as Float32Array;
    let bx0 = 1e9, by0 = 1e9, bz0 = 1e9, bx1 = -1e9, by1 = -1e9, bz1 = -1e9;
    for (let i = 0; i < n; i++) {
      const a = age[i] + dt;
      const h = heat[i] * Math.exp(-this.cool[i] * dt);
      if (a >= life[i] || (h < 0.03 && this.kind[i] !== GLASS)) {
        n--;
        if (i < n) {
          this.copy(n, i);
          i--;
        }
        continue;
      }
      age[i] = a;
      heat[i] = h;
      const e = Math.exp(-this.drag[i] * dt);
      const k = this.kind[i];
      if (k === EMBER) {
        // Embers ride the rising hot air and the wind.
        vx[i] = WIND.x + (vx[i] - WIND.x) * e + Math.sin(a * 3.1 + this.seed[i] * 50) * 1.6 * dt;
        vz[i] = WIND.z + (vz[i] - WIND.z) * e + Math.cos(a * 2.7 + this.seed[i] * 31) * 1.6 * dt;
        vy[i] = vy[i] * e + (1.2 * h - 9.81 * this.grav[i]) * dt;
      } else {
        vx[i] *= e;
        vz[i] *= e;
        vy[i] = vy[i] * e - 9.81 * this.grav[i] * dt;
      }
      px[i] += vx[i] * dt;
      py[i] += vy[i] * dt;
      pz[i] += vz[i] * dt;
      if (py[i] < 0.012) {
        py[i] = 0.012;
        if (vy[i] < 0) {
          const b = this.bounce[i];
          vy[i] = -vy[i] * b * (0.6 + 0.8 * fract(this.seed[i] * 17 + a));
          vx[i] *= 0.45 + 0.3 * b;
          vz[i] *= 0.45 + 0.3 * b;
          if (k === SPARK) heat[i] *= 0.82;
        } else if (k === GLASS) {
          // sliding on the wet road
          const f = Math.exp(-3 * dt);
          vx[i] *= f;
          vz[i] *= f;
        }
      }
      const j = i * 4;
      P[j] = px[i];
      P[j + 1] = py[i];
      P[j + 2] = pz[i];
      P[j + 3] = this.size[i];
      V[j] = vx[i];
      V[j + 1] = vy[i];
      V[j + 2] = vz[i];
      V[j + 3] = h;
      K[j] = k;
      K[j + 1] = this.seed[i];
      K[j + 2] = a / life[i];
      K[j + 3] = 0;
      if (px[i] < bx0) bx0 = px[i];
      if (py[i] < by0) by0 = py[i];
      if (pz[i] < bz0) bz0 = pz[i];
      if (px[i] > bx1) bx1 = px[i];
      if (py[i] > by1) by1 = py[i];
      if (pz[i] > bz1) bz1 = pz[i];
    }
    this.count = n;
    if (n > this.peak) this.peak = n;
    // Swap-remove above may have moved a later (not yet written) particle into slot i; it is
    // written when the loop revisits i, so the arrays are consistent for [0, n).
    if (n === 0) {
      this.geometry.instanceCount = 0;
      this.mesh.visible = false;
      return;
    }
    const bs = this.geometry.boundingSphere as Sphere;
    bs.center.set((bx0 + bx1) * 0.5, (by0 + by1) * 0.5, (bz0 + bz1) * 0.5);
    bs.radius = 0.5 * Math.hypot(bx1 - bx0, by1 - by0, bz1 - bz0) + 1;
    for (const at of this.attrs) {
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * 4);
      at.needsUpdate = true;
    }
    this.geometry.instanceCount = n;
    this.mesh.visible = true;
  }

  private get attrs(): readonly InstancedBufferAttribute[] {
    return this._attrs ?? (this._attrs = [this.aP, this.aV, this.aK]);
  }
  private _attrs: InstancedBufferAttribute[] | null = null;

  private copy(src: number, dst: number): void {
    this.px[dst] = this.px[src];
    this.py[dst] = this.py[src];
    this.pz[dst] = this.pz[src];
    this.vx[dst] = this.vx[src];
    this.vy[dst] = this.vy[src];
    this.vz[dst] = this.vz[src];
    this.age[dst] = this.age[src];
    this.life[dst] = this.life[src];
    this.heat[dst] = this.heat[src];
    this.cool[dst] = this.cool[src];
    this.size[dst] = this.size[src];
    this.drag[dst] = this.drag[src];
    this.grav[dst] = this.grav[src];
    this.bounce[dst] = this.bounce[src];
    this.kind[dst] = this.kind[src];
    this.seed[dst] = this.seed[src];
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}

function fract(x: number): number {
  return x - Math.floor(x);
}

const VERT = (lampField: string) => /* glsl */ `
${lampField}
attribute vec4 iP; // pos, half width
attribute vec4 iV; // velocity, heat
attribute vec4 iK; // kind, seed, life01, -
uniform float uShutter;
uniform float uVfxTime;
uniform vec2 uResolution;
varying vec2 vUv;
varying vec3 vCol;
varying float vDist;
// streak length between the two cap centres, in half-widths (0 = round dot)
varying float vLen;
void main() {
  vec3 p = iP.xyz;
  float kind = iK.x;
  float seed = iK.y;
  float heat = iV.w;
  vec3 vel = iV.xyz;
  // embers / glass: a slight stretch along the velocity even when slow (soft motion blur)
  float shutter = kind > 0.5 ? uShutter * 0.6 : uShutter;
  vec4 h = viewMatrix * vec4(p, 1.0);
  vec4 t = viewMatrix * vec4(p - vel * shutter, 1.0);
  // keep both ends in front of the camera
  if (t.z > -0.05) t = h;
  vDist = length(h.xyz);
  float zh = max(-h.z, 0.05);
  // Near the lens: fade out (gone below 0.25 m, full by 1.2 m) and collapse when invisible.
  float nearF = smoothstep(0.25, 1.2, -h.z);
  if (nearF <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // On-screen half-width clamped to [1.1, 7] px (render-target pixels). Below the minimum the
  // dot keeps its minimum size and dims with its true area instead (no snapping to 2-px blocks);
  // above the maximum it stays a small soft dot (a near ember never becomes a tile).
  float pxPerM = projectionMatrix[1][1] * 0.5 * uResolution.y / zh;
  float wPx = iP.w * pxPerM;
  float wMinPx = 1.25;
  float wMaxPx = 7.0;
  float w = clamp(wPx, wMinPx, wMaxPx) / pxPerM;
  float ratio = min(1.0, wPx / wMinPx);
  vec2 axis = h.xy / zh - t.xy / max(-t.z, 0.05);
  float al = length(axis);
  vec2 dir = al > 1e-6 ? axis / al : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  // streak length in half-widths (in the head's depth plane)
  float len = al * zh / w;
  vLen = len;
  // sub-minimum: a round dot dims with its area (ratio²), a streak with its width (ratio)
  float energy = ratio * mix(ratio, 1.0, clamp(len / (len + 2.0), 0.0, 1.0)) * nearF;
  // corner: x = -1 tail, +1 head; y = side (both ends extended by one half-width: round caps)
  vec4 e = position.x > 0.0 ? h : t;
  e.xy += dir * position.x * w + perp * position.y * w;
  gl_Position = projectionMatrix * e;
  vUv = position.xy;
  // Streak energy is spread along its length (longer = dimmer per pixel, like a real exposure).
  float lenWorld = length(h.xyz - t.xyz) + 2.0 * w;
  float spread = clamp((2.0 * w + 0.05) / lenWorld, 0.08, 1.0);
  vec3 col;
  if (kind < 0.5) {
    // spark: 30 (yellow-white) → 8 (orange) → 3 (red)
    vec3 c = mix(vec3(3.0, 0.42, 0.06), vec3(9.0, 3.4, 0.7), smoothstep(0.2, 0.55, heat));
    c = mix(c, vec3(30.0, 22.0, 10.0), smoothstep(0.55, 0.95, heat));
    col = c * smoothstep(0.0, 0.12, heat) * mix(1.0, spread * 3.0, 0.6);
  } else if (kind < 1.5) {
    // ember: flickering orange
    float fl = 0.65 + 0.35 * sin(uVfxTime * (9.0 + seed * 13.0) + seed * 40.0);
    col = mix(vec3(2.4, 0.35, 0.05), vec3(9.0, 3.6, 0.8), smoothstep(0.3, 0.9, heat)) * fl * smoothstep(0.0, 0.15, heat);
  } else {
    // glass glitter: lamp + headlight lit glints
    vec3 irr = nsLampLight(p) + nsHeadlight(p) + uAmbient * 4.0;
    float tw = sin(uVfxTime * (14.0 + seed * 20.0) + seed * 60.0);
    float glint = 0.12 + 3.5 * pow(max(tw, 0.0), 12.0);
    col = irr * glint * vec3(0.8, 0.9, 1.0) * 0.12;
  }
  vCol = col * energy;
}
`;

const FRAG = (lampField: string, particleGlsl: string) => /* glsl */ `
${particleGlsl}
${lampField}
varying vec2 vUv;
varying vec3 vCol;
varying float vDist;
varying float vLen;
void main() {
  // Soft round capsule: distance to the segment between the two cap centres, in half-widths.
  float L = vLen;
  float x = (vUv.x * 0.5 + 0.5) * (L + 2.0) - 1.0;
  float dx = x - clamp(x, 0.0, L);
  float d2 = dx * dx + vUv.y * vUv.y;
  if (d2 >= 1.0) discard;
  float core = exp(-d2 * 3.0) * (1.0 - d2);
  // brighter head, dimmer tail (exposure of a cooling, decelerating streak)
  float along = 0.55 + 0.45 * smoothstep(0.0, max(L, 1e-3), x);
  float i = 1.3 * core * along;
  float fogT = exp(-uFogDensity * uFogDensity * vDist * vDist);
  gl_FragColor = vec4(vCol * (i * fogT * nsSoftFade(0.15)), 0.0);
}
`;
