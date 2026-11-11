/**
 * Furniture materials. Everything is cached (shared between chunks, never disposed with them).
 */
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  MeshStandardMaterial,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
} from 'three';
import type { Material, Texture } from 'three';
import type { IChunkBuilder } from '../../../core/types';
import { getSignAtlas } from './signAtlas';

export const LAMP_RGB = new Color(1.0, 0.62, 0.3);

/** Shared animated time for halos / cones (any live chunk updates it). */
export const furnTime = { value: 0 };

/**
 * Work-around for lightField.patchStatic on three 0.187: its color_vertex replacement assigns a
 * vec3 to `vColor`, which is a vec4 since r16x (breaks vertexColors / instanceColor materials).
 * Harmless once the core is fixed (the strings simply stop matching).
 */
export function fixStaticColor<T extends Material>(m: T): T {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace('vColor = vec3( 1.0 );', 'vColor = vec4( 1.0 );').replace('vColor *= color;', 'vColor.rgb *= color.rgb;');
  };
  const prevKey = m.customProgramCacheKey;
  m.customProgramCacheKey = () => prevKey.call(m) + '|furnFix';
  m.needsUpdate = true;
  return m;
}

export function concreteMaterial(b: IChunkBuilder): Material {
  return b.materials.cached('furn:concrete', () => {
    const m = new MeshStandardMaterial({
      name: 'furn-concrete',
      map: b.materials.texture('concrete_albedo.webp', { srgb: true }),
      normalMap: b.materials.texture('concrete_normal.webp'),
      roughnessMap: b.materials.texture('concrete_rough.webp'),
      color: new Color(0.78, 0.76, 0.72),
      roughness: 1,
      metalness: 0,
    });
    m.normalScale.set(0.8, 0.8);
    const noise = b.materials.texture('noise_rgba.png');
    const grunge = b.materials.texture('grunge_mask.webp');
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uFurnNoise = { value: noise };
      shader.uniforms.uFurnGrunge = { value: grunge };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 nsW;\nvarying vec2 vFurnW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFurnW = nsW;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uFurnNoise;\nuniform sampler2D uFurnGrunge;\nvarying vec2 vFurnW;')
        .replace(
          '#include <map_fragment>',
          /* glsl */ `#include <map_fragment>
{
  float fs = vFurnW.x;
  float fy = vFurnW.y;
  // Vertical rain streaks running down from the top edge.
  float st = texture2D(uFurnNoise, vec2(fs * 0.61, fy * 0.035)).g;
  float st2 = texture2D(uFurnNoise, vec2(fs * 0.23 + 0.37, fy * 0.02)).r;
  float streak = smoothstep(0.52, 0.78, st * 0.7 + st2 * 0.5) * smoothstep(0.15, 0.95, fy);
  // Road-spray grime band at the base, patchy.
  float gr = texture2D(uFurnGrunge, vec2(fs * 0.11, fy * 0.45)).r;
  float low = (1.0 - smoothstep(0.02, 0.5 + 0.25 * gr, fy));
  // Contraction joints every 6 m: each segment poured / weathered differently (the main read at
  // speed), a soft shadow either side of the groove and a dark groove whose width never drops
  // below the pixel footprint (energy-conserving, so no shimmer at pixel ratio 0.7).
  float fw = max(fwidth(fs), 1e-4);
  float fwy = max(fwidth(fy), 1e-4);
  float seg = floor(fs / 6.0);
  float h1 = fract(sin(seg * 12.9898 + 1.7) * 43758.5453);
  float h2 = fract(sin(seg * 78.233 + 0.3) * 24634.6345);
  diffuseColor.rgb *= mix(0.8, 1.1, h1) * mix(vec3(1.0, 0.98, 0.95), vec3(0.95, 0.97, 1.0), h2);
  float jd = abs(mod(fs + 3.0, 6.0) - 3.0);
  float cw = 0.009 + 1.5 * fw;
  float joint = (1.0 - smoothstep(0.0, cw, jd)) * clamp(0.018 / cw, 0.0, 1.0);
  float halo = 1.0 - smoothstep(0.0, 0.1 + fw, jd);
  // Drain slots at the base, centred in every other segment (0.5 × 0.1 m).
  float sd = abs(mod(fs, 6.0) - 3.0);
  float slot = (1.0 - smoothstep(0.25, 0.25 + fw, sd)) * (1.0 - smoothstep(0.1, 0.1 + fwy, fy)) * step(0.5, fract(seg * 0.5));
  float slotLip = (1.0 - smoothstep(0.3, 0.3 + fw, sd)) * (1.0 - smoothstep(0.16, 0.16 + fwy, fy)) * step(0.5, fract(seg * 0.5));
  // Tyre scuffs: long horizontal rubber smears on the toe (0.04–0.4 m), in patches.
  float sc = texture2D(uFurnNoise, vec2(fs * 0.012, fy * 0.05 + 0.21)).b;
  float scPatch = smoothstep(0.45, 0.7, texture2D(uFurnNoise, vec2(fs * 0.0021 + 0.6, 0.77)).g);
  float scBand = smoothstep(0.03, 0.08, fy) * (1.0 - smoothstep(0.3, 0.42, fy));
  float scuff = smoothstep(0.62, 0.86, sc) * scPatch * scBand;
  float big = texture2D(uFurnNoise, vec2(fs * 0.017, 0.31)).r;
  vec3 dirt = vec3(0.46, 0.42, 0.36);
  diffuseColor.rgb *= mix(0.86, 1.06, big);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * dirt, low * (0.55 + 0.45 * gr));
  diffuseColor.rgb *= 1.0 - streak * 0.4;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025, 0.024, 0.023), scuff * 0.75);
  diffuseColor.rgb *= 1.0 - halo * 0.14;
  diffuseColor.rgb *= 1.0 - joint * 0.7;
  diffuseColor.rgb *= 1.0 - slotLip * 0.25;
  diffuseColor.rgb *= 1.0 - slot * 0.92;
}`,
        );
    };
    m.customProgramCacheKey = () => 'furnConcrete';
    return fixStaticColor(b.materials.patchStatic(m, { wetness: 1 }));
  });
}

/**
 * Soft-limit the *reflected* light of a material (lamps + headlights + retro-reflection), leaving
 * emissive untouched: retro-reflective sheeting saturates instead of blowing out in the beam.
 * Below `knee` nothing changes; above, it rolls off smoothly towards `max` (linear, max channel).
 */
export function limitReflected<T extends Material>(m: T, knee: number, max: number): T {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      /* glsl */ `{
  vec3 furnR = max(outgoingLight - totalEmissiveRadiance, vec3(0.0));
  float furnL = max(max(furnR.r, furnR.g), furnR.b);
  if (furnL > ${knee.toFixed(3)}) {
    float furnSpan = ${(max - knee).toFixed(3)};
    float furnC = ${knee.toFixed(3)} + furnSpan * (1.0 - exp(-(furnL - ${knee.toFixed(3)}) / furnSpan));
    outgoingLight = furnR * (furnC / furnL) + totalEmissiveRadiance;
  }
}
#include <opaque_fragment>`,
    );
  };
  const prevKey = m.customProgramCacheKey;
  m.customProgramCacheKey = () => prevKey.call(m) + `|furnLim${knee}:${max}`;
  m.needsUpdate = true;
  return m;
}

/**
 * Instanced props get ONE baked light value (an up-facing surface ~1.2 m above the base). Shade
 * it by the local normal so the faces of a post do not all glow alike: up-facing full, the face
 * towards the road (local −X, where the lamps are) partly, along-road faces a little, the back
 * almost nothing. Merged (non-instanced) geometry is untouched (it has per-vertex Lambert bakes).
 */
export function instanceLightByNormal<T extends Material>(m: T): T {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace(
      'vNsUp = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal).y;',
      `vNsUp = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal).y;
  {
    vec3 furnN = normalize(objectNormal);
    vNsBaked *= 0.08 + 0.42 * max(-furnN.x, 0.0) + 0.92 * max(furnN.y, 0.0) + 0.22 * abs(furnN.z);
  }`,
    );
  };
  const prevKey = m.customProgramCacheKey;
  m.customProgramCacheKey = () => prevKey.call(m) + '|furnInstN';
  m.needsUpdate = true;
  return m;
}

/**
 * Guardrail steel (W-beam, posts, bolts and the verge metalwork merged with it): hot-dip
 * galvanised zinc, slightly rough, every 4 m beam its own age/tone, vertical run-off streaks and
 * road-spray grime towards the bottom. Needs the `nsW` (s, height) attribute.
 */
export function railMaterial(b: IChunkBuilder): Material {
  return b.materials.cached('furn:rail', () => {
    const m = new MeshStandardMaterial({
      name: 'furn-rail',
      map: b.materials.texture('metal_galv_albedo.webp', { srgb: true }),
      normalMap: b.materials.texture('metal_galv_normal.webp'),
      roughnessMap: b.materials.texture('metal_galv_rough.webp'),
      color: new Color(0.6, 0.6, 0.58),
      roughness: 0.7,
      metalness: 0.6,
      vertexColors: true,
    });
    m.normalScale.set(0.5, 0.5);
    const noise = b.materials.texture('noise_rgba.png');
    const grunge = b.materials.texture('grunge_mask.webp');
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uFurnNoise = { value: noise };
      shader.uniforms.uFurnGrunge = { value: grunge };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 nsW;\nvarying vec2 vFurnW;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
#ifdef USE_INSTANCING
  // Instanced 4 m units: pseudo arc length from the world position (noise only needs continuity).
  { vec4 furnWp = instanceMatrix * vec4(position, 1.0); vFurnW = vec2((furnWp.x - furnWp.z) * 0.7071, position.y); }
#else
  vFurnW = nsW;
#endif`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uFurnNoise;\nuniform sampler2D uFurnGrunge;\nvarying vec2 vFurnW;')
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor * vFurnRough, 0.05, 1.0);`,
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `#include <map_fragment>
float vFurnRough = 1.0;
{
  float fs = vFurnW.x;
  float fy = vFurnW.y;
  // Each 4 m beam (and its posts) weathered differently: fresh bright zinc to dull grey.
  float seg = floor(fs * 0.25);
  float age = fract(sin(seg * 12.9898 + 3.1) * 43758.5453);
  diffuseColor.rgb *= mix(0.78, 1.08, age);
  vFurnRough = mix(0.8, 1.15, age);
  // Vertical run-off streaks (a few cm wide, long in y), low frequency only.
  float st = texture2D(uFurnNoise, vec2(fs * 0.11, fy * 0.006)).g;
  float st2 = texture2D(uFurnNoise, vec2(fs * 0.037 + 0.41, fy * 0.003)).b;
  float streak = smoothstep(0.5, 0.82, st * 0.65 + st2 * 0.45);
  diffuseColor.rgb *= 1.0 - streak * 0.28;
  // Road-spray grime, heaviest at the bottom edge of the beam and on the post feet.
  float gr = texture2D(uFurnGrunge, vec2(fs * 0.19, fy * 0.5)).r;
  float low = 1.0 - smoothstep(0.05, 0.58 + 0.18 * gr, fy);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.42, 0.38, 0.32), low * (0.45 + 0.55 * gr));
  vFurnRough *= mix(1.0, 1.25, low);
}`,
        );
    };
    m.customProgramCacheKey = () => 'furnRail';
    // Grazing headlight glints on wet zinc stay bright but never a white wall.
    return limitReflected(instanceLightByNormal(fixStaticColor(b.materials.patchStatic(m, { wetness: 1 }))), 0.45, 1.1);
  });
}

/** Galvanised / painted steel. Vertex colour tints (white = bare galvanised). */
export function metalMaterial(b: IChunkBuilder): Material {
  return b.materials.cached('furn:metal', () => {
    const m = new MeshStandardMaterial({
      name: 'furn-metal',
      map: b.materials.texture('metal_galv_albedo.webp', { srgb: true }),
      normalMap: b.materials.texture('metal_galv_normal.webp'),
      roughnessMap: b.materials.texture('metal_galv_rough.webp'),
      color: new Color(0.9, 0.9, 0.9),
      roughness: 0.85,
      // Low enough that baked lamp light (diffuse) still shows; wetness adds the sheen.
      metalness: 0.45,
      vertexColors: true,
    });
    m.normalScale.set(0.6, 0.6);
    return fixStaticColor(b.materials.patchStatic(m, { wetness: 1 }));
  });
}

/** White plastic delineator posts (vertex colours: white body, black band). */
export function plasticMaterial(b: IChunkBuilder): Material {
  return b.materials.cached('furn:plastic', () =>
    limitReflected(fixStaticColor(b.materials.standard({ name: 'furn-plastic', color: 0xffffff, roughness: 0.55, metalness: 0, vertexColors: true, wetness: 0.8, retroReflect: 0.12 })), 0.6, 1.2),
  );
}

/** Corner-cube reflectors (studs, delineators). Strong retro-reflection so they sparkle in the headlights. */
export function reflectorMaterial(b: IChunkBuilder): Material {
  return b.materials.cached('furn:reflector', () =>
    limitReflected(fixStaticColor(b.materials.standard({ name: 'furn-reflector', color: 0xffffff, roughness: 0.25, metalness: 0, vertexColors: true, wetness: 0.3, retroReflect: 1.6 })), 1.5, 3.0),
  );
}

/** Sign faces: shared atlas (albedo + faint/LED emissive), retro-reflective sheeting. */
export function signMaterial(b: IChunkBuilder): Material {
  return b.materials.cached('furn:sign', () => makeSignMaterial(b, 0.8, true));
}

/** Verge signs sit right in the headlight cone: lower retro gain so the legend survives, no self-glow. */
export function vergeSignMaterial(b: IChunkBuilder): Material {
  return b.materials.cached('furn:vsign', () => makeSignMaterial(b, 0.35, false));
}

function makeSignMaterial(b: IChunkBuilder, retro: number, glow: boolean): Material {
  {
    const atlas = getSignAtlas();
    const m = b.materials.standard({
      name: 'furn-sign',
      map: atlas.albedo,
      emissive: glow ? 0xffffff : 0x000000,
      emissiveIntensity: glow ? atlas.emissiveScale : 0,
      emissiveMap: glow ? atlas.emissive : null,
      roughness: 0.42,
      metalness: 0,
      wetness: 0.45,
      retroReflect: retro,
      alphaTest: 0.5,
    });
    // Lit sheeting stays ≤ ≈ 1.5 linear in the beam (LED / glow emissive is not limited).
    return limitReflected(fixStaticColor(m), 0.8, 1.5);
  }
}

/**
 * Lamp assemblies: the metal look + an emissive lens selected by the `aEmit` vertex attribute
 * (one draw call per assembly type). The lens fogs at 0.6× like b.materials.emissive light sources.
 */
export function lampMaterial(b: IChunkBuilder): Material {
  return b.materials.cached('furn:lamp', () => {
    const m = new MeshStandardMaterial({
      name: 'furn-lamp',
      map: b.materials.texture('metal_galv_albedo.webp', { srgb: true }),
      normalMap: b.materials.texture('metal_galv_normal.webp'),
      roughnessMap: b.materials.texture('metal_galv_rough.webp'),
      color: new Color(0.9, 0.9, 0.9),
      roughness: 0.8,
      metalness: 0.45,
      vertexColors: true,
    });
    m.normalScale.set(0.6, 0.6);
    const lens = { value: LAMP_RGB.clone().multiplyScalar(LENS_INTENSITY) };
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uFurnLens = lens;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aEmit;\nvarying float vFurnEmit;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFurnEmit = aEmit;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uFurnLens;\nvarying float vFurnEmit;')
        .replace(
          '#include <fog_fragment>',
          `#include <fog_fragment>
#ifdef USE_FOG
{
  // Light sources punch through fog more than lit surfaces (same 0.6 scale as b.materials.emissive).
  #ifdef FOG_EXP2
  float fz = vFogDepth * fogDensity;
  float fogL = 1.0 - exp(-fz * fz * 0.36);
  #else
  float fogL = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  gl_FragColor.rgb += vFurnEmit * mix(uFurnLens, fogColor, fogL);
}
#else
  gl_FragColor.rgb += vFurnEmit * uFurnLens;
#endif`,
        );
    };
    m.customProgramCacheKey = () => 'furnLamp';
    return fixStaticColor(b.materials.patchStatic(m, { wetness: 1 }));
  });
}

export const LENS_INTENSITY = 48;

const FOG_GLSL = /* glsl */ `
float furnFogT(float dist) {
#ifdef USE_FOG
  #ifdef FOG_EXP2
  return exp(-fogDensity * fogDensity * dist * dist * 0.36);
  #else
  return 1.0 - smoothstep(fogNear, fogFar, dist);
  #endif
#else
  return 1.0;
#endif
}`;

/**
 * Camera-facing glow halo (instanced unit quad). A tight bright core plus a faint wide veil,
 * slightly sagging below the lamp (lit rain under the luminaire), fog-aware, additive.
 */
export function haloMaterial(b: IChunkBuilder): Material {
  return b.materials.cached('furn:halo', () => {
    const m = new ShaderMaterial({
      name: 'furn-halo',
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uColor: { value: LAMP_RGB.clone() },
          uSize: { value: 7.0 },
          uCore: { value: 2.2 },
          uVeil: { value: 0.1 },
        },
      ]),
      vertexShader: /* glsl */ `
uniform float uSize;
varying vec2 vQ;
varying float vFade;
varying float vDist;
#include <fog_pars_vertex>
void main() {
  vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float dist = length(c.xyz);
  // Pull towards the camera so the sprite never cuts into the luminaire housing.
  c.xyz -= c.xyz / max(dist, 1e-3) * min(0.9, dist * 0.08);
  // Far away keep a minimum apparent size (≈ sub-pixel shimmer otherwise), dimmer to compensate.
  float grow = max(1.0, dist / 260.0);
  vec4 mvPosition = c + vec4(position.xy * uSize * grow, 0.0, 0.0);
  vQ = position.xy * uSize;
  vDist = dist;
  vFade = smoothstep(5.0, 24.0, dist) / (grow * grow);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
      fragmentShader: /* glsl */ `
uniform vec3 uColor;
uniform float uSize;
uniform float uCore;
uniform float uVeil;
varying vec2 vQ;
varying float vFade;
varying float vDist;
#include <fog_pars_fragment>
${FOG_GLSL}
void main() {
  vec2 q = vQ;
  // Veil sags a little: rain right under the lamp catches more light.
  vec2 qv = vec2(q.x, q.y + 0.35) * vec2(1.0, 0.82);
  float r2 = dot(q, q);
  float rv = length(qv);
  // Core ≈ 2.2 m across at 1/e², then a long soft scattering tail (no visible disc edge).
  float core = exp(-r2 / (2.0 * 0.32 * 0.32));
  float mid = exp(-r2 / (2.0 * 0.75 * 0.75)) * 0.07;
  float veil = (exp(-rv / 1.1) * 0.6 + exp(-rv / 0.45) * 0.4) * uVeil;
  float edge = 1.0 - smoothstep(uSize * 0.2, uSize * 0.5, length(q));
  float k = (core * uCore + mid + veil) * edge * vFade * furnFogT(vDist);
  // Slightly whiter in the very centre (the source saturates the eye / sensor).
  vec3 col = mix(uColor, vec3(1.0, 0.86, 0.68), core * 0.5) * k;
  gl_FragColor = vec4(col, 1.0);
}`,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      fog: true,
      toneMapped: false,
    });
    return m;
  });
}

/**
 * Volumetric haze cone under a luminaire (instanced open cone, top at the instance origin).
 * Fresnel-style falloff (bright where the surface faces the viewer, invisible at the silhouette),
 * strongest near the lamp, modulated by falling rain-mist noise. Very low intensity.
 */
export function coneMaterial(b: IChunkBuilder, height: number): Material {
  return b.materials.cached('furn:cone', () => {
    const noise: Texture = b.materials.texture('noise_rgba.png');
    const m = new ShaderMaterial({
      name: 'furn-cone',
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uColor: { value: LAMP_RGB.clone() },
          uIntensity: { value: 0.05 },
          uHeight: { value: height },
          uNoise: { value: null },
        },
      ]),
      vertexShader: /* glsl */ `
uniform float uHeight;
varying vec3 vWp;
varying vec3 vN;
varying float vH;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWp = wp.xyz;
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vH = clamp(-position.y / uHeight, 0.0, 1.0);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
      fragmentShader: /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform sampler2D uNoise;
uniform float uTime;
varying vec3 vWp;
varying vec3 vN;
varying float vH;
#include <fog_pars_fragment>
${FOG_GLSL}
void main() {
  vec3 V = cameraPosition - vWp;
  float dist = length(V);
  V /= max(dist, 1e-3);
  float ndv = abs(dot(normalize(vN), V));
  float rim = ndv * ndv * ndv;
  // Brightest right under the head, fading out well above the road.
  float h = vH;
  float fall = (1.0 / (1.0 + 7.0 * h * h)) * (1.0 - smoothstep(0.55, 1.0, h)) * smoothstep(0.0, 0.06, h);
  // Falling, drifting mist: two noise layers scrolled downwards.
  // Low-frequency only: high-frequency noise reads as dithering, not mist.
  vec2 a = vec2((vWp.x + vWp.z) * 0.035, vWp.y * 0.02 + uTime * 0.045);
  vec2 c = vec2((vWp.x - vWp.z) * 0.06 + 0.5, vWp.y * 0.035 + uTime * 0.11);
  float n = texture2D(uNoise, a).r * 0.55 + texture2D(uNoise, c).r * 0.45;
  float mist = mix(0.45, 1.4, smoothstep(0.3, 0.75, n));
  float near = smoothstep(1.5, 9.0, dist);
  float k = uIntensity * rim * fall * mist * near * furnFogT(dist);
  gl_FragColor = vec4(uColor * k, 1.0);
}`,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: true,
      toneMapped: false,
    });
    m.uniforms.uNoise.value = noise;
    m.uniforms.uTime = furnTime;
    return m;
  });
}
