#!/usr/bin/env node
/**
 * NIGHTSHIFT — pack the generated player car for the game.
 *
 *   node tools/car/pack.mjs [--raw tools/car/out/player_car.raw.glb] [--meta tools/car/out/player_car.meta.json]
 *                           [--out public/assets/models/player_car.glb] [--check]
 *
 * Input: the raw glTF written by tools/car/build_car.py (Blender, already in car space: Y up, the car faces -Z,
 * origin = centre of the wheelbase on the ground) and the measurements it writes next to it (.meta.json).
 *
 * What this does:
 *  - validates the contract the runtime (src/vehicle/playerCarVisual.ts) relies on and exits with code 1 if it
 *    is broken: root "PlayerCar", every part node present once and not empty, every mesh inside a part, every
 *    material name known (tools/car/lib/materials.py DEFS), triangles only, normals present, wheels centred on
 *    their hubs with the measured radius, steering / mirror pivots on their parts, anchors on the right side,
 *    no textures or images, no brand name in any node / mesh / material name;
 *  - drops what the runtime does not read (TANGENT, TEXCOORD_1+, COLOR_1+, skin attributes; COLOR_0 on a material
 *    where not every piece has it, since the runtime then ignores it);
 *  - writes the measurements into scene extras AND root node extras under "nightshift"
 *    (the runtime reads scene.userData.nightshift);
 *  - dedup (keepUniqueNames: headlight_L / headlight_R must stay apart), prune, meshopt + quantisation;
 *  - reads the written file back and checks parts, materials and triangle count survived;
 *  - prints triangles per part and per material, draw calls after the runtime's per-material merge, file size.
 *
 * --check validates and reports without writing anything.
 */
import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []),
);
const RAW = path.resolve(ROOT, args.raw || 'tools/car/out/player_car.raw.glb');
const META = path.resolve(ROOT, args.meta || 'tools/car/out/player_car.meta.json');
const OUT = path.resolve(ROOT, args.out || 'public/assets/models/player_car.glb');
const CHECK_ONLY = !!args.check;
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

// ───────────────────────────────────────────── the contract

/** Part nodes the runtime binds to (bones). Keep in sync with tools/car/lib/spec.py PART_NAMES. */
const PARTS = ['Body', 'MirrorL', 'MirrorR', 'Steering', ...['FL', 'FR', 'RL', 'RR'].flatMap((k) => [`Wheel_${k}_Spin`, `Wheel_${k}_Caliper`])];
/** Materials src/vehicle/playerCarVisual.ts builds by name. */
const RUNTIME_MATERIALS = [
  'paint_main', 'paint_accent', 'carbon', 'trim', 'grille', 'glass', 'lens', 'mirror', 'interior', 'interior_accent',
  'dashboard', 'hardware', 'mechanical', 'plate', 'headlight_L', 'headlight_R', 'taillight', 'signal', 'reflector',
  'rim_chrome', 'rim_dark', 'caliper', 'disc', 'tyre_side', 'tyre_tread', 'grille_mesh', 'reverse',
];
const ANCHORS = ['headlightL', 'headlightR', 'taillightL', 'taillightR', 'exhaustL', 'exhaustR', 'hoodCam'];
const DIMS = ['length', 'width', 'height', 'wheelBase', 'trackFront', 'trackRear', 'wheelRadius', 'frontAxle', 'rearAxle'];
/** Tolerances (metres). */
const TOL_HUB = 0.015;
const TOL_DIM = 0.01;

/**
 * Brand names that must not appear in any name. Long names match anywhere (case and separators ignored),
 * short ones only as a whole word (so "seat", "fiat" in "fiat_lux"... are checked as words).
 */
const BRANDS_ANY = [
  'ferrari', 'lamborghini', 'porsche', 'mclaren', 'bugatti', 'koenigsegg', 'pagani', 'maserati', 'alfaromeo',
  'astonmartin', 'bentley', 'rollsroyce', 'jaguar', 'landrover', 'rangerover', 'mercedes', 'maybach', 'chevrolet',
  'corvette', 'camaro', 'mustang', 'cadillac', 'chrysler', 'toyota', 'lexus', 'nissan', 'infiniti', 'skyline',
  'honda', 'acura', 'mazda', 'subaru', 'mitsubishi', 'suzuki', 'hyundai', 'volkswagen', 'skoda', 'renault',
  'peugeot', 'citroen', 'lotus', 'tesla', 'rivian', 'polestar', 'volvo', 'huracan', 'aventador', 'countach',
  'cayenne', 'carrera', 'veyron', 'chiron', 'michelin', 'pirelli', 'bridgestone', 'goodyear', 'brembo', 'recaro',
  'sparco', 'khronos', 'carconcept', 'sketchfab', 'turbosquid', 'cgtrader',
];
const BRANDS_WORD = ['bmw', 'audi', 'amg', 'kia', 'vw', 'gmc', 'ford', 'fiat', 'opel', 'jeep', 'dodge', 'supra', 'gtr', 'nsx', 'bbs', 'oz'];

/** Material names defined on the Blender side (tools/car/lib/materials.py DEFS). */
function blenderMaterialNames() {
  const file = path.join(ROOT, 'tools/car/lib/materials.py');
  if (!fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('DEFS = {');
  if (start < 0) return null;
  const body = src.slice(start, src.indexOf('\n}', start));
  return [...body.matchAll(/^\s*'([A-Za-z0-9_]+)'\s*:\s*dict\(/gm)].map((m) => m[1]);
}

function brandIn(name) {
  if (!name) return null;
  const flat = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const b of BRANDS_ANY) if (flat.includes(b)) return b;
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
  for (const b of BRANDS_WORD) if (words.includes(b)) return b;
  return null;
}

// ───────────────────────────────────────────── helpers

const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));
const fmt = (v) => `[${v.map((x) => x.toFixed(3)).join(', ')}]`;

function xfPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
const emptyBox = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
function growBox(b, p) {
  for (let k = 0; k < 3; k++) {
    if (p[k] < b.min[k]) b.min[k] = p[k];
    if (p[k] > b.max[k]) b.max[k] = p[k];
  }
}
const boxCentre = (b) => b.min.map((v, k) => (v + b.max[k]) / 2);
const inBox = (b, p, pad) => p.every((v, k) => v >= b.min[k] - pad && v <= b.max[k] + pad);
const triCount = (prim) => (prim.getIndices() ? prim.getIndices().getCount() : prim.getAttribute('POSITION')?.getCount() ?? 0) / 3;

/** Logger that keeps gltf-transform's per-primitive warnings out of the report (counted instead). */
class QuietLogger extends Logger {
  constructor() {
    super(Logger.Verbosity.WARN);
    this.skippedUv = 0;
  }
  warn(text) {
    if (/Skipping TEXCOORD_\d+; out of \[0,1\] range/.test(text)) this.skippedUv++;
    else super.warn(text);
  }
}

// ───────────────────────────────────────────── read

if (!fs.existsSync(RAW)) {
  console.error(`[pack] raw model not found: ${rel(RAW)} (build it first: tools/car/build_car.py)`);
  process.exit(1);
}
if (!fs.existsSync(META)) {
  console.error(`[pack] measurements not found: ${rel(META)} (written by tools/car/build_car.py next to the .glb)`);
  process.exit(1);
}

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(RAW);
const logger = new QuietLogger();
doc.setLogger(logger);
const root = doc.getRoot();
let meta;
try {
  meta = JSON.parse(fs.readFileSync(META, 'utf8'));
} catch (e) {
  console.error(`[pack] ${rel(META)} is not valid JSON: ${e.message}`);
  process.exit(1);
}

// ───────────────────────────────────────────── validate the measurements

const wheelKeys = ['FL', 'FR', 'RL', 'RR'];
const hubOf = {};
if (!Array.isArray(meta.wheels)) fail('meta: "wheels" missing');
else {
  for (const k of wheelKeys) {
    const w = meta.wheels.find((q) => q.key === k);
    if (!w) {
      fail(`meta: wheel ${k} missing`);
      continue;
    }
    if (!isVec3(w.hub)) fail(`meta: wheel ${k} hub is not [x, y, z]`);
    else hubOf[k] = w.hub;
    if (w.front !== k.startsWith('F')) fail(`meta: wheel ${k} has front=${w.front}`);
  }
}
const R = meta.wheelRadius;
if (!(R > 0.2 && R < 0.6)) fail(`meta: wheelRadius ${R} is not a plausible radius in metres`);
for (const k of DIMS) if (!Number.isFinite(meta.dims?.[k]) || meta.dims[k] <= 0) fail(`meta: dims.${k} missing or not positive`);
if (!isVec3(meta.steering?.pivot) || !isVec3(meta.steering?.axis)) fail('meta: steering.pivot / steering.axis missing');
else if (Math.hypot(...meta.steering.axis) < 0.5) fail('meta: steering.axis is not a unit vector');
for (const k of ANCHORS) if (!isVec3(meta.anchors?.[k])) fail(`meta: anchors.${k} missing`);
for (const k of ['MirrorL', 'MirrorR']) if (!isVec3(meta.parts?.[k]?.pivot)) fail(`meta: parts.${k}.pivot missing`);

if (Object.keys(hubOf).length === 4) {
  const H = hubOf;
  if (!(H.FL[0] < 0 && H.RL[0] < 0 && H.FR[0] > 0 && H.RR[0] > 0)) fail('meta: left wheels must be at x < 0, right wheels at x > 0');
  if (!(H.FL[2] < 0 && H.FR[2] < 0 && H.RL[2] > 0 && H.RR[2] > 0)) fail('meta: front wheels must be at z < 0 (the car faces -Z), rear at z > 0');
  for (const k of wheelKeys) if (Math.abs(H[k][1] - R) > TOL_HUB) fail(`meta: hub ${k} height ${H[k][1]} != wheelRadius ${R} (wheels must touch y = 0)`);
  const D = meta.dims ?? {};
  const checks = [
    ['trackFront', H.FR[0] - H.FL[0]],
    ['trackRear', H.RR[0] - H.RL[0]],
    ['frontAxle', -(H.FL[2] + H.FR[2]) / 2],
    ['rearAxle', (H.RL[2] + H.RR[2]) / 2],
    ['wheelBase', (H.RL[2] + H.RR[2]) / 2 - (H.FL[2] + H.FR[2]) / 2],
    ['wheelRadius', R],
  ];
  for (const [k, v] of checks) if (Number.isFinite(D[k]) && Math.abs(D[k] - v) > TOL_DIM) fail(`meta: dims.${k} = ${D[k]} but the hubs give ${v.toFixed(4)}`);
}
for (const k of ANCHORS) {
  const a = meta.anchors?.[k];
  if (!isVec3(a)) continue;
  // (a single centred exhaust may sit at x = 0)
  const centreOk = k.startsWith('exhaust') ? 0 : 1e-9;
  if (k.endsWith('L') && !(a[0] <= -centreOk)) fail(`meta: anchors.${k} must be on the left (x < 0), is ${fmt(a)}`);
  if (k.endsWith('R') && !(a[0] >= centreOk)) fail(`meta: anchors.${k} must be on the right (x > 0), is ${fmt(a)}`);
  if (k.startsWith('headlight') && !(a[2] < 0)) fail(`meta: anchors.${k} must be at the front (z < 0)`);
  if ((k.startsWith('taillight') || k.startsWith('exhaust')) && !(a[2] > 0)) fail(`meta: anchors.${k} must be at the rear (z > 0)`);
}
if (brandIn(meta.source)) fail(`meta: "source" names a brand (${brandIn(meta.source)})`);

// ───────────────────────────────────────────── validate the document

const known = new Set(RUNTIME_MATERIALS);
const blenderMats = blenderMaterialNames();
if (blenderMats) {
  for (const n of blenderMats) if (!known.has(n)) fail(`tools/car/lib/materials.py defines "${n}" but the runtime does not build it (add it to playerCarVisual.ts and to RUNTIME_MATERIALS here)`);
  for (const n of RUNTIME_MATERIALS) if (!blenderMats.includes(n)) warn(`runtime material "${n}" is not in tools/car/lib/materials.py DEFS`);
} else warn('tools/car/lib/materials.py not found: material names checked against the runtime list only');

if (root.listTextures().length) fail(`the file carries ${root.listTextures().length} texture(s): the car must have none (the runtime makes its own)`);
if (root.listSkins().length) fail('the file carries skins: export without skinning (the runtime skins the car itself)');
if (root.listAnimations().length) fail('the file carries animations');
if (root.listCameras().length) warn(`the file carries ${root.listCameras().length} camera(s): dropped`);

const scene = root.getDefaultScene() ?? root.listScenes()[0];
if (!scene) {
  console.error('[pack] the file has no scene');
  process.exit(1);
}
const carRoots = scene.listChildren().filter((n) => n.getName() === 'PlayerCar');
if (carRoots.length !== 1) fail(`expected one root node "PlayerCar" in the scene, found ${carRoots.length} (scene children: ${scene.listChildren().map((n) => n.getName()).join(', ')})`);
const others = scene.listChildren().filter((n) => n.getName() !== 'PlayerCar');
if (others.length) fail(`nodes outside "PlayerCar": ${others.map((n) => n.getName() || '(unnamed)').join(', ')}`);
const carRoot = carRoots[0];

for (const n of root.listNodes()) {
  const b = brandIn(n.getName());
  if (b) fail(`node "${n.getName()}" contains a brand name (${b})`);
  if (n.getCamera()) n.setCamera(null);
}
for (const m of root.listMeshes()) {
  const b = brandIn(m.getName());
  if (b) fail(`mesh "${m.getName()}" contains a brand name (${b})`);
}
for (const m of root.listMaterials()) {
  const b = brandIn(m.getName());
  if (b) fail(`material "${m.getName()}" contains a brand name (${b})`);
}
for (const s of root.listScenes()) if (brandIn(s.getName())) fail(`scene "${s.getName()}" contains a brand name`);

// part nodes
const partNodes = new Map();
for (const n of root.listNodes()) {
  if (!PARTS.includes(n.getName())) continue;
  if (partNodes.has(n.getName())) fail(`part "${n.getName()}" appears more than once`);
  partNodes.set(n.getName(), n);
}
for (const p of PARTS) if (!partNodes.has(p)) fail(`part node "${p}" missing`);
for (const [name, n] of partNodes) {
  let inside = false;
  for (let q = n.getParentNode(); q; q = q.getParentNode()) if (q === carRoot) inside = true;
  if (!inside) fail(`part "${name}" is not under "PlayerCar"`);
}

/** Part a node belongs to: itself or its nearest part ancestor (same walk as the runtime). */
function partOf(n) {
  for (let q = n; q; q = q.getParentNode()) if (PARTS.includes(q.getName())) return q.getName();
  return null;
}

// walk every mesh node: triangles, materials, attributes, bounds per part
const triByPart = Object.fromEntries(PARTS.map((p) => [p, 0]));
const triByMat = new Map();
const boxByPart = Object.fromEntries(PARTS.map((p) => [p, emptyBox()]));
const attrByMat = new Map(); // name -> { prims, uv, color }
const caliperReach = {}; // wheel key -> farthest caliper vertex from the hub axis
let primCount = 0;
const unknownMats = new Set();
const tmp = [0, 0, 0];
for (const n of root.listNodes()) {
  const mesh = n.getMesh();
  if (!mesh) continue;
  const part = partOf(n);
  if (!part) {
    fail(`mesh node "${n.getName() || '(unnamed)'}" is not inside a part (parent it to Body or another part)`);
    continue;
  }
  const W = n.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    primCount++;
    const mat = prim.getMaterial();
    const mname = mat?.getName() ?? '';
    if (!mat) fail(`a primitive of "${n.getName()}" has no material`);
    else if (!known.has(mname)) unknownMats.add(mname);
    if (prim.getMode() !== 4) fail(`a primitive of "${n.getName()}" (${mname}) is not a triangle list (mode ${prim.getMode()})`);
    const P = prim.getAttribute('POSITION');
    if (!P) {
      fail(`a primitive of "${n.getName()}" has no POSITION`);
      continue;
    }
    if (!prim.getAttribute('NORMAL')) fail(`a primitive of "${n.getName()}" (${mname}) has no NORMAL`);
    const t = triCount(prim);
    triByPart[part] += t;
    triByMat.set(mname, (triByMat.get(mname) ?? 0) + t);
    const a = attrByMat.get(mname) ?? { prims: 0, uv: 0, color: 0 };
    a.prims++;
    if (prim.getAttribute('TEXCOORD_0')) a.uv++;
    if (prim.getAttribute('COLOR_0')) a.color++;
    attrByMat.set(mname, a);
    const caliperOf = /^Wheel_(FL|FR|RL|RR)_Caliper$/.exec(part)?.[1];
    for (let i = 0; i < P.getCount(); i++) {
      const p = xfPoint(W, P.getElement(i, tmp));
      growBox(boxByPart[part], p);
      if (caliperOf && hubOf[caliperOf]) {
        const h = hubOf[caliperOf];
        caliperReach[caliperOf] = Math.max(caliperReach[caliperOf] ?? 0, Math.hypot(p[1] - h[1], p[2] - h[2]));
      }
    }
  }
}
for (const m of unknownMats) {
  const hint = /\.\d{3}$/.test(m) ? ' (Blender renamed a duplicate: reuse materials.get(name) instead of creating it twice)' : '';
  fail(`material "${m}" is not a known car material${hint}`);
}
for (const p of PARTS) if (partNodes.has(p) && triByPart[p] === 0) fail(`part "${p}" has no triangles`);

// wheels at their hubs, calipers around them
for (const k of wheelKeys) {
  const hub = hubOf[k];
  const b = boxByPart[`Wheel_${k}_Spin`];
  if (!hub || !Number.isFinite(b.min[0])) continue;
  const c = boxCentre(b);
  if (Math.abs(c[1] - hub[1]) > TOL_HUB || Math.abs(c[2] - hub[2]) > TOL_HUB)
    fail(`Wheel_${k}_Spin is centred at ${fmt(c)}, hub is ${fmt(hub)} (y / z must agree within ${TOL_HUB * 1000} mm)`);
  if (Math.abs(c[0] - hub[0]) > 0.12) fail(`Wheel_${k}_Spin is centred at x ${c[0].toFixed(3)}, hub x is ${hub[0]}`);
  const rLow = hub[1] - b.min[1], rHigh = b.max[1] - hub[1];
  if (Math.abs(rLow - R) > TOL_HUB || Math.abs(rHigh - R) > TOL_HUB)
    fail(`Wheel_${k}_Spin radius ${rLow.toFixed(3)} / ${rHigh.toFixed(3)} m does not match wheelRadius ${R}`);
  const far = caliperReach[k];
  if (far !== undefined && far > R) fail(`Wheel_${k}_Caliper reaches ${far.toFixed(3)} m from the hub axis (outside the tyre)`);
}
// pivots
if (isVec3(meta.steering?.pivot) && Number.isFinite(boxByPart.Steering.min[0]) && !inBox(boxByPart.Steering, meta.steering.pivot, 0.03))
  fail(`steering.pivot ${fmt(meta.steering.pivot)} is not on the Steering part (box ${fmt(boxByPart.Steering.min)} .. ${fmt(boxByPart.Steering.max)})`);
for (const k of ['MirrorL', 'MirrorR']) {
  const p = meta.parts?.[k]?.pivot;
  if (isVec3(p) && Number.isFinite(boxByPart[k].min[0]) && !inBox(boxByPart[k], p, 0.1)) fail(`parts.${k}.pivot ${fmt(p)} is not on the ${k} part`);
}
// body sanity
{
  const b = boxByPart.Body;
  if (Number.isFinite(b.min[0])) {
    if (b.min[1] < -0.02) fail(`Body reaches below the road (y = ${b.min[1].toFixed(3)})`);
    const len = b.max[2] - b.min[2];
    if (Number.isFinite(meta.dims?.length) && Math.abs(len - meta.dims.length) > 0.05) warn(`Body is ${len.toFixed(3)} m long, dims.length says ${meta.dims.length}`);
  }
}
// triangle counts against the Blender side
if (meta.triangles) {
  for (const p of PARTS) if (Number.isFinite(meta.triangles[p]) && meta.triangles[p] !== triByPart[p]) warn(`triangles of ${p}: file ${triByPart[p]}, meta ${meta.triangles[p]}`);
}
// attributes
for (const [m, a] of attrByMat) {
  if (a.uv < a.prims) warn(`${m}: ${a.prims - a.uv} of ${a.prims} primitive(s) without TEXCOORD_0 (the runtime box-projects them)`);
  if (a.color > 0 && a.color < a.prims) warn(`${m}: COLOR_0 on ${a.color} of ${a.prims} primitive(s) only: dropped (the runtime needs it on all of them)`);
}

// ───────────────────────────────────────────── stop on a broken contract

const triTotal = PARTS.reduce((a, p) => a + triByPart[p], 0);
function printWarnings() {
  if (logger.skippedUv) warnings.push(`TEXCOORD_0 of ${logger.skippedUv} primitive(s) kept as float (UVs are in metres, outside [0,1])`);
  for (const w of warnings) console.log(`[pack] warning: ${w}`);
}
if (errors.length) {
  printWarnings();
  console.error(`\n[pack] ${rel(RAW)}: contract broken, ${errors.length} error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('[pack] nothing written.');
  process.exit(1);
}

// ───────────────────────────────────────────── clean up attributes the runtime does not read

let dropped = 0;
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const mname = prim.getMaterial().getName();
    const a = attrByMat.get(mname);
    for (const sem of prim.listSemantics()) {
      const drop =
        sem === 'TANGENT' ||
        /^TEXCOORD_[1-9]/.test(sem) ||
        /^COLOR_[1-9]/.test(sem) ||
        /^(JOINTS|WEIGHTS)_/.test(sem) ||
        sem.startsWith('_') ||
        (sem === 'COLOR_0' && a && a.color < a.prims);
      if (drop) {
        prim.setAttribute(sem, null);
        dropped++;
      }
    }
  }
}

// ───────────────────────────────────────────── metadata

const extrasValue = { ...meta, packedBy: 'tools/car/pack.mjs' };
carRoot.setExtras({ ...carRoot.getExtras(), nightshift: extrasValue });
scene.setExtras({ ...scene.getExtras(), nightshift: extrasValue });
if (!scene.getName()) scene.setName('PlayerCar');

// ───────────────────────────────────────────── report (before writing)

const matsUsed = [...triByMat.keys()].sort((a, b) => triByMat.get(b) - triByMat.get(a));
console.log(`[pack] ${rel(RAW)} + ${rel(META)}: contract OK`);
console.log('\n[pack] triangles per part');
for (const p of PARTS) console.log(`  ${p.padEnd(18)} ${String(triByPart[p]).padStart(8)}`);
console.log(`  ${'total'.padEnd(18)} ${String(triTotal).padStart(8)}`);
console.log('\n[pack] triangles per material (one draw call each after the runtime merge)');
for (const m of matsUsed) {
  const a = attrByMat.get(m);
  const flags = [a.uv === a.prims ? 'uv' : a.uv ? 'uv(part)' : 'no-uv', a.color === a.prims ? 'ao' : ''].filter(Boolean).join(' ');
  console.log(`  ${m.padEnd(18)} ${String(triByMat.get(m)).padStart(8)}   ${flags}`);
}
console.log(`\n[pack] draw calls: ${matsUsed.length} with the runtime's per-material skinned merge (${primCount} primitives as plain nodes)`);
const transparent = matsUsed.filter((m) => m === 'glass' || m === 'lens');
if (transparent.length) console.log(`[pack] transparent (drawn after opaque): ${transparent.join(', ')}`);
if (dropped) console.log(`[pack] dropped ${dropped} unused vertex attribute(s)`);

if (CHECK_ONLY) {
  printWarnings();
  console.log('[pack] --check: nothing written.');
  process.exit(0);
}

// ───────────────────────────────────────────── optimise + compress + write

// keepUniqueNames: headlight_L / headlight_R are identical by value but must stay separate (per-side damage flicker).
// keepAttributes: no material has a texture, so prune would otherwise drop TEXCOORD_0 (the runtime's maps use it).
await doc.transform(dedup({ keepUniqueNames: true }), prune({ keepAttributes: true }));
await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 16, quantizeNormal: 12, quantizeTexcoord: 14, quantizeColor: 8 }));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
await io.write(OUT, doc);

// ───────────────────────────────────────────── read back and verify

const back = await io.read(OUT);
const bRoot = back.getRoot();
const bScene = bRoot.getDefaultScene() ?? bRoot.listScenes()[0];
const post = [];
if (!bScene?.getExtras()?.nightshift) post.push('scene extras "nightshift" missing');
const bCar = bScene?.listChildren().find((n) => n.getName() === 'PlayerCar');
if (!bCar?.getExtras()?.nightshift) post.push('root node extras "nightshift" missing');
const bNames = new Set(bRoot.listNodes().map((n) => n.getName()));
for (const p of PARTS) if (!bNames.has(p)) post.push(`part "${p}" lost`);
const bMats = new Set(bRoot.listMaterials().map((m) => m.getName()));
for (const m of matsUsed) if (!bMats.has(m)) post.push(`material "${m}" lost`);
let bTris = 0;
const bAttr = new Map();
for (const n of bRoot.listNodes()) {
  for (const prim of n.getMesh()?.listPrimitives() ?? []) {
    bTris += triCount(prim);
    const a = bAttr.get(prim.getMaterial().getName()) ?? { uv: 0, color: 0 };
    if (prim.getAttribute('TEXCOORD_0')) a.uv++;
    if (prim.getAttribute('COLOR_0')) a.color++;
    bAttr.set(prim.getMaterial().getName(), a);
  }
}
if (bTris !== triTotal) post.push(`triangles ${bTris} after packing, ${triTotal} before`);
for (const [m, a] of attrByMat) {
  const b = bAttr.get(m) ?? { uv: 0, color: 0 };
  if (b.uv < a.uv) post.push(`${m}: TEXCOORD_0 lost (${a.uv} primitive(s) before, ${b.uv} after)`);
  if (a.color === a.prims && b.color < a.color) post.push(`${m}: COLOR_0 lost`);
}
if (bRoot.listTextures().length) post.push('textures appeared');
if (post.length) {
  console.error(`\n[pack] ${rel(OUT)} failed the read-back check:`);
  for (const e of post) console.error(`  - ${e}`);
  process.exit(1);
}

printWarnings();
const rawSize = fs.statSync(RAW).size, outSize = fs.statSync(OUT).size;
console.log(`\n[pack] extensions: ${bRoot.listExtensionsUsed().map((e) => e.extensionName).join(', ')}`);
console.log(`[pack] wrote ${rel(OUT)}: ${(outSize / 1024).toFixed(1)} KB (raw ${(rawSize / 1024).toFixed(1)} KB), ${bTris} triangles, read-back OK`);
