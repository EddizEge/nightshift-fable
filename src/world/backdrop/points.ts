/**
 * Emissive light points (work lights, beacons, floodlights, lot lamps, shore lights), ground light
 * pools and water reflection streaks — all merged per chunk into ONE additive mesh.
 *
 * Authored in straight road space (position = centre, bent by addBent), camera-facing in the shader.
 * Sub-pixel lights keep a ~1.5 px footprint and dim with their real angular size (no sparkle).
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, ShaderMaterial, UniformsLib, UniformsUtils } from 'three';
import type { IChunkBuilder } from '../../core/types';
import { GLSL_FOG, GLSL_HASH, shared } from './shared';

export const enum PointKind {
  Sprite = 0,
  /** Flat light pool on the ground (radius = halo). */
  Pool = 1,
  /** Reflection streak on water (centre = light base on the water plane, size = light height). */
  Streak = 2,
  /** Light cone in the rain below a floodlight (see PointBatch.beam). */
  Beam = 3,
}

/** Blink codes. */
export const BLINK_STEADY = 0;
/** Aviation beacon: 1 + phase (0..0.99). */
export const blinkBeacon = (phase: number) => 1 + (phase % 1) * 0.99;
/** Slow flicker: 3 + phase. */
export const blinkFlicker = (phase: number) => 3 + (phase % 1) * 0.99;
/** Period (m) of the far-road traffic pattern (cars repeat every CAR_PERIOD metres of s). */
export const CAR_PERIOD = 660;
/**
 * Far-road traffic: a string of points along a distant road (every ~3 m) lights up where a car is,
 * and the pattern moves at ~25 m/s (forward = 5 + phase, backward = 6 + phase; phase = s / CAR_PERIOD).
 */
export const blinkCar = (s: number, forward: boolean) => (forward ? 5 : 6) + ((((s / CAR_PERIOD) % 1) + 1) % 1) * 0.99;

export class PointBatch {
  private pos: number[] = [];
  private corner: number[] = [];
  private col: number[] = [];
  private par: number[] = [];
  private kind: number[] = [];
  get count(): number {
    return this.kind.length / 8;
  }

  /**
   * @param d,y,s road space (straight-space z is derived from s0 at build time)
   * @param rgb linear colour already multiplied by intensity
   * @param size core radius (m)  @param halo halo radius (m)  @param haloAmt halo strength relative to the core
   */
  add(s: number, d: number, y: number, r: number, g: number, b: number, size: number, halo = 0, haloAmt = 0, blink = 0, fogScale = 0.6, kind: PointKind = PointKind.Sprite): void {
    for (let i = 0; i < 4; i++) {
      this.pos.push(d, y, s);
      this.col.push(r, g, b);
      this.par.push(size, halo, blink, fogScale);
      this.kind.push(kind, haloAmt);
    }
    this.corner.push(-1, -1, 1, -1, 1, 1, -1, 1);
  }

  /**
   * Visible light cone in the rain: a camera-facing (around Y) strip from the lamp (s, d, y) to the lit
   * ground point (s2, d2, y2), radius r0 at the lamp widening to r1. rgb = scattered radiance at the core.
   */
  beam(s: number, d: number, y: number, s2: number, d2: number, y2: number, r: number, g: number, b: number, r0: number, r1: number, fogScale = 0.8): void {
    const len = Math.hypot(s2 - s, d2 - d, y2 - y);
    for (let i = 0; i < 4; i++) {
      const top = i >= 2;
      this.pos.push(top ? d : d2, top ? y : y2, top ? s : s2);
      this.col.push(r, g, b);
      this.par.push(len, r1, 0, fogScale);
      this.kind.push(PointKind.Beam, r0);
    }
    this.corner.push(-1, -1, 1, -1, 1, 1, -1, 1);
  }

  /** Build into the chunk (one draw call). */
  build(b: IChunkBuilder, name = 'bdPoints'): void {
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
    g.setAttribute('aColor', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aParams', new BufferAttribute(new Float32Array(this.par), 4));
    g.setAttribute('aKind', new BufferAttribute(new Float32Array(this.kind), 2));
    const idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const v = i * 4;
      idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    g.setIndex(new BufferAttribute(idx, 1));
    const mesh = b.addBent(g, pointMaterial(b), { bake: false, noProbe: true, name });
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
  }
}

export function pointMaterial(b: IChunkBuilder): ShaderMaterial {
  return b.materials.cached('bd.points', () => {
    const m = new ShaderMaterial({
      name: 'bdPoints',
      uniforms: UniformsUtils.merge([UniformsLib.fog, {}]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: true,
    });
    m.uniforms.uTime = shared.uTime;
    m.uniforms.uViewH = shared.uViewH;
    return m;
  }) as ShaderMaterial;
}

const VERT = /* glsl */ `
attribute vec2 aCorner;
attribute vec3 aColor;
attribute vec4 aParams;
attribute vec2 aKind;
uniform float uTime;
uniform float uViewH;
varying vec2 vQ;
varying vec3 vColor;
varying float vSigma;
varying float vHalo;
varying float vHaloAmt;
varying float vKind;
varying float vFog;
varying float vStreak;
varying float vR;
${GLSL_FOG}
${GLSL_HASH}
float bdBlink(float code, vec3 wp) {
  if (code < 0.5) return 1.0;
  if (code > 4.5) {
    // Far-road car lights: distance (m) to the nearest of 5 cars in the moving pattern.
    float dir = code < 5.995 ? 1.0 : -1.0;
    float x = fract(fract(code) / 0.99 - dir * uTime * (25.0 / ${CAR_PERIOD.toFixed(1)}));
    float v = 0.0;
    for (int k = 0; k < 5; k++) {
      float c = (float(k) + 0.5 + 0.35 * sin(float(k) * 7.13 + dir * 1.7)) / 5.0;
      float dx = (fract(x - c + 0.5) - 0.5) * ${CAR_PERIOD.toFixed(1)};
      v += exp(-dx * dx / 10.0);
    }
    return v;
  }
  if (code < 2.5) {
    float t = fract(uTime / 1.7 + (code - 1.0));
    return 0.04 + 0.96 * smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.22, 0.42, t));
  }
  float ph = (code - 3.0) * 37.0;
  return 0.78 + 0.22 * sin(uTime * (0.35 + fract(ph) * 0.6) + ph) * sin(uTime * 0.13 + ph * 1.7);
}
void main() {
  float kind = aKind.x;
  float haloAmt = aKind.y;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float size = aParams.x;
  float halo = aParams.y;
  vColor = aColor * bdBlink(aParams.z, wp.xyz);
  vKind = kind;
  vHaloAmt = haloAmt;
  vStreak = 0.0;
  vR = 1.0;
  float dist = length(wp.xyz - cameraPosition);
  vFog = 1.0 - bdFogFactor(dist, aParams.w);
  if (kind < 0.5) {
    vec4 mv = viewMatrix * wp;
    float px = max(-mv.z, 0.1) * 2.0 / (projectionMatrix[1][1] * uViewH);
    float sigma = max(size, px * 0.75);
    float energy = (size * size) / (sigma * sigma);
    float R = max(max(sigma * 3.2, halo * 2.6), px * 2.5);
    vR = R;
    vColor *= energy;
    vSigma = sigma;
    vHalo = max(halo, 1e-3);
    vQ = aCorner * R;
    mv.xy += vQ;
    gl_Position = projectionMatrix * mv;
  } else if (kind < 1.5) {
    // Ground pool: flat disc.
    vec3 p = wp.xyz + vec3(aCorner.x * halo, 0.0, aCorner.y * halo);
    vQ = aCorner;
    vSigma = 1.0;
    vHalo = 1.0;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  } else if (kind > 2.5) {
    // Light cone: corners y = +1 sit at the lamp, y = -1 at the lit ground; widened across the view.
    float t = 0.5 - 0.5 * aCorner.y;
    float rad = mix(haloAmt, halo, t);
    vec3 toC = cameraPosition - wp.xyz;
    vec3 sd = normalize(vec3(-toC.z, 0.0, toC.x) + vec3(1e-5, 0.0, 0.0));
    vQ = vec2(aCorner.x * rad, t);
    vR = rad;
    vSigma = size;
    vHalo = 1.0;
    vStreak = fract(dot(floor(wp.xz * 0.2), vec2(0.13, 0.71))) * 40.0;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp.xyz + sd * aCorner.x * rad, 1.0);
  } else {
    // Water streak: lies on the water plane, stretched from the light towards the camera.
    vec2 toCam = cameraPosition.xz - wp.xz;
    float D = max(length(toCam), 1.0);
    vec2 al = toCam / D;
    vec2 ac = vec2(-al.y, al.x);
    float hl = size; // light height above water
    float hc = max(cameraPosition.y - wp.y, 0.5);
    float off = D * hl / (hl + hc);
    float len = min(off * 1.6 + 6.0, D * 0.9);
    float w = 0.9 + D * 0.0035;
    float t = aCorner.y * 0.5 + 0.5;
    vec2 xz = wp.xz + al * (off - len * 0.45 + t * len) + ac * aCorner.x * w;
    vQ = vec2(aCorner.x, aCorner.y);
    vSigma = len;
    vHalo = off;
    vStreak = (wp.x * 0.13 + wp.z * 0.07);
    gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, wp.y + 0.02, xz.y, 1.0);
  }
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vQ;
varying vec3 vColor;
varying float vSigma;
varying float vHalo;
varying float vHaloAmt;
varying float vKind;
varying float vFog;
varying float vStreak;
varying float vR;
void main() {
  vec3 c;
  if (vKind < 0.5) {
    float r2 = dot(vQ, vQ);
    float core = exp(-r2 / (vSigma * vSigma));
    float edge = max(0.0, 1.0 - r2 / (vR * vR));
    float halo = exp(-r2 / (vHalo * vHalo)) * vHaloAmt * edge * edge;
    c = vColor * (core + halo);
  } else if (vKind < 1.5) {
    float r2 = dot(vQ, vQ);
    float f = max(0.0, 1.0 - r2);
    c = vColor * f * f;
  } else if (vKind > 2.5) {
    // Chord length through a cone of falling rain (thicker in the middle), brightest under the lamp,
    // with faint rain streaks drifting down through it.
    float x = vQ.x / max(vR, 1e-3);
    float t = vQ.y;
    float across = sqrt(max(0.0, 1.0 - x * x));
    float along = smoothstep(0.0, 0.06, t) * (1.0 - 0.7 * t) / (0.35 + 1.6 * t);
    float rain = 0.75 + 0.25 * sin(x * 31.0 + vStreak) * sin(t * vSigma * 2.3 + uTime * 26.0 + x * 9.0 + vStreak);
    c = vColor * across * along * rain;
  } else {
    float t = vQ.y * 0.5 + 0.5;
    float across = 1.0 - vQ.x * vQ.x;
    // Ripples break the reflection into shimmering bands moving towards the viewer.
    float bands = 0.55 + 0.45 * sin(t * vSigma * 1.3 - uTime * 2.4 + vStreak) * sin(t * vSigma * 0.37 + uTime * 1.1 + vStreak * 2.0);
    float prof = smoothstep(0.0, 0.25, t) * (1.0 - smoothstep(0.55, 1.0, t));
    c = vColor * across * across * prof * bands;
  }
  gl_FragColor = vec4(c * vFog, 1.0);
}
`;
