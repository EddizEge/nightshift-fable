/**
 * Bridge zone: a dark water plane far below (y = BRIDGE_WATER_Y, ±1500 m) with moving ripples
 * reflecting the overcast city glow, distant shore lights along both lateral shores and on the
 * banks at the bridge ends, and long shimmering reflection streaks of those lights. 2 draw calls.
 */
import { Mesh, PlaneGeometry, ShaderMaterial, UniformsLib, UniformsUtils } from 'three';
import type { IChunkBuilder } from '../../core/types';
import { BRIDGE_WATER_Y, CHUNK_LENGTH } from '../roadProfile';
import { PointBatch, PointKind, blinkBeacon } from './points';
import { GLSL_FOG, GLSL_HASH, GLSL_SKY, shared } from './shared';

const WY = BRIDGE_WATER_Y;
const SODIUM: [number, number, number] = [1.0, 0.55, 0.24];
const WARM: [number, number, number] = [1.0, 0.7, 0.42];
const COOL: [number, number, number] = [0.75, 0.86, 1.0];

function waterMaterial(b: IChunkBuilder): ShaderMaterial {
  return b.materials.cached('bd.water', () => {
    const noise = b.materials.texture('noise_rgba.png');
    const cloud = b.materials.texture('noise_fbm_512.png');
    const m = new ShaderMaterial({
      name: 'bdWater',
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uNoise: { value: null }, uCloud: { value: null } }]),
      fog: true,
      vertexShader: /* glsl */ `
varying vec3 vWp;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWp = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`,
      fragmentShader: /* glsl */ `
uniform sampler2D uNoise;
uniform sampler2D uCloud;
uniform float uTime;
uniform vec4 uFlash;
uniform float uFlashGlobal;
varying vec3 vWp;
${GLSL_FOG}
${GLSL_HASH}
${GLSL_SKY}
float hgt(vec2 p) {
  float a = texture2D(uNoise, p * 0.018 + vec2(uTime * 0.0045, uTime * 0.003)).g;
  float b = texture2D(uNoise, p * 0.061 + vec2(-uTime * 0.009, uTime * 0.0075)).g;
  float c = texture2D(uNoise, p * 0.19 + vec2(uTime * 0.02, -uTime * 0.013)).r;
  return a * 0.55 + b * 0.3 + c * 0.15;
}
void main() {
  vec3 toP = vWp - cameraPosition;
  float dist = length(toP);
  vec3 V = toP / dist;
  vec2 p = vWp.xz;
  float e = 0.6;
  float h0 = hgt(p);
  float hx = hgt(p + vec2(e, 0.0));
  float hz = hgt(p + vec2(0.0, e));
  float k = 2.2 * (1.0 - smoothstep(120.0, 1100.0, dist) * 0.7);
  vec3 n = normalize(vec3((h0 - hx) * k, 1.0, (h0 - hz) * k));
  vec3 R = reflect(V, n);
  R.y = max(R.y, 0.004);
  float cloud;
  vec3 sky = bdSky(normalize(R), cloud);
  // Horizon glow of the far city reflected (the dome composites the skyline; here just its haze).
  float az = atan(R.x, -R.z);
  sky += vec3(1.0, 0.6, 0.36) * bdCityWeight(az) * 0.03 * exp(-R.y / 0.03);
  float cosT = max(dot(-V, n), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
  vec3 col = vec3(0.0012, 0.0017, 0.002) + sky * fres * 0.9;
  float f = bdFogFactor(dist, 0.5);
  gl_FragColor = vec4(mix(col, fogColor, f), 1.0);
}`,
    });
    m.uniforms.uNoise.value = noise;
    m.uniforms.uCloud.value = cloud;
    m.uniforms.uTime = shared.uTime;
    m.uniforms.uFlash = shared.uFlash;
    m.uniforms.uFlashGlobal = shared.uFlashGlobal;
    return m;
  }) as ShaderMaterial;
}

let _plane: PlaneGeometry | null = null;

export function buildBridge(b: IChunkBuilder): void {
  const sp = b.spec;
  if (sp.zone !== 'bridge') return;
  const r = () => b.rand();
  // Water: world-space plane centred on the chunk, aligned with the road heading (not bent, so it
  // never folds on curves; overlapping neighbours shade identically).
  if (!_plane) {
    _plane = new PlaneGeometry(3000, CHUNK_LENGTH + 170, 1, 1);
    _plane.rotateX(-Math.PI / 2);
  }
  const f = b.road.frameAt((sp.s0 + sp.s1) * 0.5);
  const water = new Mesh(_plane, waterMaterial(b));
  water.position.set(f.x, WY, f.z);
  water.rotation.y = -f.h;
  water.updateMatrix();
  water.matrixAutoUpdate = false;
  water.renderOrder = -10;
  water.name = 'bdWater';
  b.addObject(water);

  const pts = new PointBatch();
  const light = (s: number, d: number, y: number, col: [number, number, number], k: number, size: number, halo: number, haloAmt: number, streak: number, blink = 0) => {
    pts.add(s, d, y, col[0] * k, col[1] * k, col[2] * k, size, halo, haloAmt, blink, 0.32);
    if (streak > 0) {
      const ks = k * streak;
      pts.add(s, d, WY + 0.05, col[0] * ks, col[1] * ks, col[2] * ks, y - WY, 0, 0, 0, 0.32, PointKind.Streak);
    }
  };

  // Lateral far shores: a promenade lamp row, scattered windows, harbour cranes.
  for (const side of [1, -1]) {
    const shore = side * (560 + r() * 160);
    for (let s = sp.s0 + r() * 30; s < sp.s1; s += 26 + r() * 14) {
      const d = shore + (r() - 0.5) * 10;
      light(s, d, WY + 9, r() < 0.7 ? SODIUM : COOL, 26, 0.3, 5, 0.03, 0.22);
    }
    const nWin = 40 + Math.floor(r() * 30);
    for (let i = 0; i < nWin; i++) {
      const s = sp.s0 + r() * (sp.s1 - sp.s0);
      const d = shore + side * (15 + r() * 160);
      const y = WY + 4 + Math.pow(r(), 2) * 45;
      light(s, d, y, r() < 0.65 ? WARM : COOL, 3 + r() * 5, 0.7, 0, 0, r() < 0.3 ? 0.15 : 0);
    }
    if (r() < 0.6) {
      const s = sp.s0 + r() * (sp.s1 - sp.s0);
      const d = shore + side * 8;
      light(s, d, WY + 48, [1, 0.06, 0.03], 12, 0.4, 5, 0.03, 0.25, blinkBeacon(r()));
      light(s, d + side * 20, WY + 40, WARM, 10, 0.4, 3, 0.02, 0.2);
    }
  }
  // Banks at the bridge ends: the shoreline perpendicular to the road.
  const bankLights = (sBank: number, dir: number) => {
    for (const side of [1, -1]) {
      for (let d = 260 + r() * 30; d < 900; d += 22 + r() * 30) {
        const s = sBank + dir * (8 + r() * 18);
        light(s, side * d, WY + 7, r() < 0.6 ? SODIUM : COOL, 24, 0.3, 4.5, 0.03, 0.22);
        if (r() < 0.5) light(sBank + dir * (30 + r() * 140), side * (d + (r() - 0.5) * 30), WY + 6 + Math.pow(r(), 2) * 40, r() < 0.6 ? WARM : COOL, 3 + r() * 5, 0.7, 0, 0, 0);
      }
    }
  };
  if (sp.zoneIndex === 0) bankLights(sp.s0, -1);
  if (sp.zoneIndex === sp.zoneLength - 1) bankLights(sp.s1, 1);
  pts.build(b, 'bdShoreLights');
  b.onUpdate((t) => shared.uTime.value < t && (shared.uTime.value = t));
}
