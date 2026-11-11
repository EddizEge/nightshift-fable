/**
 * Weather — state shared by every rain / spray / splash material.
 *
 * One `WeatherUniforms` bag is referenced (by object identity) from all weather ShaderMaterials,
 * so the CPU writes each value once per frame.
 *
 * Time: `uWTime` is the weather's own *scaled* clock wrapped at WRAP_T seconds. Every periodic
 * motion in the shaders (fall speeds, turbulence, splash cycles) is quantised so that it is exactly
 * periodic over WRAP_T — the wrap is seamless and float precision stays high.
 */
import { Vector2, Vector3, Vector4 } from 'three';
import type { IUniform } from 'three';

export const WRAP_T = 400;
/** Fall speed quantum: fall · WRAP_T must be a multiple of every rain box height (8 and 16 m). */
export const FALL_QUANTUM = 16 / WRAP_T; // 0.04 m/s

/** Rain coverage line: samples of world.rainAt() along the road around the camera. */
export const RAIN_LINE_N = 16;
export const RAIN_LINE_S0 = -30;
export const RAIN_LINE_STEP = 10;

export interface WeatherUniforms {
  [k: string]: IUniform;
  uWTime: IUniform<number>;
  uWCamPos: IUniform<Vector3>;
  uWCamVel: IUniform<Vector3>;
  uWind: IUniform<Vector3>;
  /** Road tangent (xz) at the camera and the road centre point at the camera's s (xz). */
  uWRoadFwd: IUniform<Vector2>;
  uWRoadOrigin: IUniform<Vector2>;
  /** rainAt() samples at s = camS + RAIN_LINE_S0 + i·RAIN_LINE_STEP (already × intensity-independent coverage). */
  uWRainLine: IUniform<number[]>;
  /** Nearest roof (overpass deck): xy = centre (world xz), zw = road tangent there. */
  uWRoof: IUniform<Vector4>;
  /** x = half width along the road, y = underside height (0 = no roof). */
  uWRoofP: IUniform<Vector2>;
  /** Drawing-buffer size in px (main render target). */
  uWViewport: IUniform<Vector2>;
  /** Overall rain intensity 0..1. */
  uWIntensity: IUniform<number>;
}

export function createWeatherUniforms(): WeatherUniforms {
  const line: number[] = [];
  for (let i = 0; i < RAIN_LINE_N; i++) line.push(1);
  return {
    uWTime: { value: 0 },
    uWCamPos: { value: new Vector3() },
    uWCamVel: { value: new Vector3() },
    uWind: { value: new Vector3(2, 0, 0.8) },
    uWRoadFwd: { value: new Vector2(0, -1) },
    uWRoadOrigin: { value: new Vector2() },
    uWRainLine: { value: line },
    uWRoof: { value: new Vector4(0, 0, 0, -1) },
    uWRoofP: { value: new Vector2(6.5, 0) },
    uWViewport: { value: new Vector2(1600, 900) },
    uWIntensity: { value: 1 },
  };
}

/** GLSL: uniform declarations + hashes + rain coverage at a world point. */
export const WEATHER_GLSL = /* glsl */ `
#ifndef NS_WEATHER
#define NS_WEATHER
#define NS_WRAP_T ${WRAP_T.toFixed(1)}
#define NS_TAU 6.28318530718
#define NS_RAIN_LINE_N ${RAIN_LINE_N}
uniform float uWTime;
uniform vec3 uWCamPos;
uniform vec3 uWCamVel;
uniform vec3 uWind;
uniform vec2 uWRoadFwd;
uniform vec2 uWRoadOrigin;
uniform float uWRainLine[NS_RAIN_LINE_N];
uniform vec4 uWRoof;
uniform vec2 uWRoofP;
uniform vec2 uWViewport;
uniform float uWIntensity;

float nsH11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
vec3 nsH31(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
vec3 nsH33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
// Rain reaching world point p: tunnel coverage along the road + overpass deck shelter.
float nsRainCover(vec3 p) {
  float a = dot(p.xz - uWCamPos.xz, uWRoadFwd);
  float f = clamp((a - (${RAIN_LINE_S0.toFixed(1)})) / ${RAIN_LINE_STEP.toFixed(1)}, 0.0, float(NS_RAIN_LINE_N) - 1.001);
  int i = int(f);
  float c = mix(uWRainLine[i], uWRainLine[i + 1], f - float(i));
  float along = dot(p.xz - uWRoof.xy, uWRoof.zw);
  float under = (1.0 - smoothstep(uWRoofP.x - 1.2, uWRoofP.x + 0.6, abs(along))) * step(p.y, uWRoofP.y);
  return c * (1.0 - under);
}
// Low-beam cut-off: the player's beam barely lights what is above the headlamp horizon.
float nsBeamCut(vec3 p) {
  vec3 r = p - uHeadPos;
  float e = r.y / max(length(r.xz), 0.5);
  return mix(0.1, 1.0, smoothstep(0.1, -0.03, e));
}
// Lateral road offset of a world point (relative to the road centre line at the camera).
float nsRoadD(vec3 p) {
  vec2 r = vec2(-uWRoadFwd.y, uWRoadFwd.x);
  return dot(p.xz - uWRoadOrigin, r);
}
#endif
`;
