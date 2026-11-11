// Prints nodes / meshes / materials / triangle counts of a GLB (dev helper).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
let total = 0;
for (const mesh of root.listMeshes()) {
  let t = 0;
  const mats = [];
  for (const p of mesh.listPrimitives()) {
    const idx = p.getIndices();
    const n = idx ? idx.getCount() / 3 : p.getAttribute('POSITION').getCount() / 3;
    t += n;
    mats.push(`${p.getMaterial()?.getName() ?? '-'}:${n}`);
  }
  total += t;
  console.log(`mesh ${mesh.getName()} tris=${t} [${mats.join(', ')}]`);
}
console.log('nodes:', root.listNodes().map((n) => `${n.getName()}${n.getMesh() ? '*' : ''}`).join(' | '));
console.log('materials:', root.listMaterials().map((m) => m.getName()).join(', '));
console.log('textures:', root.listTextures().map((t) => `${t.getName() || t.getURI()} ${t.getSize()?.join('x')}`).join(', '));
console.log('TOTAL tris', total);
