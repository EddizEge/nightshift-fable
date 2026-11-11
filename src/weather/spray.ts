/**
 * Tyre spray: a pooled CPU particle system (fixed pool, free-list allocation, zero per-frame
 * allocations) rendered as ONE instanced draw call in the particle pass.
 *
 * Two particle kinds share the buffer:
 *   0 = mist   — noise-eroded soft billboards that grow, drag to the (wake) air speed and lift
 *   1 = drops  — small bright droplets with gravity, stretched along their screen velocity
 * Lighting per particle (vertex shader): ambient + street lamps (isotropic + forward scatter)
 * + the player's headlight (with forward-scatter boost) + up to 8 nearby tail lamps (red glow
 * in the spray right behind each vehicle). Premultiplied alpha, fog, soft-particle fade.
 */
import {
  CustomBlending,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  LinearMipmapLinearFilter,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RepeatWrapping,
  ShaderMaterial,
  TextureLoader,
  Vector4,
} from 'three';
import type { Texture } from 'three';
import type { GameContext } from '../core/types';
import { LAYERS } from '../core/types';
import { assetUrl } from '../world/materials';
import { WEATHER_GLSL } from './shared';
import type { WeatherUniforms } from './shared';

export const MAX_TAILS = 8;
const STRIDE = 10; // pos3 vel3 params4 (size, age01, seed, kind + alpha)

const VERT = /* glsl */ `
#define NS_MAX_TAILS ${MAX_TAILS}
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aP;
uniform vec4 uTailPos[NS_MAX_TAILS];
uniform vec4 uTailDir[NS_MAX_TAILS];
uniform float uSprayShutter;
varying vec3 vColor;
varying vec2 vUv;
varying vec4 vInfo; // age, seed, kind, alpha
varying float vSizeM;
varying float vSpeck;
void main() {
  float size = aP.x;
  if (size <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float age = aP.y;
  float seed = aP.z;
  float kind = floor(aP.w);
  float alpha = fract(aP.w);
  vec3 p = aPos;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float depth = -mv.z;
  if (depth < 0.05) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }

  vec2 ax;
  float sx = size;
  float sy = size;
  vec2 vv = (viewMatrix * vec4(aVel - uWCamVel, 0.0)).xy;
  float vl = length(vv);
  if (kind > 0.5) {
    ax = vl > 1e-3 ? vv / vl : vec2(1.0, 0.0);
    sx = size + vl * uSprayShutter;
  } else {
    // mist: slightly streaked along its motion relative to the camera (atomised water, not puffs)
    float st = min(vl * uSprayShutter * 4.0 / size, 1.6);
    float ang = seed * NS_TAU + age * (seed - 0.5) * 2.0;
    vec2 rd = vec2(cos(ang), sin(ang));
    ax = st > 0.08 && vl > 1e-3 ? normalize(mix(rd, vv / vl, min(st * 3.0, 1.0))) : rd;
    sx = size * (1.0 + st);
    sy = size * (1.0 - 0.3 * min(st, 1.0));
  }
  vec2 ay = vec2(-ax.y, ax.x);
  mv.xy += ax * (position.x * sx) + ay * (position.y * sy);
  vSpeck = max(0.05, size * projectionMatrix[1][1] * 0.5 * uWViewport.y / depth / 45.0);
  gl_Position = projectionMatrix * mv;

  // life curve: quick fade-in, long soft fade-out
  float life = smoothstep(0.0, 0.07, age) * (1.0 - age) * (1.0 - age * 0.5);
  float a = alpha * life;
  // close to the lens: fade (but keep enough to briefly reduce visibility inside a spray wall)
  a *= kind > 0.5 ? smoothstep(1.5, 4.0, depth) : mix(0.0, 1.0, smoothstep(0.4, 3.2, depth));

  vec3 V = normalize(p - cameraPosition);
  vec3 fwd = vec3(0.0);
  for (int i = 0; i < NS_MAX_LAMPS; i++) {
    vec3 lv = uLampPos[i] - p;
    float r2 = dot(lv, lv);
    float cf = max(dot(lv * inversesqrt(max(r2, 1e-4)), V), 0.0);
    float cf4 = cf * cf; cf4 *= cf4;
    fwd += uLampColor[i] * (cf4 * cf4 / (r2 + 6.0));
  }
  vec3 tail = vec3(0.0);
  for (int j = 0; j < NS_MAX_TAILS; j++) {
    vec3 tv = p - uTailPos[j].xyz;
    float r2 = dot(tv, tv);
    float face = 0.25 + 0.75 * max(dot(tv * inversesqrt(max(r2, 1e-4)), uTailDir[j].xyz), 0.0);
    tail += vec3(1.0, 0.06, 0.025) * (uTailPos[j].w * face * face / (r2 * r2 * 0.35 + r2 + 0.6));
  }
  float hc = max(dot(normalize(p - uHeadPos), V), 0.0);
  float hcp = hc * hc; hcp *= hcp; hcp *= hcp;
  // headlights: mostly forward-scattered away from the viewer, so a spray wall ahead reads grey, not glowing
  vec3 head = nsHeadlight(p) * (0.0032 * nsBeamCut(p) * (0.6 + 0.9 * hcp));
  vec3 rad = uAmbient * 2.0 + nsLampLight(p) * 0.022 + fwd * 0.035 + head + tail;
  if (kind > 0.5) rad *= 2.2;
  float dist = length(p - cameraPosition);
  float fogF = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  vColor = mix(rad, uFogColor, fogF);
  vUv = position.xy;
  vInfo = vec4(age, seed, kind, a);
  vSizeM = size;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uNoise;
varying vec3 vColor;
varying vec2 vUv;
varying vec4 vInfo;
varying float vSizeM;
varying float vSpeck;
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float age = vInfo.x;
  float seed = vInfo.y;
  float a;
  float spark = 0.0;
  if (vInfo.z > 0.5) {
    a = vInfo.w * smoothstep(1.0, 0.15, r2);
  } else {
    // noise-eroded soft billboard: low-freq body eroded with age, high-freq grain and
    // screen-scaled droplet speckle (Worley cells) so it reads as atomised water, not smoke
    vec2 nuv = vUv * (0.16 + 0.05 * vSizeM) + vec2(seed * 7.31, seed * 3.17 + age * 0.25);
    vec4 n = texture2D(uNoise, nuv);
    vec4 g = texture2D(uNoise, vUv * (0.4 + 0.25 * vSizeM) + vec2(seed * 11.7, seed * 5.3 - age * 0.4));
    float sp = texture2D(uNoise, vUv * vSpeck + vec2(seed * 3.7, seed * 9.1)).b;
    float body = (1.0 - r2);
    body *= body;
    float dens = body * (0.3 + 1.25 * n.r) - age * 0.5 - 0.06;
    dens = clamp(dens * 1.7, 0.0, 1.0);
    dens *= mix(0.35, 1.45, g.g);
    float dots = smoothstep(0.8, 0.97, sp) * clamp(dens * 3.0, 0.0, 1.0);
    a = vInfo.w * (dens * 0.9 + dots * 0.25);
    spark = dots;
  }
  a *= nsSoftFade(vInfo.z > 0.5 ? 0.1 : 0.7);
  gl_FragColor = vec4(vColor * (a * (1.0 + 0.6 * spark)), a * 0.7);
}
`;

let noiseTex: Texture | null = null;
function getNoise(): Texture {
  if (!noiseTex) {
    noiseTex = new TextureLoader().load(assetUrl('assets/textures/noise_rgba.png'));
    noiseTex.wrapS = noiseTex.wrapT = RepeatWrapping;
    noiseTex.minFilter = LinearMipmapLinearFilter;
  }
  return noiseTex;
}

export interface EmitParams {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  size0: number; size1: number; life: number;
  kind: 0 | 1; alpha: number;
  drag: number; lift: number; grav: number;
  wakeX: number; wakeZ: number;
}

export class SprayPool {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly cap: number;
  alive = 0;
  private data: Float32Array;
  private buffer: InstancedInterleavedBuffer;
  // CPU-only state
  private age: Float32Array;
  private life: Float32Array;
  private size0: Float32Array;
  private size1: Float32Array;
  private drag: Float32Array;
  private lift: Float32Array;
  private grav: Float32Array;
  private wake: Float32Array;
  private free: Int32Array;
  private freeTop = 0;
  private aliveFlag: Uint8Array;
  private seedCounter = 0;
  readonly tailPos: Vector4[] = [];
  readonly tailDir: Vector4[] = [];
  private u: Record<string, { value: unknown }>;

  constructor(ctx: GameContext, wu: WeatherUniforms, cap: number) {
    this.cap = Math.max(128, Math.round(cap));
    const n = this.cap;
    this.data = new Float32Array(n * STRIDE);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.size1 = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.lift = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.wake = new Float32Array(n * 2);
    this.free = new Int32Array(n);
    this.aliveFlag = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.free[i] = n - 1 - i;
    this.freeTop = n;
    for (let i = 0; i < MAX_TAILS; i++) {
      this.tailPos.push(new Vector4(0, -1000, 0, 0));
      this.tailDir.push(new Vector4(0, 0, 1, 0));
    }

    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 2, 1, 3]);
    this.buffer = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(DynamicDrawUsage);
    geo.setAttribute('aPos', new InterleavedBufferAttribute(this.buffer, 3, 0));
    geo.setAttribute('aVel', new InterleavedBufferAttribute(this.buffer, 3, 3));
    geo.setAttribute('aP', new InterleavedBufferAttribute(this.buffer, 4, 6));
    geo.instanceCount = n;
    this.u = {
      uTailPos: { value: this.tailPos },
      uTailDir: { value: this.tailDir },
      uSprayShutter: { value: 1 / 48 },
      uNoise: { value: getNoise() },
    };
    const mat = new ShaderMaterial({
      name: 'nsTyreSpray',
      uniforms: { ...ctx.lighting.uniforms, ...ctx.engine.particles.uniforms, ...wu, ...this.u },
      vertexShader: ctx.lighting.glslLampField + WEATHER_GLSL + VERT,
      fragmentShader: ctx.engine.particles.glsl + FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
      fog: false,
    });
    this.mesh = new Mesh(geo, mat);
    this.mesh.name = 'tyreSpray';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.layers.set(LAYERS.PARTICLES);
  }

  /** Free slots available. */
  get freeCount(): number {
    return this.freeTop;
  }

  emit(e: EmitParams): void {
    if (this.freeTop === 0) return;
    const i = this.free[--this.freeTop];
    this.aliveFlag[i] = 1;
    this.alive++;
    const o = i * STRIDE;
    const d = this.data;
    d[o] = e.x; d[o + 1] = e.y; d[o + 2] = e.z;
    d[o + 3] = e.vx; d[o + 4] = e.vy; d[o + 5] = e.vz;
    d[o + 6] = e.size0;
    d[o + 7] = 0;
    this.seedCounter = (this.seedCounter + 0.6180339887) % 1;
    d[o + 8] = this.seedCounter;
    d[o + 9] = e.kind + Math.min(0.998, Math.max(0.001, e.alpha));
    this.age[i] = 0;
    this.life[i] = Math.max(0.05, e.life);
    this.size0[i] = e.size0;
    this.size1[i] = e.size1;
    this.drag[i] = e.drag;
    this.lift[i] = e.lift;
    this.grav[i] = e.grav;
    this.wake[i * 2] = e.wakeX;
    this.wake[i * 2 + 1] = e.wakeZ;
  }

  private kill(i: number): void {
    this.aliveFlag[i] = 0;
    this.data[i * STRIDE + 6] = 0;
    this.free[this.freeTop++] = i;
    this.alive--;
  }

  update(dt: number, windX: number, windZ: number, shutter: number): void {
    (this.u.uSprayShutter as { value: number }).value = shutter;
    const d = this.data;
    if (dt > 0 && this.alive > 0) {
      for (let i = 0; i < this.cap; i++) {
        if (!this.aliveFlag[i]) continue;
        const age = this.age[i] + dt;
        const life = this.life[i];
        if (age >= life) {
          this.kill(i);
          continue;
        }
        this.age[i] = age;
        const o = i * STRIDE;
        const t = age / life;
        const wk = Math.exp(-age * 1.6);
        const ax = windX + this.wake[i * 2] * wk;
        const az = windZ + this.wake[i * 2 + 1] * wk;
        const k = 1 - Math.exp(-this.drag[i] * dt);
        let vx = d[o + 3];
        let vy = d[o + 4];
        let vz = d[o + 5];
        vx += (ax - vx) * k;
        vz += (az - vz) * k;
        vy += -vy * k * 0.6 + (this.lift[i] - this.grav[i]) * dt;
        let y = d[o + 1] + vy * dt;
        if (y < 0.03) {
          if (this.grav[i] > 1) {
            this.kill(i);
            continue;
          }
          y = 0.03;
          if (vy < 0) vy = 0;
        }
        d[o] += vx * dt;
        d[o + 1] = y;
        d[o + 2] += vz * dt;
        d[o + 3] = vx;
        d[o + 4] = vy;
        d[o + 5] = vz;
        // ease-out growth
        const g = 1 - (1 - t) * (1 - t);
        d[o + 6] = this.size0[i] + (this.size1[i] - this.size0[i]) * g;
        d[o + 7] = t;
      }
    }
    this.buffer.needsUpdate = true;
    this.mesh.visible = this.alive > 0;
  }

  clear(): void {
    for (let i = 0; i < this.cap; i++) if (this.aliveFlag[i]) this.kill(i);
    this.buffer.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
