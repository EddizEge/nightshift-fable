/**
 * Roadside furniture sandbox (kit-based). Extra URL params on top of the kit's:
 *   nofurn=1            do not register the furniture features (baseline cost)
 *   only=<a,b>          register only these features (barriers, lamps, gantry, small)
 *   find=<zone>         log the first chunk s of that zone (e.g. find=rural)
 */
import type { Mesh } from 'three';
import { createKit } from './kit';
import { furnitureFeatures } from '../world/features/furniture';
import type { ZoneType } from '../core/types';

const kit = createKit();
const p = kit.params;
const timing = new Map<string, { n: number; total: number; max: number; all: number[] }>();
const bake = new Map<string, number>();
if (p.get('nofurn') !== '1') {
  const only = p.get('only')?.split(',');
  for (const f of furnitureFeatures) {
    if (only && !only.some((o) => f.name.endsWith(o))) continue;
    kit.world.addFeature(f.name, (b) => {
      // Split: time inside the kit's addBent/addInstances (bending + baking) vs our own geometry work.
      const ab = b.addBent.bind(b);
      const ai = b.addInstances.bind(b);
      let inner = 0;
      (b as { addBent: typeof ab }).addBent = (...a) => {
        const t = performance.now();
        const r = ab(...a);
        inner += performance.now() - t;
        return r;
      };
      (b as { addInstances: typeof ai }).addInstances = (...a) => {
        const t = performance.now();
        const r = ai(...a);
        inner += performance.now() - t;
        return r;
      };
      const t0 = performance.now();
      f.build(b);
      const dt = performance.now() - t0;
      bake.set(f.name, (bake.get(f.name) ?? 0) + inner);
      const t = timing.get(f.name) ?? { n: 0, total: 0, max: 0, all: [] };
      t.all.push(dt);
      t.n++;
      t.total += dt;
      t.max = Math.max(t.max, dt);
      timing.set(f.name, t);
    });
  }
}
if (p.has('find')) {
  const z = p.get('find') as ZoneType;
  for (let s = 0; s < 60000; s += 220) {
    if (kit.world.zoneAt(s) === z) {
      console.log(`[ns] first ${z} chunk at s=${s}`);
      break;
    }
  }
}
await kit.start();
const iv = setInterval(() => {
  if (!(window as unknown as { __ready?: boolean }).__ready) return;
  clearInterval(iv);
  const parts: string[] = [];
  for (const [k, t] of timing) {
    const med = [...t.all].sort((a, b) => a - b)[t.all.length >> 1];
    parts.push(`${k.replace('furniture-', '')} n=${t.n} med=${med.toFixed(2)} last=${t.all.slice(-4).map((x) => x.toFixed(1)).join(',')} avg=${(t.total / t.n).toFixed(2)} (bend/bake ${((bake.get(k) ?? 0) / t.n).toFixed(2)}) max=${t.max.toFixed(2)}ms`);
  }
  console.log(`[ns] furniture build: ${parts.join(' | ')}`);
  // Per-chunk furniture meshes / triangles.
  const per = new Map<string, { calls: number; tris: number }>();
  kit.world.group.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || !m.name.startsWith('furn')) return;
    const chunk = m.parent?.name ?? '?';
    const g = m.geometry;
    const tri = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    const inst = (m as unknown as { count?: number; isInstancedMesh?: boolean }).isInstancedMesh ? (m as unknown as { count: number }).count : 1;
    const e = per.get(chunk) ?? { calls: 0, tris: 0 };
    e.calls++;
    e.tris += tri * inst;
    per.set(chunk, e);
  });
  const rows = [...per].map(([c, e]) => `${c}:${e.calls}/${Math.round(e.tris / 1000)}k`);
  console.log(`[ns] furniture per chunk (calls/tris): ${rows.join(' ')}`);
}, 100);

// Warm benchmark: rebuild chunk furniture with the real ChunkBuilder (window.__furnBench(rounds)).
import { Chunk, ChunkBuilder } from '../world/chunkBuilder';
(window as unknown as { __furnBench: (n: number) => string }).__furnBench = (rounds: number) => {
  const res: Record<string, number[]> = {};
  const idx = [0, 1, 2, 6, 7, 8, 9, 13, 14, 16];
  for (let r = 0; r < rounds; r++) {
    for (const i of idx) {
      const spec = kit.world.chunkAt(i * 220 + 1);
      const chunk = new Chunk(spec);
      for (const f of furnitureFeatures) {
        const b = new ChunkBuilder(chunk, kit.ctx.road, kit.ctx.quality.settings, kit.lighting, kit.mats, 7);
        const t0 = performance.now();
        f.build(b);
        (res[f.name] ??= []).push(performance.now() - t0);
      }
      chunk.dispose();
    }
  }
  const out = Object.entries(res).map(([k, v]) => {
    v.sort((a, b) => a - b);
    const sum = v.reduce((a, b) => a + b, 0);
    return `${k.replace('furniture-', '')} med=${v[v.length >> 1].toFixed(2)} p90=${v[Math.floor(v.length * 0.9)].toFixed(2)} mean=${(sum / v.length).toFixed(2)}`;
  });
  return out.join(' | ');
};
