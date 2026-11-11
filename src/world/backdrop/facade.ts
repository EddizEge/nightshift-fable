/**
 * Instanced structure materials: MeshStandardMaterial + patchStatic (baked lamp light, wetness,
 * headlight, fog) extended with
 *   - box-projected textures in metres (instances are scaled unit boxes / cylinders),
 *   - procedural lit window grids (city blocks, commercial sheds) and loading bays (warehouses),
 *   - per-instance colour variation (containers, tanks).
 * Per-instance randomness comes from a hash of the instance position (no extra attributes, so the
 * geometry stays shared between chunks).
 */
import { Color, MeshStandardMaterial } from 'three';
import type { Material, Texture } from 'three';
import type { IChunkBuilder } from '../../core/types';
import { COLOR_VERTEX_FIX, GLSL_HASH, shared } from './shared';

export type FacadeMode = 'city' | 'warehouse' | 'container' | 'tank' | 'plain' | 'car';

export interface FacadeOpts {
  key: string;
  mode: FacadeMode;
  albedo?: string;
  normal?: string;
  rough?: string;
  /** Texture tile size in metres. */
  tile?: number;
  color?: number;
  roughness?: number;
  metalness?: number;
  wetness?: number;
  /** Cylinders: wrap the texture around (u = angle·radius). */
  cylinder?: boolean;
}

const MODE_DEFINE: Record<FacadeMode, string> = {
  city: 'BD_CITY',
  warehouse: 'BD_WAREHOUSE',
  container: 'BD_CONTAINER',
  tank: 'BD_TANK',
  plain: 'BD_PLAIN',
  car: 'BD_CAR',
};

export function facadeMaterial(b: IChunkBuilder, o: FacadeOpts): Material {
  return b.materials.cached(o.key, () => {
    const tex = (f: string | undefined, srgb: boolean): Texture | null => (f ? b.materials.texture(f, { srgb }) : null);
    const albedo = tex(o.albedo, true);
    const normal = tex(o.normal, false);
    const rough = tex(o.rough, false);
    const m = new MeshStandardMaterial({
      name: o.key,
      color: new Color(o.color ?? 0xffffff),
      roughness: o.roughness ?? 0.85,
      metalness: o.metalness ?? 0,
    });
    const tile = (o.tile ?? 4).toFixed(3);
    const define = MODE_DEFINE[o.mode];
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uBdAlbedo = { value: albedo };
      shader.uniforms.uBdNormal = { value: normal };
      shader.uniforms.uBdRough = { value: rough };
      shader.uniforms.uTime = shared.uTime;
      shader.uniforms.uBdFlash = shared.uFlashGlobal;
      const defs = `#define ${define}\n${albedo ? '#define BD_ALBEDO\n' : ''}${normal ? '#define BD_NORMAL\n' : ''}${rough ? '#define BD_ROUGH\n' : ''}${o.cylinder ? '#define BD_CYL\n' : ''}#define BD_TILE ${tile}\n`;
      shader.vertexShader = shader.vertexShader
        .replace('#include <color_vertex>', COLOR_VERTEX_FIX)
        .replace(
          '#include <common>',
          `#include <common>
${defs}
${GLSL_HASH}
varying vec3 vBdLocal;
flat varying vec3 vBdScale;
varying vec3 vBdN;
flat varying float vBdSeed;
#ifdef BD_CITY
varying vec3 vBdCam;
#endif
#ifdef BD_CAR
attribute float bdPart;
varying float vBdPart;
#endif`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
#ifdef BD_CAR
  vBdPart = bdPart;
#endif
#ifdef USE_INSTANCING
  vBdScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  vBdSeed = bdHash(mod(floor(instanceMatrix[3].xz * 0.5), 4096.0) + 0.37);
#else
  vBdScale = vec3(1.0);
  vBdSeed = 0.5;
#endif
  vBdLocal = position * vBdScale;
  vBdN = normal;
#ifdef BD_CITY
  // Camera in the instance's scaled local frame (interior mapping of close windows).
  #ifdef USE_INSTANCING
    vBdCam = (inverse(modelMatrix * instanceMatrix) * vec4(cameraPosition, 1.0)).xyz * vBdScale;
  #else
    vBdCam = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  #endif
#endif`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
${defs}
${GLSL_HASH}
uniform sampler2D uBdAlbedo;
uniform sampler2D uBdNormal;
uniform sampler2D uBdRough;
uniform float uTime;
uniform float uBdFlash;
#ifdef BD_CAR
varying float vBdPart;
#endif
varying vec3 vBdLocal;
flat varying vec3 vBdScale;
varying vec3 vBdN;
flat varying float vBdSeed;
#ifdef BD_CITY
varying vec3 vBdCam;
// Close-range room behind a lit window (interior mapping): ray from the glass into a box room
// (cell width × floor height × depth), shaded ceiling with light rows / a lamp, darker floor,
// walls with a falloff, furniture / plant silhouettes on a plane in front of the back wall,
// curtains or blinds on the glass. Returns radiance relative to the window's tenant intensity.
vec3 bdRoom(vec3 rd, vec3 nrm, float u, float v, float u0, float bw, float v0, float fh, vec2 g, float h, float office, float blind) {
  float du, dw;
  if (abs(nrm.x) > 0.5) { du = rd.z; dw = -rd.x * sign(nrm.x); } else { du = rd.x; dw = -rd.z * sign(nrm.z); }
  float dv = rd.y;
  dw = max(dw, 1e-4);
  float D = 3.5 + 3.0 * fract(h * 3.1);
  float tB = D / dw;
  float tU = du > 1e-5 ? (u0 + bw - u) / du : (du < -1e-5 ? (u0 - u) / du : 1e9);
  float tV = dv > 1e-5 ? (v0 + fh - v) / dv : (dv < -1e-5 ? (v0 - v) / dv : 1e9);
  float t = min(tB, min(tU, tV));
  vec3 hp = vec3((u + du * t - u0) / bw, (v + dv * t - v0) / fh, dw * t / D);
  // Wall / ceiling / floor shading (room lit from the ceiling).
  vec3 col;
  float ceilL;
  if (t == tV && dv > 0.0) {
    // Ceiling: office light rows across the depth, or one lamp in the middle of a home.
    float rows = office > 0.5
      ? smoothstep(0.03, 0.0, abs(fract(hp.z * 2.0 + 0.25) - 0.5) - 0.07) * smoothstep(0.08, 0.14, hp.x) * smoothstep(0.92, 0.86, hp.x)
      : exp(-(pow(abs((hp.x - 0.5) * 3.0), 2.0) + pow(abs((hp.z - 0.45) * 4.0), 2.0)));
    col = vec3(0.32 + 3.2 * rows);
  } else if (t == tV) {
    col = vec3(0.09 + 0.05 * hp.z);
  } else if (t == tB) {
    col = vec3(0.32 + 0.5 * hp.y * hp.y);
  } else {
    col = vec3((0.24 + 0.42 * hp.y * hp.y) * (1.0 - 0.35 * hp.z));
  }
  // A darker band near the floor (skirting / shadow), and some colour on the walls.
  col *= mix(vec3(1.0), vec3(1.0, 0.92, 0.82) * (0.8 + 0.4 * fract(h * 13.7)), step(t, tU) * step(tB, t));
  // Furniture plane 0.8 m in front of the back wall: a cabinet / sofa / desk block, sometimes a plant.
  float zf = max(D - 0.8, 0.5);
  float tf = zf / dw;
  if (tf < t) {
    vec2 q = vec2((u + du * tf - u0) / bw, (v + dv * tf - v0) / fh);
    float a0 = 0.08 + 0.4 * fract(h * 5.3);
    float fh0 = office > 0.5 ? 0.27 : 0.2 + 0.18 * fract(h * 9.1);
    float blk = step(a0, q.x) * step(q.x, a0 + 0.3 + 0.25 * fract(h * 2.9)) * step(0.0, q.y) * step(q.y, fh0);
    vec2 pc = vec2(fract(h * 17.0) < 0.5 ? 0.82 : 0.14, 0.42);
    float plant = step(0.55, fract(h * 23.0)) * (step(length((q - pc) * vec2(1.6, 1.0)), 0.13) + step(abs(q.x - pc.x), 0.02) * step(q.y, pc.y) );
    col = mix(col, vec3(0.05), clamp(blk + plant, 0.0, 1.0));
  }
  // On the glass: curtains (homes) or venetian blind slats (offices) where the blind is down.
  float fx = g.x;
  float fy = g.y;
  if (office < 0.5 && fract(h * 41.0) < 0.55) {
    float cw = 0.12 + 0.2 * fract(h * 29.0);
    float cur = smoothstep(cw, cw - 0.03, fx) + smoothstep(1.0 - cw, 1.0 - cw + 0.03, fx);
    vec3 cc = fract(h * 31.0) < 0.5 ? vec3(1.0, 0.8, 0.6) : vec3(0.85, 0.85, 0.8);
    col = mix(col, cc * (0.3 + 0.06 * sin(fx * 40.0)) * (0.7 + 0.3 * fy), clamp(cur, 0.0, 1.0));
  }
  if (blind > 0.0) {
    float slat = 0.5 + 0.5 * sin(fy * 140.0);
    col = mix(col, vec3(0.28 + 0.2 * slat), blind);
  }
  return col;
}
#endif
// Integral of the periodic pulse [lo, hi] in fract(x); bdPulse = its exact box-filtered average over width w.
float bdPulseI(float x, float lo, float hi) { return floor(x) * (hi - lo) + clamp(fract(x), lo, hi) - lo; }
float bdPulse(float x, float w, float lo, float hi) { return clamp((bdPulseI(x + 0.5 * w, lo, hi) - bdPulseI(x - 0.5 * w, lo, hi)) / w, 0.0, 1.0); }
// Box-filtered coverage of the interval [a, b].
float bdBand(float x, float w, float a, float b) { return clamp((min(x + 0.5 * w, b) - max(x - 0.5 * w, a)) / w, 0.0, 1.0); }
float fwV0(float v) { return max(fwidth(v), 1e-4); }
vec3 bdPalette(float h) {
  // Muted architectural / industrial paint colours (linear).
  if (h < 0.2) return vec3(0.55, 0.53, 0.5);
  if (h < 0.35) return vec3(0.5, 0.42, 0.34);
  if (h < 0.5) return vec3(0.36, 0.38, 0.4);
  if (h < 0.62) return vec3(0.62, 0.58, 0.52);
  if (h < 0.75) return vec3(0.3, 0.3, 0.31);
  if (h < 0.87) return vec3(0.46, 0.4, 0.38);
  return vec3(0.42, 0.46, 0.5);
}
vec3 bdContainer(float h) {
  if (h < 0.18) return vec3(0.34, 0.05, 0.03);
  if (h < 0.33) return vec3(0.04, 0.12, 0.3);
  if (h < 0.45) return vec3(0.05, 0.2, 0.09);
  if (h < 0.56) return vec3(0.5, 0.2, 0.03);
  if (h < 0.66) return vec3(0.42, 0.42, 0.4);
  if (h < 0.76) return vec3(0.18, 0.04, 0.05);
  if (h < 0.86) return vec3(0.06, 0.24, 0.3);
  return vec3(0.16, 0.16, 0.17);
}`,
        )
        .replace(
          '#include <map_fragment>',
          `
vec3 bdN = normalize(vBdN);
float bdFaceU, bdFaceW, bdFace;
#ifdef BD_CYL
  bdFaceU = (atan(vBdLocal.x / vBdScale.x, vBdLocal.z / vBdScale.z) + 3.14159) * vBdScale.x;
  bdFaceW = 6.2832 * vBdScale.x;
  bdFace = 0.0;
#else
  if (abs(bdN.x) > 0.5) { bdFaceU = vBdLocal.z + vBdScale.z * 0.5; bdFaceW = vBdScale.z; bdFace = bdN.x > 0.0 ? 0.0 : 1.0; }
  else { bdFaceU = vBdLocal.x + vBdScale.x * 0.5; bdFaceW = vBdScale.x; bdFace = bdN.z > 0.0 ? 2.0 : 3.0; }
#endif
float bdV = vBdLocal.y;
float bdTop = step(0.5, abs(bdN.y));
vec2 bdUV = bdTop > 0.5 ? vBdLocal.xz : vec2(bdFaceU, bdV);
vec3 bdEmit = vec3(0.0);
float bdGlass = 0.0;
float bdSd = vBdSeed;
#ifdef BD_ALBEDO
  diffuseColor.rgb *= texture2D(uBdAlbedo, bdUV / BD_TILE).rgb;
#endif
#if defined(BD_CITY)
  diffuseColor.rgb *= bdPalette(fract(bdSd * 3.71));
  float H = vBdScale.y;
  // Building code packed in the cm of the height (city.ts packHeight): kind * 4 + style.
  float bdCode = floor(fract(H * 10.0) * 16.0);
  float kind = floor(bdCode / 4.0);
  float style = mod(bdCode, 4.0);
  if ((H < 11.0 && kind != 1.0) || kind == 2.0) style = 4.0;
  float fwV = max(fwidth(bdV), 1e-4);
  if (bdTop < 0.5) {
    float fh = style == 3.0 ? 3.0 : ((style == 1.0 || style == 2.0) ? 3.9 : 3.1 + fract(bdSd * 3.7) * 0.45);
    float bw0 = style == 2.0 ? 1.5 : (style == 1.0 ? 1.8 : (style == 3.0 ? 3.0 + fract(bdSd * 5.3) * 0.7 : 2.7 + fract(bdSd * 5.3) * 1.2));
    if (style == 4.0) { fh = H; bw0 = 6.5 + fract(bdSd * 5.3) * 2.0; }
    float fwid = max(bdFaceW - 1.0, 0.5);
    float nb = max(1.0, floor(fwid / bw0));
    float bw = fwid / nb;
    float u = bdFaceU - 0.5;
    float fwU = max(fwidth(u), 1e-4);
    float topMargin = style == 4.0 ? 0.0 : 1.2;
    float nf = max(1.0, floor((H - topMargin) / fh));
    float inF = bdBand(u, fwU, 0.0, fwid) * bdBand(bdV, fwV, 0.0, nf * fh);
    vec2 cell = vec2(u / bw, bdV / fh);
    vec2 id = floor(cell);
    vec2 f = cell - id;
    vec2 fw = max(fwidth(cell), vec2(1e-4));
    bool shop = id.y < 0.5 && kind == 0.0 && style != 2.0 && style != 4.0;
    vec2 lo = vec2(0.18, 0.3), hi = vec2(0.82, 0.86);
    if (style == 1.0) { lo = vec2(0.025, 0.36); hi = vec2(0.975, 0.92); }
    else if (style == 2.0) { lo = vec2(0.03, 0.24); hi = vec2(0.97, 0.98); }
    else if (style == 3.0) { lo = vec2(0.22, 0.26); hi = vec2(0.78, 0.84); }
    else if (style == 4.0) { lo = vec2(0.06, 0.45 / H); hi = vec2(0.94, min(0.62, 3.6 / H)); }
    if (shop) { lo = vec2(0.05, 0.12); hi = vec2(0.95, 0.86); }
    // Analytically box-filtered aperture (exact pixel-footprint average: fades to coverage, no aliasing).
    float apX = bdPulse(cell.x, fw.x, lo.x, hi.x);
    if ((style == 0.0 && bw > 3.1) || style == 3.0 || shop) apX = max(apX - bdPulse(cell.x, fw.x, 0.49, 0.51), 0.0);
    if (style == 2.0) apX = max(apX - bdPulse(cell.x * 2.0, fw.x * 2.0, 0.49, 0.51), 0.0);
    if (style == 4.0) apX = max(apX - bdPulse(cell.x * 3.0, fw.x * 3.0, 0.485, 0.515), 0.0);
    float apY = bdPulse(cell.y, fw.y, lo.y, hi.y);
    if (style == 2.0) apY = max(apY - bdPulse(cell.y, fw.y, 0.79, 0.81), 0.0);
    if (style == 4.0 || shop) { float ty = lo.y + (hi.y - lo.y) * 0.8; apY = max(apY - bdPulse(cell.y, fw.y, ty - 0.012, ty + 0.012), 0.0); }
    float ap = apX * apY * inF;
    // Recessed reveal around punched windows, floor slab edges.
    if (style == 0.0 || style == 3.0) {
      float rev = bdPulse(cell.x, fw.x, lo.x - 0.05, hi.x + 0.05) * bdPulse(cell.y, fw.y, lo.y - 0.06, hi.y + 0.03) * inF - ap;
      diffuseColor.rgb *= 1.0 - 0.55 * rev;
      diffuseColor.rgb *= 1.0 + 0.35 * bdPulse(cell.y, fw.y, 0.0, 0.07) * inF;
    }
    if (style == 2.0 || style == 1.0) diffuseColor.rgb *= mix(1.0, style == 2.0 ? 0.3 : 0.75, inF);
    // ── occupancy: building -> floor -> tenant -> window (clustered, 30-45 % lit) ──
    float bL = 0.3 + 0.15 * fract(bdSd * 11.7);
    float fl = id.y;
    float fseed = bdHash(vec2(fl * 1.37 + bdFace * 0.71, bdSd * 57.0));
    bool office = style == 1.0 || style == 2.0;
    float pf = office ? (fseed < 0.2 ? 0.95 : bL * 0.6) : clamp(bL + (fseed - 0.5) * 0.7, 0.04, 0.92);
    float bMean = office ? 0.2 * 0.95 + 0.8 * bL * 0.6 : bL;
    float tw = style == 3.0 ? 1.0 + floor(bdHash(vec2(fl * 0.91, bdSd * 13.0 + bdFace)) * 2.0) : 2.0 + floor(bdHash(vec2(fl * 0.91, bdSd * 13.0 + bdFace)) * 4.0);
    float tI0 = 1.4, tI1 = 1.9;
    if (shop) { pf = 0.6; tw = 2.0; tI0 = 1.3; tI1 = 1.3; }
    if (style == 4.0) { pf = 0.5; tw = 1.0; tI0 = 0.9; tI1 = 1.2; bMean = 0.5; }
    float tOff = floor(bdHash(vec2(fl + 0.5, bdSd * 7.0 + bdFace)) * tw);
    float tid = floor((id.x + tOff) / tw);
    float hT = bdHash(vec2(tid * 1.13 + bdFace * 31.0, fl + bdSd * 173.0));
    float tLit = step(hT, pf);
    float hc = bdHash(vec2(tid * 3.1 + bdFace, fl * 7.3 + bdSd * 11.0));
    // 2700 K / 3200 K / 4000 K interiors, a few cool-white ones.
    vec3 tc = hc < 0.3 ? vec3(1.0, 0.58, 0.29) : (hc < 0.6 ? vec3(1.0, 0.7, 0.44) : (hc < 0.86 ? vec3(1.0, 0.82, 0.63) : vec3(0.78, 0.87, 1.0)));
    if (style == 2.0) tc = mix(tc, vec3(0.86, 0.92, 1.0), 0.5);
    float tI = tI0 + tI1 * bdHash(vec2(tid + 5.0, fl + bdSd * 3.0));
    // Dark rooms with a TV: dim flickering blue (homes mostly).
    float tv = (1.0 - tLit) * step(style == 3.0 ? 0.86 : 0.965, fract(hT * 17.3)) * step(style, 3.0);
    float tvF = 0.55 + 0.25 * sin(uTime * 7.3 + tid * 4.1) * sin(uTime * 2.9 + fl) + 0.2 * sin(uTime * 17.0 + tid);
    vec3 tvC = vec3(0.32, 0.45, 1.0) * 0.7 * tvF * tv;
    float hw = bdHash(vec2(id.x * 1.7 + bdFace * 13.0, fl * 3.3 + bdSd * 29.0));
    float wOn = step(0.12, hw);
    float blind = step(0.62, fract(hw * 7.31)) * (0.25 + 0.5 * fract(hw * 3.7));
    float fy = clamp((f.y - lo.y) / (hi.y - lo.y), 0.0, 1.0);
    float fwy = fw.y / (hi.y - lo.y);
    float bm = smoothstep(1.0 - blind - fwy, 1.0 - blind + fwy, fy) * step(0.01, blind);
    float interior = (style == 4.0 || shop) ? 0.45 + 0.75 * fy * fy : 0.75 + 0.35 * fy;
    vec3 winV = tLit * wOn * tI * tc * interior * mix(1.0, 0.42, bm) + tvC;
    // Close & large on screen (≥ ~20 px per window): the room behind the glass fades in, with a lower
    // peak so colour survives the tone mapping. Mean stays close to winV (no pop when it fades).
    // Vertical size decides (faces seen at a grazing angle keep their rooms); narrow windows down to ~8 px.
    float kDet = (1.0 - smoothstep(0.04, 0.085, fw.y)) * (1.0 - smoothstep(0.08, 0.13, fw.x)) * tLit * wOn;
    if (kDet > 0.0) {
      float fx = clamp((f.x - lo.x) / (hi.x - lo.x), 0.0, 1.0);
      vec3 room = bdRoom(vBdLocal - vBdCam, bdN, u, bdV, id.x * bw, bw, id.y * fh, fh, vec2(fx, fy), hw, (office || shop || style == 4.0) ? 1.0 : 0.0, bm);
      winV = mix(winV, tI * tc * 0.8 * room + tvC, kDet);
    }
    vec3 meanC = vec3(0.96, 0.72, 0.5);
    vec3 tenV = tLit * tI * tc * 0.72 + vec3(0.32, 0.45, 1.0) * 0.38 * tv;
    vec3 flV = pf * (tI0 + 0.5 * tI1) * meanC * 0.72;
    vec3 bV = bMean * (tI0 + 0.5 * tI1) * meanC * 0.72;
    // LOD: per-window detail, then tenants, then floors fade to their averages below ~3 px.
    float kWin = 1.0 - smoothstep(0.22, 0.5, max(fw.x, fw.y));
    float kTen = 1.0 - smoothstep(0.22, 0.5, fw.x / tw);
    float kFl = 1.0 - smoothstep(0.22, 0.5, fw.y);
    vec3 val = mix(bV, mix(flV, mix(tenV, winV, kWin), kTen), kFl);
    bdEmit = val * ap + vec3(0.016, 0.015, 0.014) * ap;
    bdGlass = ap;
    // Crown light strip on some tall blocks and on setback tops.
    float hasCrown = H > 28.0 ? step(fract(bdSd * 19.3), kind == 1.0 ? 0.5 : 0.24) : 0.0;
    vec3 crownC = mix(vec3(0.75, 0.88, 1.0), vec3(1.0, 0.75, 0.45), step(0.5, fract(bdSd * 41.0)));
    bdEmit += crownC * hasCrown * bdBand(bdV, fwV, H - 1.0, H - 0.6) * 2.6;
    // Vertical corner LED strips on some office towers (0.3 m, filtered).
    if (office && H > 24.0 && fract(bdSd * 29.7) < 0.3) {
      float cs = bdBand(u, fwU, -0.42, -0.12) + bdBand(u, fwU, fwid + 0.12, fwid + 0.42);
      bdEmit += crownC * cs * bdBand(bdV, fwV, 4.0, H - 0.3) * 1.8;
    }
    // Parapet coping.
    diffuseColor.rgb *= 1.0 + 0.7 * bdBand(bdV, fwV, H - 0.22, H);
    if (style == 4.0) {
      // Lit fascia band segment above the shopfronts.
      float fu = u / fwid;
      float c0 = 0.12 + 0.4 * fract(bdSd * 17.0 + bdFace * 0.37);
      float seg = bdBand(fu, fwU / fwid, c0, c0 + 0.22 + 0.25 * fract(bdSd * 5.0));
      float band = bdBand(bdV, fwV, H - 1.6, H - 0.7) * seg * step(0.3, fract(bdSd * 23.0 + bdFace * 0.31));
      float fh2 = bdHash(vec2(bdSd, bdFace));
      vec3 fc = fh2 < 0.3 ? vec3(0.9, 0.25, 0.2) : (fh2 < 0.6 ? vec3(0.25, 0.55, 1.0) : vec3(1.0, 0.85, 0.6));
      bdEmit += fc * band * 1.1;
    }
  }
#elif defined(BD_WAREHOUSE)
  diffuseColor.rgb *= mix(vec3(0.62, 0.64, 0.66), bdPalette(fract(bdSd * 5.1)), 0.5);
  float H = vBdScale.y;
  if (bdTop < 0.5) {
    bool longSide = abs(bdN.x) > 0.5;
    float u = bdFaceU;
    if (longSide) {
      // Loading bays.
      float pitch = 7.5;
      float bid = floor((u - 3.0) / pitch);
      float bu = (u - 3.0) - bid * pitch;
      float nBays = floor((bdFaceW - 6.0) / pitch);
      float inBay = step(0.0, bid) * step(bid, nBays - 1.0) * step(0.0, bu) * step(bu, 3.8) * step(bdV, 4.3) * step(0.15, bdV);
      float hb = bdHash(vec2(bid + bdFace * 17.0, bdSd * 91.0));
      float open = step(hb, 0.38);
      vec2 bf = vec2(bu / 3.8, bdV / 4.3);
      // Open bay: lit hall seen through the door: bright under the ceiling lamps, darker floor,
      // racking uprights and a pallet stack / forklift block cutting the light.
      float fwB = max(fwidth(bu), 1e-3);
      vec3 hallC = hb < 0.6 ? vec3(1.0, 0.72, 0.42) : vec3(0.8, 0.88, 1.0);
      float hall = (0.12 + 1.15 * bf.y * bf.y) * (0.7 + 0.3 * hb);
      float fwVb = fwV0(bdV);
      // Pallet racking: uprights every 1.25 m and shelf beams every 1.1 m (the shelves hold dark goods).
      float rk = bdPulse(bu / 1.25 + hb * 3.0, fwB / 1.25, 0.0, 0.1);
      float shelf = bdPulse(bdV / 1.1 + 0.3, fwVb / 1.1, 0.0, 0.09);
      float goods = bdPulse(bdV / 1.1 + 0.3, fwVb / 1.1, 0.12, 0.75) * step(0.35, fract(floor(bu / 1.25 + hb * 3.0) * 0.37 + floor(bdV / 1.1) * 0.61 + hb));
      float rack = step(0.3, fract(hb * 5.0)) * clamp(rk * 0.85 + shelf * 0.7 + goods * 0.65, 0.0, 0.92);
      float pal = bdBand(bu, fwB, 0.4 + hb * 1.6, 1.5 + hb * 1.6) * bdBand(bdV, fwVb, 0.15, 1.1 + 0.9 * fract(hb * 7.0));
      float header = smoothstep(0.82, 0.96, bf.y) * 0.6;
      bdEmit += hallC * hall * (1.0 - rack) * (1.0 - 0.85 * pal) * (1.0 - header) * inBay * open;
      // Closed roller doors: lighter ribbed panels.
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.33, 0.34) * (0.85 + 0.15 * step(0.5, fract(bdV * 3.0))), inBay * (1.0 - open));
      bdGlass = inBay * (1.0 - open) * 0.3;
      // Bay lamp above each door.
      vec2 lp = vec2(bu - 1.9, bdV - 5.1);
      float lamp = step(abs(lp.x), 0.32) * step(abs(lp.y), 0.14) * step(0.0, bid) * step(bid, nBays - 1.0);
      bdEmit += vec3(1.0, 0.92, 0.8) * lamp * 9.0 * step(0.25, hb);
      // Wall-wash below the bay lamps.
      float wash = exp(-pow(abs((bu - 1.9) / 2.4), 2.0)) * smoothstep(5.3, 4.4, bdV) * step(0.0, bid) * step(bid, nBays - 1.0) * step(0.25, hb);
      diffuseColor.rgb += vec3(0.0);
      bdEmit += vec3(1.0, 0.9, 0.75) * wash * 0.045 * (1.0 - inBay);
    }
    // Clerestory band of translucent polycarbonate panels: mullions every 1.2 m and a transom,
    // light from the high-bay lamps inside (hot spots, warm or cool per bay), dirt streaks, racking /
    // crane beams occluding parts of it; dark bays show only a faint spill from their neighbours.
    float fwU = max(fwidth(u), 1e-3);
    float fwV = fwV0(bdV);
    float y0 = H - 2.6;
    float cl = bdBand(bdV, fwV, y0, H - 1.5) * bdBand(u, fwU, 1.5, bdFaceW - 1.5);
    if (cl > 0.0) {
      float seg = floor(u / 6.0);
      float cs = bdHash(vec2(seg + bdFace * 9.0, bdSd * 33.0));
      float lit = step(cs, 0.42);
      float yy = clamp((bdV - y0) / 1.1, 0.0, 1.0);
      vec3 tint = fract(cs * 7.3) < 0.55 ? vec3(1.0, 0.8, 0.55) : vec3(0.74, 0.84, 1.0);
      float lu = (fract(u / 6.0) - 0.5) * 6.0;
      float hot = exp(-lu * lu / 2.2) * (0.55 + 0.45 * yy);
      float pid = floor(u / 1.2);
      float ph = bdHash(vec2(pid + bdFace * 3.0, bdSd * 71.0));
      float kP = 1.0 - smoothstep(0.25, 0.6, fwU / 1.2);
      // Per-panel translucency / dirt (fades to its mean when panels get small on screen).
      float dirt = mix(0.72, (0.5 + 0.45 * ph) * (0.65 + 0.35 * yy) * (0.85 + 0.15 * sin(u * 9.0 + ph * 6.0)), kP);
      float frame = max(bdPulse(u / 1.2, fwU / 1.2, 0.0, 0.08), bdBand(bdV, fwV, y0 + 0.5, y0 + 0.58)) * kP + 0.08 * (1.0 - kP);
      float occ = 1.0 - 0.85 * step(0.6, ph) * bdBand(bdV, fwV, y0, y0 + 0.2 + 0.5 * fract(ph * 5.0));
      float k = lit * (0.25 + 1.9 * hot) + (1.0 - lit) * 0.05;
      bdEmit += tint * k * dirt * occ * (1.0 - frame) * cl * 1.15;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2), cl * frame);
      bdGlass = max(bdGlass, cl * (1.0 - frame) * 0.6);
    }
  }
#elif defined(BD_CONTAINER)
  diffuseColor.rgb *= bdContainer(fract(bdSd * 7.77));
#elif defined(BD_CAR)
  // Parked cars: dark wet paint, glasshouse band, tyres.
  float hp = fract(bdSd * 7.77);
  vec3 paint = hp < 0.24 ? vec3(0.016) : (hp < 0.42 ? vec3(0.05, 0.052, 0.056) : (hp < 0.57 ? vec3(0.24, 0.25, 0.26) : (hp < 0.66 ? vec3(0.5, 0.5, 0.48) : (hp < 0.8 ? vec3(0.018, 0.032, 0.085) : (hp < 0.9 ? vec3(0.12, 0.014, 0.018) : vec3(0.045, 0.062, 0.052))))));
  diffuseColor.rgb = paint;
  float gy = vBdLocal.y / max(vBdScale.y, 0.01);
  bdGlass = smoothstep(0.97, 1.0, gy) * (1.0 - smoothstep(1.36, 1.39, gy)) * (1.0 - step(0.5, vBdPart));
  if (vBdPart > 0.5) diffuseColor.rgb = vec3(0.014);
  bdV = 40.0; // no ground-level street spill boost on cars
#elif defined(BD_TANK)
  diffuseColor.rgb *= mix(vec3(0.72, 0.72, 0.7), bdPalette(fract(bdSd * 2.3)), 0.35);
#endif
`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
#ifdef BD_ROUGH
  roughnessFactor *= texture2D(uBdRough, bdUV / BD_TILE).g * 1.2;
#endif
  roughnessFactor = mix(roughnessFactor, 0.2, bdGlass);`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
#ifdef BD_NORMAL
  {
    vec3 tn = texture2D(uBdNormal, bdUV / BD_TILE).xyz * 2.0 - 1.0;
    tn.xy *= 0.8 * (1.0 - bdGlass);
    // Screen-space cotangent frame on the box-projected uv.
    vec3 q0 = dFdx(-vViewPosition); vec3 q1 = dFdy(-vViewPosition);
    vec2 st0 = dFdx(bdUV); vec2 st1 = dFdy(bdUV);
    vec3 N = normal;
    vec3 q1perp = cross(q1, N); vec3 q0perp = cross(N, q0);
    vec3 T = q1perp * st0.x + q0perp * st1.x;
    vec3 B = q1perp * st0.y + q0perp * st1.y;
    float det = max(dot(T, T), dot(B, B));
    float sc = det == 0.0 ? 0.0 : inversesqrt(det);
    normal = normalize(T * (tn.x * sc) + B * (tn.y * sc) + N * tn.z);
  }
#endif`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
  // City glow / street spill on the facades so silhouettes read as buildings, not holes.
  totalEmissiveRadiance += bdEmit + diffuseColor.rgb * (1.0 - bdGlass) * vec3(0.024, 0.018, 0.014) * (1.0 + 2.2 * exp(-bdV / 9.0));
  // Lightning: cold sky light on roofs and facades for a few frames.
  totalEmissiveRadiance += (diffuseColor.rgb + 0.04 * bdGlass) * vec3(0.55, 0.6, 0.8) * uBdFlash * (0.05 + 0.1 * bdTop);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.012, 0.013, 0.016), bdGlass);`,
        );
    };
    m.customProgramCacheKey = () => `bdFacade:${o.key}`;
    return b.materials.patchStatic(m, { wetness: o.wetness ?? 0.7 });
  });
}
