/**
 * NIGHTSHIFT — traffic vehicle factory.
 *
 * All eight vehicle types live in one meshopt-compressed GLB (public/assets/models/traffic/traffic.glb,
 * built by tools/traffic/build.py + pack.mjs). Each type is ONE merged mesh = one draw call:
 *   COLOR_0  albedo × baked AO × road grime, sRGB-encoded u8 (paint classes carry AO only)
 *   _SURF    u8 vec4 (surface class, roughness·255, metalness·255, –)
 * One MeshStandardMaterial per pooled vehicle (all share one program) patched in onBeforeCompile:
 * paint classes take the per-vehicle paint colour, lamps are emissive from per-vehicle uniforms,
 * plates / reflectors / truck tape are retro-reflective to the player's headlight, setCharred()
 * turns the vehicle into a burnt-out shell (procedural scale / ash / rust / bare steel, lamps dark) whose
 * sheet metal glows red-hot and cools over ~1 min. Geometry is shared between instances of a type.
 * Origin: centre of the footprint on the ground, facing −Z.
 * Distance LOD: '<type>_lod1' (meshopt-simplified, lamps locked) replaces the full mesh beyond LOD1_DISTANCE.
 * Meshes sit on LAYERS.NO_PROBE (main view + road reflection, not the env probe) and cast no shadows.
 */
import { Color, Group, LOD, Matrix4, Mesh, MeshStandardMaterial, Vector3, Vector4 } from 'three';
import type { BufferGeometry, IUniform, Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type {
  ILighting,
  ITrafficVehicleFactory,
  ITrafficVisual,
  QualitySettings,
  TrafficType,
  TrafficVehicleDef,
} from '../core/types';
import { LAYERS } from '../core/types';
import { assetUrl } from '../world/materials';

export const TRAFFIC_TYPES: readonly TrafficType[] = ['sedan', 'hatch', 'suv', 'van', 'boxtruck', 'semi', 'tanker', 'sports'];

/** Surface classes baked into _SURF.x (keep in sync with tools/traffic/pack.mjs). */
export const SURF = { other: 0, paint: 1, paint2: 2, head: 3, tail: 4, brake: 5, indL: 6, indR: 7, markerA: 8, markerR: 9, markerW: 10, retro: 11, glass: 12, drl: 13, lens: 14 } as const;

/** Emissive levels (linear HDR). */
const TAIL_ON = 6;
const BRAKE_ON = 20;
const IND_ON = 10;
const HEAD_ON = 40;
const MARKER_ON = 4;
/** Camera distance (m) beyond which the simplified mesh is drawn. */
const LOD1_DISTANCE = 120;

function nominalDef(type: TrafficType, length: number, width: number, height: number, mass: number, speedMin: number, speedMax: number): TrafficVehicleDef {
  return { type, length, width, height, mass, speedMin, speedMax, tailY: height * 0.55, tailX: width * 0.38, headY: height * 0.48, headX: width * 0.36 };
}

const NOMINAL: Record<TrafficType, TrafficVehicleDef> = {
  sedan: nominalDef('sedan', 4.75, 1.85, 1.45, 1500, 26, 36),
  hatch: nominalDef('hatch', 4.25, 1.8, 1.5, 1500, 26, 34),
  suv: nominalDef('suv', 4.85, 1.95, 1.75, 2100, 25, 33),
  van: nominalDef('van', 5.4, 2.0, 2.5, 2600, 25, 31),
  boxtruck: nominalDef('boxtruck', 8.2, 2.5, 3.5, 9000, 22, 25),
  semi: nominalDef('semi', 16.5, 2.55, 4.0, 26000, 22, 26),
  tanker: nominalDef('tanker', 16, 2.55, 3.7, 30000, 22, 25),
  sports: nominalDef('sports', 4.4, 1.95, 1.25, 1500, 30, 36),
};

// ───────────────────────────────────────────────────────────── paint fleet

interface Paint {
  c: [number, number, number];
  rough: number;
  metal: number;
}
const P = (r: number, g: number, b: number, rough: number, metal: number): Paint => ({ c: [r, g, b], rough, metal });
/** [weight, paint] — linear albedo. Roughness is the wet clear coat. */
const CAR_PAINTS: Array<[number, Paint]> = [
  [22, P(0.78, 0.78, 0.76, 0.16, 0.0)], // white
  [4, P(0.66, 0.66, 0.62, 0.18, 0.15)], // pearl white
  [19, P(0.012, 0.012, 0.013, 0.12, 0.0)], // black
  [15, P(0.5, 0.51, 0.52, 0.22, 0.65)], // silver
  [10, P(0.14, 0.145, 0.15, 0.2, 0.5)], // dark grey metallic
  [5, P(0.26, 0.27, 0.28, 0.2, 0.3)], // mid grey
  [8, P(0.012, 0.028, 0.075, 0.16, 0.45)], // dark blue
  [6, P(0.22, 0.012, 0.012, 0.15, 0.3)], // deep red
  [2, P(0.02, 0.045, 0.03, 0.18, 0.4)], // dark green
  [2, P(0.36, 0.3, 0.22, 0.22, 0.4)], // beige / champagne
  [2, P(0.13, 0.24, 0.42, 0.18, 0.4)], // light blue
  [1, P(0.32, 0.1, 0.02, 0.18, 0.45)], // copper
  [1, P(0.55, 0.36, 0.0, 0.16, 0.1)], // yellow
];
const SPORTS_PAINTS: Array<[number, Paint]> = [
  [5, P(0.3, 0.008, 0.006, 0.12, 0.25)],
  [3, P(0.012, 0.012, 0.013, 0.1, 0.0)],
  [3, P(0.75, 0.75, 0.74, 0.12, 0.0)],
  [3, P(0.34, 0.35, 0.37, 0.16, 0.7)],
  [2, P(0.02, 0.07, 0.3, 0.12, 0.5)],
  [2, P(0.6, 0.2, 0.0, 0.12, 0.2)],
  [1, P(0.6, 0.45, 0.0, 0.12, 0.1)],
  [1, P(0.06, 0.2, 0.06, 0.14, 0.4)],
];
const CAB_PAINTS: Array<[number, Paint]> = [
  [10, P(0.75, 0.75, 0.73, 0.25, 0.0)],
  [4, P(0.32, 0.33, 0.34, 0.25, 0.35)],
  [3, P(0.02, 0.05, 0.16, 0.22, 0.3)],
  [2, P(0.28, 0.015, 0.012, 0.22, 0.2)],
  [1, P(0.012, 0.012, 0.013, 0.2, 0.0)],
  [1, P(0.04, 0.12, 0.06, 0.24, 0.2)],
];
/** Boxes / trailers: fleet white dominates, plain aluminium, a few plain coloured fleets (no logos, no text). */
const BOX_PAINTS: Array<[number, Paint]> = [
  [12, P(0.72, 0.72, 0.7, 0.4, 0.0)], // fleet white
  [2, P(0.6, 0.6, 0.57, 0.45, 0.0)], // aged off-white
  [4, P(0.62, 0.63, 0.64, 0.32, 0.85)], // aluminium panels
  [2, P(0.42, 0.43, 0.44, 0.4, 0.2)], // grey
  [1, P(0.03, 0.06, 0.18, 0.35, 0.1)], // dark blue
  [1, P(0.2, 0.012, 0.01, 0.38, 0.05)], // dark red
  [1, P(0.025, 0.07, 0.035, 0.38, 0.05)], // dark green
  [1, P(0.012, 0.012, 0.013, 0.36, 0.0)], // black
];

function rng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(list: Array<[number, Paint]>, r: number): Paint {
  let total = 0;
  for (const [w] of list) total += w;
  let x = r * total;
  for (const [w, p] of list) {
    x -= w;
    if (x <= 0) return p;
  }
  return list[list.length - 1][1];
}

// ───────────────────────────────────────────────────────────── shader patch

interface VehicleUniforms {
  uPaint: IUniform<Color>;
  uPaint2: IUniform<Color>;
  /** x = paint roughness, y = paint metalness, z = paint2 roughness, w = paint2 metalness */
  uPaintMR: IUniform<Vector4>;
  /** x = tail, y = brake-only, z = indicator L, w = indicator R */
  uLamps: IUniform<Vector4>;
  /** x = head lamps, y = marker lamps, z = charred 0..1, w = retro-reflection gain */
  uLamps2: IUniform<Vector4>;
  /** Inverse world matrix of the vehicle root (object-space wreck pattern; updated only while charred). */
  uNsRootInv: IUniform<Matrix4>;
  /** Burnt shell: x = heat 0..1 (fades over ~1 min after charring), y = time (s, flicker), z = 1 / vehicle height, w = per-vehicle seed. */
  uNsChar: IUniform<Vector4>;
}

/** Seconds after setCharred() until the metal has cooled (no more glow). */
const CHAR_COOL_SECONDS = 65;

const VERT_HEAD = /* glsl */ `#include <common>
attribute vec4 _surf;
uniform mat4 uNsRootInv;
varying vec4 vSurf;
varying vec3 vNsTrafficPos;
varying vec3 vNsLocal;`;

const FRAG_HEAD = /* glsl */ `#include <common>
uniform vec3 uPaint;
uniform vec3 uPaint2;
uniform vec4 uPaintMR;
uniform vec4 uLamps;
uniform vec4 uLamps2;
uniform vec4 uNsChar;
uniform vec3 uNsHeadPos;
uniform vec3 uNsHeadDir;
uniform vec3 uNsHeadColor;
uniform vec3 uNsHeadCone;
varying vec4 vSurf;
varying vec3 vNsTrafficPos;
varying vec3 vNsLocal;
float nsHash3(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
const mat3 nsTurn = mat3(0.36, 0.48, -0.8, -0.8, 0.6, 0.0, 0.48, 0.64, 0.6);
float nsNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(nsHash3(i), nsHash3(i + vec3(1, 0, 0)), f.x), mix(nsHash3(i + vec3(0, 1, 0)), nsHash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(nsHash3(i + vec3(0, 0, 1)), nsHash3(i + vec3(1, 0, 1)), f.x), mix(nsHash3(i + vec3(0, 1, 1)), nsHash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`;

const FRAG_COLOR = /* glsl */ `#include <color_fragment>
float nsCls = floor(vSurf.x + 0.5);
float nsChar = uLamps2.z;
bool nsP1 = abs(nsCls - 1.0) < 0.5;
bool nsP2 = abs(nsCls - 2.0) < 0.5;
if (nsP1) diffuseColor.rgb *= uPaint;
else if (nsP2) diffuseColor.rgb *= uPaint2;
float nsCharR = 1.0;
float nsCharM = 0.0;
vec3 nsGlow = vec3(0.0);
if (nsChar > 0.0) {
  // Burnt-out shell (object space, so the pattern sticks to a tumbling wreck): grey-black scale and soot, light ash
  // settled on top faces, rust-brown and heat-blued bare steel where the paint burnt off, worn edges, blackened glass.
  vec3 L = vNsLocal + uNsChar.w;
  // (each octave on its own turned lattice, the fine one doubled: value noise straight on the object
  // axes shows as a grid of squares on a big flat panel — a box truck looked like pixel camouflage)
  float nA = nsNoise3((L * nsTurn) * 1.15 + 3.7);
  float nB = nsNoise3((nsTurn * L) * 3.4 + 17.0);
  float nC = 0.6 * nsNoise3((nsTurn * L).zxy * 9.0 + 5.0) + 0.4 * nsNoise3((L * nsTurn).yzx * 19.0 + 11.0);
  nC = clamp((nC - 0.5) * 1.4 + 0.5, 0.0, 1.0);
  float yN = clamp(vNsLocal.y * uNsChar.z, 0.0, 1.0);
  vec3 nsDx = dFdx(vNsLocal);
  vec3 nsDy = dFdy(vNsLocal);
  vec3 nsFn = normalize(cross(nsDx, nsDy) + 1e-7);
  float nsUp = clamp(nsFn.y, 0.0, 1.0);
  // panel edges / creases: normal change per metre of surface
  float nsCurv = length(fwidth(vNormal)) / max(length(fwidth(vNsLocal)), 1e-4);
  float nsEdge = smoothstep(4.0, 14.0, nsCurv) * (1.0 - smoothstep(60.0, 120.0, nsCurv));
  // baked AO (paint classes carry AO only) marks recesses and seams
  float nsAo = max(vColor.r, max(vColor.g, vColor.b));
  // (deep recesses only, broken up by noise: the AO is per vertex and shows the mesh grid on big flat panels)
  float nsRecess = ((nsP1 || nsP2) ? 1.0 - smoothstep(0.12, 0.45, nsAo) : 0.35 * (1.0 - smoothstep(0.05, 0.3, nsAo))) * (0.6 + 0.4 * nB);

  vec3 nsC = mix(vec3(0.04, 0.038, 0.036), vec3(0.11, 0.105, 0.098), smoothstep(0.3, 0.65, nA * 0.7 + nC * 0.3));
  float nsRustM = smoothstep(0.45, 0.72, nA * 0.55 + nB * 0.45 + nsUp * 0.12);
  nsC = mix(nsC, mix(vec3(0.085, 0.036, 0.017), vec3(0.2, 0.078, 0.03), nC), nsRustM * 0.85);
  float nsMetalM = smoothstep(0.62, 0.78, nB * 0.6 + nC * 0.4) * (1.0 - nsRustM * 0.6);
  nsMetalM = max(nsMetalM, nsEdge * 0.75);
  nsC = mix(nsC, mix(vec3(0.3, 0.29, 0.28), vec3(0.2, 0.22, 0.3), smoothstep(0.35, 0.65, nA)), nsMetalM);
  float nsAshM = smoothstep(0.6, 0.85, nB + (nC - 0.5) * 0.35) * (0.25 + 0.75 * nsUp) * (1.0 - nsMetalM);
  nsC = mix(nsC, vec3(0.2, 0.19, 0.175), nsAshM * 0.75);
  // soot is heaviest low on the body and in recesses (flames lick up from below)
  float nsSoot = max(1.0 - smoothstep(0.04, 0.35, yN), nsRecess * 0.7) * (1.0 - nsMetalM * 0.7);
  nsC *= 1.0 - 0.45 * nsSoot;
  float nsR = mix(0.78, 0.95, nC) - 0.28 * nsMetalM + 0.05 * nsAshM;
  float nsM = nsMetalM * 0.85;
  if (nsCls > 11.5 && nsCls < 12.5) {
    // glass: blackened, crazed, still glossy
    nsC = vec3(0.012 + 0.012 * nC);
    nsR = 0.22 + 0.35 * smoothstep(0.4, 0.7, nB);
    nsM = 0.0;
  } else if (nsCls > 2.5 && nsCls != 11.0) {
    // lamp lenses / reflectors: melted smoked plastic
    nsC = vec3(0.03, 0.028, 0.026);
    nsR = 0.45;
    nsM = 0.0;
  }
  // rain on top faces
  nsR *= 1.0 - 0.3 * nsUp;
  // heat glow: thin sheet metal, seams, recesses and the lower body, slow flicker; fades with uNsChar.x
  if (uNsChar.x > 0.0) {
    // hot zones: a few large patches (thin panels over the fire), the lower body, recesses; sparse seams inside them
    float nsHot = smoothstep(0.5, 0.8, nA * 0.8 + nC * 0.2);
    float nsLow = 1.0 - smoothstep(0.0, 0.4, yN);
    float nsRec = nsRecess * (0.5 + 0.5 * nC);
    float nsSeam = (1.0 - smoothstep(0.0, 0.025, abs(nB - 0.5))) * smoothstep(0.55, 0.75, nA * 0.7 + nsLow * 0.4);
    float nsThin = (nsP1 || nsP2) ? 1.0 : (nsCls > 11.5 && nsCls < 12.5 ? 0.0 : 0.6);
    float nsT = 0.45 * nsHot + 0.4 * nsLow * (0.4 + 0.6 * nC) + 0.6 * nsRec + 0.35 * nsSeam;
    float nsFl = nsNoise3(vec3(L.x * 0.6, L.z * 0.6 + uNsChar.y * 0.35, uNsChar.y * 0.55));
    nsT *= nsThin * uNsChar.x * (0.6 + 0.55 * nsFl) * (1.0 - 0.6 * nsMetalM * (1.0 - nsEdge));
    nsT = clamp(nsT, 0.0, 1.0);
    // 4 at the hottest point, dull red at the low end (T^3: the cool majority of the shell stays dark)
    nsGlow = mix(vec3(1.0, 0.06, 0.01), vec3(1.0, 0.28, 0.05), nsT) * (4.0 * nsT * nsT * nsT) * nsChar;
    nsC *= 1.0 - 0.4 * nsT;
  }
  diffuseColor.rgb = mix(diffuseColor.rgb, nsC, nsChar);
  nsCharR = nsR;
  nsCharM = nsM;
}`;

const FRAG_ROUGH = /* glsl */ `#include <roughnessmap_fragment>
roughnessFactor = nsP1 ? uPaintMR.x : (nsP2 ? uPaintMR.z : vSurf.y / 255.0);
roughnessFactor = mix(roughnessFactor, nsCharR, nsChar);`;

const FRAG_METAL = /* glsl */ `#include <metalnessmap_fragment>
metalnessFactor = nsP1 ? uPaintMR.y : (nsP2 ? uPaintMR.w : vSurf.z / 255.0);
metalnessFactor = mix(metalnessFactor, nsCharM, nsChar);`;

const FRAG_EMIT = /* glsl */ `#include <emissivemap_fragment>
{
  vec3 nsE = vec3(0.0);
  const vec3 RED = vec3(1.0, 0.025, 0.012);
  const vec3 AMBER = vec3(1.0, 0.42, 0.04);
  if (nsCls > 2.5) {
    if (nsCls < 3.5) nsE = vec3(1.0, 0.95, 0.88) * uLamps2.x;
    else if (nsCls < 4.5) nsE = RED * uLamps.x;
    else if (nsCls < 5.5) nsE = RED * uLamps.y;
    else if (nsCls < 6.5) nsE = AMBER * uLamps.z;
    else if (nsCls < 7.5) nsE = AMBER * uLamps.w;
    else if (nsCls < 8.5) nsE = AMBER * uLamps2.y;
    else if (nsCls < 9.5) nsE = RED * uLamps2.y;
    else if (nsCls < 10.5) nsE = vec3(0.9, 0.92, 1.0) * uLamps2.y * 0.8;
    else if (nsCls < 11.5) {
      // retro-reflective sheeting (plates, reflectors, conspicuity tape): returns the player's headlight
      vec3 hv = vNsTrafficPos - uNsHeadPos;
      float hr2 = dot(hv, hv);
      float hr = sqrt(hr2);
      float cone = smoothstep(uNsHeadCone.y - 0.25, uNsHeadCone.x, dot(hv / max(hr, 1e-3), uNsHeadDir));
      float range = 1.0 - smoothstep(uNsHeadCone.z * 0.8, uNsHeadCone.z * 1.6, hr);
      nsE = diffuseColor.rgb * uNsHeadColor * (cone * range * uLamps2.w / (hr2 * 0.35 + 30.0));
    }
    else if (nsCls < 12.5) nsE = vec3(0.0);
    else if (nsCls < 13.5) nsE = vec3(0.92, 0.95, 1.0) * uLamps2.x * 0.45;
    else nsE = RED * uLamps.x * 0.05;
  }
  totalEmissiveRadiance += nsE * (1.0 - nsChar) + nsGlow;
}`;

function patchVehicleMaterial(m: MeshStandardMaterial, u: VehicleUniforms, lighting: ILighting | undefined, head: Record<string, IUniform>): void {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u, head);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERT_HEAD)
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
vColor.rgb = pow(vColor.rgb, vec3(2.2));
vSurf = _surf;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vNsTrafficPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vNsLocal = (uNsRootInv * vec4(vNsTrafficPos, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', FRAG_HEAD)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <metalnessmap_fragment>', FRAG_METAL)
      .replace('#include <emissivemap_fragment>', FRAG_EMIT);
  };
  m.customProgramCacheKey = () => 'nsTraffic5';
  if (lighting) lighting.patchDynamic(m);
}

// ───────────────────────────────────────────────────────────── visual

class TrafficVisual implements ITrafficVisual {
  readonly object = new Group();
  readonly mesh: Mesh;
  readonly material: MeshStandardMaterial;
  readonly u: VehicleUniforms;

  constructor(
    readonly def: TrafficVehicleDef,
    template: Mesh,
    lodTemplate: Mesh | undefined,
    lighting: ILighting | undefined,
    head: Record<string, IUniform>,
    envMap: Texture | null,
  ) {
    this.u = {
      uPaint: { value: new Color(0.8, 0.8, 0.8) },
      uPaint2: { value: new Color(0.75, 0.75, 0.75) },
      uPaintMR: { value: new Vector4(0.18, 0, 0.35, 0) },
      uLamps: { value: new Vector4(TAIL_ON, 0, 0, 0) },
      uLamps2: { value: new Vector4(HEAD_ON, MARKER_ON, 0, 1) },
      uNsRootInv: { value: new Matrix4() },
      uNsChar: { value: new Vector4(0, 0, 1 / Math.max(0.5, def.height), 0) },
    };
    this.clock = lighting ? lighting.uniforms.uTime : null;
    const m = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, envMap, envMapIntensity: 1 });
    m.name = `traffic.${def.type}`;
    patchVehicleMaterial(m, this.u, lighting, head);
    this.material = m;
    const mk = (tpl: Mesh, name: string): Mesh => {
      const mesh = new Mesh(tpl.geometry, m);
      mesh.position.copy(tpl.position);
      mesh.quaternion.copy(tpl.quaternion);
      mesh.scale.copy(tpl.scale);
      mesh.name = name;
      mesh.layers.set(LAYERS.NO_PROBE);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.onBeforeRender = this.beforeRender;
      return mesh;
    };
    this.mesh = mk(template, def.type);
    this.object.name = `traffic-${def.type}`;
    if (lodTemplate) {
      const lod = new LOD();
      lod.name = `traffic-${def.type}-lod`;
      lod.addLevel(this.mesh, 0, 0.04);
      lod.addLevel(mk(lodTemplate, `${def.type}_lod1`), LOD1_DISTANCE, 0.04);
      this.object.add(lod);
    } else {
      this.object.add(this.mesh);
    }
  }

  /** Game clock (lighting uTime, wraps at 3600 s); wall clock without a lighting model. */
  private readonly clock: IUniform<number> | null;
  /** Clock value when the vehicle was first charred. */
  private charredAt = 0;

  private now(): number {
    return this.clock ? this.clock.value : (performance.now() / 1000) % 3600;
  }

  private readonly beforeRender = (): void => {
    if (this.u.uLamps2.value.z <= 0) return;
    this.u.uNsRootInv.value.copy(this.object.matrixWorld).invert();
    const c = this.u.uNsChar.value;
    const t = this.now();
    const age = (t - this.charredAt + 3600) % 3600;
    // fast at first (thin sheet), a dull ember tail, cold at CHAR_COOL_SECONDS
    const tail = age >= CHAR_COOL_SECONDS ? 0 : 1 - age / CHAR_COOL_SECONDS;
    c.x = Math.exp(-age / 16) * tail * tail;
    c.y = t;
  };

  setPaint(seed: number): void {
    const r = rng(seed);
    const t = this.def.type;
    const truck = t === 'boxtruck' || t === 'semi' || t === 'tanker';
    const p1 = pick(t === 'sports' ? SPORTS_PAINTS : truck ? CAB_PAINTS : CAR_PAINTS, r());
    const p2 = truck ? pick(BOX_PAINTS, r()) : p1;
    const age = r();
    this.u.uPaint.value.setRGB(p1.c[0], p1.c[1], p1.c[2]);
    this.u.uPaint2.value.setRGB(p2.c[0], p2.c[1], p2.c[2]);
    // older / dirtier vehicles: a little rougher and darker
    const dull = age > 0.75 ? (age - 0.75) * 4 : 0;
    this.u.uPaint.value.multiplyScalar(1 - 0.12 * dull);
    this.u.uPaintMR.value.set(p1.rough + 0.12 * dull, p1.metal, p2.rough + 0.1 * dull, p2.metal);
  }

  setLights(brake: number, indicator: -1 | 0 | 1, time: number, hazard = false): void {
    const b = brake < 0 ? 0 : brake > 1 ? 1 : brake;
    const blink = (time * 1.45) % 1 < 0.55 ? IND_ON : 0;
    const l = this.u.uLamps.value;
    l.x = TAIL_ON + (BRAKE_ON - TAIL_ON) * b;
    l.y = BRAKE_ON * b;
    l.z = hazard || indicator === -1 ? blink : 0;
    l.w = hazard || indicator === 1 ? blink : 0;
  }

  setCharred(amount: number): void {
    const a = amount < 0 ? 0 : amount > 1 ? 1 : amount;
    const l2 = this.u.uLamps2.value;
    if (a > 0 && l2.z <= 0) {
      // first charring: start the cool-down clock, new burn pattern
      this.charredAt = this.now();
      const c = this.u.uNsChar.value;
      c.x = 1;
      c.w = Math.floor(Math.random() * 97) * 1.37;
    }
    l2.z = a;
    // matte scale and ash dull the reflections, bare steel and glass keep some (uniform only, no recompile)
    this.material.envMapIntensity = 1 - 0.45 * a;
  }

  reset(): void {
    this.setLights(0, 0, 0);
    this.setCharred(0);
    const l2 = this.u.uLamps2.value;
    l2.x = HEAD_ON;
    l2.y = MARKER_ON;
    this.object.visible = true;
    this.object.position.set(0, 0, 0);
    this.object.rotation.set(0, 0, 0);
    this.object.scale.set(1, 1, 1);
  }

  setEnvMap(tex: Texture | null): void {
    if (this.material.envMap === tex) return;
    if (!this.material.envMap !== !tex) this.material.needsUpdate = true;
    this.material.envMap = tex;
  }

  dispose(): void {
    this.material.dispose();
  }
}

// ───────────────────────────────────────────────────────────── factory

export interface TrafficFactoryDeps {
  lighting?: ILighting;
  envMap?: Texture | null;
  quality?: QualitySettings;
}

export type TrafficVehicleFactory = ITrafficVehicleFactory & {
  setEnvMap(tex: Texture | null): void;
  /** Free every pooled material and the shared geometry. */
  dispose(): void;
};

export function createTrafficVehicleFactory(deps: TrafficFactoryDeps = {}): TrafficVehicleFactory {
  const defs = {} as Record<TrafficType, TrafficVehicleDef>;
  for (const t of TRAFFIC_TYPES) defs[t] = { ...NOMINAL[t] };
  const templates = new Map<TrafficType, Mesh>();
  const lodTemplates = new Map<TrafficType, Mesh>();
  const pools = new Map<TrafficType, TrafficVisual[]>();
  const all: TrafficVisual[] = [];
  let envMap: Texture | null = deps.envMap ?? null;
  let loading: Promise<void> | null = null;

  // Headlight uniforms for the retro-reflection term (shared objects from the lighting model).
  const lu = deps.lighting?.uniforms;
  const head: Record<string, IUniform> = {
    uNsHeadPos: lu ? lu.uHeadPos : { value: new Vector3() },
    uNsHeadDir: lu ? lu.uHeadDir : { value: new Vector3(0, 0, -1) },
    uNsHeadColor: lu ? lu.uHeadColor : { value: new Color(0, 0, 0) },
    uNsHeadCone: lu ? lu.uHeadCone : { value: new Vector3(0.95, 0.85, 120) },
  };
  const retroGain = deps.quality?.level === 'low' ? 0 : 0.045;

  async function doLoad(): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(assetUrl('assets/models/traffic/traffic.glb'));
    for (const t of TRAFFIC_TYPES) {
      const node = gltf.scene.getObjectByName(t) as Mesh | undefined;
      if (!node || !(node as Mesh).isMesh) continue;
      const geo = node.geometry as BufferGeometry;
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      templates.set(t, node);
      const lod = gltf.scene.getObjectByName(`${t}_lod1`) as Mesh | undefined;
      if (lod && lod.isMesh) {
        lod.geometry.computeBoundingSphere();
        lodTemplates.set(t, lod);
      }
      const x = node.userData as Partial<TrafficVehicleDef>;
      const d = defs[t];
      for (const k of ['length', 'width', 'height', 'tailY', 'tailX', 'headY', 'headX'] as const) {
        const v = x[k];
        if (typeof v === 'number' && v > 0) d[k] = v;
      }
    }
    // fallback: a missing type borrows the closest available one so the game never crashes
    const fallback: Record<TrafficType, TrafficType[]> = {
      sedan: ['hatch', 'sports', 'suv'], hatch: ['sedan'], suv: ['sedan'], sports: ['sedan'], van: ['suv', 'sedan'],
      boxtruck: ['van', 'semi'], semi: ['tanker', 'boxtruck'], tanker: ['semi', 'boxtruck'],
    };
    for (const t of TRAFFIC_TYPES) {
      if (templates.has(t)) continue;
      const alt = fallback[t].find((a) => templates.has(a)) ?? [...templates.keys()][0];
      if (!alt) throw new Error('traffic.glb contains no vehicles');
      templates.set(t, templates.get(alt)!);
      const altLod = lodTemplates.get(alt);
      if (altLod) lodTemplates.set(t, altLod);
      Object.assign(defs[t], { ...defs[alt], type: t, mass: NOMINAL[t].mass, speedMin: NOMINAL[t].speedMin, speedMax: NOMINAL[t].speedMax });
      console.warn(`[traffic] missing model '${t}', using '${alt}'`);
    }
  }

  return {
    defs,
    load(): Promise<void> {
      loading ??= doLoad();
      return loading;
    },
    acquire(type: TrafficType, seed: number): ITrafficVisual {
      const tpl = templates.get(type);
      if (!tpl) throw new Error('traffic factory: call load() first');
      let pool = pools.get(type);
      if (!pool) pools.set(type, (pool = []));
      let v = pool.pop();
      if (!v) {
        v = new TrafficVisual(defs[type], tpl, lodTemplates.get(type), deps.lighting, head, envMap);
        v.u.uLamps2.value.w = retroGain;
        all.push(v);
      }
      v.reset();
      v.setPaint(seed);
      return v;
    },
    release(v: ITrafficVisual): void {
      const tv = v as TrafficVisual;
      tv.reset();
      tv.object.removeFromParent();
      let pool = pools.get(tv.def.type);
      if (!pool) pools.set(tv.def.type, (pool = []));
      if (!pool.includes(tv)) pool.push(tv);
    },
    setEnvMap(tex: Texture | null): void {
      envMap = tex;
      for (const v of all) v.setEnvMap(tex);
    },
    dispose(): void {
      for (const v of all) v.dispose();
      all.length = 0;
      pools.clear();
      const geos = new Set<BufferGeometry>();
      for (const m of templates.values()) geos.add(m.geometry);
      for (const m of lodTemplates.values()) geos.add(m.geometry);
      for (const g of geos) g.dispose();
      templates.clear();
      lodTemplates.clear();
      loading = null;
    },
  };
}
