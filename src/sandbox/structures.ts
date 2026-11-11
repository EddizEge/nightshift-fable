/**
 * Structures sandbox (overpass, tunnel, bridge, noise walls) on the kit.
 *   sandbox/structures.html?s=700&cam=chase      (kit params, see src/sandbox/kit.ts)
 *   &nost=1      skip the structures features (cost baseline)
 *   &only=name   only the feature whose name contains `name`
 *   &bench=1     after start, rebuild chunks -4..22 three times per feature (warm JIT) and log
 *                per-chunk build ms / draw calls / triangles of the structures features
 * Logs "[ns] structures <feature> chunks=… totalMs=… maxMs=…" after the initial build.
 */
import { createKit } from './kit';
import { structureFeatures } from '../world/features/structures';
import { structureMaterials } from '../world/features/structures/materials';
import { Chunk, ChunkBuilder } from '../world/chunkBuilder';
import { geoTiming } from '../world/features/structures/geom';
import type { Mesh } from 'three';

const kit = createKit();
const p = kit.params;
// Warm the shared materials / canvas atlas outside the per-chunk timings.
structureMaterials(kit.mats);
const timing = new Map<string, { n: number; total: number; max: number }>();
if (p.get('nost') !== '1') {
  const only = p.get('only');
  for (const f of structureFeatures) {
    if (only && !f.name.includes(only)) continue;
    const t = { n: 0, total: 0, max: 0 };
    timing.set(f.name, t);
    kit.world.addFeature(f.name, (b) => {
      const t0 = performance.now();
      f.build(b);
      const ms = performance.now() - t0;
      t.n++;
      t.total += ms;
      t.max = Math.max(t.max, ms);
    });
  }
}
let logged = false;
kit.onFrame(() => {
  if (logged) return;
  logged = true;
  for (const [name, t] of timing) console.log(`[ns] structures ${name} chunks=${t.n} totalMs=${t.total.toFixed(1)} maxMs=${t.max.toFixed(2)}`);
});
await kit.start();

if (p.get('bench') === '1') {
  const world = kit.world as unknown as { chunkAt(s: number): import('../core/types').ChunkSpec };
  const lines: string[] = [];
  for (let i = -4; i <= 22; i++) {
    const spec = world.chunkAt(i * 220 + 1);
    let ms = 0;
    let per = '';
    let calls = 0;
    let tris = 0;
    for (let rep = 0; rep < 3; rep++) {
      const chunk = new Chunk(spec);
      ms = 0;
      per = '';
      for (let f = 0; f < structureFeatures.length; f++) {
        const b = new ChunkBuilder(chunk, kit.ctx.road, kit.ctx.quality.settings, kit.lighting, kit.mats, 101 + f * 977);
        geoTiming.bentMs = 0;
        geoTiming.verts = 0;
        const t0 = performance.now();
        structureFeatures[f].build(b);
        const dt = performance.now() - t0;
        ms += dt;
        if (dt > 0.3) per += `${structureFeatures[f].name.replace('structures-', '')}=${dt.toFixed(1)}/bent${geoTiming.bentMs.toFixed(1)}/v${geoTiming.verts} `;
      }
      calls = 0;
      tris = 0;
      chunk.group.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        calls++;
        const g = m.geometry;
        const n = g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
        tris += n * ((o as unknown as { count?: number }).count ?? 1);
      });
      chunk.dispose();
    }
    if (calls) lines.push(`${i}:${spec.zone}${spec.overpassS !== null ? '+op' : ''} ${ms.toFixed(1)}ms (${per.trim()}) calls=${calls} tris=${tris}`);
  }
  console.log('[ns] bench ' + lines.join(' | '));
}
