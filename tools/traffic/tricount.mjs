// Per-material triangle counts of the Blender exports: node tools/traffic/tricount.mjs [type...]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const types = process.argv.slice(2);
for (const t of types.length ? types : ['sedan', 'hatch', 'suv', 'sports', 'van', 'boxtruck', 'semi', 'tanker']) {
  const doc = await io.read(`assets-src/traffic/out/${t}.glb`);
  const by = {};
  let tot = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    const n = (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
    const k = (p.getMaterial()?.getName() ?? '?').split('~')[0];
    by[k] = (by[k] ?? 0) + n; tot += n;
  }
  const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`${t} ${tot} | ${top}`);
}
