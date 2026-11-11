/**
 * Night lighting core. Street lamps are never three.js lights:
 *  - road surface: per-pixel periodic lamp field (see roadSurface.ts, shares the constants below)
 *  - static world: baked per-vertex / per-instance irradiance (irradianceAt + patchStatic)
 *  - moving objects: the K nearest lamps as uniforms (patchDynamic)
 *  - particles / rain: glslLampField
 */
import { Color, DataTexture, NearestFilter, RedFormat, UnsignedByteType, Vector3, Vector4 } from 'three';
import type { IUniform, Material, Texture } from 'three';
import { MAX_DYNAMIC_LAMPS } from '../core/types';
import type { ILighting, IRoadPath } from '../core/types';
import {
  LAMP_HEIGHT,
  LAMP_MEDIAN_D,
  LAMP_MEDIAN_OPP_D,
  LAMP_OPP_OUTER_D,
  LAMP_RIGHT_D,
  LAMP_SPACING,
  MEDIAN_D,
  TUNNEL_LIGHT_D,
  TUNNEL_LIGHT_Y,
  mirrorD,
} from './roadProfile';

export const LAMP_SLOTS = 4096; // ring buffer of lamp slots (≈ 90 km)
/** Warm high-pressure-sodium-ish street light, radiant intensity (irradiance = I · cos / (r² + LAMP_SOFT)). */
export const LAMP_COLOR = new Color(1.0, 0.62, 0.3);
export const LAMP_INTENSITY = 620;
export const LAMP_SOFT = 4;
/** Tunnel strip lights: cooler white, modelled as line lights for baking and as points for dynamic objects. */
export const TUNNEL_COLOR = new Color(1.0, 0.86, 0.66);
export const TUNNEL_LINE_INTENSITY = 34; // irradiance = I · cos / r_perp
export const TUNNEL_POINT_SPACING = 11;
export const TUNNEL_POINT_INTENSITY = 190;

const MAX_FLASH = 2;

interface Flash {
  pos: Vector3;
  color: Color;
  intensity: number;
  duration: number;
  age: number;
  active: boolean;
}

/** Uniform bag used by static-world materials (wetness etc.) in addition to ILighting.uniforms. */
export interface WorldUniforms {
  /** 0..1 how wet exposed surfaces are right now. */
  uNsWet: IUniform<number>;
}

export class LightField implements ILighting {
  readonly uniforms: ILighting['uniforms'];
  readonly worldUniforms: WorldUniforms = { uNsWet: { value: 1 } };
  /** 1 texel per lamp slot: 255 = lamp on. Sampled by the road shader with texelFetch. */
  readonly lampTexture: DataTexture;
  private readonly lampData = new Uint8Array(LAMP_SLOTS);
  /** Tunnel intervals [s0, s1] (sorted), set by the world plan. */
  private tunnels: Array<[number, number]> = [];
  /** Nearest tunnel range for shaders: x = start, y = end (far away when none). */
  readonly uTunnelRange: IUniform<Vector4> = { value: new Vector4(1e9, 1e9 + 1, 1e9, 1e9 + 1) };
  readonly uLampTex: IUniform<Texture>;
  private flashes: Flash[] = [];
  private playerS = 0;
  private readonly tmpV = new Vector3();
  private readonly tmpC = new Color();
  readonly glslLampField: string;

  constructor(private road: IRoadPath) {
    this.lampTexture = new DataTexture(this.lampData, LAMP_SLOTS, 1, RedFormat, UnsignedByteType);
    this.lampTexture.minFilter = NearestFilter;
    this.lampTexture.magFilter = NearestFilter;
    this.lampTexture.generateMipmaps = false;
    this.lampTexture.needsUpdate = true;
    this.uLampTex = { value: this.lampTexture };

    const lampPos: Vector3[] = [];
    const lampColor: Color[] = [];
    for (let i = 0; i < MAX_DYNAMIC_LAMPS; i++) {
      lampPos.push(new Vector3(0, -1000, 0));
      lampColor.push(new Color(0, 0, 0));
    }
    const flashPos: Vector3[] = [];
    const flashColor: Color[] = [];
    for (let i = 0; i < MAX_FLASH; i++) {
      flashPos.push(new Vector3(0, -1000, 0));
      flashColor.push(new Color(0, 0, 0));
      this.flashes.push({ pos: new Vector3(), color: new Color(), intensity: 0, duration: 1, age: 0, active: false });
    }
    this.uniforms = {
      uLampPos: { value: lampPos },
      uLampColor: { value: lampColor },
      uHeadPos: { value: new Vector3(0, 0.7, 0) },
      uHeadDir: { value: new Vector3(0, -0.05, -1).normalize() },
      uHeadColor: { value: new Color(0, 0, 0) },
      uHeadCone: { value: new Vector3(Math.cos(0.3), Math.cos(0.62), 160) },
      uAmbient: { value: new Color(0.012, 0.016, 0.024) },
      uFogColor: { value: new Color(0.012, 0.016, 0.024) },
      uFogDensity: { value: 0.0022 },
      uTime: { value: 0 },
      uFlashPos: { value: flashPos },
      uFlashColor: { value: flashColor },
    };

    this.glslLampField = /* glsl */ `
#ifndef NS_LAMP_FIELD
#define NS_LAMP_FIELD
#define NS_MAX_LAMPS ${MAX_DYNAMIC_LAMPS}
uniform vec3 uLampPos[NS_MAX_LAMPS];
uniform vec3 uLampColor[NS_MAX_LAMPS];
uniform vec3 uFlashPos[${MAX_FLASH}];
uniform vec3 uFlashColor[${MAX_FLASH}];
uniform vec3 uHeadPos;
uniform vec3 uHeadDir;
uniform vec3 uHeadColor;
uniform vec3 uHeadCone;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uTime;
// Isotropic irradiance (no surface normal): lamps + explosion flashes.
vec3 nsLampLight(vec3 worldPos) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < NS_MAX_LAMPS; i++) {
    vec3 lv = uLampPos[i] - worldPos;
    sum += uLampColor[i] / (dot(lv, lv) + ${LAMP_SOFT.toFixed(1)});
  }
  for (int i = 0; i < ${MAX_FLASH}; i++) {
    vec3 lv = uFlashPos[i] - worldPos;
    sum += uFlashColor[i] / (dot(lv, lv) + 9.0);
  }
  return sum;
}
// Lambert irradiance on a surface with the given world normal.
vec3 nsLampLightN(vec3 worldPos, vec3 normal) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < NS_MAX_LAMPS; i++) {
    vec3 lv = uLampPos[i] - worldPos;
    float r2 = dot(lv, lv);
    sum += uLampColor[i] * max(dot(normal, lv) * inversesqrt(r2), 0.0) / (r2 + ${LAMP_SOFT.toFixed(1)});
  }
  for (int i = 0; i < ${MAX_FLASH}; i++) {
    vec3 lv = uFlashPos[i] - worldPos;
    float r2 = dot(lv, lv);
    sum += uFlashColor[i] * max(dot(normal, lv) * inversesqrt(r2), 0.0) / (r2 + 9.0);
  }
  return sum;
}
// Player headlight cone irradiance (no normal term): use to light rain / spray / smoke.
vec3 nsHeadlight(vec3 worldPos) {
  vec3 lv = worldPos - uHeadPos;
  float r2 = dot(lv, lv);
  float r = sqrt(r2);
  float c = dot(lv / max(r, 1e-3), uHeadDir);
  float cone = smoothstep(uHeadCone.y, uHeadCone.x, c);
  float range = 1.0 - smoothstep(uHeadCone.z * 0.55, uHeadCone.z, r);
  return uHeadColor * cone * range / (r2 + 6.0);
}
vec3 nsApplyFog(vec3 color, float viewDist) {
  float f = 1.0 - exp(-uFogDensity * uFogDensity * viewDist * viewDist);
  return mix(color, uFogColor, f);
}
#endif
`;
  }

  // ── lamp slots ──────────────────────────────────────────────────────────

  static slotIndex(s: number): number {
    return Math.round(s / LAMP_SPACING);
  }

  setLamp(k: number, on: boolean): void {
    const i = ((k % LAMP_SLOTS) + LAMP_SLOTS) % LAMP_SLOTS;
    const v = on ? 255 : 0;
    if (this.lampData[i] !== v) {
      this.lampData[i] = v;
      this.lampTexture.needsUpdate = true;
    }
  }

  lampOn(k: number): boolean {
    return this.lampData[((k % LAMP_SLOTS) + LAMP_SLOTS) % LAMP_SLOTS] !== 0;
  }

  setTunnels(ranges: Array<[number, number]>): void {
    this.tunnels = ranges;
  }

  /** 0 outside, 1 inside a tunnel; `soft` metres of blend around the portals. */
  tunnelAt(s: number, soft = 12): number {
    for (const [a, b] of this.tunnels) {
      if (s > a - soft && s < b + soft) {
        const inA = Math.min(1, Math.max(0, (s - (a - soft)) / (2 * soft)));
        const inB = Math.min(1, Math.max(0, (b + soft - s) / (2 * soft)));
        return Math.min(inA, inB);
      }
    }
    return 0;
  }

  // ── CPU irradiance (baking) ─────────────────────────────────────────────

  /**
   * Lamp irradiance at a road-space point. The normal is given in straight road space:
   * nx = lateral (+ right), ny = up, nz = along +Z of the straight frame (= backwards, -s).
   */
  irradianceAt(s: number, d: number, y: number, nx: number, ny: number, nz: number, out: Color): Color {
    let r = 0;
    let g = 0;
    let b = 0;
    const k0 = Math.round(s / LAMP_SPACING);
    for (let k = k0 - 3; k <= k0 + 3; k++) {
      if (!this.lampOn(k)) continue;
      const ds = k * LAMP_SPACING - s; // forward distance to the lamp
      const even = (k & 1) === 0;
      for (let side = 0; side < 2; side++) {
        const ld = even ? (side === 0 ? LAMP_MEDIAN_D : LAMP_MEDIAN_OPP_D) : side === 0 ? LAMP_RIGHT_D : LAMP_OPP_OUTER_D;
        const lx = ld - d;
        const ly = LAMP_HEIGHT - y;
        const lz = -ds; // straight frame: forward is -Z
        const r2 = lx * lx + ly * ly + lz * lz;
        const inv = 1 / Math.sqrt(r2);
        const cos = (nx * lx + ny * ly + nz * lz) * inv;
        if (cos <= 0) continue;
        // The median wall blocks nothing (lamps are high); keep it simple.
        const e = (LAMP_INTENSITY * cos) / (r2 + LAMP_SOFT);
        r += LAMP_COLOR.r * e;
        g += LAMP_COLOR.g * e;
        b += LAMP_COLOR.b * e;
      }
    }
    const t = this.tunnelAt(s, 6);
    if (t > 0) {
      // Two continuous strips per tube; pick the tube this point is in.
      const opp = d < MEDIAN_D;
      for (let i = 0; i < TUNNEL_LIGHT_D.length; i++) {
        const ld = opp ? mirrorD(TUNNEL_LIGHT_D[i]) : TUNNEL_LIGHT_D[i];
        const lx = ld - d;
        const ly = TUNNEL_LIGHT_Y - y;
        const rp = Math.sqrt(lx * lx + ly * ly);
        if (rp < 0.05) continue;
        // Line light: light arrives from the whole strip, so the along-road normal component still gets some.
        const cos = Math.max(0, (nx * lx + ny * ly) / rp) * 0.85 + Math.abs(nz) * 0.35;
        const e = (TUNNEL_LINE_INTENSITY * t * cos) / (rp + 0.6);
        r += TUNNEL_COLOR.r * e;
        g += TUNNEL_COLOR.g * e;
        b += TUNNEL_COLOR.b * e;
      }
    }
    return out.setRGB(r, g, b);
  }

  // ── transient flashes ───────────────────────────────────────────────────

  flash(position: Vector3, color: Color | number, intensity: number, duration: number): void {
    let slot = this.flashes.find((f) => !f.active);
    if (!slot) {
      // Replace the weakest.
      slot = this.flashes.reduce((a, b) => (a.intensity * (1 - a.age / a.duration) < b.intensity * (1 - b.age / b.duration) ? a : b));
    }
    slot.pos.copy(position);
    if (typeof color === 'number') slot.color.setHex(color);
    else slot.color.copy(color);
    slot.intensity = intensity;
    slot.duration = Math.max(0.05, duration);
    slot.age = 0;
    slot.active = true;
  }

  setPlayerS(s: number): void {
    this.playerS = s;
  }

  update(dt: number, time: number): void {
    const u = this.uniforms;
    u.uTime.value = time % 3600;

    // K nearest lamps around the player for dynamic objects.
    const lampPos = u.uLampPos.value;
    const lampColor = u.uLampColor.value;
    let n = 0;
    const s = this.playerS;
    const k0 = Math.round(s / LAMP_SPACING);
    const tunnel = this.tunnelAt(s, 30);
    if (tunnel < 1) {
      const half = tunnel > 0 ? 3 : MAX_DYNAMIC_LAMPS / 2;
      for (let k = k0 - half + 1; k <= k0 + half && n < MAX_DYNAMIC_LAMPS; k++) {
        if (!this.lampOn(k)) continue;
        const ld = (k & 1) === 0 ? LAMP_MEDIAN_D : LAMP_RIGHT_D;
        this.road.toWorld(k * LAMP_SPACING, ld, LAMP_HEIGHT, lampPos[n]);
        lampColor[n].copy(LAMP_COLOR).multiplyScalar(LAMP_INTENSITY);
        n++;
      }
    }
    if (tunnel > 0) {
      const i0 = Math.round(s / TUNNEL_POINT_SPACING);
      for (let i = i0 - 2; i <= i0 + 3 && n < MAX_DYNAMIC_LAMPS; i++) {
        const ps = i * TUNNEL_POINT_SPACING;
        const w = this.tunnelAt(ps, 4);
        if (w <= 0) continue;
        for (let j = 0; j < TUNNEL_LIGHT_D.length && n < MAX_DYNAMIC_LAMPS; j++) {
          this.road.toWorld(ps, TUNNEL_LIGHT_D[j], TUNNEL_LIGHT_Y, lampPos[n]);
          lampColor[n].copy(TUNNEL_COLOR).multiplyScalar(TUNNEL_POINT_INTENSITY * w);
          n++;
        }
      }
    }
    for (; n < MAX_DYNAMIC_LAMPS; n++) {
      lampPos[n].set(0, -1000, 0);
      lampColor[n].setRGB(0, 0, 0);
    }

    // Flashes.
    for (let i = 0; i < MAX_FLASH; i++) {
      const f = this.flashes[i];
      if (f.active) {
        f.age += dt;
        const t = f.age / f.duration;
        if (t >= 1) {
          f.active = false;
          u.uFlashColor.value[i].setRGB(0, 0, 0);
          continue;
        }
        // Fast attack, long tail.
        const env = Math.pow(1 - t, 2.2) * Math.min(1, f.age / 0.03);
        u.uFlashPos.value[i].copy(f.pos);
        u.uFlashColor.value[i].copy(f.color).multiplyScalar(f.intensity * env);
      } else {
        u.uFlashColor.value[i].setRGB(0, 0, 0);
      }
    }

    // Nearest tunnel for shaders (two nearest ranges packed in one vec4).
    const tr = this.uTunnelRange.value;
    tr.set(1e9, 1e9 + 1, 1e9, 1e9 + 1);
    let slot = 0;
    for (const [a, b] of this.tunnels) {
      if (b < s - 400 || a > s + 2500) continue;
      if (slot === 0) {
        tr.x = a;
        tr.y = b;
      } else if (slot === 1) {
        tr.z = a;
        tr.w = b;
      }
      slot++;
    }
    void this.tmpV;
    void this.tmpC;
  }

  // ── material patching ───────────────────────────────────────────────────

  /** Moving objects: nearest lamps + flashes as extra direct lights through three's BRDF. */
  patchDynamic<T extends Material>(m: T): T {
    const u = this.uniforms;
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (shader, renderer) => {
      prev?.call(m, shader, renderer);
      shader.uniforms.uLampPos = u.uLampPos;
      shader.uniforms.uLampColor = u.uLampColor;
      shader.uniforms.uFlashPos = u.uFlashPos;
      shader.uniforms.uFlashColor = u.uFlashColor;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
#define NS_MAX_LAMPS ${MAX_DYNAMIC_LAMPS}
uniform vec3 uLampPos[NS_MAX_LAMPS];
uniform vec3 uLampColor[NS_MAX_LAMPS];
uniform vec3 uFlashPos[${MAX_FLASH}];
uniform vec3 uFlashColor[${MAX_FLASH}];`,
        )
        .replace(
          '#include <lights_fragment_begin>',
          `#include <lights_fragment_begin>
#ifdef RE_Direct
{
  IncidentLight nsLight;
  nsLight.visible = true;
  for (int i = 0; i < NS_MAX_LAMPS; i++) {
    vec3 lc = uLampColor[i];
    if (lc.r + lc.g + lc.b > 0.0) {
      vec3 lv = (viewMatrix * vec4(uLampPos[i], 1.0)).xyz - geometryPosition;
      float r2 = dot(lv, lv);
      nsLight.direction = lv * inversesqrt(r2);
      nsLight.color = lc / (r2 + ${LAMP_SOFT.toFixed(1)});
      RE_Direct(nsLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
    }
  }
  for (int i = 0; i < ${MAX_FLASH}; i++) {
    vec3 lc = uFlashColor[i];
    if (lc.r + lc.g + lc.b > 0.0) {
      vec3 lv = (viewMatrix * vec4(uFlashPos[i], 1.0)).xyz - geometryPosition;
      float r2 = dot(lv, lv);
      nsLight.direction = lv * inversesqrt(r2);
      nsLight.color = lc / (r2 + 9.0);
      RE_Direct(nsLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
    }
  }
}
#endif`,
        );
    };
    // Distinct program cache key so patched and unpatched variants never share a program.
    const prevKey = m.customProgramCacheKey;
    m.customProgramCacheKey = () => (prevKey ? prevKey.call(m) : '') + '|nsDyn';
    m.needsUpdate = true;
    return m;
  }

  /**
   * Static world: baked lamp irradiance (attribute `bakedLight`, or InstancedMesh.instanceColor on
   * instanced meshes) + rain wetness + flashes + optional retro-reflection of the player's headlight.
   */
  patchStatic<T extends Material>(m: T, opts: { wetness?: number; retroReflect?: number } = {}): T {
    const u = this.uniforms;
    const wu = this.worldUniforms;
    const wet = opts.wetness ?? 1;
    const retro = opts.retroReflect ?? 0;
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (shader, renderer) => {
      prev?.call(m, shader, renderer);
      shader.uniforms.uNsWet = wu.uNsWet;
      shader.uniforms.uFlashPos = u.uFlashPos;
      shader.uniforms.uFlashColor = u.uFlashColor;
      shader.uniforms.uHeadPos = u.uHeadPos;
      shader.uniforms.uHeadDir = u.uHeadDir;
      shader.uniforms.uHeadColor = u.uHeadColor;
      shader.uniforms.uHeadCone = u.uHeadCone;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
#ifndef USE_INSTANCING
attribute vec3 bakedLight;
#endif
varying vec3 vNsBaked;
varying vec3 vNsWorldPos;
varying float vNsUp;`,
        )
        .replace(
          '#include <color_vertex>',
          // Same as three's chunk minus the instanceColor tint: instanceColor carries baked light here.
          `#if defined( USE_COLOR_ALPHA )
  vColor = vec4( 1.0 );
#elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
  vColor = vec3( 1.0 );
#endif
#ifdef USE_COLOR
  vColor *= color;
#endif`,
        )
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
#ifdef USE_INSTANCING
  #ifdef USE_INSTANCING_COLOR
    vNsBaked = instanceColor.xyz;
  #else
    vNsBaked = vec3(0.0);
  #endif
  vec4 nsWp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
  vNsUp = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal).y;
#else
  vNsBaked = bakedLight;
  vec4 nsWp = modelMatrix * vec4(transformed, 1.0);
  vNsUp = normalize(mat3(modelMatrix) * objectNormal).y;
#endif
  vNsWorldPos = nsWp.xyz;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uNsWet;
uniform vec3 uFlashPos[${MAX_FLASH}];
uniform vec3 uFlashColor[${MAX_FLASH}];
uniform vec3 uHeadPos;
uniform vec3 uHeadDir;
uniform vec3 uHeadColor;
uniform vec3 uHeadCone;
varying vec3 vNsBaked;
varying vec3 vNsWorldPos;
varying float vNsUp;`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
{
  float nsWet = uNsWet * ${wet.toFixed(3)};
  float nsUp = clamp(vNsUp * 0.5 + 0.5, 0.0, 1.0);
  roughnessFactor *= mix(1.0, 0.45, nsWet * (0.35 + 0.65 * nsUp));
  diffuseColor.rgb *= mix(1.0, 0.62, nsWet);
}`,
        )
        .replace(
          '#include <lights_fragment_begin>',
          `#include <lights_fragment_begin>
#ifdef RE_Direct
{
  reflectedLight.directDiffuse += vNsBaked * BRDF_Lambert(material.diffuseColor);
  IncidentLight nsLight;
  nsLight.visible = true;
  for (int i = 0; i < ${MAX_FLASH}; i++) {
    vec3 lc = uFlashColor[i];
    if (lc.r + lc.g + lc.b > 0.0) {
      vec3 lv = (viewMatrix * vec4(uFlashPos[i], 1.0)).xyz - geometryPosition;
      float r2 = dot(lv, lv);
      nsLight.direction = lv * inversesqrt(r2);
      nsLight.color = lc / (r2 + 9.0);
      RE_Direct(nsLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
    }
  }
  ${
    retro > 0
      ? `{
    // Retro-reflective sheeting / paint: returns headlight light towards the driver regardless of the surface normal.
    vec3 hv = vNsWorldPos - uHeadPos;
    float hr2 = dot(hv, hv);
    float hr = sqrt(hr2);
    float hc = dot(hv / max(hr, 1e-3), uHeadDir);
    float cone = smoothstep(uHeadCone.y - 0.25, uHeadCone.x, hc);
    float range = 1.0 - smoothstep(uHeadCone.z * 0.8, uHeadCone.z * 1.6, hr);
    reflectedLight.directDiffuse += material.diffuseColor * uHeadColor * (cone * range * ${retro.toFixed(3)} * 0.9 / (hr2 * 0.35 + 30.0));
  }`
      : ''
  }
}
#endif`,
        );
    };
    const prevKey = m.customProgramCacheKey;
    m.customProgramCacheKey = () => (prevKey ? prevKey.call(m) : '') + `|nsStatic:${wet.toFixed(3)}:${retro.toFixed(3)}`;
    m.needsUpdate = true;
    return m;
  }
}
