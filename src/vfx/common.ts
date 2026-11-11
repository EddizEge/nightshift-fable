/**
 * Shared bits of the VFX module: noise texture, premultiplied "blend add" material setup,
 * wind, fire light slots and small math helpers. No per-frame allocations anywhere in src/vfx.
 */
import {
  CustomBlending,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RepeatWrapping,
  TextureLoader,
  Vector3,
  Vector4,
  AddEquation,
} from 'three';
import type { ShaderMaterial, Texture } from 'three';
import { assetUrl } from '../world/materials';

let noiseTex: Texture | null = null;
let noisePromise: Promise<void> | null = null;

/** Tiling 256² noise (R low fbm, G high fbm, B inverted Worley, A white noise), linear, mip-mapped. */
export function vfxNoise(): { texture: Texture; ready: Promise<void> } {
  if (!noiseTex) {
    const loader = new TextureLoader();
    let resolve!: () => void;
    noisePromise = new Promise<void>((r) => (resolve = r));
    noiseTex = loader.load(assetUrl('assets/textures/noise_rgba.png'), () => resolve(), undefined, () => resolve());
    noiseTex.wrapS = noiseTex.wrapT = RepeatWrapping;
    noiseTex.colorSpace = NoColorSpace;
    noiseTex.minFilter = LinearMipmapLinearFilter;
    noiseTex.magFilter = LinearFilter;
    noiseTex.generateMipmaps = true;
    noiseTex.name = 'vfx_noise_rgba';
  }
  return { texture: noiseTex, ready: noisePromise as Promise<void> };
}

/**
 * Premultiplied "blend add": rgb = emission + colour·alpha, alpha = coverage.
 * alpha = 0 → purely additive, alpha = 1 → opaque over. One material does fire and smoke.
 */
export function premultipliedBlend(m: ShaderMaterial): ShaderMaterial {
  m.transparent = true;
  m.depthWrite = false;
  m.depthTest = true;
  m.blending = CustomBlending;
  m.blendEquation = AddEquation;
  m.blendSrc = OneFactor;
  m.blendDst = OneMinusSrcAlphaFactor;
  m.blendEquationAlpha = AddEquation;
  m.blendSrcAlpha = OneFactor;
  m.blendDstAlpha = OneMinusSrcAlphaFactor;
  m.fog = false;
  m.toneMapped = false;
  return m;
}

/** Prevailing wind for smoke drift (world m/s, ≈ 3 m/s). */
export const WIND = new Vector3(2.1, 0, 1.6);

/** Number of fire light slots that self-illuminate smoke / debris particles. */
export const FIRE_LIGHTS = 4;
/** Warm fire light colour (linear, scaled by the slot intensity). */
export const FIRE_LIGHT_COLOR = new Vector3(1.0, 0.42, 0.12);

/** Fire light slots shared by every particle material (xyz = pos, w = intensity; softening r² in uFireR). */
export interface FireLightUniforms {
  uFireL: { value: Vector4[] };
  uFireR: { value: number[] };
  uFireCol: { value: Vector3 };
  uVfxTime: { value: number };
}

export function createFireLightUniforms(): FireLightUniforms {
  const l: Vector4[] = [];
  const r: number[] = [];
  for (let i = 0; i < FIRE_LIGHTS; i++) {
    l.push(new Vector4(0, -1000, 0, 0));
    r.push(4);
  }
  return { uFireL: { value: l }, uFireR: { value: r }, uFireCol: { value: FIRE_LIGHT_COLOR.clone() }, uVfxTime: { value: 0 } };
}

export const GLSL_FIRE_LIGHTS = /* glsl */ `
#ifndef NS_VFX_FIRE
#define NS_VFX_FIRE
uniform vec4 uFireL[${FIRE_LIGHTS}];
uniform float uFireR[${FIRE_LIGHTS}];
uniform vec3 uFireCol;
uniform float uVfxTime;
#endif
`;

/**
 * Temperature → emission (linear HDR). t ≈ 0 cold, 0.25 deep red (≈2), 0.5 orange (≈8–12),
 * 0.75 yellow-orange (≈20), ≥ 1.1 white-hot (≈ 60).
 */
export const GLSL_RAMPS = /* glsl */ `
vec3 nsFireRamp(float t) {
  t = clamp(t, 0.0, 1.5);
  vec3 c = vec3(1.9, 0.2, 0.03) * smoothstep(0.06, 0.3, t);
  c = mix(c, vec3(5.0, 1.25, 0.2), smoothstep(0.3, 0.55, t));
  c = mix(c, vec3(14.0, 5.6, 1.1), smoothstep(0.55, 0.82, t));
  c = mix(c, vec3(48.0, 36.0, 22.0), smoothstep(0.85, 1.3, t));
  return c;
}
vec3 nsNitroRamp(float t) {
  t = clamp(t, 0.0, 1.5);
  vec3 c = vec3(0.12, 0.08, 0.9) * smoothstep(0.05, 0.35, t);
  c = mix(c, vec3(1.2, 2.6, 9.0), smoothstep(0.35, 0.75, t));
  c = mix(c, vec3(16.0, 20.0, 28.0), smoothstep(0.75, 1.2, t));
  return c;
}
`;

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
