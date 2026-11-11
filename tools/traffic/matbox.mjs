// Dev helper: per-material bounding boxes of a Blender export.
import { NodeIO } from '@gltf-transform/core';
const doc = await new NodeIO().read(process.argv[2]);
for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
  const a = p.getAttribute('POSITION'); const mn=[1e9,1e9,1e9], mx=[-1e9,-1e9,-1e9], v=[0,0,0];
  for (let i=0;i<a.getCount();i++){a.getElement(i,v);for(let k=0;k<3;k++){mn[k]=Math.min(mn[k],v[k]);mx[k]=Math.max(mx[k],v[k]);}}
  const n = p.getIndices().getCount()/3;
  console.log(p.getMaterial().getName().padEnd(14), String(n).padStart(5), mn.map(x=>x.toFixed(2)).join(','), ' .. ', mx.map(x=>x.toFixed(2)).join(','));
}
