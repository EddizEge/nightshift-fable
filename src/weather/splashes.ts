/**
 * Ground splashes: instanced crown/droplet sprites where drops hit the road around the camera.
 * One draw call (particle pass, soft). Fully GPU-driven: every instance cycles through short
 * lives; each cycle picks a new hashed, world-anchored spot inside a wrap-around window that
 * follows the camera, so a splash never slides while the camera moves.
 */
import {
  CustomBlending,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  OneFactor,
  ShaderMaterial,
  Vector2,
} from 'three';
import type { GameContext } from '../core/types';
import { LAYERS } from '../core/types';
import { makeRng } from '../core/math';
import { WEATHER_GLSL } from './shared';
import type { WeatherUniforms } from './shared';

const WINDOW = 44;

const VERT = /* glsl */ `
attribute vec4 aSeed;
uniform vec2 uSBoxMin;
uniform float uSBox;
uniform float uSDensity;
uniform float uSAlpha;
varying vec3 vColor;
varying vec2 vUv;
varying float vT;
varying float vSeed;
void main() {
  float k = floor(mix(1350.0, 1900.0, aSeed.x));
  float life = NS_WRAP_T / k;
  float ph = uWTime / life + aSeed.y;
  float cyc = floor(ph);
  float t = fract(ph);
  vec3 h = nsH33(vec3(cyc * 0.7317 + aSeed.z * 97.13, aSeed.w * 131.7 + cyc * 0.1173, aSeed.x * 53.9 + cyc * 0.031));
  vec2 xz = uSBoxMin + mod(h.xy * uSBox - uSBoxMin, vec2(uSBox));
  vec3 p = vec3(xz.x, 0.0, xz.y);
  vec3 toCam = cameraPosition - p;
  float dist = length(toCam);
  float d = nsRoadD(p);
  float a = uSAlpha * nsRainCover(p + vec3(0.0, 0.1, 0.0))
          * step(-28.6, d) * step(d, 10.7)
          * (1.0 - smoothstep(14.0, 24.0, dist)) * smoothstep(2.2, 4.5, dist)
          * (1.0 - smoothstep(uSDensity - 0.05, uSDensity, aSeed.w));
  if (a < 0.002) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float s = mix(0.035, 0.09, h.z * h.z);
  vec2 tc = normalize(toCam.xz + vec2(1e-4));
  vec3 right = vec3(tc.y, 0.0, -tc.x);
  vec3 wp = p + right * (position.x * s * 1.25) + vec3(0.0, position.y * s + 0.004, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  vUv = position.xy;
  vT = t;
  vSeed = h.z;
  vec3 lp = p + vec3(0.0, 0.05, 0.0);
  vec3 V = normalize(lp - cameraPosition);
  float hc = max(dot(normalize(lp - uHeadPos), V), 0.0);
  float hcp = hc * hc; hcp *= hcp; hcp *= hcp; hcp *= hcp;
  vec3 rad = uAmbient * 2.0 + nsLampLight(lp) * 0.02 + nsHeadlight(lp) * (0.01 * (0.4 + 2.5 * hcp));
  rad *= exp(-uFogDensity * uFogDensity * dist * dist);
  vColor = rad * a;
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying vec2 vUv;
varying float vT;
varying float vSeed;
void main() {
  float t = vT;
  vec2 uv = vUv;               // x -1..1, y 0..1
  float R = 0.22 + 0.5 * sqrt(t);
  float H = 0.8 * sin(3.14159 * min(t * 1.5, 1.0)) * (0.7 + 0.3 * vSeed);
  // crown walls leaning outward
  float wallX = R + 0.3 * uv.y;
  float wall = exp(-pow(abs((abs(uv.x) - wallX) / 0.08), 2.0)) * (1.0 - smoothstep(H * 0.75, H, uv.y));
  // base ring seen in perspective
  float ring = exp(-pow(abs((length(vec2(uv.x, uv.y * 5.0)) - R) / 0.09), 2.0)) * 0.6;
  // droplets thrown off the rim
  float drops = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float side = mod(fi, 2.0) * 2.0 - 1.0;
    float spread = 0.25 + 0.55 * fract(vSeed * 7.3 + fi * 0.37);
    float vy = 0.7 + 0.6 * fract(vSeed * 3.1 + fi * 0.71);
    vec2 dp = vec2(side * (R + spread * t * 1.2), (vy * t * 2.2 - 2.6 * t * t) + H * 0.6);
    drops += smoothstep(0.1, 0.02, length((uv - dp) * vec2(1.0, 1.4)));
  }
  float shape = (wall * 0.7 + ring * 0.5 + drops) * (1.0 - t * t);
  gl_FragColor = vec4(vColor * shape * nsSoftFade(0.03), 1.0);
}
`;

export class Splashes {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly count: number;
  private boxMin = new Vector2();
  private u: Record<string, { value: unknown }>;

  constructor(ctx: GameContext, wu: WeatherUniforms, count: number) {
    this.count = Math.max(64, Math.round(count));
    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 2, 1, 3]);
    const seeds = new Float32Array(this.count * 4);
    const rng = makeRng(0x5a1a);
    for (let i = 0; i < this.count; i++) {
      seeds[i * 4] = rng();
      seeds[i * 4 + 1] = rng();
      seeds[i * 4 + 2] = rng();
      seeds[i * 4 + 3] = (i + 0.5) / this.count;
    }
    geo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = this.count;
    this.u = {
      uSBoxMin: { value: this.boxMin },
      uSBox: { value: WINDOW },
      uSDensity: { value: 1 },
      uSAlpha: { value: 1 },
    };
    const mat = new ShaderMaterial({
      name: 'nsRainSplashes',
      uniforms: { ...ctx.lighting.uniforms, ...ctx.engine.particles.uniforms, ...wu, ...this.u },
      vertexShader: ctx.lighting.glslLampField + WEATHER_GLSL + VERT,
      fragmentShader: ctx.engine.particles.glsl + FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      fog: false,
    });
    this.mesh = new Mesh(geo, mat);
    this.mesh.name = 'rainSplashes';
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYERS.PARTICLES);
  }

  update(camX: number, camZ: number, fx: number, fz: number, density: number, alpha: number): void {
    this.boxMin.set(camX + fx * 10 - WINDOW * 0.5, camZ + fz * 10 - WINDOW * 0.5);
    this.u.uSDensity.value = density * 1.05;
    this.u.uSAlpha.value = alpha;
    const n = Math.ceil(this.count * Math.min(1, density + 0.06));
    this.mesh.geometry.instanceCount = n;
    this.mesh.visible = n > 0 && alpha > 0.001;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
