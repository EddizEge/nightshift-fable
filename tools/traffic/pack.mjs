// NIGHTSHIFT traffic: merge the Blender exports (assets-src/traffic/out/<type>.glb, one primitive per
// surface-class material) into ONE glb with one primitive per vehicle type:
//   POSITION, NORMAL, COLOR_0 (albedo x baked AO x road grime; paint classes carry AO only),
//   _SURF (u8 vec4: class id, roughness*255, metalness*255, 255).
// Usage: node tools/traffic/pack.mjs [inDir] [outFile]
import fs from 'node:fs';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const inDir = process.argv[2] ?? 'assets-src/traffic/out';
const outFile = process.argv[3] ?? 'public/assets/models/traffic/traffic.glb';
const TYPES = ['sedan', 'hatch', 'suv', 'van', 'boxtruck', 'semi', 'tanker', 'sports'];

// Surface classes (keep in sync with src/traffic/vehicleFactory.ts)
const CLS = { other: 0, paint: 1, paint2: 2, head: 3, tail: 4, brake: 5, indL: 6, indR: 7, markerA: 8, markerR: 9, markerW: 10, retro: 11, glass: 12, drl: 13, lens: 14 };
function classOf(name) {
  const n = name.split('~')[0];
  if (n.startsWith('paint2.')) return CLS.paint2;
  if (n.startsWith('paint.')) return CLS.paint;
  if (n === 'head.lamp') return CLS.head;
  if (n === 'tail.lamp') return CLS.tail;
  if (n === 'brake.lamp') return CLS.brake;
  if (n === 'ind.lamp') return CLS.indR; // split by side below
  if (n === 'markerA.lamp') return CLS.markerA;
  if (n === 'markerR.lamp') return CLS.markerR;
  if (n === 'markerW.lamp') return CLS.markerW;
  if (n.startsWith('retro.') || n === 'plate.white') return CLS.retro;
  if (n.startsWith('glass.')) return CLS.glass;
  if (n === 'drl.lamp') return CLS.drl;
  if (n === 'lens.red') return CLS.lens;
  return CLS.other;
}
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Triangle budgets (LOD0) and the distance LOD (LOD1, used beyond ~120 m by the factory).
const TRUCKS = new Set(['boxtruck', 'semi', 'tanker']);
const BUDGET = (t) => (TRUCKS.has(t) ? 12500 : 8000);
const LOD1_BUDGET = (t) => (TRUCKS.has(t) ? 3200 : 2400);
/**
 * Attribute-aware meshopt simplification of one vehicle (all surface classes in one index buffer: class
 * boundaries are attribute seams, so they stay watertight). Returns compacted arrays.
 * lockFn(cls) locks vertices of that class (lamps keep their shape on the distance LOD).
 */
function simplifyVehicle(src, targetTris, maxErr, lockFn = null, flags = []) {
  const n = src.pos.length / 3;
  const P = new Float32Array(src.pos);
  const A = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    A[i * 4] = src.nor[i * 3];
    A[i * 4 + 1] = src.nor[i * 3 + 1];
    A[i * 4 + 2] = src.nor[i * 3 + 2];
    A[i * 4 + 3] = src.col[i * 3] / 255;
  }
  let lock = null;
  if (lockFn) {
    lock = new Uint8Array(n);
    for (let i = 0; i < n; i++) lock[i] = lockFn(src.surf[i * 4]) ? 1 : 0;
  }
  const I = new Uint32Array(src.idx);
  let [out, err] = I.length / 3 <= targetTris ? [I, 0] : MeshoptSimplifier.simplifyWithAttributes(I, P, 3, A, 4, [0.02, 0.02, 0.02, 0.012], lock, targetTris * 3, maxErr, ['ErrorAbsolute', ...flags]);
  const remap = new Int32Array(n).fill(-1);
  const r = { pos: [], nor: [], col: [], surf: [], idx: [], err };
  let k = 0;
  for (const v of out) {
    if (remap[v] < 0) {
      remap[v] = k++;
      r.pos.push(src.pos[v * 3], src.pos[v * 3 + 1], src.pos[v * 3 + 2]);
      r.nor.push(src.nor[v * 3], src.nor[v * 3 + 1], src.nor[v * 3 + 2]);
      r.col.push(src.col[v * 3], src.col[v * 3 + 1], src.col[v * 3 + 2]);
      r.surf.push(src.surf[v * 4], src.surf[v * 4 + 1], src.surf[v * 4 + 2], src.surf[v * 4 + 3]);
    }
    r.idx.push(remap[v]);
  }
  return r;
}
function makePrim(g) {
  const nv = g.pos.length / 3;
  return out.createPrimitive()
    .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(new Float32Array(g.pos)).setBuffer(buffer))
    .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(new Float32Array(g.nor)).setBuffer(buffer))
    .setAttribute('COLOR_0', out.createAccessor().setType('VEC3').setArray(new Uint8Array(g.col)).setNormalized(true).setBuffer(buffer))
    .setAttribute('_SURF', out.createAccessor().setType('VEC4').setArray(new Uint8Array(g.surf)).setBuffer(buffer))
    .setIndices(out.createAccessor().setType('SCALAR').setArray(nv > 65535 ? new Uint32Array(g.idx) : new Uint16Array(g.idx)).setBuffer(buffer))
    .setMaterial(material);
}
const LAMP_CLASSES = new Set([CLS.head, CLS.tail, CLS.brake, CLS.indL, CLS.indR, CLS.drl, CLS.markerA, CLS.markerR]);
/**
 * Distance LOD only: grow every lamp element (connected lamp-class triangles) about its centre and push it
 * slightly out along its normal, so tail / head lamps stay 2-4 px wide at 150 m and pixel ratio 0.7
 * instead of flickering sub-pixel quads (real lamps bloom to that size at night anyway).
 */
function enlargeLamps(g) {
  const nv = g.pos.length / 3;
  const parent = new Int32Array(nv).map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const isLamp = (v) => LAMP_CLASSES.has(g.surf[v * 4]);
  const byPos = new Map();
  for (let v = 0; v < nv; v++) {
    if (!isLamp(v)) continue;
    const key = `${Math.round(g.pos[v * 3] * 500)},${Math.round(g.pos[v * 3 + 1] * 500)},${Math.round(g.pos[v * 3 + 2] * 500)}`;
    const o = byPos.get(key);
    if (o === undefined) byPos.set(key, v); else unite(v, o);
  }
  for (let t = 0; t < g.idx.length; t += 3) {
    const [a, b, c] = [g.idx[t], g.idx[t + 1], g.idx[t + 2]];
    if (isLamp(a) && isLamp(b)) unite(a, b);
    if (isLamp(b) && isLamp(c)) unite(b, c);
  }
  const acc = new Map();
  for (let v = 0; v < nv; v++) {
    if (!isLamp(v)) continue;
    const r = find(v);
    let a = acc.get(r);
    if (!a) acc.set(r, (a = [0, 0, 0, 0, 0, 0, 0, g.surf[v * 4]]));
    for (let k = 0; k < 3; k++) { a[k] += g.pos[v * 3 + k]; a[3 + k] += g.nor[v * 3 + k]; }
    a[6]++;
  }
  for (let v = 0; v < nv; v++) {
    if (!isLamp(v)) continue;
    const a = acc.get(find(v));
    const cls = a[7];
    const kk = cls === CLS.markerA || cls === CLS.markerR ? 1.6 : 2.3;
    const nl = Math.hypot(a[3], a[4], a[5]) || 1;
    for (let k = 0; k < 3; k++) {
      const c = a[k] / a[6];
      g.pos[v * 3 + k] = c + (g.pos[v * 3 + k] - c) * kk + (a[3 + k] / nl) * 0.035;
    }
  }
  return g;
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
io.registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const out = new Document();
const buffer = out.createBuffer();
const scene = out.createScene('traffic');
const material = out.createMaterial('traffic');
const report = [];

for (const type of TYPES) {
  const file = path.join(inDir, `${type}.glb`);
  if (!fs.existsSync(file)) continue;
  const doc = await io.read(file);
  const pos = [], nor = [], col = [], surf = [], idx = [];
  let base = 0;
  let maxY = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const P = prim.getAttribute('POSITION');
      for (let i = 0; i < P.getCount(); i++) maxY = Math.max(maxY, P.getElement(i, [0, 0, 0])[1]);
    }
  }
  const grimeTop = Math.min(1.2, maxY * 0.5);
  const lamps = { tail: [0, 0, 0], head: [0, 0, 0] };
  const jsonFile = path.join(inDir, `${type}.json`);
  const dims = fs.existsSync(jsonFile) ? JSON.parse(fs.readFileSync(jsonFile, 'utf8')).dims : {};
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      const name = mat?.getName() ?? 'trim.black';
      const cls0 = classOf(name);
      const bc = mat ? mat.getBaseColorFactor() : [0.02, 0.02, 0.02, 1];
      const rough = mat ? mat.getRoughnessFactor() : 0.6;
      const metal = mat ? mat.getMetallicFactor() : 0;
      const P = prim.getAttribute('POSITION');
      const N = prim.getAttribute('NORMAL');
      const A = prim.getAttribute('COLOR_0');
      const n = P.getCount();
      const p = [0, 0, 0], q = [0, 0, 0], c = [1, 1, 1, 1];
      const isPaint = cls0 === CLS.paint || cls0 === CLS.paint2;
      const lit = cls0 >= CLS.head && cls0 !== CLS.retro && cls0 !== CLS.glass;
      for (let i = 0; i < n; i++) {
        P.getElement(i, p);
        N.getElement(i, q);
        if (A) A.getElement(i, c);
        else c[0] = c[1] = c[2] = 1;
        const ao = c[0];
        const grime = lit || cls0 === CLS.glass ? 1 : 0.7 + 0.3 * smooth(0.12, grimeTop, p[1]);
        const k = ao * grime;
        const alb = isPaint ? [k, k, k] : [bc[0] * k, bc[1] * k, bc[2] * k];
        pos.push(p[0], p[1], p[2]);
        nor.push(q[0], q[1], q[2]);
        for (const v of alb) col.push(Math.round(Math.min(1, Math.max(0, Math.pow(v, 1 / 2.2))) * 255)); // sRGB-encoded u8
        let cls = cls0;
        if (cls === CLS.indR && p[0] < 0) cls = CLS.indL;
        if ((cls === CLS.tail || cls === CLS.head) && p[0] > 0) {
          const L = cls === CLS.tail ? lamps.tail : lamps.head;
          L[0] += p[1]; L[1] += p[0]; L[2]++;
        }
        surf.push(cls, Math.round(rough * 255), Math.round(metal * 255), 255);
      }
      const I = prim.getIndices();
      if (I) for (let i = 0; i < I.getCount(); i++) idx.push(I.getScalar(i) + base);
      else for (let i = 0; i < n; i++) idx.push(base + i);
      base += n;
    }
  }
  const full = { pos, nor, col, surf, idx };
  const lod0 = simplifyVehicle(full, BUDGET(type), 0.03);
  const lod1 = enlargeLamps(simplifyVehicle(lod0, LOD1_BUDGET(type), 0.25, (c) => LAMP_CLASSES.has(c), ['Prune']));
  const mesh = out.createMesh(type).addPrimitive(makePrim(lod0));
  const mesh1 = out.createMesh(`${type}_lod1`).addPrimitive(makePrim(lod1));
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const extras = { ...dims, tailY: r3(lamps.tail[0] / Math.max(1, lamps.tail[2])), tailX: r3(lamps.tail[1] / Math.max(1, lamps.tail[2])), headY: r3(lamps.head[0] / Math.max(1, lamps.head[2])), headX: r3(lamps.head[1] / Math.max(1, lamps.head[2])) };
  scene.addChild(out.createNode(type).setMesh(mesh).setExtras(extras));
  scene.addChild(out.createNode(`${type}_lod1`).setMesh(mesh1));
  report.push(`${type}: src=${idx.length / 3} lod0=${lod0.idx.length / 3} (err ${lod0.err.toFixed(4)} m) lod1=${lod1.idx.length / 3} (err ${lod1.err.toFixed(3)} m) ${JSON.stringify(extras)}`);
}

await out.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
await io.write(outFile, out);
console.log(report.join('\n'));
console.log(`wrote ${outFile} ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB`);
