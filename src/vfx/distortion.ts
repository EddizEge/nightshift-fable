/**
 * Screen-space refraction for the VFX: up to 2 simultaneous explosion shockwaves (expanding
 * refractive ring around the projected blast centre) + up to 2 heat-haze columns above long
 * fires. A `postprocessing` Effect using mainUv(); when nothing is active its blend function is
 * DST, which makes the EffectPass skip rendering entirely (zero cost when idle).
 */
import { BlendFunction, Effect } from 'postprocessing';
import { Uniform, Vector2, Vector3, Vector4 } from 'three';
import type { PerspectiveCamera, Texture } from 'three';

const FRAG = /* glsl */ `
uniform vec4 uWave0;   // xy centre (uv), z radius (uv-y units), w amplitude
uniform vec4 uWave1;
uniform vec2 uWaveW;   // ring thickness (uv-y units)
uniform vec4 uHaze0;   // xy base (uv), z half width (uv-y units), w strength
uniform vec4 uHaze1;
uniform vec2 uHazeH;   // column height (uv-y units)
uniform float uAspect;
uniform float uT;
uniform sampler2D uNoiseTex;

vec2 shockOffset(vec2 uv, vec4 w, float th) {
  vec2 d = uv - w.xy;
  d.x *= uAspect;
  float r = length(d);
  float x = (r - w.z) / th;
  if (abs(x) > 3.0) return vec2(0.0);
  // derivative-of-gaussian lens profile: compresses the image just outside the front
  float k = -x * exp(-x * x);
  vec2 o = d / max(r, 1e-4) * (k * w.w);
  o.x /= uAspect;
  return o;
}

vec2 hazeOffset(vec2 uv, vec4 h, float height) {
  vec2 d = uv - h.xy;
  d.x *= uAspect;
  if (d.y < -h.z * 0.3 || d.y > height || abs(d.x) > h.z * 1.6) return vec2(0.0);
  float across = 1.0 - smoothstep(h.z * 0.35, h.z * 1.6, abs(d.x));
  float up = smoothstep(-h.z * 0.3, h.z * 0.4, d.y) * (1.0 - smoothstep(height * 0.45, height, d.y));
  vec2 nuv = vec2(d.x / max(h.z, 1e-4) * 0.35, d.y / max(h.z, 1e-4) * 0.22 - uT * 0.9);
  vec2 n = texture2D(uNoiseTex, nuv).rg + texture2D(uNoiseTex, nuv * 2.1 + 0.37).rg * 0.5 - 0.75;
  return n * (h.w * across * up);
}

void mainUv(inout vec2 uv) {
  vec2 o = vec2(0.0);
  if (uWave0.w > 0.0) o += shockOffset(uv, uWave0, uWaveW.x);
  if (uWave1.w > 0.0) o += shockOffset(uv, uWave1, uWaveW.y);
  if (uHaze0.w > 0.0) o += hazeOffset(uv, uHaze0, uHazeH.x);
  if (uHaze1.w > 0.0) o += hazeOffset(uv, uHaze1, uHazeH.y);
  uv += o;
}
`;

interface Wave {
  active: boolean;
  t: number;
  pos: Vector3;
  scale: number;
}
interface Haze {
  pos: Vector3;
  width: number;
  height: number;
  strength: number;
}

const _v = new Vector3();

export class VfxDistortionEffect extends Effect {
  private waves: Wave[] = [];
  private haze: Haze[] = [];
  private hazeCount = 0;
  private on = true;
  private warm = 3; // keep it compiled for the first frames, then go idle
  private time = 0;

  constructor(noise: Texture) {
    super('NsVfxDistortion', FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([
        ['uWave0', new Uniform(new Vector4(0, 0, 0, 0))],
        ['uWave1', new Uniform(new Vector4(0, 0, 0, 0))],
        ['uWaveW', new Uniform(new Vector2(0.02, 0.02))],
        ['uHaze0', new Uniform(new Vector4(0, 0, 0, 0))],
        ['uHaze1', new Uniform(new Vector4(0, 0, 0, 0))],
        ['uHazeH', new Uniform(new Vector2(0.1, 0.1))],
        ['uAspect', new Uniform(16 / 9)],
        ['uT', new Uniform(0)],
        ['uNoiseTex', new Uniform(noise)],
      ]),
    });
    for (let i = 0; i < 2; i++) {
      this.waves.push({ active: false, t: 0, pos: new Vector3(), scale: 1 });
      this.haze.push({ pos: new Vector3(), width: 1, height: 3, strength: 0 });
    }
  }

  /** Start a shockwave (replaces the older one when both are busy). */
  shock(pos: Vector3, scale: number): void {
    let w = this.waves.find((x) => !x.active);
    if (!w) w = this.waves[0].t > this.waves[1].t ? this.waves[0] : this.waves[1];
    w.active = true;
    w.t = 0;
    w.pos.copy(pos);
    w.scale = scale;
  }

  /** Heat haze candidates are pushed every frame (only the first 2 are used). */
  beginHaze(): void {
    this.hazeCount = 0;
  }
  pushHaze(pos: Vector3, width: number, height: number, strength: number): void {
    if (this.hazeCount >= 2) {
      // keep the strongest two
      const weak = this.haze[0].strength < this.haze[1].strength ? 0 : 1;
      if (this.haze[weak].strength >= strength) return;
      const h = this.haze[weak];
      h.pos.copy(pos);
      h.width = width;
      h.height = height;
      h.strength = strength;
      return;
    }
    const h = this.haze[this.hazeCount++];
    h.pos.copy(pos);
    h.width = width;
    h.height = height;
    h.strength = strength;
  }

  clear(): void {
    for (const w of this.waves) w.active = false;
    this.hazeCount = 0;
  }

  /** Advance (scaled dt) and project everything with the main camera. */
  step(dt: number, camera: PerspectiveCamera): void {
    this.time += dt;
    const u = this.uniforms;
    (u.get('uT') as Uniform<number>).value = this.time;
    (u.get('uAspect') as Uniform<number>).value = camera.aspect;
    const p11 = camera.projectionMatrix.elements[5];
    const ww = (u.get('uWaveW') as Uniform<Vector2>).value;
    let any = false;
    for (let i = 0; i < 2; i++) {
      const w = this.waves[i];
      const U = (u.get(i === 0 ? 'uWave0' : 'uWave1') as Uniform<Vector4>).value;
      U.w = 0;
      if (!w.active) continue;
      w.t += dt;
      const dur = 0.55 + 0.25 * w.scale;
      if (w.t > dur) {
        w.active = false;
        continue;
      }
      _v.copy(w.pos).applyMatrix4(camera.matrixWorldInverse);
      const depth = -_v.z;
      if (depth < 1.5) continue;
      _v.applyMatrix4(camera.projectionMatrix);
      const S = w.scale;
      // shock front: fast, decelerating; world radius → uv-y units
      const R = 26 * S * (1 - Math.exp(-w.t * 4.2)) + 1;
      const toUv = (0.5 * p11) / depth;
      const radius = R * toUv;
      const th = Math.max(0.006, 2.2 * Math.sqrt(S) * toUv);
      const life = w.t / dur;
      // (0.022 drew the front across the fireball as a crisp concentric ring: a "disc" look)
      const amp = 0.012 * Math.sqrt(S) * Math.min(1, 28 / depth) * (1 - life) * (1 - life) * Math.min(1, w.t / 0.03);
      if (radius > 1.8) continue;
      U.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5, radius, amp);
      if (i === 0) ww.x = th;
      else ww.y = th;
      any = true;
    }
    const hh = (u.get('uHazeH') as Uniform<Vector2>).value;
    for (let i = 0; i < 2; i++) {
      const U = (u.get(i === 0 ? 'uHaze0' : 'uHaze1') as Uniform<Vector4>).value;
      U.w = 0;
      if (i >= this.hazeCount) continue;
      const h = this.haze[i];
      _v.copy(h.pos).applyMatrix4(camera.matrixWorldInverse);
      const depth = -_v.z;
      if (depth < 2 || depth > 160) continue;
      _v.applyMatrix4(camera.projectionMatrix);
      const toUv = (0.5 * p11) / depth;
      const fade = 1 - smooth01((depth - 90) / 70);
      U.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5, h.width * toUv, 0.0035 * h.strength * fade);
      if (i === 0) hh.x = h.height * toUv;
      else hh.y = h.height * toUv;
      any = true;
    }
    if (this.warm > 0) {
      this.warm--;
      any = true;
    }
    if (any !== this.on) {
      this.on = any;
      this.blendMode.blendFunction = any ? BlendFunction.NORMAL : BlendFunction.DST;
    }
  }

  get active(): boolean {
    return this.on;
  }
}

function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}
