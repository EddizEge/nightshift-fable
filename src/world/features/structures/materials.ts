/**
 * Shared (cached) materials + the procedural sign atlas for the structures features.
 * Every material comes from IWorldMaterials.cached so chunks never dispose them.
 */
import { CanvasTexture, Color, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace } from 'three';
import type { Material, Texture } from 'three';
import type { IWorldMaterials } from '../../../core/types';

export interface StructureMaterials {
  /** Board-formed panel concrete, outdoor (wet). */
  panel: Material;
  /** Plain cast concrete, outdoor (wet): decks, pylons, piers. */
  plain: Material;
  /** Tunnel concrete (dry, sooty). */
  tunnel: Material;
  /** Tunnel wall enamel panels (light, glossy, dry). */
  tiles: Material;
  /** Painted / galvanised steel (vertex-colour tinted). */
  steel: Material;
  /** Stay cables (plastic sheath). */
  cable: Material;
  /** Unlit HDR emissive, colour per vertex (luminaires, reflectors, glows). */
  glow: Material;
  /** Unlit emissive sign atlas, intensity per vertex. */
  signs: Material;
  /** Retro-reflective sign / hazard sheeting (atlas). */
  retro: Material;
  /** Transparent acrylic noise-wall panels. */
  glass: Material;
  /** Red aircraft-warning beacons (colour animated). */
  beacon: Material;
  /** Tunnel luminaire lens (instanced, no vertex colours). */
  tunnelLens: Material;
}

export const BEACON_COLOR = new Color(1.0, 0.07, 0.03);
export const BEACON_INTENSITY = 12;
/** Stay-cable radius (bridge.ts builds them, the cable shader widens them with distance). */
export const CABLE_RADIUS = 0.13;

/** Atlas regions in UV space: [u0, v0, u1, v1] (v0 = bottom). */
export const ATLAS = {
  tunnelName: [0, 0, 0, 0] as [number, number, number, number],
  exit: [0, 0, 0, 0] as [number, number, number, number],
  sos: [0, 0, 0, 0] as [number, number, number, number],
  hazard: [0, 0, 0, 0] as [number, number, number, number],
  height: [0, 0, 0, 0] as [number, number, number, number],
  chevron: [0, 0, 0, 0] as [number, number, number, number],
  plate: [0, 0, 0, 0] as [number, number, number, number],
  lcsArrow: [0, 0, 0, 0] as [number, number, number, number],
  lcsCross: [0, 0, 0, 0] as [number, number, number, number],
  speed: [0, 0, 0, 0] as [number, number, number, number],
  dist200: [0, 0, 0, 0] as [number, number, number, number],
  dist400: [0, 0, 0, 0] as [number, number, number, number],
  dist600: [0, 0, 0, 0] as [number, number, number, number],
  dist800: [0, 0, 0, 0] as [number, number, number, number],
};

/** Tunnel luminaire rhythm (shared by tunnel.ts and the wall shader): centres at k·PITCH + OFFSET. */
export const TUNNEL_FIT_PITCH = 5.5;
export const TUNNEL_FIT_LEN = 1.5;
export const TUNNEL_FIT_OFFSET = TUNNEL_FIT_LEN * 0.5;

const W = 1024;
const H = 1024;
function region(key: keyof typeof ATLAS, x: number, y: number, w: number, h: number): void {
  ATLAS[key] = [x / W, 1 - (y + h) / H, (x + w) / W, 1 - y / H];
}

let atlasTex: Texture | null = null;

function makeAtlas(): Texture {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  const font = (px: number) => `bold ${px}px "Arial Narrow", Arial, Helvetica, sans-serif`;

  // Tunnel name / clearance band (back-lit): dark slate field, white lettering, amber clearance.
  region('tunnelName', 0, 0, 1024, 128);
  g.fillStyle = '#0b1219';
  g.fillRect(0, 0, 1024, 128);
  g.fillStyle = '#1b2834';
  g.fillRect(0, 0, 1024, 6);
  g.fillRect(0, 122, 1024, 6);
  g.fillStyle = '#f2f4f0';
  g.font = font(78);
  g.textBaseline = 'middle';
  (g as unknown as { letterSpacing: string }).letterSpacing = '10px';
  g.fillText('MERIDIAN TUNNEL', 40, 66);
  g.fillStyle = '#ffb347';
  g.font = font(70);
  (g as unknown as { letterSpacing: string }).letterSpacing = '4px';
  g.fillText('4.8 m', 820, 66);
  // clearance arrows
  g.beginPath();
  g.moveTo(790, 18);
  g.lineTo(774, 44);
  g.lineTo(806, 44);
  g.closePath();
  g.moveTo(790, 112);
  g.lineTo(774, 86);
  g.lineTo(806, 86);
  g.closePath();
  g.fill();
  g.fillRect(786, 40, 8, 50);

  // Emergency exit sign (ISO-7010-style generic pictogram, drawn here).
  region('exit', 0, 128, 256, 128);
  g.fillStyle = '#0a9a46';
  g.fillRect(0, 128, 256, 128);
  g.strokeStyle = '#f4fff6';
  g.fillStyle = '#f4fff6';
  g.lineWidth = 6;
  g.strokeRect(150, 146, 76, 94); // door
  g.lineCap = 'round';
  g.lineWidth = 11;
  g.beginPath(); // running figure
  g.arc(108, 156, 10, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(100, 172);
  g.lineTo(88, 204); // torso
  g.moveTo(98, 180);
  g.lineTo(122, 192); // front arm
  g.moveTo(96, 178);
  g.lineTo(74, 186); // back arm
  g.moveTo(88, 204);
  g.lineTo(112, 216);
  g.lineTo(116, 238); // front leg
  g.moveTo(88, 204);
  g.lineTo(76, 224);
  g.lineTo(56, 230); // back leg
  g.stroke();
  // arrow
  g.lineWidth = 9;
  g.beginPath();
  g.moveTo(18, 192);
  g.lineTo(48, 192);
  g.moveTo(18, 192);
  g.lineTo(30, 180);
  g.moveTo(18, 192);
  g.lineTo(30, 204);
  g.stroke();

  // SOS niche sign
  region('sos', 256, 128, 256, 128);
  g.fillStyle = '#1556b8';
  g.fillRect(256, 128, 256, 128);
  g.fillStyle = '#ffffff';
  g.font = font(84);
  (g as unknown as { letterSpacing: string }).letterSpacing = '6px';
  g.textAlign = 'center';
  g.fillText('SOS', 384, 196);
  g.textAlign = 'left';

  // Hazard stripes (yellow / black diagonals) — retro-reflective band.
  region('hazard', 0, 256, 1024, 64);
  g.save();
  g.beginPath();
  g.rect(0, 256, 1024, 64);
  g.clip();
  g.fillStyle = '#111111';
  g.fillRect(0, 256, 1024, 64);
  g.fillStyle = '#f2b705';
  for (let x = -64; x < 1024 + 64; x += 64) {
    g.beginPath();
    g.moveTo(x, 320);
    g.lineTo(x + 32, 320);
    g.lineTo(x + 96, 256);
    g.lineTo(x + 64, 256);
    g.closePath();
    g.fill();
  }
  g.restore();

  // Height-limit sign: white disc, red ring, black "6.0 m" between arrow heads.
  region('height', 0, 320, 256, 256);
  g.fillStyle = '#000';
  g.fillRect(0, 320, 256, 256);
  g.fillStyle = '#d41a1a';
  g.beginPath();
  g.arc(128, 448, 124, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#f3f3ee';
  g.beginPath();
  g.arc(128, 448, 96, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#111';
  g.font = font(64);
  g.textAlign = 'center';
  (g as unknown as { letterSpacing: string }).letterSpacing = '0px';
  g.fillText('6.0m', 128, 452);
  g.beginPath();
  g.moveTo(128, 392);
  g.lineTo(110, 414);
  g.lineTo(146, 414);
  g.closePath();
  g.moveTo(128, 506);
  g.lineTo(110, 484);
  g.lineTo(146, 484);
  g.closePath();
  g.fill();
  g.textAlign = 'left';

  // Chevron hazard marker (pier protection).
  region('chevron', 256, 320, 256, 256);
  g.fillStyle = '#f2b705';
  g.fillRect(256, 320, 256, 256);
  g.fillStyle = '#111';
  for (let i = 0; i < 3; i++) {
    const y = 330 + i * 82;
    g.beginPath();
    g.moveTo(276, y + 70);
    g.lineTo(384, y + 14);
    g.lineTo(492, y + 70);
    g.lineTo(492, y + 40);
    g.lineTo(384, y - 16);
    g.lineTo(276, y + 40);
    g.closePath();
    g.fill();
  }

  // Bridge / structure ID plate (white on dark green).
  region('plate', 512, 320, 512, 128);
  g.fillStyle = '#0f3d2a';
  g.fillRect(512, 320, 512, 128);
  g.strokeStyle = '#e8f0ea';
  g.lineWidth = 6;
  g.strokeRect(522, 330, 492, 108);
  g.fillStyle = '#e8f0ea';
  g.font = font(60);
  (g as unknown as { letterSpacing: string }).letterSpacing = '6px';
  g.fillText('RIVER  VALE  BRIDGE', 548, 386);

  // Lane-control signals (LED matrix look: dots on black, drawn large so they survive mips).
  const dots = (cx: number, cy: number, pts: Array<[number, number]>, col: string) => {
    g.fillStyle = col;
    for (const [x, y] of pts) {
      g.beginPath();
      g.arc(cx + x * 11, cy + y * 11, 4.6, 0, Math.PI * 2);
      g.fill();
    }
  };
  region('lcsArrow', 0, 576, 128, 128);
  region('lcsCross', 128, 576, 128, 128);
  g.fillStyle = '#020202';
  g.fillRect(0, 576, 256, 128);
  const arrow: Array<[number, number]> = [];
  for (let y = -4; y <= 1; y++) arrow.push([0, y], [-0.5, y], [0.5, y]);
  for (let i = 1; i <= 4; i++) arrow.push([-i, 4 - i - 1.5], [i, 4 - i - 1.5]);
  arrow.push([0, 2.5], [0, 3.5]);
  dots(64, 636, arrow, '#3dff6e');
  const cross: Array<[number, number]> = [];
  for (let i = -4; i <= 4; i++) cross.push([i, i], [i, -i]);
  dots(192, 640, cross, '#ff2a1a');

  // Speed limit (back-lit): red ring, white field, black numerals.
  region('speed', 256, 576, 128, 128);
  g.fillStyle = '#000';
  g.fillRect(256, 576, 128, 128);
  g.fillStyle = '#d8141a';
  g.beginPath();
  g.arc(320, 640, 62, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#f6f6f2';
  g.beginPath();
  g.arc(320, 640, 48, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#101010';
  g.font = font(56);
  g.textAlign = 'center';
  (g as unknown as { letterSpacing: string }).letterSpacing = '0px';
  g.fillText('80', 320, 644);

  // Tunnel-exit distance signs (white on green, exit pictogram arrow).
  const dist = (key: 'dist200' | 'dist400' | 'dist600' | 'dist800', x: number, y: number, m: number) => {
    region(key, x, y, 512, 96);
    g.fillStyle = '#0b6b3a';
    g.fillRect(x, y, 512, 96);
    g.strokeStyle = '#eef6f0';
    g.lineWidth = 5;
    g.strokeRect(x + 6, y + 6, 500, 84);
    g.fillStyle = '#eef6f0';
    g.font = font(50);
    g.textAlign = 'left';
    (g as unknown as { letterSpacing: string }).letterSpacing = '3px';
    g.fillText('TUNNEL EXIT', x + 26, y + 50);
    g.textAlign = 'right';
    g.fillText(`${m} m`, x + 486, y + 50);
    g.textAlign = 'left';
  };
  dist('dist200', 0, 704, 200);
  dist('dist400', 512, 704, 400);
  dist('dist600', 0, 800, 600);
  dist('dist800', 512, 800, 800);

  const t = new CanvasTexture(cv);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export function signAtlas(): Texture {
  if (!atlasTex) atlasTex = makeAtlas();
  return atlasTex;
}

let tileTex: { map: Texture; rough: Texture } | null = null;
/** Enamel wall panels: 2 × 4 panels per texture (2 m × 1 m at uvScale 0.25), thin seams. */
function makeTiles(): { map: Texture; rough: Texture } {
  const S = 512;
  const a = document.createElement('canvas');
  a.width = a.height = S;
  const r = document.createElement('canvas');
  r.width = r.height = S;
  const ga = a.getContext('2d')!;
  const gr = r.getContext('2d')!;
  ga.fillStyle = '#55544e';
  ga.fillRect(0, 0, S, S);
  gr.fillStyle = '#f0f0f0';
  gr.fillRect(0, 0, S, S);
  const cols = 2;
  const rows = 4;
  const cw = S / cols;
  const ch = S / rows;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v = 172 + Math.floor(rnd() * 18);
      ga.fillStyle = `rgb(${v},${v - 3},${v - 12})`;
      ga.fillRect(i * cw + 2, j * ch + 2, cw - 4, ch - 4);
      // faint vertical gloss gradient per panel
      const grad = ga.createLinearGradient(0, j * ch, 0, (j + 1) * ch);
      grad.addColorStop(0, 'rgba(255,255,255,0.05)');
      grad.addColorStop(1, 'rgba(0,0,0,0.06)');
      ga.fillStyle = grad;
      ga.fillRect(i * cw + 2, j * ch + 2, cw - 4, ch - 4);
      const rv = 50 + Math.floor(rnd() * 30);
      gr.fillStyle = `rgb(${rv},${rv},${rv})`;
      gr.fillRect(i * cw + 2, j * ch + 2, cw - 4, ch - 4);
    }
  }
  const map = new CanvasTexture(a);
  map.colorSpace = SRGBColorSpace;
  const rough = new CanvasTexture(r);
  for (const t of [map, rough]) {
    t.wrapS = t.wrapT = RepeatWrapping;
    t.anisotropy = 8;
    t.needsUpdate = true;
  }
  return { map, rough };
}

/**
 * three r187 declares vColor as vec4; LightField.patchStatic's color_vertex replacement still
 * writes vec3 (shader compile error with vertexColors). Resolve the chunk first, the same way
 * three does minus the instanceColor tint, so patchStatic's replace finds nothing to replace.
 */
const COLOR_VERTEX_FIXED = `#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
  vColor = vec4( 1.0 );
#endif
#ifdef USE_COLOR_ALPHA
  vColor *= color;
#elif defined( USE_COLOR )
  vColor.rgb *= color;
#endif`;
function fixColorVertex(shader: { vertexShader: string }): void {
  shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', COLOR_VERTEX_FIXED);
}

/**
 * Grime overlay: darkens the albedo with the grunge mask sampled at two scales (blotches +
 * vertical rain-wash streaks, using the box-mapped uv where v is up on walls).
 */
function addGrime(mat: MeshStandardMaterial, grime: Texture, amount: number, key: string, rhythm = false): void {
  mat.onBeforeCompile = (shader) => {
    fixColorVertex(shader);
    shader.uniforms.uStGrime = { value: grime };
    if (rhythm) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nattribute vec2 stAux;\nvarying vec2 vStAux;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\nvStAux = stAux;`);
    }
    // Tunnel light rhythm: stAux = (s, effective distance to the nearest luminaire line). The
    // baked line light is the average of a row of discrete fittings; re-distribute it per pixel
    // as the sum of point sources (normalised to the same mean): pools near the fittings,
    // smooth far away.
    const rhythmGlsl = rhythm
      ? `
{
  float stR = vStAux.y;
  // Fade out where one pixel spans a good part of the pitch (grazing far walls): no moiré.
  float stFw = fwidth(vStAux.x) / ${TUNNEL_FIT_PITCH.toFixed(3)};
  if (stR > 0.0 && stFw < 0.45) {
    const float P = ${TUNNEL_FIT_PITCH.toFixed(3)};
    float d0 = (fract((vStAux.x - ${TUNNEL_FIT_OFFSET.toFixed(3)}) / P + 0.5) - 0.5) * P;
    float r2 = stR * stR;
    float sum = 0.0;
    for (int k = -2; k <= 2; k++) {
      float dk = d0 + float(k) * P;
      float q = r2 + dk * dk;
      sum += 1.0 / (q * sqrt(q));
    }
    float f = clamp(0.5 * P * r2 * sum, 0.3, 2.6);
    diffuseColor.rgb *= mix(f, 1.0, smoothstep(0.12, 0.45, stFw));
  }
}`
      : '';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D uStGrime;${rhythm ? '\nvarying vec2 vStAux;' : ''}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
#ifdef USE_MAP
{
  float stB = texture2D(uStGrime, vMapUv * 0.29 + vec2(0.17, 0.43)).r;
  float stS = texture2D(uStGrime, vec2(vMapUv.x * 0.61 + 0.31, vMapUv.y * 0.19)).r;
  float stG = clamp(stB * 0.65 + stS * 0.75, 0.0, 1.0) * ${amount.toFixed(3)};
  diffuseColor.rgb *= 1.0 - 0.5 * stG;
}
#endif${rhythmGlsl}`,
      );
  };
  mat.customProgramCacheKey = () => `stGrime:${key}${rhythm ? ':rhythm' : ''}`;
}

export function structureMaterials(m: IWorldMaterials): StructureMaterials {
  const grime = () => m.texture('grunge_mask.webp');
  const concrete = (key: string, tex: string, wet: number, color: number, rough: number, grimeAmt: number, rhythm = false) =>
    m.cached(`structures:${key}`, () => {
      const mat = new MeshStandardMaterial({
        name: `st-${key}`,
        color: new Color(color),
        map: m.texture(`${tex}_albedo.webp`, { srgb: true }),
        normalMap: m.texture(`${tex}_normal.webp`),
        roughnessMap: m.texture(`${tex}_rough.webp`),
        roughness: rough,
        metalness: 0,
        vertexColors: true,
      });
      mat.normalScale.set(0.9, 0.9);
      addGrime(mat, grime(), grimeAmt, key, rhythm);
      return m.patchStatic(mat, { wetness: wet });
    });

  return {
    panel: concrete('panel', 'concrete_panel', 1, 0xd8d6d0, 1, 0.9),
    plain: concrete('plain', 'concrete', 1, 0xcfcdc8, 1, 0.8),
    tunnel: concrete('tunnel', 'concrete', 0.12, 0xb8b4ac, 1, 1.0, true),
    tiles: m.cached('structures:tiles', () => {
      if (!tileTex) tileTex = makeTiles();
      const mat = new MeshStandardMaterial({
        name: 'st-tiles',
        color: 0xffffff,
        map: tileTex.map,
        roughnessMap: tileTex.rough,
        roughness: 1,
        metalness: 0,
        vertexColors: true,
        envMapIntensity: 0.4,
      });
      addGrime(mat, grime(), 0.55, 'tiles', true);
      return m.patchStatic(mat, { wetness: 0.08 });
    }),
    steel: m.cached('structures:steel', () => {
      const mat = new MeshStandardMaterial({
        name: 'st-steel',
        color: 0xffffff,
        map: m.texture('metal_galv_albedo.webp', { srgb: true }),
        normalMap: m.texture('metal_galv_normal.webp'),
        roughnessMap: m.texture('metal_galv_rough.webp'),
        roughness: 0.9,
        metalness: 0.25,
        vertexColors: true,
        envMapIntensity: 0.45,
      });
      mat.onBeforeCompile = fixColorVertex;
      mat.customProgramCacheKey = () => 'stSteel';
      return m.patchStatic(mat, { wetness: 0.8 });
    }),
    cable: m.cached('structures:cable', () => {
      // HDPE-sheathed stay cable: plastic, not metal (the env's lamp band would turn steel white).
      const mat = new MeshStandardMaterial({ name: 'st-cable', color: 0xffffff, roughness: 0.55, metalness: 0, vertexColors: true, envMapIntensity: 0.3 });
      // Thin stays alias into dotted lines once they are under ~1.5 px wide: inflate the tube
      // along its (smooth, radial) normals to a minimum screen width and darken it by the same
      // ratio so the pixel's average radiance stays right — distant cables fade to a soft line.
      mat.onBeforeCompile = (shader) => {
        fixColorVertex(shader);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\nvarying float vStCov;`)
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
{
  vec4 stW = modelMatrix * vec4(transformed, 1.0);
  float stDist = length(stW.xyz - cameraPosition);
  // ≈ 0.8 px radius at 1080p × 0.7 render scale and a ~60° vertical field of view.
  float stMin = stDist * ${(0.0013).toFixed(5)};
  float stR = ${CABLE_RADIUS.toFixed(3)};
  float stE = max(stR, stMin);
  transformed += objectNormal * (stE - stR);
  vStCov = stR / stE;
}`,
          );
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\nvarying float vStCov;`)
          .replace('#include <color_fragment>', `#include <color_fragment>\n  diffuseColor.rgb *= vStCov;`);
      };
      mat.customProgramCacheKey = () => 'stCable2';
      return m.patchStatic(mat, { wetness: 0.7 });
    }),
    glow: m.cached('structures:glow', () => {
      const mat = m.emissive(0xffffff, 1);
      mat.vertexColors = true;
      mat.needsUpdate = true;
      return mat;
    }),
    signs: m.cached('structures:signs', () => {
      const mat = m.emissive(0xffffff, 1, { map: signAtlas() });
      mat.vertexColors = true;
      mat.needsUpdate = true;
      return mat;
    }),
    retro: m.cached('structures:retro', () => m.standard({ name: 'st-retro', map: signAtlas(), roughness: 0.5, retroReflect: 0.45, wetness: 0.6 })),
    glass: m.cached('structures:glass', () => {
      const mat = m.standard({
        name: 'st-glass',
        color: 0xb4cbc6,
        roughness: 0.08,
        metalness: 0,
        transparent: true,
        opacity: 0.38,
        side: 'double',
        wetness: 0.4,
      });
      mat.depthWrite = false;
      return mat;
    }),
    beacon: m.cached('structures:beacon', () => m.emissive(BEACON_COLOR, BEACON_INTENSITY, { fogScale: 0.45 })),
    tunnelLens: m.cached('structures:tunnelLens', () => m.emissive(new Color(1.0, 0.9, 0.74), 14)),
  };
}
