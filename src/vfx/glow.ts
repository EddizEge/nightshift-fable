/**
 * Ground light pools: flat additive quads just above the road (y = 0) for the warm flickering
 * light a fire throws on the wet asphalt and the bluish pool under the nitro flames. One instanced
 * draw call; pushed every frame by the caller (begin → push … → end), no allocations.
 * Drawn only in the main view (skipped in the planar-reflection pass, which would double it).
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
import { premultipliedBlend } from './common';

export const GLOW_POOL = 24;
/** Luminance already on the road at which a further overlapping pool is halved. */
const GLOW_SOFT_CAP = 0.22;
/** Peak luminance of one pool (≈ 1.0 R / 0.4 G / 0.12 B for warm fire light). */
const GLOW_MAX = 0.5;

function upload(a: InstancedBufferAttribute, n: number): void {
  a.clearUpdateRanges();
  a.addUpdateRange(0, n * 4);
  a.needsUpdate = true;
}

export class GroundGlow {
  readonly mesh: Mesh;
  private material: ShaderMaterial;
  private geometry: InstancedBufferGeometry;
  private aP: InstancedBufferAttribute; // x, z, radius, elongation
  private aC: InstancedBufferAttribute; // rgb, seed
  private aD: InstancedBufferAttribute; // dir x, dir z (unit), y, unused
  private n = 0;

  constructor(lighting: ILighting, particles: IParticleShared) {
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]), 3));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    const mk = () => {
      const a = new InstancedBufferAttribute(new Float32Array(GLOW_POOL * 4), 4);
      a.setUsage(DynamicDrawUsage);
      return a;
    };
    this.aP = mk();
    this.aC = mk();
    this.aD = mk();
    g.setAttribute('iP', this.aP);
    g.setAttribute('iC', this.aC);
    g.setAttribute('iD', this.aD);
    g.instanceCount = 0;
    g.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.geometry = g;
    this.material = premultipliedBlend(
      new ShaderMaterial({
        name: 'vfx_ground_glow',
        side: DoubleSide,
        uniforms: { ...lighting.uniforms, ...particles.uniforms },
        vertexShader: /* glsl */ `
attribute vec4 iP;
attribute vec4 iC;
attribute vec4 iD;
varying vec2 vUv;
varying vec4 vC;
varying float vDist;
void main() {
  vec2 dir = iD.xy;
  vec2 side = vec2(-dir.y, dir.x);
  float r = iP.z;
  vec2 xz = iP.xy + (side * position.x + dir * position.z * iP.w) * r;
  vec3 wp = vec3(xz.x, iD.z, xz.y);
  vUv = position.xz;
  vC = iC;
  vDist = length(cameraPosition - wp);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`,
        fragmentShader: /* glsl */ `
${particles.glsl}
${lighting.glslLampField}
varying vec2 vUv;
varying vec4 vC;
varying float vDist;
void main() {
  if (uSoftParticles < 0.5) discard; // reflection pass: the mirror would double the pool
  float r2 = dot(vUv, vUv);
  if (r2 >= 1.0) discard;
  float f = exp(-r2 * 3.2) - 0.04 * r2;
  f = max(0.0, f) * (1.0 - r2);
  float fogT = exp(-uFogDensity * uFogDensity * vDist * vDist);
  gl_FragColor = vec4(vC.rgb * (f * fogT), 0.0);
}`,
      }),
    );
    this.material.depthTest = true;
    this.material.polygonOffset = true;
    this.material.polygonOffsetFactor = -2;
    this.material.polygonOffsetUnits = -4;
    this.mesh = new Mesh(g, this.material);
    this.mesh.name = 'vfx_ground_glow';
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYERS.PARTICLES);
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
  }

  begin(): void {
    this.n = 0;
  }

  /**
   * One light pool centred at (x, z) on the road, `radius` across (m), stretched `elong`× along the
   * unit direction (dx, dz); colour is linear HDR emission at the centre.
   */
  push(x: number, z: number, radius: number, r: number, g: number, b: number, dx = 0, dz = 1, elong = 1, y = 0.03): void {
    if (this.n >= GLOW_POOL || radius <= 0 || r + g + b < 1e-3) return;
    const P = this.aP.array as Float32Array;
    const C = this.aC.array as Float32Array;
    const D = this.aD.array as Float32Array;
    // Overlapping pools (a burning wreck + the fuel patches around it) must not add up to a
    // white-washed road: a pool is dimmed by what the pools already pushed give at its centre
    // (soft limit, ≈ GLOW_SOFT_CAP luminance), and no single pool exceeds GLOW_MAX luminance.
    let existing = 0;
    for (let k = 0; k < this.n; k++) {
      const q = k * 4;
      const ex = x - P[q];
      const ez = z - P[q + 1];
      const rr = P[q + 2];
      const ddx = D[q];
      const ddz = D[q + 1];
      const u = (ex * -ddz + ez * ddx) / rr;
      const v = (ex * ddx + ez * ddz) / (rr * P[q + 3]);
      const q2 = u * u + v * v;
      if (q2 >= 1) continue;
      const f = Math.max(0, Math.exp(-q2 * 3.2) - 0.04 * q2) * (1 - q2);
      existing += f * (0.2126 * C[q] + 0.7152 * C[q + 1] + 0.0722 * C[q + 2]);
    }
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let k = GLOW_SOFT_CAP / (GLOW_SOFT_CAP + existing);
    if (lum * k > GLOW_MAX) k = GLOW_MAX / lum;
    r *= k;
    g *= k;
    b *= k;
    const j = this.n++ * 4;
    P[j] = x;
    P[j + 1] = z;
    P[j + 2] = radius;
    P[j + 3] = elong;
    C[j] = r;
    C[j + 1] = g;
    C[j + 2] = b;
    C[j + 3] = 0;
    D[j] = dx;
    D[j + 1] = dz;
    D[j + 2] = y;
    D[j + 3] = 0;
  }

  end(): void {
    const n = this.n;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    upload(this.aP, n);
    upload(this.aC, n);
    upload(this.aD, n);
  }

  clear(): void {
    this.n = 0;
    this.end();
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
