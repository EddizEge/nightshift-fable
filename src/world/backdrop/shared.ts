/**
 * Backdrop shared state: uniforms updated by createBackdrop (and by chunk updaters as a fallback),
 * deterministic noise helpers, GLSL snippets and module-level geometry caches.
 */
import { BoxGeometry, Color, CylinderGeometry, Vector3 } from 'three';
import type { Box3, BufferGeometry, IUniform, InstancedMesh, Material, Mesh, Object3D } from 'three';
import type { IChunkBuilder } from '../../core/types';
import { hash2 } from '../../core/math';

/** Uniform objects shared by every backdrop material (referenced by identity). */
export const shared: {
  uTime: IUniform<number>;
  /** Drawing-buffer height in px (point sprites keep a minimum on-screen size). */
  uViewH: IUniform<number>;
  /** Lightning: xyz = direction of the flash in the sky, w = current intensity (0..~1.5). */
  uFlash: IUniform<{ x: number; y: number; z: number; w: number }>;
  /** Global sky lift from lightning (0..1). */
  uFlashGlobal: IUniform<number>;
  /** City glow / ambient radiance for unlit particles (steam). */
  uGlow: IUniform<Color>;
  /** Night fill on unlit backdrop surfaces (withNightFill): sky / city-glow irradiance from above. */
  uFill: IUniform<Color>;
  /** Rim irradiance on silhouette edges facing the glowing horizon. */
  uRim: IUniform<Color>;
  /** Fraction of the player's headlight spilling wide (beyond the beam) onto the verge, trees, fences. */
  uSpill: IUniform<number>;
} = {
  uTime: { value: 0 },
  uViewH: { value: 1080 },
  uFlash: { value: { x: 0, y: 0.2, z: -1, w: 0 } },
  uFlashGlobal: { value: 0 },
  uGlow: { value: new Color(0.05, 0.034, 0.024) },
  uFill: { value: new Color(0.62, 0.74, 1.0).multiplyScalar(0.5) },
  uRim: { value: new Color(1.0, 0.68, 0.45).multiplyScalar(2.4) },
  uSpill: { value: 0.07 },
};

/** Called from chunk updaters so animation keeps running even if createBackdrop().update is not wired. */
export function tickShared(time: number): void {
  if (time > shared.uTime.value || time < shared.uTime.value - 5) shared.uTime.value = time;
}

// ── deterministic noise (road-space, seam-free across chunks) ───────────────

const fade = (t: number) => t * t * (3 - 2 * t);

/** 2D value noise, 0..1. */
export function vnoise2(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const k = seed * 7919;
  const a = hash2(ix + k, iy);
  const b = hash2(ix + 1 + k, iy);
  const c = hash2(ix + k, iy + 1);
  const d = hash2(ix + 1 + k, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** 3-octave fbm, 0..1. */
export function fbm2(x: number, y: number, seed = 0): number {
  return (vnoise2(x, y, seed) * 0.57 + vnoise2(x * 2.03, y * 2.03, seed + 1) * 0.29 + vnoise2(x * 4.1, y * 4.1, seed + 2) * 0.14);
}

// ── GLSL ────────────────────────────────────────────────────────────────────

/** Hash helpers shared by the shaders. */
export const GLSL_HASH = /* glsl */ `
float bdHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float bdHash3(vec3 p) { return bdHash(p.xy + p.z * 17.17); }
`;

/** Fog helper using three's fog uniforms (material.fog = true + UniformsLib.fog). */
export const GLSL_FOG = /* glsl */ `
uniform vec3 fogColor;
uniform float fogDensity;
float bdFogFactor(float dist, float scale) {
  float k = fogDensity * scale * dist;
  return 1.0 - exp(-k * k);
}
`;

/**
 * Sky radiance in a world direction (shared by the dome and the water reflection).
 * Needs uniforms uTime, uFlash, uFlashGlobal and sampler uCloud (fbm noise, repeat).
 */
export const GLSL_CITYW = /* glsl */ `
float bdCityWeight(float az) {
  // az = 0 towards -Z (city), + towards +X. Main downtown glow, two satellite glows, dark behind.
  float w = 0.16 + 0.84 * exp(-az * az / 0.55) + 0.38 * exp(-pow(abs(az - 1.05), 2.0) / 0.12) + 0.28 * exp(-pow(abs(az + 1.35), 2.0) / 0.1);
  return w;
}
`;
export const GLSL_SKY = /* glsl */ `
const vec3 BD_SODIUM = vec3(1.0, 0.5, 0.22);
${GLSL_CITYW}
vec3 bdSkyBase(vec3 dir, float az) {
  float el = max(dir.y, 0.0);
  float cw = bdCityWeight(az);
  vec3 zenith = vec3(0.0085, 0.0094, 0.0118);
  vec3 horizon = vec3(0.021, 0.0205, 0.022);
  vec3 c = mix(horizon, zenith, pow(smoothstep(0.0, 1.0, el), 0.5));
  vec3 glow = vec3(1.0, 0.6, 0.36);
  c += glow * cw * (0.075 * exp(-el / 0.075) + 0.042 * exp(-el / 0.38));
  // Light dome over downtown.
  float dome = max(cw - 0.45, 0.0);
  c += glow * dome * dome * 0.09 * exp(-el / 0.14);
  return c;
}
/** Cloud density (0..1) of the overcast layer seen in direction dir (dir.y > 0). */
float bdClouds(vec3 dir, out float detail) {
  float y = max(dir.y, 0.035);
  vec2 p = dir.xz / y;
  vec2 wind = vec2(0.0045, 0.0021) * uTime;
  float n1 = texture2D(uCloud, p * 0.085 + wind).r;
  float n2 = texture2D(uCloud, p * 0.23 - wind * 1.7 + 0.37).r;
  float n3 = texture2D(uCloud, p * 0.61 + wind * 2.6 + 0.71).r;
  detail = n3;
  float d = n1 * 0.6 + n2 * 0.3 + n3 * 0.1;
  return smoothstep(0.3, 0.72, d);
}
vec3 bdSky(vec3 dir, out float cloud) {
  float az = atan(dir.x, -dir.z);
  vec3 base = bdSkyBase(dir, az);
  float detail;
  float c = bdClouds(dir, detail);
  float el = max(dir.y, 0.0);
  // Structure fades into haze towards the horizon (also hides projection stretching).
  float vis = smoothstep(0.015, 0.22, el);
  float cw = bdCityWeight(az);
  // Thick cloud bellies catch city light from below; thin gaps show the darker upper deck.
  float lit = mix(1.0, 0.28 + 1.45 * c, vis);
  vec3 col = base * lit;
  col += vec3(1.0, 0.6, 0.36) * cw * 0.06 * c * c * vis * exp(-el / 0.5);
  col *= mix(1.0, 0.8 + 0.4 * detail, vis * 0.7);
  cloud = mix(0.6, c, vis);
  // Lightning inside the clouds: localised glow lighting the cloud structure + small global lift.
  float fw = uFlash.w;
  if (fw > 0.0) {
    vec3 fd = normalize(vec3(uFlash.x, uFlash.y, uFlash.z));
    float ca = dot(dir, fd);
    float g = exp((ca - 1.0) * 9.0) * 1.0 + exp((ca - 1.0) * 2.2) * 0.2;
    col += vec3(0.62, 0.68, 0.9) * fw * g * (0.25 + 1.9 * cloud * cloud) * 0.55;
  }
  col += vec3(0.5, 0.55, 0.72) * uFlashGlobal * 0.026 * (0.4 + cloud);
  return col;
}
`;

// ── shared geometries (never disposed; added with sharedGeometry: true) ─────

let _box: BufferGeometry | null = null;
/** Unit box, base at y = 0 (x, z centred). */
export function unitBox(): BufferGeometry {
  if (!_box) {
    _box = new BoxGeometry(1, 1, 1);
    _box.translate(0, 0.5, 0);
  }
  return _box;
}
let _cyl: BufferGeometry | null = null;
/** Unit cylinder (radius 1, height 1, base at y = 0), 20 sides, capped. */
export function unitCylinder(): BufferGeometry {
  if (!_cyl) {
    _cyl = new CylinderGeometry(1, 1, 1, 20, 1, false);
    _cyl.translate(0, 0.5, 0);
  }
  return _cyl;
}
let _hcyl: BufferGeometry | null = null;
/** Unit cylinder lying along Z (radius 1, length 1 centred), 10 sides, open. */
export function unitPipe(): BufferGeometry {
  if (!_hcyl) {
    _hcyl = new CylinderGeometry(1, 1, 1, 10, 1, true);
    _hcyl.rotateX(Math.PI / 2);
  }
  return _hcyl;
}

export const _v3 = new Vector3();

/**
 * WORKAROUND (core bug, src/world/lightField.ts patchStatic): three 0.187 declares `vColor` as vec4,
 * but patchStatic's color_vertex replacement assigns vec3 → every patched material with vertex
 * colours or instanceColor fails to compile. Replacing the chunk before patchStatic runs makes its
 * replacement a no-op (same semantics: instanceColor carries baked light, it is not a tint).
 */
export const COLOR_VERTEX_FIX = /* glsl */ `
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
  vColor = vec4( 1.0 );
#endif
#ifdef USE_COLOR_ALPHA
  vColor *= color;
#elif defined( USE_COLOR )
  vColor.rgb *= color;
#endif`;

/** Wrap an already patched material so the color_vertex fix runs before patchStatic's hook. */
export function withColorFix<T extends Material>(m: T, tag: string): T {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', COLOR_VERTEX_FIX);
    prev.call(m, shader, renderer);
  };
  const pk = m.customProgramCacheKey;
  m.customProgramCacheKey = () => pk.call(m) + '|bdFix:' + tag;
  m.needsUpdate = true;
  return m;
}

/**
 * Night fill for unlit backdrop surfaces (terrain, verge, trees, fences, farm buildings). Wrap a
 * patchStatic'ed material (after withColorFix): its hook runs first, then this adds
 *   - a faint cool sky / city-glow irradiance (more from above), so dark forms read as blue-grey shapes,
 *   - a warm rim on silhouette edges seen against the glowing horizon (bdCityWeight of the view ray),
 *   - a wide, short-range spill of the player's headlight (verge, fences, tree trunks beside the car),
 *     through RE_Direct so wet surfaces get a real specular glint.
 * Cost: a few ALU per pixel on these materials only; no extra draw calls or uniforms per frame.
 */
export function withNightFill<T extends Material>(m: T, tag: string, k = 1, leaf: boolean | 'ground' = false): T {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.uniforms.uBdFill = shared.uFill;
    shader.uniforms.uBdRim = shared.uRim;
    shader.uniforms.uBdSpill = shared.uSpill;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uBdFill;
uniform vec3 uBdRim;
uniform float uBdSpill;
${GLSL_CITYW}
${leaf === true ? GLSL_HASH + GLSL_VNOISE3 : leaf === 'ground' ? GLSL_HASH + GLSL_VNOISE2P : ''}`,
      );
    if (leaf === 'ground') {
      // Verge ground + the vegetation merged into it (terrain.ts / roadside.ts): without lamps the only
      // light is a uniform sky fill, so a flat albedo reads as one pale plane. Break it up per pixel:
      // grass clumps and bare patches (albedo + colour: green, straw, soil), small rain puddles
      // (dark, glossy: they mirror the sky in patches instead of a uniform sheen) and a clump-scale
      // normal jitter near the camera (headlight / fire light catches individual clumps).
      // World xz with the height folded in, so shrub sides are not streaked vertically.
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  vec2 bdQ = vNsWorldPos.xz + vec2(0.8, -0.6) * vNsWorldPos.y;
  float bdG1 = bdN2(bdQ * 0.27);
  float bdG2 = bdN2(bdQ * 1.05 + 7.0);
  float bdG3 = bdN2(bdQ * 3.9 + 3.0);
  float bdUpG = clamp(vNsUp, 0.0, 1.0);
  float bdPud = smoothstep(0.74, 0.8, bdN2(bdQ * 0.16 + 31.0) * 0.75 + (1.0 - bdG2) * 0.25) * smoothstep(0.95, 0.995, bdUpG);
  float bdTone = (0.35 + 1.2 * bdG1) * (0.4 + 1.25 * bdG2 * bdG2) * (0.65 + 0.7 * bdG3);
  vec3 bdTint = mix(vec3(0.8, 1.1, 0.7), vec3(1.22, 1.0, 0.66), smoothstep(0.6, 0.9, bdG1 * 0.7 + bdG3 * 0.3));
  bdTint = mix(bdTint, vec3(1.15, 0.92, 0.78), smoothstep(0.6, 0.2, bdG2) * 0.45);
  // Asphalt (frontage roads: neutral / bluish vertex colour) keeps only a mild mottle.
  float bdVeg = smoothstep(0.0, 0.3, (vColor.g - vColor.b) / max(vColor.g, 1e-3));
  bdTone = mix(0.8 + 0.4 * bdG3, bdTone, bdVeg);
  bdTint = mix(vec3(1.0), bdTint, bdVeg);
  diffuseColor.rgb *= bdTone * bdTint * (1.0 - 0.55 * bdPud);`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
  {
    float bdFw = length(fwidth(vNsWorldPos));
    float bdNear = (1.0 - smoothstep(0.05, 0.2, bdFw)) * (1.0 - bdPud);
    if (bdNear > 0.0) {
      vec2 q = bdQ * 7.5;
      vec3 j = vec3(bdN2(q) - 0.5, 0.0, bdN2(q + 17.0) - 0.5);
      normal = normalize(normal + (viewMatrix * vec4(j, 0.0)).xyz * 0.9 * bdNear);
    }
  }`,
        )
        .replace(
          '#include <lights_fragment_begin>',
          `material.roughness = mix(clamp(material.roughness + 0.3 * bdG2 - 0.05, 0.0, 1.0), 0.5, bdPud);
#include <lights_fragment_begin>`,
        );
    }
    if (leaf === true) {
      // Foliage: leaf clumps (albedo), crevice darkening and a leaf-scale normal jitter that makes wet
      // leaves glint in the headlights; the jitter fades out by pixel footprint (no shimmer far away).
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  float bdLeafA = bdVN3(vNsWorldPos * 0.85);
  float bdLeafB = bdVN3(vNsWorldPos * 2.7 + 11.0);
  diffuseColor.rgb *= (0.35 + 1.05 * bdLeafA) * (0.6 + 0.8 * bdLeafB);`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
  {
    float bdFw = length(fwidth(vNsWorldPos));
    float bdNear = 1.0 - smoothstep(0.04, 0.16, bdFw);
    if (bdNear > 0.0) {
      vec3 q = vNsWorldPos * 4.3;
      vec3 j = vec3(bdVN3(q), bdVN3(q + 17.0), bdVN3(q + 31.0)) - 0.5;
      normal = normalize(normal + (viewMatrix * vec4(j, 0.0)).xyz * 1.6 * bdNear);
    }
  }`,
        );
    }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <lights_fragment_end>',
        `#ifdef RE_Direct
{
  vec3 bdNw = inverseTransformDirection(geometryNormal, viewMatrix);
  vec3 bdVw = normalize(vNsWorldPos - cameraPosition);
  float bdUp = clamp(bdNw.y * 0.5 + 0.5, 0.0, 1.0);
  float bdCw = bdCityWeight(atan(bdVw.x, -bdVw.z));
  vec3 bdIrr = uBdFill * (0.22 + 0.78 * bdUp * bdUp) * (0.75 + 0.3 * bdCw);
  float bdRim = pow(1.0 - clamp(dot(bdNw, -bdVw), 0.0, 1.0), 3.0) * smoothstep(-0.4, 0.3, bdNw.y + 0.15);
  bdIrr += uBdRim * bdRim * bdCw;
  reflectedLight.indirectDiffuse += bdIrr * BRDF_Lambert(material.diffuseColor) * ${k.toFixed(3)};
  reflectedLight.indirectSpecular += uBdRim * bdRim * bdCw * 0.012 * (1.0 - material.roughness) * ${k.toFixed(3)};
  vec3 bdHv = vNsWorldPos - uHeadPos;
  float bdHr2 = dot(bdHv, bdHv);
  float bdHr = sqrt(bdHr2);
  vec3 bdHl = bdHv / max(bdHr, 1e-3);
  float bdHc = dot(bdHl, uHeadDir);
  float bdWide = smoothstep(-0.15, 0.65, bdHc) * (1.0 - 0.8 * smoothstep(uHeadCone.y, uHeadCone.x, bdHc));
  float bdRange = 1.0 - smoothstep(22.0, 50.0, bdHr);
  if (bdWide * bdRange > 0.0) {
    IncidentLight bdL;
    bdL.direction = normalize((viewMatrix * vec4(-bdHl, 0.0)).xyz);
    bdL.color = uHeadColor * (uBdSpill * bdWide * bdRange / (bdHr2 + 6.0));
    bdL.visible = true;
    RE_Direct(bdL, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  }
}
#endif
#include <lights_fragment_end>`,
      );
  };
  const pk = m.customProgramCacheKey;
  m.customProgramCacheKey = () => pk.call(m) + '|bdFill:' + tag;
  m.needsUpdate = true;
  return m;
}

/** 2D value noise 0..1 with a 256-cell period (hash inputs stay small: exact at any world coordinate). Needs GLSL_HASH. */
export const GLSL_VNOISE2P = /* glsl */ `
float bdN2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec2 i0 = mod(i, 256.0);
  vec2 i1 = mod(i + 1.0, 256.0);
  return mix(mix(bdHash(i0), bdHash(vec2(i1.x, i0.y)), f.x), mix(bdHash(vec2(i0.x, i1.y)), bdHash(i1), f.x), f.y);
}
`;

/** 3D value noise 0..1 (needs GLSL_HASH). */
export const GLSL_VNOISE3 = /* glsl */ `
float bdVN3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(bdHash3(i), bdHash3(i + vec3(1.0, 0.0, 0.0)), f.x);
  float b = mix(bdHash3(i + vec3(0.0, 1.0, 0.0)), bdHash3(i + vec3(1.0, 1.0, 0.0)), f.x);
  float c = mix(bdHash3(i + vec3(0.0, 0.0, 1.0)), bdHash3(i + vec3(1.0, 0.0, 1.0)), f.x);
  float d = mix(bdHash3(i + vec3(0.0, 1.0, 1.0)), bdHash3(i + vec3(1.0, 1.0, 1.0)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}
`;

// ── distance culling (FogExp2 ≈ 0.0036 hides geometry beyond ~600 m; the streamer keeps more chunks) ──

/** Main camera position, updated by createBackdrop().update (culling is off until it runs). */
export const camState = { x: 0, y: 0, z: 0, valid: false };

/** Cull distances: lit point sprites carry further than surfaces (their fog is scaled down). */
const CULL_FAR_LIGHTS = 950;
const CULL_FAR = 500;
/** Lit city blocks stay a little longer (bright windows would pop). */
const CULL_FAR_BLOCKS = 620;

/**
 * Call at the end of a backdrop chunk builder: every 'bd*' mesh it added to the chunk is hidden
 * (all passes: main, reflection, probe) while its bounding sphere is beyond fog range.
 */
export function cullChunkMeshes(b: IChunkBuilder): void {
  // Nearest-point distance to the world-space bounding box (chunks are long and wide: spheres are too loose).
  const list: Array<{ o: Object3D; box: Box3; far: number }> = [];
  for (const o of b.group.children) {
    if (o.userData.bdCull || !/^bd/.test(o.name)) continue;
    o.userData.bdCull = true;
    const m = o as Mesh;
    let box: Box3 | null = null;
    if ((m as InstancedMesh).isInstancedMesh) {
      const im = m as InstancedMesh;
      im.computeBoundingBox();
      box = im.boundingBox;
    } else if (m.geometry) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      box = m.geometry.boundingBox;
    }
    if (!box) continue;
    const light = /Lights|Points|Plumes/.test(o.name);
    const far = light ? CULL_FAR_LIGHTS : /CityBlocks|Billboards/.test(o.name) ? CULL_FAR_BLOCKS : CULL_FAR;
    list.push({ o, box: box.clone().applyMatrix4(o.matrixWorld), far });
  }
  if (!list.length) return;
  b.onUpdate(() => {
    if (!camState.valid) return;
    _cp.set(camState.x, camState.y, camState.z);
    for (const e of list) e.o.visible = e.box.distanceToPoint(_cp) < e.far;
  });
}
const _cp = new Vector3();
