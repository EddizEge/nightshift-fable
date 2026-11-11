/**
 * Rain streaks: `count` instanced camera-facing streak quads, one draw call, zero CPU work per drop.
 *
 * Every drop lives in a world-anchored wrap-around box that follows the camera (two nested boxes:
 * a dense near box and a large far box, interleaved by instance index so `instanceCount` thins
 * both evenly). The vertex shader derives the drop position from its seed, the weather clock,
 * the fall speed, the integrated wind and per-drop turbulence, wraps it with mod(), and builds a
 * screen-space streak from the drop's motion RELATIVE to the camera during the shutter time
 * (capped on screen at ~5.5 % of the frame height, energy-conserving: stretched streaks are fainter).
 * Widths are computed in pixels: sub-pixel drops are drawn 1 px wide with proportionally less
 * energy (no shimmering), close drops are capped (no blurry quads in the face).
 */
import {
  Color,
  CustomBlending,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  OneFactor,
  ShaderMaterial,
  Vector3,
  Vector4,
} from 'three';
import type { GameContext } from '../core/types';
import { LAYERS } from '../core/types';
import { makeRng } from '../core/math';
import { FALL_QUANTUM, WEATHER_GLSL } from './shared';
import type { WeatherUniforms } from './shared';

/** Box sizes (x, y, z). Heights must divide fall · WRAP_T (see shared.ts). */
export const NEAR_BOX = new Vector3(26, 8, 26);
export const FAR_BOX = new Vector3(64, 16, 64);
/** Fraction of the drops in the near box. */
const NEAR_FRAC = 0.42;
/** Streak length cap / energy reference length, as fractions of the frame height. */
const MAX_LEN_FRAC = 0.055;
const REF_LEN_FRAC = 0.018;

const VERT = /* glsl */ `
#define NS_FALL_Q ${FALL_QUANTUM.toFixed(6)}
attribute vec4 aSeed;
uniform vec3 uRBoxMin[2];
uniform vec3 uRBoxSize[2];
uniform vec3 uRWindOff[2];
uniform float uRShutter;
uniform float uRDensity;
uniform float uRAlpha;
uniform float uRWidth;
/** x = isotropic lamp gain, y = lamp forward-scatter gain, z = headlight gain, w = ambient gain */
uniform vec4 uRGain;
/** Streak length cap and reference (px). */
uniform float uRMaxLen;
uniform float uRLenRef;
/** Lightning: diffuse sky light (linear RGB) added to the ambient term. */
uniform vec3 uRFlash;
varying vec3 vColor;
varying vec2 vQuad;
varying vec4 vMetrics;

void main() {
  bool nearBox = aSeed.w < 0.0;
  float frac = abs(aSeed.w);
  vec3 bmin = nearBox ? uRBoxMin[0] : uRBoxMin[1];
  vec3 bsize = nearBox ? uRBoxSize[0] : uRBoxSize[1];
  vec3 woff = nearBox ? uRWindOff[0] : uRWindOff[1];

  float h1 = nsH11(frac * 913.71 + aSeed.x * 7.3);
  float h2 = nsH11(aSeed.x * 517.13 + aSeed.z * 41.7);
  float h3 = nsH11(aSeed.y * 291.7 + aSeed.x * 13.1);
  // Quantised so every motion is exactly periodic over NS_WRAP_T.
  float fall = floor(mix(212.0, 276.0, h1)) * NS_FALL_Q;
  float w1 = NS_TAU * floor(mix(300.0, 800.0, h2)) / NS_WRAP_T;
  float w2 = NS_TAU * floor(mix(300.0, 800.0, h3)) / NS_WRAP_T;
  float amp = mix(0.03, 0.09, h3);
  float ph1 = uWTime * w1 + h2 * 40.0;
  float ph2 = uWTime * w2 + h1 * 40.0;
  vec3 turb = vec3(sin(ph1), 0.0, cos(ph2)) * amp;
  vec3 turbV = vec3(cos(ph1) * w1, 0.0, -sin(ph2) * w2) * amp;

  vec3 p = aSeed.xyz * bsize + woff + vec3(0.0, -fall * uWTime, 0.0) + turb;
  p = bmin + mod(p - bmin, bsize);
  vec3 q = (p - bmin) / bsize;
  float edge = smoothstep(0.0, 0.08, min(q.x, 1.0 - q.x)) * smoothstep(0.0, 0.08, min(q.z, 1.0 - q.z))
             * smoothstep(0.0, 0.12, 1.0 - q.y) * smoothstep(0.0, 0.03, q.y);
  float a = uRAlpha * edge * nsRainCover(p) * (1.0 - smoothstep(uRDensity - 0.05, uRDensity, frac));
  if (a < 0.002) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }

  vec3 vDrop = uWind + turbV - vec3(0.0, fall, 0.0);
  vec3 vRel = vDrop - uWCamVel;
  vec3 A = p;
  vec3 B = p - vRel * uRShutter;
  vec4 Av = viewMatrix * vec4(A, 1.0);
  vec4 Bv = viewMatrix * vec4(B, 1.0);
  const float NZ = -0.15;
  if (Av.z > NZ && Bv.z > NZ) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  if (Av.z > NZ) Av.xyz = mix(Bv.xyz, Av.xyz, (Bv.z - NZ) / (Bv.z - Av.z));
  if (Bv.z > NZ) Bv.xyz = mix(Av.xyz, Bv.xyz, (Av.z - NZ) / (Av.z - Bv.z));
  // No huge quads in the face.
  a *= smoothstep(0.5, 2.0, min(-Av.z, -Bv.z));

  vec2 halfVp = 0.5 * uWViewport;
  vec4 Ac = projectionMatrix * Av;
  vec4 Bc = projectionMatrix * Bv;
  vec2 sa = Ac.xy / Ac.w * halfVp;
  vec2 sb = Bc.xy / Bc.w * halfVp;
  float lenRaw = length(sb - sa);
  // Energy conservation: the drop's light is spread over its whole motion-blur path, so a
  // stretched streak is proportionally fainter (the reference length is about a standing-still streak).
  float energy = uRLenRef / max(lenRaw, uRLenRef);
  a *= pow(energy, 0.75);
  // On-screen length cap: only the newest part of a long streak is drawn (exact perspective
  // split of the segment), tapered towards the tail so it never ends in a hard line.
  float capped = 0.0;
  if (lenRaw > uRMaxLen) {
    float u = uRMaxLen / lenRaw;
    float wa = -Av.z;
    float wb = -Bv.z;
    float t = u * wa / (wb * (1.0 - u) + u * wa);
    Bv = mix(Av, Bv, t);
    Bc = projectionMatrix * Bv;
    sb = Bc.xy / Bc.w * halfVp;
    capped = 1.0;
  }
  float dA = -Av.z;
  float dB = -Bv.z;
  float focal = projectionMatrix[1][1] * halfVp.y;
  bool isA = position.y < 0.5;
  float depth = isA ? dA : dB;
  // Width in px: sub-pixel drops are drawn ~1.2 px wide with proportionally less energy (no shimmer
  // at pixel ratio 0.7); close drops are out of focus: wider, spread thinner.
  float wRaw = uRWidth * focal / depth;
  float wPx = clamp(wRaw, 1.2, 4.5);
  a *= clamp(wRaw / 1.2, 0.25, 1.0) * min(1.0, 2.2 / wPx);
  vec2 dir = sb - sa;
  float len = length(dir);
  dir = len > 1e-3 ? dir / len : vec2(0.0, 1.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = wPx * 0.5 + 1.0;
  vec2 base = isA ? sa : sb;
  vec2 off = nrm * position.x * hw + dir * (isA ? -hw : hw);
  vec4 clip = isA ? Ac : Bc;
  clip.xy = (base + off) / halfVp * clip.w;
  gl_Position = clip;
  vQuad = vec2(position.x * hw, isA ? -hw : len + hw);
  vMetrics = vec4(wPx * 0.5, len, hw, capped);

  // Lighting: drops are invisible in darkness and light up only where light reaches them:
  // under a luminaire (downward cone, short reach), backlit by a lamp (forward scattering),
  // in the player's headlight beam, during explosion flashes and lightning.
  vec3 V = normalize(p - cameraPosition);
  vec3 iso = vec3(0.0);
  vec3 fwd = vec3(0.0);
  for (int i = 0; i < NS_MAX_LAMPS; i++) {
    vec3 lv = uLampPos[i] - p;
    float r2 = dot(lv, lv);
    vec3 L = lv * inversesqrt(max(r2, 1e-4));
    float under = smoothstep(-0.05, 0.55, L.y);
    vec3 c = uLampColor[i] * (under / ((r2 + 4.0) * (1.0 + r2 * (1.0 / 150.0))));
    iso += c * under;
    float cf = max(dot(L, V), 0.0);
    float cf2 = cf * cf; cf2 *= cf2;
    fwd += c * (cf2 * cf2);
  }
  for (int i = 0; i < uFlashPos.length(); i++) {
    vec3 lv = uFlashPos[i] - p;
    iso += uFlashColor[i] / (dot(lv, lv) + 9.0);
  }
  vec3 hv = normalize(p - uHeadPos);
  float hc = max(dot(hv, V), 0.0);
  float hcp = hc * hc; hcp *= hcp; hcp *= hcp;
  vec3 rad = (uAmbient + uRFlash) * uRGain.w + iso * uRGain.x + fwd * uRGain.y
           + nsHeadlight(p) * (uRGain.z * nsBeamCut(p) * (0.4 + 1.6 * hcp));
  float dist = length(p - cameraPosition);
  rad *= exp(-uFogDensity * uFogDensity * dist * dist);
  vColor = rad * a * mix(0.85, 1.15, h2);
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying vec2 vQuad;
varying vec4 vMetrics;
void main() {
  float x = vQuad.x / max(vMetrics.x, 0.5);
  float prof = exp(-x * x * 1.3);
  float t = vQuad.y;
  float cap = smoothstep(-vMetrics.z, 0.0, t) * (1.0 - smoothstep(vMetrics.y, vMetrics.y + vMetrics.z, t));
  // newest end brightest; capped streaks fade out towards the tail
  float along = clamp(t / max(vMetrics.y, 1.0), 0.0, 1.0);
  float taper = 1.0 - along * mix(0.35, 0.95, vMetrics.w);
  gl_FragColor = vec4(vColor * (prof * cap * taper), 1.0);
}
`;

export class RainStreaks {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly count: number;
  private boxMin = [new Vector3(), new Vector3()];
  private windOff = [new Vector3(), new Vector3()];
  readonly uniforms: { [k: string]: { value: unknown }; uRMaxLen: { value: number }; uRLenRef: { value: number } };

  constructor(ctx: GameContext, wu: WeatherUniforms, count: number) {
    this.count = Math.max(64, Math.round(count));
    const geo = new InstancedBufferGeometry();
    // x = side (-1/1), y = end (0 = A, 1 = B)
    geo.setAttribute('position', new Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
    // wound so the screen-space quad is front-facing (nrm is dir rotated +90°)
    geo.setIndex([0, 2, 1, 1, 2, 3]);
    const seeds = new Float32Array(this.count * 4);
    const rng = makeRng(0x5eed);
    for (let i = 0; i < this.count; i++) {
      seeds[i * 4] = rng();
      seeds[i * 4 + 1] = rng();
      seeds[i * 4 + 2] = rng();
      // Interleave near/far boxes by index so instanceCount thins both evenly.
      const near = (i * 0.618034) % 1 < NEAR_FRAC;
      const f = (i + 0.5) / this.count;
      seeds[i * 4 + 3] = near ? -f : f;
    }
    geo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = this.count;

    this.uniforms = {
      uRBoxMin: { value: this.boxMin },
      uRBoxSize: { value: [NEAR_BOX, FAR_BOX] },
      uRWindOff: { value: this.windOff },
      uRShutter: { value: 1 / 48 },
      uRDensity: { value: 1.05 },
      uRAlpha: { value: 0.4 },
      uRWidth: { value: 0.016 },
      uRGain: { value: new Vector4(0.02, 0.05, 0.013, 0.3) },
      uRMaxLen: { value: 50 },
      uRLenRef: { value: 18 },
      uRFlash: { value: new Color(0, 0, 0) },
    };
    const mat = new ShaderMaterial({
      name: 'nsRainStreaks',
      uniforms: { ...ctx.lighting.uniforms, ...wu, ...this.uniforms },
      vertexShader: ctx.lighting.glslLampField + WEATHER_GLSL + VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      fog: false,
    });
    this.mesh = new Mesh(geo, mat);
    this.mesh.name = 'rainStreaks';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.layers.set(LAYERS.MAIN_ONLY);
  }

  /**
   * @param cam camera position, @param fx/fz horizontal view direction (unit),
   * @param windOffset integrated wind displacement (unwrapped)
   */
  update(
    cam: Vector3,
    fx: number,
    fz: number,
    windOffset: Vector3,
    shutter: number,
    density: number,
    alpha: number,
    viewportH: number,
    flash: number,
  ): void {
    const u = this.uniforms;
    // No streak longer than ~5.5 % of the frame height at any speed (resolution independent).
    u.uRMaxLen.value = MAX_LEN_FRAC * viewportH;
    u.uRLenRef.value = REF_LEN_FRAC * viewportH;
    (u.uRFlash.value as Color).setRGB(0.3 * flash, 0.34 * flash, 0.42 * flash);
    const bottom = Math.max(-0.8, cam.y - 2.3);
    this.place(0, NEAR_BOX, cam, fx, fz, 9, bottom, windOffset);
    this.place(1, FAR_BOX, cam, fx, fz, 26, bottom, windOffset);
    u.uRShutter.value = shutter;
    u.uRDensity.value = density * 1.05;
    u.uRAlpha.value = alpha;
    const n = Math.ceil(this.count * Math.min(1, density + 0.06));
    this.mesh.geometry.instanceCount = n;
    this.mesh.visible = n > 0 && alpha > 0.001;
  }

  private place(i: number, size: Vector3, cam: Vector3, fx: number, fz: number, ahead: number, bottom: number, wind: Vector3): void {
    const m = this.boxMin[i];
    m.set(cam.x + fx * ahead - size.x * 0.5, bottom, cam.z + fz * ahead - size.z * 0.5);
    const w = this.windOff[i];
    w.set(wind.x % size.x, 0, wind.z % size.z);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
