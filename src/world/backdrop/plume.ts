/**
 * Steam plumes and gas-flare flames: vertical camera-facing quads with animated noise, merged per
 * chunk into one mesh on LAYERS.PARTICLES (drawn in the particle pass and the road reflection).
 * Premultiplied-alpha blending: steam is alpha-blended, flames are additive (alpha 0).
 */
import { BufferAttribute, BufferGeometry, CustomBlending, OneFactor, OneMinusSrcAlphaFactor, ShaderMaterial, UniformsLib, UniformsUtils } from 'three';
import type { IChunkBuilder } from '../../core/types';
import { LAYERS } from '../../core/types';
import { GLSL_FOG, shared } from './shared';

export class PlumeBatch {
  private pos: number[] = [];
  private corner: number[] = [];
  private par: number[] = [];
  private tint: number[] = [];
  get count(): number {
    return this.par.length / 16;
  }
  /** Steam plume rising from (s, d, y). `tint` = light from below (linear radiance). */
  steam(s: number, d: number, y: number, width: number, height: number, seed: number, tr = 0, tg = 0, tb = 0): void {
    this.quad(s, d, y, width, height, 0, seed, tr, tg, tb);
  }
  /** Gas flare flame (intensity ≈ 20 at the core). */
  flame(s: number, d: number, y: number, width: number, height: number, seed: number, intensity = 20): void {
    this.quad(s, d, y, width, height, 1, seed, intensity, 0, 0);
  }
  private quad(s: number, d: number, y: number, w: number, h: number, kind: number, seed: number, tr: number, tg: number, tb: number): void {
    for (let i = 0; i < 4; i++) {
      this.pos.push(d, y, s);
      this.par.push(w, h, kind, seed);
      this.tint.push(tr, tg, tb);
    }
    this.corner.push(-1, 0, 1, 0, 1, 1, -1, 1);
  }

  build(b: IChunkBuilder): void {
    const n = this.count;
    if (!n) return;
    const s0 = b.spec.s0;
    const pos = new Float32Array(this.pos.length);
    for (let i = 0; i < this.pos.length; i += 3) {
      pos[i] = this.pos[i];
      pos[i + 1] = this.pos[i + 1];
      pos[i + 2] = -(this.pos[i + 2] - s0);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aCorner', new BufferAttribute(new Float32Array(this.corner), 2));
    g.setAttribute('aP', new BufferAttribute(new Float32Array(this.par), 4));
    g.setAttribute('aTint', new BufferAttribute(new Float32Array(this.tint), 3));
    const idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    g.setIndex(new BufferAttribute(idx, 1));
    const mesh = b.addBent(g, plumeMaterial(b), { bake: false, name: 'bdPlumes' });
    mesh.layers.set(LAYERS.PARTICLES);
    mesh.frustumCulled = false;
  }
}

function plumeMaterial(b: IChunkBuilder): ShaderMaterial {
  return b.materials.cached('bd.plume', () => {
    const noise = b.materials.texture('noise_rgba.png');
    const m = new ShaderMaterial({
      name: 'bdPlume',
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uNoise: { value: null } }]),
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      vertexShader: /* glsl */ `
attribute vec2 aCorner;
attribute vec4 aP;
attribute vec3 aTint;
uniform float uTime;
varying vec2 vUv;
varying vec4 vP;
varying vec3 vTint;
varying float vDist;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 toCam = normalize(cameraPosition.xz - wp.xz + 1e-4);
  vec3 right = vec3(-toCam.y, 0.0, toCam.x);
  float y = aCorner.y;
  float w = aP.x;
  float h = aP.y;
  float kind = aP.z;
  vec3 p = wp.xyz;
  if (kind < 0.5) {
    float spread = 0.35 + 1.9 * pow(y, 0.8);
    vec2 wind = vec2(0.82, -0.36) * (0.55 + 0.25 * sin(uTime * 0.05 + aP.w * 6.0));
    p.xz += wind * pow(y, 1.5) * h * 0.75;
    p += right * aCorner.x * w * spread;
    p.y += y * h;
  } else {
    p += right * aCorner.x * w;
    p.y += y * h - h * 0.08;
  }
  vUv = vec2(aCorner.x * 0.5 + 0.5, y);
  vP = aP;
  vTint = aTint;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: /* glsl */ `
${GLSL_FOG}
uniform sampler2D uNoise;
uniform float uTime;
uniform vec3 uGlow;
varying vec2 vUv;
varying vec4 vP;
varying vec3 vTint;
varying float vDist;
void main() {
  float seed = vP.w;
  float fogK = 1.0 - bdFogFactor(vDist, 0.55);
  if (vP.z < 0.5) {
    float x = vUv.x * 2.0 - 1.0;
    float y = vUv.y;
    vec2 q = vec2(vUv.x * 0.55 + seed, y * 0.9 - uTime * 0.045);
    float n1 = texture2D(uNoise, q).r;
    float n2 = texture2D(uNoise, q * 2.3 + vec2(0.0, -uTime * 0.03)).g;
    float n = n1 * 0.7 + n2 * 0.3;
    float prof = exp(-x * x * 2.6);
    float fadeY = smoothstep(0.0, 0.06, y) * (1.0 - smoothstep(0.45, 1.0, y));
    float dens = prof * fadeY * smoothstep(0.28, 0.75, n + 0.25 * (1.0 - y));
    float a = clamp(dens * 0.6, 0.0, 0.85) * fogK;
    vec3 col = uGlow * (1.1 + 0.6 * n) + vTint * pow(1.0 - y, 3.0) * (0.6 + 0.6 * n);
    gl_FragColor = vec4(col * a, a);
  } else {
    float x = vUv.x * 2.0 - 1.0;
    float y = vUv.y;
    float fl = texture2D(uNoise, vec2(x * 0.3 + seed, y * 0.6 - uTime * 1.3)).r;
    float fl2 = texture2D(uNoise, vec2(x * 0.6 + seed * 3.0, y * 1.1 - uTime * 2.1)).g;
    float wob = (fl - 0.5) * 0.5 * y;
    float r = length(vec2((x + wob) * (1.0 + y * 1.2), (y - 0.3) * 1.15));
    float body = smoothstep(0.62, 0.05, r + (fl2 - 0.5) * 0.35 * y);
    float core = smoothstep(0.28, 0.0, length(vec2(x * 1.6, (y - 0.22) * 1.8)));
    float flick = 0.85 + 0.15 * sin(uTime * 17.0 + seed * 40.0) * sin(uTime * 7.3);
    vec3 col = mix(vec3(1.0, 0.24, 0.04), vec3(1.0, 0.62, 0.22), body) * body * 0.45 + vec3(1.0, 0.9, 0.7) * core;
    gl_FragColor = vec4(col * vTint.r * flick * fogK, 0.0);
  }
}`,
    });
    m.uniforms.uNoise.value = noise;
    m.uniforms.uTime = shared.uTime;
    m.uniforms.uGlow = shared.uGlow;
    return m;
  }) as ShaderMaterial;
}
