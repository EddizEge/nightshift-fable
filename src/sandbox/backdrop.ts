/**
 * Backdrop sandbox (sky dome, far skyline, mid-field per-chunk content) on the kit.
 * Extra params:  bd=0   disable the backdrop (baseline cost)
 *                flash=1 hold a lightning flash at its peak (for screenshots)
 * window.__flash(hold?) triggers a lightning flash.
 */
import type { InstancedMesh } from 'three';
import { createKit } from './kit';
import { backdropFeatures, createBackdrop } from '../world/backdrop/index';

const kit = createKit();
const on = kit.params.get('bd') !== '0';
if (on) {
  // Instrumented registration: per-feature build time, meshes and triangles per chunk.
  const stat = new Map<string, { ms: number; max: number; n: number; calls: number; tris: number; maxCalls: number; maxTris: number }>();
  const perChunk = new Map<number, { calls: number; tris: number }>();
  for (const f of backdropFeatures) {
    kit.world.addFeature(f.name, (b) => {
      const before = b.group.children.length;
      const t0 = performance.now();
      f.build(b);
      const ms = performance.now() - t0;
      let calls = 0;
      let tris = 0;
      for (let i = before; i < b.group.children.length; i++) {
        const m = b.group.children[i] as InstancedMesh;
        const g = m.geometry;
        if (!g) continue;
        calls++;
        const n = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
        tris += n * (m.isInstancedMesh ? m.count : 1);
      }
      const st = stat.get(f.name) ?? { ms: 0, max: 0, n: 0, calls: 0, tris: 0, maxCalls: 0, maxTris: 0 };
      st.ms += ms;
      st.max = Math.max(st.max, ms);
      st.n++;
      stat.set(f.name, st);
      const pc = perChunk.get(b.spec.index) ?? { calls: 0, tris: 0 };
      pc.calls += calls;
      pc.tris += tris;
      perChunk.set(b.spec.index, pc);
    });
  }
  const report = () => {
    for (const [k, v] of stat) console.log(`[ns] bd ${k}: chunks=${v.n} avg=${(v.ms / v.n).toFixed(2)}ms max=${v.max.toFixed(2)}ms`);
    let mc = 0;
    let mt = 0;
    for (const v of perChunk.values()) {
      mc = Math.max(mc, v.calls);
      mt = Math.max(mt, v.tris);
    }
    console.log(`[ns] bd per-chunk max calls=${mc} tris=${Math.round(mt)} chunks=${perChunk.size} ` + [...perChunk].map(([i, v]) => `${i}:${v.calls}/${Math.round(v.tris / 1000)}k`).join(' '));
  };
  (window as unknown as { __bdReport: () => void }).__bdReport = report;
  const wait = () => ((window as unknown as { __ready?: boolean }).__ready ? report() : setTimeout(wait, 100));
  setTimeout(wait, 100);
  const bd = createBackdrop(kit.ctx);
  kit.onFrame((dt, t) => bd.update(dt, t));
  kit.ctx.events.on('lightning', (e) => console.log(`[ns] lightning intensity=${e.intensity.toFixed(2)}`));
  (window as unknown as { __flash: (hold?: boolean) => void }).__flash = (hold?: boolean) => bd.flash(1, hold);
  if (kit.params.get('flash') === '1') bd.flash(1, true);
}
await kit.start();
