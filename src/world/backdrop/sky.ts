/**
 * Sky dome: heavy overcast night (drifting fbm cloud deck lit from below by sodium city glow),
 * the far skyline panorama composited in the same pass (3 hazed, parallax-free layers) and
 * sheet lightning. One draw call; centred on whichever camera renders it (main, road reflection,
 * env probe) and pinned to the far plane, so it never clips.
 */
import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry } from 'three';
import type { Texture } from 'three';
import { LAYERS } from '../../core/types';
import { GLSL_HASH, GLSL_SKY, shared } from './shared';
import { SKY_AZ, SKY_EL, SKY_H, SKY_W } from './skyline';

export function createSkyDome(cloud: Texture, mask: Texture, windows: Texture): { mesh: Mesh; material: ShaderMaterial; fogColor: Color } {
  const fogColor = new Color(0.0016, 0.0021, 0.003);
  const material = new ShaderMaterial({
    name: 'bdSky',
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      uCloud: { value: cloud },
      uMask: { value: mask },
      uWin: { value: windows },
      uFogCol: { value: fogColor },
      uTime: shared.uTime,
      uFlash: shared.uFlash,
      uFlashGlobal: shared.uFlashGlobal,
    },
    vertexShader: /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * viewMatrix * vec4(cameraPosition + position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.99995, p.w);
}`,
    fragmentShader: /* glsl */ `
uniform sampler2D uCloud;
uniform sampler2D uMask;
uniform sampler2D uWin;
uniform vec3 uFogCol;
uniform float uTime;
uniform vec4 uFlash;
uniform float uFlashGlobal;
varying vec3 vDir;
${GLSL_HASH}
${GLSL_SKY}
const float SKY_AZ = ${SKY_AZ.toFixed(5)};
const float SKY_EL = ${SKY_EL.toFixed(5)};
const vec2 SKY_RES = vec2(${SKY_W.toFixed(1)}, ${SKY_H.toFixed(1)});
vec3 bdWinColor(float code, vec2 texel) {
  if (code > 0.955) {
    float ph = bdHash(texel);
    float t = fract(uTime / 1.6 + ph);
    float b = 0.06 + 0.94 * smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.2, 0.38, t));
    return vec3(1.0, 0.08, 0.04) * 3.4 * b;
  }
  if (code > 0.915) return code > 0.93 ? vec3(0.75, 0.88, 1.0) * 1.3 : vec3(1.0, 0.78, 0.5) * 1.3;
  vec3 warm = vec3(1.0, 0.58, 0.28);
  vec3 neutral = vec3(1.0, 0.82, 0.62);
  vec3 cool = vec3(0.68, 0.8, 1.0);
  vec3 c = code < 0.5 ? mix(warm, neutral, code * 2.0) : mix(neutral, cool, (code - 0.5) / 0.4);
  float h = bdHash(texel + 7.1);
  if (h < 0.05) c *= 0.65 + 0.35 * sin(uTime * (0.25 + h * 6.0) + h * 300.0);
  return c;
}
void main() {
  vec3 dir = normalize(vDir);
  float cloud;
  vec3 col = bdSky(dir, cloud);
  float el = asin(clamp(dir.y, -1.0, 1.0));
  float az = atan(dir.x, -dir.z);
  // Low haze band: the sky right above the horizon is glowing mist.
  vec3 haze = bdSkyBase(vec3(dir.x, 0.012, dir.z), az) * 1.05 + vec3(0.5, 0.55, 0.72) * uFlashGlobal * 0.02;
  if (el < SKY_EL && abs(az) < SKY_AZ) {
    vec2 uv = vec2(az / (2.0 * SKY_AZ) + 0.5, max(el, 0.0) / SKY_EL);
    vec4 m = texture2D(uMask, uv);
    vec4 w = texture2D(uWin, uv);
    vec2 texel = floor(uv * SKY_RES);
    vec3 wc = bdWinColor(w.a, texel);
    float edge = smoothstep(SKY_AZ, SKY_AZ * 0.9, abs(az));
    // Height-dependent haze: bases dissolve, tops stand out; farther layers are more hazed.
    float lowH = 1.0 - smoothstep(0.0, 0.028, el);
    vec3 sil = vec3(0.0035, 0.0038, 0.0048);
    float hz;
    // far
    hz = mix(0.62, 1.0, lowH);
    col = mix(col, mix(sil, haze, hz) + wc * w.b * 2.6 * (1.0 - hz * 0.8), m.b * edge);
    // mid
    hz = mix(0.42, 1.0, lowH * 0.9);
    col = mix(col, mix(sil, haze, hz) + wc * w.g * 2.8 * (1.0 - hz * 0.75), m.g * edge);
    // near
    hz = mix(0.24, 0.96, lowH * 0.85);
    col = mix(col, mix(sil, haze * 0.92, hz) + wc * w.r * 3.0 * (1.0 - hz * 0.7), m.r * edge);
  }
  // Below the horizon: blend into the fog colour so the horizon line disappears into mist.
  float below = smoothstep(0.004, -0.02, el);
  col = mix(col, uFogCol, below);
  gl_FragColor = vec4(col, 1.0);
}`,
  });
  const geo = new SphereGeometry(400, 64, 40);
  const mesh = new Mesh(geo, material);
  mesh.name = 'bdSkyDome';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.matrixAutoUpdate = false;
  mesh.layers.set(LAYERS.DEFAULT);
  return { mesh, material, fogColor };
}
