/**
 * The wet asphalt. One strip mesh per chunk covering both carriageways, shaded by a patched
 * MeshStandardMaterial:
 *   - PBR asphalt (albedo / normal / roughness, anti-tiling), procedural lane paint with wear
 *   - water film, wheel-track ruts, puddles with rain ripples
 *   - analytic periodic street-lamp field with soft analytic car shadows + contact AO
 *   - vehicle light pools (tail-light glow, traffic / oncoming headlights), explosion flashes
 *   - planar reflection with roughness-driven vertical streaking ("light pillars" on wet asphalt)
 */
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, Vector2, Vector4 } from 'three';
import type { IUniform, Texture } from 'three';
import type { IChunkBuilder, IQuality, RoadFrame } from '../core/types';
import { LAYERS } from '../core/types';
import type { LightField } from './lightField';
import { LAMP_COLOR, LAMP_INTENSITY, LAMP_SLOTS, LAMP_SOFT, TUNNEL_COLOR, TUNNEL_LINE_INTENSITY } from './lightField';
import type { WorldMaterials } from './materials';
import {
  CHUNK_LENGTH,
  LAMP_HEIGHT,
  LAMP_MEDIAN_D,
  LAMP_MEDIAN_OPP_D,
  LAMP_OPP_OUTER_D,
  LAMP_RIGHT_D,
  LAMP_SPACING,
  LANES_HALF,
  LANE_WIDTH,
  MEDIAN_D,
  PAVED_LEFT_D,
  PAVED_RIGHT_D,
  TUNNEL_LIGHT_D,
  TUNNEL_LIGHT_Y,
} from './roadProfile';

export const ROAD_MAX_CARS = 10;
export const ROAD_MAX_POOLS = 14;
const ROW_STEP = 4; // metres between cross-section rows

export interface RoadCar {
  x: number;
  z: number;
  heading: number;
  halfWidth: number;
  halfLength: number;
  height: number;
}

export interface RoadPool {
  x: number;
  z: number;
  /** Unit direction (xz) the light is thrown towards. */
  dx: number;
  dz: number;
  r: number;
  g: number;
  b: number;
  /** > 5: headlight throw length in metres. ≤ 5: radius of a round glow (tail lights, fire). */
  size: number;
}

const f = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));

export class RoadSurface {
  readonly material: MeshStandardMaterial;
  readonly uniforms: {
    uAsphalt: IUniform<Texture | null>;
    uAsphaltN: IUniform<Texture | null>;
    uAsphaltR: IUniform<Texture | null>;
    tRefl: IUniform<Texture | null>;
    uReflOn: IUniform<number>;
    uNsResolution: IUniform<Vector2>;
    uCarA: IUniform<Vector4[]>;
    uCarB: IUniform<Vector4[]>;
    uPoolA: IUniform<Vector4[]>;
    uPoolB: IUniform<Vector4[]>;
    uRain: IUniform<number>;
    uStreak: IUniform<number>;
    uReflGain: IUniform<number>;
  };

  constructor(
    private lighting: LightField,
    private quality: IQuality,
    mats: WorldMaterials,
  ) {
    const carA: Vector4[] = [];
    const carB: Vector4[] = [];
    for (let i = 0; i < ROAD_MAX_CARS; i++) {
      carA.push(new Vector4(0, 0, 1, 0));
      carB.push(new Vector4(0, 0, 0, 0));
    }
    const poolA: Vector4[] = [];
    const poolB: Vector4[] = [];
    for (let i = 0; i < ROAD_MAX_POOLS; i++) {
      poolA.push(new Vector4(0, 0, 0, -1));
      poolB.push(new Vector4(0, 0, 0, 0));
    }
    this.uniforms = {
      uAsphalt: { value: mats.texture('asphalt_albedo.webp', { srgb: true }) },
      uAsphaltN: { value: mats.texture('asphalt_normal.webp') },
      uAsphaltR: { value: mats.texture('asphalt_rough.webp') },
      tRefl: { value: null },
      uReflOn: { value: 0 },
      uNsResolution: { value: new Vector2(1, 1) },
      uCarA: { value: carA },
      uCarB: { value: carB },
      uPoolA: { value: poolA },
      uPoolB: { value: poolB },
      uRain: { value: 1 },
      uStreak: { value: 1 },
      uReflGain: { value: 1 },
    };

    this.material = new MeshStandardMaterial({
      name: 'wetAsphalt',
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      fog: true,
    });
    this.material.onBeforeCompile = (shader) => this.patch(shader);
    this.material.customProgramCacheKey = () => `nsRoad:${this.quality.level}`;
  }

  /** Call when the quality preset changes (shader variants depend on it). */
  refreshQuality(): void {
    this.material.needsUpdate = true;
  }

  setCars(cars: readonly RoadCar[]): void {
    const a = this.uniforms.uCarA.value;
    const b = this.uniforms.uCarB.value;
    for (let i = 0; i < ROAD_MAX_CARS; i++) {
      const c = cars[i];
      if (c) {
        a[i].set(c.x, c.z, Math.cos(c.heading), Math.sin(c.heading));
        b[i].set(c.halfWidth, c.halfLength, c.height, 1);
      } else {
        b[i].set(0, 0, 0, 0);
      }
    }
  }

  setPools(pools: readonly RoadPool[]): void {
    const a = this.uniforms.uPoolA.value;
    const b = this.uniforms.uPoolB.value;
    for (let i = 0; i < ROAD_MAX_POOLS; i++) {
      const p = pools[i];
      if (p) {
        a[i].set(p.x, p.z, p.dx, p.dz);
        b[i].set(p.r, p.g, p.b, p.size);
      } else {
        b[i].set(0, 0, 0, 0);
      }
    }
  }

  /** World feature: builds the road strip of one chunk. */
  build = (b: IChunkBuilder): void => {
    const spec = b.spec;
    const rows = Math.round(CHUNK_LENGTH / ROW_STEP) + 1;
    // Lateral stations: denser across the lanes, sparse on the far side.
    const cols: number[] = [];
    for (let d = PAVED_LEFT_D; d < PAVED_RIGHT_D - 0.01; d += LANE_WIDTH * 0.5) cols.push(d);
    cols.push(PAVED_RIGHT_D);
    const nCols = cols.length;
    const pos = new Float32Array(rows * nCols * 3);
    const nor = new Float32Array(rows * nCols * 3);
    const aRoad = new Float32Array(rows * nCols * 3);
    const aRoad2 = new Float32Array(rows * nCols * 3);
    const slotBase = (((Math.round(spec.s0 / LAMP_SPACING) % LAMP_SLOTS) + LAMP_SLOTS) % LAMP_SLOTS);
    const frame: RoadFrame = { s: 0, x: 0, z: 0, h: 0, k: 0, tx: 0, tz: -1, rx: 1, rz: 0 };
    let p = 0;
    for (let r = 0; r < rows; r++) {
      const sLocal = r * ROW_STEP;
      const s = spec.s0 + sLocal;
      b.road.frameAt(s, frame);
      const tunnel = this.lighting.tunnelAt(s, 14);
      for (let c = 0; c < nCols; c++) {
        const d = cols[c];
        pos[p] = frame.x + frame.rx * d;
        pos[p + 1] = 0;
        pos[p + 2] = frame.z + frame.rz * d;
        nor[p] = 0;
        nor[p + 1] = 1;
        nor[p + 2] = 0;
        aRoad[p] = d;
        aRoad[p + 1] = sLocal;
        aRoad[p + 2] = slotBase;
        aRoad2[p] = frame.rx;
        aRoad2[p + 1] = frame.rz;
        aRoad2[p + 2] = tunnel;
        p += 3;
      }
    }
    const idx = new Uint16Array((rows - 1) * (nCols - 1) * 6);
    let q = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < nCols - 1; c++) {
        const i0 = r * nCols + c;
        const i1 = i0 + 1;
        const i2 = i0 + nCols;
        const i3 = i2 + 1;
        // +s is forward (−Z at h = 0), +d is right: wind counter-clockwise seen from above.
        idx[q++] = i0;
        idx[q++] = i1;
        idx[q++] = i2;
        idx[q++] = i1;
        idx[q++] = i3;
        idx[q++] = i2;
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('normal', new BufferAttribute(nor, 3));
    geo.setAttribute('aRoad', new BufferAttribute(aRoad, 3));
    geo.setAttribute('aRoad2', new BufferAttribute(aRoad2, 3));
    geo.setIndex(new BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const m = new Mesh(geo, this.material);
    m.name = 'road';
    m.matrixAutoUpdate = false;
    m.layers.set(LAYERS.ROAD);
    m.receiveShadow = true;
    b.addObject(m);
    b.onDispose(() => geo.dispose());
  };

  // ── shader ──────────────────────────────────────────────────────────────

  private patch(shader: { uniforms: Record<string, IUniform>; vertexShader: string; fragmentShader: string; defines?: Record<string, unknown> }): void {
    const q = this.quality.settings;
    const L = this.lighting;
    const u = this.uniforms;
    Object.assign(shader.uniforms, u, {
      uLampTex: L.uLampTex,
      uNsTime: L.uniforms.uTime,
      uNsWet: L.worldUniforms.uNsWet,
      uHeadPos: L.uniforms.uHeadPos,
      uHeadDir: L.uniforms.uHeadDir,
      uHeadColor: L.uniforms.uHeadColor,
      uHeadCone: L.uniforms.uHeadCone,
      uFlashPos: L.uniforms.uFlashPos,
      uFlashColor: L.uniforms.uFlashColor,
    });
    const shadowCars = q.level === 'low' ? 1 : q.level === 'medium' ? 5 : ROAD_MAX_CARS;
    const taps = q.level === 'ultra' ? 16 : q.level === 'high' ? 12 : 8;
    const lampAhead = q.level === 'ultra' ? 7 : q.level === 'high' ? 6 : q.level === 'medium' ? 4 : 2;
    const planar = q.planarReflection;
    const lampRGB = `vec3(${f(LAMP_COLOR.r * LAMP_INTENSITY)}, ${f(LAMP_COLOR.g * LAMP_INTENSITY)}, ${f(LAMP_COLOR.b * LAMP_INTENSITY)})`;
    const tunRGB = `vec3(${f(TUNNEL_COLOR.r * TUNNEL_LINE_INTENSITY)}, ${f(TUNNEL_COLOR.g * TUNNEL_LINE_INTENSITY)}, ${f(TUNNEL_COLOR.b * TUNNEL_LINE_INTENSITY)})`;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 aRoad;
attribute vec3 aRoad2;
varying vec3 vRoad;
varying vec3 vRoad2;
varying vec3 vNsWorldPos;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vRoad = aRoad;
vRoad2 = aRoad2;
vNsWorldPos = position;`,
      );

    const header = /* glsl */ `
#define NS_CARS ${ROAD_MAX_CARS}
#define NS_SHADOW_CARS ${shadowCars}
#define NS_POOLS ${ROAD_MAX_POOLS}
#define NS_TAPS ${taps}
#define NS_LAMP_AHEAD ${lampAhead}
${planar ? '#define NS_PLANAR' : ''}
uniform sampler2D uAsphalt;
uniform sampler2D uAsphaltN;
uniform sampler2D uAsphaltR;
uniform sampler2D tRefl;
uniform float uReflOn;
uniform vec2 uNsResolution;
uniform sampler2D uLampTex;
uniform vec4 uCarA[NS_CARS];
uniform vec4 uCarB[NS_CARS];
uniform vec4 uPoolA[NS_POOLS];
uniform vec4 uPoolB[NS_POOLS];
uniform float uRain;
uniform float uStreak;
uniform float uReflGain;
uniform float uNsTime;
uniform float uNsWet;
uniform vec3 uHeadPos;
uniform vec3 uHeadDir;
uniform vec3 uHeadColor;
uniform vec3 uHeadCone;
uniform vec3 uFlashPos[2];
uniform vec3 uFlashColor[2];
varying vec3 vRoad;
varying vec3 vRoad2;
varying vec3 vNsWorldPos;

float nsHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 nsHash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
// Value noise, periodic along y with period py (cells), so chunks tile seamlessly along the road.
float nsNoiseP(vec2 p, float py) {
  vec2 i = floor(p);
  vec2 fr = fract(p);
  fr = fr * fr * (3.0 - 2.0 * fr);
  float y0 = mod(i.y, py);
  float y1 = mod(i.y + 1.0, py);
  float a = nsHash(vec2(i.x, y0));
  float b = nsHash(vec2(i.x + 1.0, y0));
  float c = nsHash(vec2(i.x, y1));
  float d = nsHash(vec2(i.x + 1.0, y1));
  return mix(mix(a, b, fr.x), mix(c, d, fr.x), fr.y);
}
float nsIGN(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}
// Expanding ring ripples from rain drops: returns a normal offset (xz). Each cell holds at most one
// drop; cells take turns (most are idle at any moment) so the rings never read as a grid.
vec2 nsRipple(vec2 uv, float t) {
  vec2 cell = floor(uv);
  vec2 fr = fract(uv);
  vec2 h = nsHash2(cell);
  float cyc = t * (0.55 + h.y * 0.5) + h.x * 7.0;
  float phase = fract(cyc);
  // A new random drop position and an on/off decision every cycle.
  vec2 hc = nsHash2(cell + floor(cyc) * 7.31 + 17.0);
  if (hc.x > 0.45) return vec2(0.0);
  vec2 c = 0.25 + 0.5 * nsHash2(cell + floor(cyc) * 3.17 + 5.0);
  vec2 dv = fr - c;
  float dist = length(dv) + 1e-4;
  float radius = phase * (0.16 + 0.1 * hc.y);
  float band = smoothstep(radius - 0.05, radius, dist) * (1.0 - smoothstep(radius, radius + 0.012, dist));
  float fade = (1.0 - phase);
  float ring = sin((dist - radius) * 150.0) * band * fade * fade;
  return dv / dist * ring;
}
// Lane paint mask for our carriageway coordinates (d relative to carriageway centre). Returns x = white, y = yellow.
vec2 nsPaint(float d, float sL, float aa) {
  float hw = 0.085; // half line width
  float lane = ${f(LANE_WIDTH)};
  // Interior dashed lines at -lane, 0, +lane.
  float dl = abs(mod(d + lane * 0.5, lane) - lane * 0.5);
  float inner = (1.0 - smoothstep(hw - aa, hw + aa, dl)) * step(abs(d), lane * 1.5);
  float ph = mod(sL, 11.0);
  float dash = smoothstep(0.0, 0.06, ph) * (1.0 - smoothstep(3.6, 3.66, ph));
  inner *= dash;
  // Solid edge lines just inside the lane edges.
  float er = abs(d - (${f(LANES_HALF)} - 0.12));
  float el = abs(d + (${f(LANES_HALF)} - 0.12));
  float right = 1.0 - smoothstep(hw + 0.01 - aa, hw + 0.01 + aa, er);
  float left = 1.0 - smoothstep(hw + 0.01 - aa, hw + 0.01 + aa, el);
  return vec2(max(inner, right), left);
}
struct NsSurface {
  vec3 albedo;
  vec3 normalW;
  float rough;
  float puddle;
  float paint;
  float wet;
};
float nsCarAO(vec3 P) {
  float ao = 1.0;
  for (int i = 0; i < NS_CARS; i++) {
    vec4 b = uCarB[i];
    if (b.w < 0.5) continue;
    vec4 a = uCarA[i];
    vec2 rel = P.xz - a.xy;
    if (dot(rel, rel) > 400.0) continue;
    vec2 loc = vec2(dot(rel, a.zw), dot(rel, vec2(a.w, -a.z)));
    vec2 qd = abs(loc) - b.xy;
    float sd = length(max(qd, 0.0)) + min(max(qd.x, qd.y), 0.0);
    ao *= 1.0 - 0.82 * (1.0 - smoothstep(-0.35, 0.6, sd));
  }
  return ao;
}
// Soft analytic shadow of the car boxes for a light at P + Lv.
float nsCarShadow(vec3 P, vec3 Lv) {
  float sh = 1.0;
  for (int i = 0; i < NS_SHADOW_CARS; i++) {
    vec4 b = uCarB[i];
    if (b.w < 0.5) continue;
    vec4 a = uCarA[i];
    vec2 rel = P.xz - a.xy;
    if (dot(rel, rel) > 1600.0) continue;
    vec2 rgt = a.zw;
    vec2 fwd = vec2(a.w, -a.z);
    vec3 o = vec3(dot(rel, rgt), P.y, dot(rel, fwd));
    vec3 dir = vec3(dot(Lv.xz, rgt), Lv.y, dot(Lv.xz, fwd));
    dir += step(abs(dir), vec3(1e-4)) * 1e-4;
    vec3 inv = 1.0 / dir;
    vec3 t0 = (vec3(-b.x, 0.2, -b.y) - o) * inv;
    vec3 t1 = (vec3(b.x, b.z, b.y) - o) * inv;
    vec3 tmn = min(t0, t1);
    vec3 tmx = max(t0, t1);
    float tn = max(max(tmn.x, tmn.y), tmn.z);
    float tf = min(min(tmx.x, tmx.y), tmx.z);
    float chord = (min(tf, 1.0) - max(tn, 0.0)) * length(dir);
    sh *= 1.0 - clamp(chord * 2.2, 0.0, 1.0) * 0.9;
  }
  return sh;
}
vec3 nsPools(vec3 P) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < NS_POOLS; i++) {
    vec4 b = uPoolB[i];
    if (b.w <= 0.0) continue;
    vec4 a = uPoolA[i];
    vec2 rel = P.xz - a.xy;
    if (b.w > 5.0) {
      float along = dot(rel, a.zw);
      float lat = dot(rel, vec2(-a.w, a.z));
      float w = 1.25 + max(along, 0.0) * 0.16;
      // max(): far behind the lamp exp(+x) overflows to inf, and 0 * inf is a NaN texel that the bloom
      // mip chain smears into a screen-sized black block.
      sum += b.rgb * (smoothstep(0.3, 3.5, along) * exp(-max(along, 0.0) / b.w) * exp(-lat * lat / (2.0 * w * w)));
    } else {
      sum += b.rgb * exp(-dot(rel, rel) / (b.w * b.w));
    }
  }
  return sum;
}
#ifdef NS_PLANAR
vec3 nsPlanar(vec2 sUv, vec2 distort, float rough, float viewDist) {
  vec2 uv = vec2(1.0 - sUv.x, sUv.y) + distort;
  // Horizontal blur from the mip chain stays small; roughness mostly stretches highlights
  // vertically (anisotropic microfacet streaks, the classic wet-asphalt light pillars).
  float lod = clamp(rough * 4.0 - 0.2, 0.0, 3.2);
  float streak = uStreak * (0.004 + rough * rough * 0.5) * (0.45 + 0.55 / (1.0 + viewDist * 0.02));
  float jitter = nsIGN(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < NS_TAPS; i++) {
    float t = (float(i) + jitter) / float(NS_TAPS);
    // Skewed towards +v: the smear reaches down the screen, towards the viewer.
    float o = t * 1.35 - 0.35;
    float w = exp(-2.2 * abs(o));
    vec2 tuv = uv + vec2(0.0, o * streak);
    vec3 c = textureLod(tRefl, clamp(tuv, vec2(0.001), vec2(0.999)), lod).rgb;
    // RMS accumulation: smooth areas stay unchanged, point lights keep a visible streak core.
    acc += c * c * w;
    wsum += w;
  }
  return sqrt(acc / wsum);
}
#endif
`;

    const surface = /* glsl */ `
NsSurface nsSurf;
vec2 nsSoftN = vec2(0.0);
float nsViewDist = length(cameraPosition - vNsWorldPos);
{
  float d = vRoad.x;
  float sL = vRoad.y;
  // Our carriageway and the mirrored opposite one share the same markings.
  float opp = step(d, ${f(MEDIAN_D)});
  float dc = mix(d, ${f(2 * MEDIAN_D)} - d, opp);
  vec2 tuv = vec2(d, sL) * 0.25;
  // Anti-tiling: blend a second, rotated, larger-scale sample.
  vec2 tuv2 = vec2(d * 0.8 + sL * 0.6, sL * 0.8 - d * 0.6) * 0.085 + 0.37;
  float farFade = smoothstep(25.0, 140.0, nsViewDist);
  vec3 alb = texture2D(uAsphalt, tuv).rgb;
  vec3 alb2 = texture2D(uAsphalt, tuv2).rgb;
  alb = mix(alb, alb2, 0.35 + 0.4 * farFade);
  float rgh = texture2D(uAsphaltR, tuv).g;
  vec3 nt = texture2D(uAsphaltN, tuv).xyz * 2.0 - 1.0;
  vec3 nt2 = texture2D(uAsphaltN, tuv2).xyz * 2.0 - 1.0;
  nt = normalize(vec3(nt.xy + nt2.xy * 0.6, nt.z));
  nt.xy *= 1.0 - 0.75 * farFade;

  // Large-scale tone variation, repaired patches and longitudinal joints.
  float macro = nsNoiseP(vec2(d * 0.11 + 31.0, sL * 0.05), 11.0);
  float patchN = nsNoiseP(vec2(d * 0.35 + 7.0, sL * 0.2), 44.0);
  alb *= 0.82 + 0.36 * macro;
  alb = mix(alb, alb * 0.72, smoothstep(0.62, 0.7, patchN) * 0.6);
  float lane = ${f(LANE_WIDTH)};
  float jointD = abs(mod(dc + lane * 0.5, lane) - lane * 0.5);
  float joint = (1.0 - smoothstep(0.015, 0.05, jointD)) * step(abs(dc), ${f(LANES_HALF + 0.5)});
  alb *= 1.0 - 0.35 * joint;

  // Wheel tracks: polished, slightly depressed, hold water.
  float laneX = mod(dc + ${f(LANES_HALF)}, lane) - lane * 0.5;
  float inLanes = step(abs(dc), ${f(LANES_HALF)});
  float rut = exp(-pow(abs((abs(laneX) - 0.86) / 0.36), 2.0)) * inLanes;
  // Oil / drip line down the lane centre.
  float oil = exp(-pow(abs(laneX / 0.33), 2.0)) * inLanes;
  alb *= 1.0 - 0.14 * oil;

  // Paint.
  float aa = clamp(fwidth(d) * 1.2, 0.002, 0.2);
  vec2 paint = nsPaint(dc, sL, aa);
  float wear = smoothstep(0.18, 0.55, nsNoiseP(vec2(d * 5.0, sL * 2.5), 550.0) * 0.6 + nsNoiseP(vec2(d * 21.0, sL * 9.0), 1980.0) * 0.5);
  paint *= mix(0.5, 1.0, wear);
  paint *= 1.0 - smoothstep(0.12, 0.2, aa) * 0.5;
  float paintAny = clamp(paint.x + paint.y, 0.0, 1.0);
  vec3 paintCol = (vec3(0.62, 0.62, 0.6) * paint.x + vec3(0.62, 0.43, 0.06) * paint.y) / max(paint.x + paint.y, 1e-3);
  alb = mix(alb, paintCol, paintAny);

  // Water.
  float tunnel = vRoad2.z;
  float wet = uNsWet * (1.0 - 0.9 * tunnel);
  float pn = nsNoiseP(vec2(d * 0.16 + 3.0, sL * 0.045), 9.9) * 0.62 + nsNoiseP(vec2(d * 0.45 + 11.0, sL * 0.15), 33.0) * 0.38;
  // Water gathers in the ruts and against the barriers / kerbs.
  float edgePool = smoothstep(${f(LANES_HALF + 0.4)}, ${f(LANES_HALF + 2.6)}, abs(dc - 0.6)) * 0.22;
  float puddle = smoothstep(0.585, 0.66, pn + rut * 0.2 + edgePool - paintAny * 0.05) * wet;
  // Thin film everywhere, thicker in ruts.
  float film = wet * (0.55 + 0.45 * rut);
  alb *= mix(1.0, 0.4, film);
  alb *= mix(1.0, 0.7, puddle);
  float roughWet = mix(0.36, 0.2, rut) * mix(0.8, 1.2, rgh);
  float rough = mix(mix(0.62, 0.95, rgh), roughWet, film);
  rough = mix(rough, rough * 1.25, paintAny * 0.5);
  rough = mix(rough, 0.035, puddle);

  // Normal: asphalt grain flattened by water, rain ripples in standing water.
  float grainK = mix(1.0, 0.5, film) * (1.0 - puddle);
  vec2 ripN = vec2(0.0);
  float rainHere = uRain * (1.0 - tunnel);
  float rippleFade = 1.0 - smoothstep(14.0, 45.0, nsViewDist);
  if (rainHere * rippleFade > 0.01) {
    vec2 rp = vec2(d, sL);
    vec2 rip = nsRipple(rp * 4.3, uNsTime) + nsRipple(rp * 6.1 + 13.7, uNsTime * 1.13 + 0.4) + nsRipple(rp * 3.1 + 41.3, uNsTime * 0.9 + 0.7);
    ripN = rip * rainHere * rippleFade * (0.035 + 0.16 * puddle);
  }
  vec2 nxy = nt.xy * grainK + ripN;
  vec2 rightW = vRoad2.xy;
  vec2 fwdW = vec2(rightW.y, -rightW.x);
  vec3 nW = normalize(vec3(rightW.x * nxy.x + fwdW.x * nxy.y, 1.0, rightW.y * nxy.x + fwdW.y * nxy.y));
  // Smoothed normal (three mips up) for the reflection wobble: per-pixel grain would shred the
  // mirror image into noise.
  vec2 nLow = (texture2D(uAsphaltN, tuv, 3.0).xy * 2.0 - 1.0) * grainK * (1.0 - 0.75 * farFade) + ripN * 0.35;
  nsSoftN = vec2(rightW.x * nLow.x + fwdW.x * nLow.y, rightW.y * nLow.x + fwdW.y * nLow.y);

  // Specular anti-aliasing (Tokuyoshi-Kaplanyan): sub-pixel normal variation widens the lobe
  // instead of sparkling.
  vec3 ndx = dFdx(nW);
  vec3 ndy = dFdy(nW);
  float nVar = min(0.5 * (dot(ndx, ndx) + dot(ndy, ndy)), 0.18);
  rough = sqrt(clamp(rough * rough + nVar, 0.0, 1.0));

  nsSurf.albedo = alb;
  nsSurf.normalW = nW;
  nsSurf.rough = clamp(rough, 0.03, 1.0);
  nsSurf.puddle = puddle;
  nsSurf.paint = paintAny;
  nsSurf.wet = film;
}
diffuseColor.rgb = nsSurf.albedo;
`;

    const lights = /* glsl */ `
#include <lights_fragment_begin>
float nsAO = nsCarAO(vNsWorldPos);
{
  float d = vRoad.x;
  float sL = vRoad.y;
  vec2 rightW = vRoad2.xy;
  vec2 fwdW = vec2(rightW.y, -rightW.x);
  vec3 lamb = BRDF_Lambert(material.diffuseColor);
  IncidentLight nsLight;
  nsLight.visible = true;

  // Street lamps. Highlights on a grazing wet surface come from lamps far AHEAD of the shaded
  // point (the light pillar), so the slot window is biased forwards.
  float kf = floor(sL / ${f(LAMP_SPACING)} + 0.5);
  for (int j = -1; j <= NS_LAMP_AHEAD; j++) {
    float kr = kf + float(j);
    // vRoad.z is a per-chunk constant, but an interpolated one: round it, or the parity test
    // below flips from pixel to pixel and stipples the highlight.
    float kAbs = mod(floor(vRoad.z + kr + 0.5), ${f(LAMP_SLOTS)});
    float on = texelFetch(uLampTex, ivec2(int(kAbs + 0.5), 0), 0).r;
    if (on < 0.5) continue;
    float ds = kr * ${f(LAMP_SPACING)} - sL;
    bool even = mod(kAbs, 2.0) < 0.5;
    // The slot window slides with the shaded point: fade lamps in and out at its ends so no
    // highlight pops along a line across the road.
    float winBack = smoothstep(${f(-1.5 * LAMP_SPACING)}, ${f(-0.5 * LAMP_SPACING)}, ds);
    for (int side = 0; side < 2; side++) {
      if (side == 1 && j > 2) break;
      float aheadEnd = side == 0 ? float(NS_LAMP_AHEAD) : 2.0;
      float win = winBack * (1.0 - smoothstep((aheadEnd - 0.5) * ${f(LAMP_SPACING)}, (aheadEnd + 0.5) * ${f(LAMP_SPACING)}, ds));
      float ld = even ? (side == 0 ? ${f(LAMP_MEDIAN_D)} : ${f(LAMP_MEDIAN_OPP_D)}) : (side == 0 ? ${f(LAMP_RIGHT_D)} : ${f(LAMP_OPP_OUTER_D)});
      vec3 Lv = vec3(rightW.x * (ld - d) + fwdW.x * ds, ${f(LAMP_HEIGHT)}, rightW.y * (ld - d) + fwdW.y * ds);
      float r2 = dot(Lv, Lv);
      float atten = 1.0 / (r2 + ${f(LAMP_SOFT)});
      float sh = side == 0 ? nsCarShadow(vNsWorldPos, Lv) : 1.0;
      vec3 Ldir = Lv * inversesqrt(r2);
      nsLight.color = ${lampRGB} * (atten * sh * win);
      nsLight.direction = normalize(mat3(viewMatrix) * Ldir);
      // Lambert diffuse + analytic GGX highlight (at grazing angles it stretches into the
      // wet-road light pillar). Roughness is clamped so mirror-flat puddles do not sparkle with
      // fireflies; there the planar reflection shows the luminaire itself.
      float nsNL = max(dot(nsSurf.normalW, Ldir), 0.0);
      reflectedLight.directDiffuse += nsLight.color * nsNL * lamb;
      float nsR = material.roughness;
      material.roughness = max(nsR, 0.2);
      vec3 nsLd = nsLight.direction;
      reflectedLight.directSpecular += nsLight.color * (1.0 - 0.8 * nsSurf.puddle) * saturate(dot(geometryNormal, nsLd))
        * BRDF_GGX(nsLd, geometryViewDir, geometryNormal, material);
      material.roughness = nsR;
    }
  }

  // Tunnel luminaire strips (line lights).
  float tunnel = vRoad2.z;
  if (tunnel > 0.001) {
    float oppT = step(d, ${f(MEDIAN_D)});
    for (int i = 0; i < 2; i++) {
      float ld0 = i == 0 ? ${f(TUNNEL_LIGHT_D[0])} : ${f(TUNNEL_LIGHT_D[1])};
      float ld = mix(ld0, ${f(2 * MEDIAN_D)} - ld0, oppT);
      vec2 lp = vec2(ld - d, ${f(TUNNEL_LIGHT_Y)});
      float rp = length(lp);
      vec3 Ldir = normalize(vec3(rightW.x * lp.x, lp.y, rightW.y * lp.x));
      float e = tunnel * max(dot(nsSurf.normalW, Ldir), 0.0) / (rp + 0.6);
      reflectedLight.directDiffuse += ${tunRGB} * e * lamb * mix(1.0, nsAO, 0.85);
    }
  }

  // Vehicle light pools.
  reflectedLight.directDiffuse += nsPools(vNsWorldPos) * lamb;

  // Explosion flashes.
  for (int i = 0; i < 2; i++) {
    vec3 lc = uFlashColor[i];
    if (lc.r + lc.g + lc.b > 0.0) {
      vec3 lv = (viewMatrix * vec4(uFlashPos[i], 1.0)).xyz - geometryPosition;
      float r2 = dot(lv, lv);
      nsLight.direction = lv * inversesqrt(max(r2, 1e-4));
      nsLight.color = lc / (r2 + 9.0);
      // A fireball is a large area light, not a point: on the mirror-wet road a point light gives
      // a small blinding highlight next to the car (worst on LOW, where nothing else softens it).
      float nsRF = material.roughness;
      material.roughness = max(nsRF, 0.5);
      RE_Direct(nsLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
      material.roughness = nsRF;
    }
  }

  // Light thrown straight back at the driver from the player's headlights: retro-reflective
  // paint, and a little backscatter from the wet aggregate (a mirror-wet road would otherwise
  // send the whole beam away from the camera and stay black on an unlit stretch).
  {
    vec3 hv = vNsWorldPos - uHeadPos;
    float hr2 = dot(hv, hv);
    float hr = sqrt(hr2);
    float hc = dot(hv / max(hr, 1e-3), uHeadDir);
    float cone = smoothstep(uHeadCone.y - 0.2, uHeadCone.x, hc);
    float range = 1.0 - smoothstep(uHeadCone.z * 0.9, uHeadCone.z * 1.8, hr);
    float back = cone * range * smoothstep(3.0, 16.0, hr) / (hr2 * 0.3 + 60.0);
    vec3 grit = vec3(0.0065) * (1.0 - nsSurf.paint) * (1.0 - 0.7 * nsSurf.puddle) * mix(0.75, 1.25, nsSurf.rough);
    reflectedLight.directDiffuse += uHeadColor * back * (material.diffuseColor * nsSurf.paint * 0.26 + grit);
  }
}
`;

    const end = /* glsl */ `
#include <lights_fragment_end>
{
  // Contact occlusion under vehicles dims ambient light.
  reflectedLight.indirectDiffuse *= nsAO;
#ifdef NS_PLANAR
  vec3 Vw = normalize(cameraPosition - vNsWorldPos);
  float NdV = clamp(Vw.y, 0.0, 1.0);
  float F0 = 0.025;
  float fres = F0 + (1.0 - F0) * pow(1.0 - NdV, 5.0);
  // Rough wet asphalt scatters the mirror image: less energy reaches the eye than from a puddle.
  float mirror = mix(1.0, 0.7, smoothstep(0.05, 0.5, nsSurf.rough));
  vec2 sUv = gl_FragCoord.xy / uNsResolution;
  // Map the world-space normal tilt to screen space (x ≈ camera right, y ≈ away from camera).
  vec3 camR = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));
  vec2 nTilt = vec2(dot(nsSoftN, camR.xz), dot(nsSoftN, vec2(-camR.z, camR.x)));
  vec2 distort = vec2(nTilt.x, -nTilt.y * 0.6) * (0.3 / (1.0 + nsViewDist * 0.05));
  vec3 refl = nsPlanar(sUv, distort, nsSurf.rough, nsViewDist);
  vec3 planarSpec = refl * (fres * mirror * uReflGain) * mix(1.0, nsAO, 0.6);
  reflectedLight.indirectSpecular = mix(reflectedLight.indirectSpecular, planarSpec, uReflOn);
#else
  reflectedLight.indirectSpecular *= nsAO;
#endif
}
`;

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${header}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${surface}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = nsSurf.rough;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\nnormal = normalize(mat3(viewMatrix) * nsSurf.normalW);`)
      .replace('#include <lights_fragment_begin>', lights)
      .replace('#include <lights_fragment_end>', end);
  }
}
