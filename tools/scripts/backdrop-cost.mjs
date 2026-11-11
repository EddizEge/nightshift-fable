/**
 * backdrop cost in the real game: at each stop compare renderer calls / triangles with and without the
 * backdrop meshes (names starting with "bd") — no traffic.  --stops <s,...>
 */
export default async ({ page, sleep, log, args }) => {
  const stops = String(args.stops || '700,1500,2300,3000,3700,4400').split(',').map(Number);
  const rural = await page.evaluate(() => {
    const w = window.__NS.world;
    for (let s = 5000; s <= 12000; s += 55) if (w.zoneAt(s) === 'rural' && w.zoneAt(s + 300) === 'rural') return s + 150;
    return null;
  });
  if (rural !== null) stops.push(rural);
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
  await page.evaluate(() => { const NS = window.__NS; NS.autopilot(true); NS.game.autopilot.cruise = 0.1; });
  const avg = async () => {
    let c = 0, t = 0;
    for (let i = 0; i < 6; i++) {
      await sleep(120);
      const st = await page.evaluate(() => window.__NS.stats());
      c += st.calls; t += st.triangles;
    }
    return [c / 6, t / 6];
  };
  for (const s of stops) {
    await page.evaluate(([s]) => { const NS = window.__NS; NS.teleport(s, 1.85, 0.1); NS.ctx.traffic?.setDensity(0); }, [s]);
    await sleep(2500);
    const zone = await page.evaluate(() => window.__NS.stats().zone);
    const [c1, t1] = await avg();
    await page.evaluate(() => {
      const hidden = [];
      window.__NS.engine.scene.traverse((o) => { if (/^bd/.test(o.name || '')) { hidden.push([o, o.layers.mask]); o.layers.disableAll(); } });
      window.__bdHidden = hidden;
    });
    const [c0, t0] = await avg();
    await page.evaluate(() => { for (const [o, m] of window.__bdHidden) o.layers.mask = m; });
    if (args.detail) {
      const rows = await page.evaluate(async () => {
        const { Frustum, Matrix4, Sphere } = await import('/node_modules/.vite/deps/three.js').catch(() => ({}));
        const NS = window.__NS;
        const cam = NS.engine.camera;
        const agg = {};
        let fr = null;
        if (Frustum) { fr = new Frustum(); fr.setFromProjectionMatrix(new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)); }
        NS.engine.scene.traverse((o) => {
          if (!o.isMesh || !o.visible || !/^bd/.test(o.name || '')) return;
          if (fr && o.geometry) {
            if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
            if (o.isInstancedMesh && o.boundingSphere === null) o.computeBoundingSphere();
            const sp = (o.isInstancedMesh ? o.boundingSphere : o.geometry.boundingSphere).clone().applyMatrix4(o.matrixWorld);
            if (!fr.intersectsSphere(sp)) return;
          }
          const g = o.geometry;
          const n = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
          const inst = o.isInstancedMesh ? o.count : 1;
          const a = (agg[o.name] ||= { n: 0, tris: 0 });
          a.n++; a.tris += n * inst;
        });
        return Object.entries(agg).sort((x, y) => y[1].tris - x[1].tris).map(([k, v]) => `${k}:${v.n}/${(v.tris / 1000).toFixed(1)}k`).join(' ');
      });
      log(`  in-frustum: ${rows}`);
    }
    if (args.pername) {
      const names = await page.evaluate(() => { const n = new Set(); window.__NS.engine.scene.traverse((o) => { if (/^bd/.test(o.name || '')) n.add(o.name); }); return [...n]; });
      const out = [];
      for (const nm of names) {
        await page.evaluate((nm) => { const h = []; window.__NS.engine.scene.traverse((o) => { if (o.name === nm) { h.push([o, o.layers.mask]); o.layers.disableAll(); } }); window.__bdH = h; }, nm);
        const [c2, t2] = await avg();
        await page.evaluate(() => { for (const [o, m] of window.__bdH) o.layers.mask = m; });
        out.push(`${nm}:${(c1 - c2).toFixed(0)}/${((t1 - t2) / 1000).toFixed(0)}k`);
      }
      log(`  per-name calls/tris: ${out.join(' ')}`);
    }
    log(`s=${s} zone=${zone} frame calls=${c1.toFixed(0)} tris=${(t1 / 1000).toFixed(0)}k | backdrop share calls=${(c1 - c0).toFixed(0)} tris=${((t1 - t0) / 1000).toFixed(0)}k`);
  }
};
