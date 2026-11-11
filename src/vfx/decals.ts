/**
 * Scorch marks: flat alpha quads just above the road (LAYERS.DEFAULT, one instanced draw call,
 * pool of 6). Procedural soot blotch with radial blast streaks from tiling noise; glowing embers
 * in the centre for the first seconds; fades out after 60 s. Lit by lamps / flashes / headlight.
 */
import {
  BufferAttribute,
  DynamicDrawUsage,
  FrontSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';
import type { Texture } from 'three';
import { LAYERS } from '../core/types';
import type { ILighting } from '../core/types';
import { premultipliedBlend } from './common';

export const DECAL_POOL = 6;
const HOLD = 60;
const FADE = 8;

export class ScorchDecals {
  readonly mesh: Mesh;
  private material: ShaderMaterial;
  private geometry: InstancedBufferGeometry;
  private aA: InstancedBufferAttribute;
  private aB: InstancedBufferAttribute;
  private x = new Float32Array(DECAL_POOL);
  private z = new Float32Array(DECAL_POOL);
  private r = new Float32Array(DECAL_POOL);
  private rot = new Float32Array(DECAL_POOL);
  private age = new Float32Array(DECAL_POOL);
  private seed = new Float32Array(DECAL_POOL);
  private heat = new Float32Array(DECAL_POOL);
  private alive = new Uint8Array(DECAL_POOL);
  private next = 0;

  constructor(lighting: ILighting, noise: Texture) {
    const g = new InstancedBufferGeometry();
    // flat quad in XZ facing up (+Y), corners at ±1
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, 0, 1, 1, 0, 1, 1, 0, -1, -1, 0, -1]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.aA = new InstancedBufferAttribute(new Float32Array(DECAL_POOL * 4), 4);
    this.aB = new InstancedBufferAttribute(new Float32Array(DECAL_POOL * 4), 4);
    this.aA.setUsage(DynamicDrawUsage);
    this.aB.setUsage(DynamicDrawUsage);
    g.setAttribute('iA', this.aA);
    g.setAttribute('iB', this.aB);
    g.instanceCount = 0;
    g.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.geometry = g;
    this.material = premultipliedBlend(
      new ShaderMaterial({
        name: 'vfx_scorch',
        side: FrontSide,
        uniforms: { ...lighting.uniforms, uNoise: { value: noise } },
        vertexShader: /* glsl */ `
attribute vec4 iA; // x, z, radius, rotation
attribute vec4 iB; // opacity, seed, ember heat, -
varying vec2 vUv;
varying vec4 vB;
varying vec3 vW;
void main() {
  float c = cos(iA.w), s = sin(iA.w);
  vec2 p = vec2(c * position.x - s * position.z, s * position.x + c * position.z) * iA.z;
  vec3 w = vec3(iA.x + p.x, 0.018, iA.y + p.y);
  vW = w;
  vUv = position.xz;
  vB = iB;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`,
        fragmentShader: /* glsl */ `
${lighting.glslLampField}
uniform sampler2D uNoise;
varying vec2 vUv;
varying vec4 vB;
varying vec3 vW;
void main() {
  vec2 uv = vUv;
  float rr = length(uv);
  if (rr > 1.0) discard;
  float seed = vB.y;
  float ang = atan(uv.y, uv.x);
  vec2 o = vec2(seed * 3.7, seed * 1.9);
  // blotch: irregular soot core
  float n1 = texture2D(uNoise, uv * 0.45 + o).r;
  float n2 = texture2D(uNoise, uv * 1.3 + o.yx).g;
  float core = 1.0 - smoothstep(0.25, 0.78, rr + (n1 - 0.5) * 0.55 + (n2 - 0.5) * 0.18);
  // radial blast streaks (noise stretched in polar coordinates)
  float st = texture2D(uNoise, vec2(ang * 0.95 + seed * 5.0, rr * 0.06 + seed)).r;
  float streak = smoothstep(0.45, 0.75, st) * (1.0 - smoothstep(0.35, 1.0, rr)) * smoothstep(0.1, 0.4, rr);
  float a = clamp(core * 0.92 + streak * 0.55, 0.0, 0.94) * vB.x;
  if (a < 0.003) discard;
  // soot lit by lamps / flashes / headlight (very dark albedo, wet sheen ignored)
  vec3 irr = nsLampLightN(vW, vec3(0.0, 1.0, 0.0)) + nsHeadlight(vW) * 0.5 + uAmbient;
  vec3 col = vec3(0.018, 0.016, 0.014) * irr * 0.3183;
  // glowing embers in the centre while hot
  float cells = texture2D(uNoise, uv * 1.7 + o * 2.0).b;
  float ember = smoothstep(0.62, 0.9, cells) * (1.0 - smoothstep(0.1, 0.6, rr)) * vB.z;
  vec3 emis = vec3(5.0, 1.1, 0.15) * ember * (0.75 + 0.25 * sin(uTime * 7.0 + cells * 30.0));
  float dist = length(vW - cameraPosition);
  float fogF = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  vec3 rgb = (col * a + emis * a) * (1.0 - fogF) + uFogColor * fogF * a;
  gl_FragColor = vec4(rgb, a);
}`,
      }),
    );
    this.material.polygonOffset = true;
    this.material.polygonOffsetFactor = -2;
    this.material.polygonOffsetUnits = -2;
    this.mesh = new Mesh(g, this.material);
    this.mesh.name = 'vfx_scorch';
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYERS.DEFAULT);
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
  }

  add(x: number, z: number, radius: number, seed: number): void {
    const i = this.next;
    this.next = (this.next + 1) % DECAL_POOL;
    this.x[i] = x;
    this.z[i] = z;
    this.r[i] = radius;
    this.rot[i] = seed * 6.283;
    this.seed[i] = seed;
    this.age[i] = 0;
    this.heat[i] = 1;
    this.alive[i] = 1;
  }

  clear(): void {
    this.alive.fill(0);
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  update(dt: number): void {
    const A = this.aA.array as Float32Array;
    const B = this.aB.array as Float32Array;
    let n = 0;
    for (let i = 0; i < DECAL_POOL; i++) {
      if (!this.alive[i]) continue;
      const a = (this.age[i] += dt);
      if (a > HOLD + FADE) {
        this.alive[i] = 0;
        continue;
      }
      const fadeIn = Math.min(1, a / 0.25);
      const op = fadeIn * (a > HOLD ? 1 - (a - HOLD) / FADE : 1);
      const j = n * 4;
      A[j] = this.x[i];
      A[j + 1] = this.z[i];
      A[j + 2] = this.r[i];
      A[j + 3] = this.rot[i];
      B[j] = op;
      B[j + 1] = this.seed[i];
      B[j + 2] = Math.max(0, 1 - a / 9) ** 1.5;
      B[j + 3] = 0;
      n++;
    }
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.aA.needsUpdate = true;
      this.aB.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
