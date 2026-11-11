// Probe (structures agent): triangles / draw calls of the structures meshes per chunk in the real game.
//   node tools/shot.mjs --page "index.html" --script tools/scripts/structures-probe.mjs --label structures --at 3600
export default async ({ page, sleep, log, args }) => {
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
  for (const at of String(args.at || '3600,700').split(',').map(Number)) {
    await page.evaluate((s) => { window.__NS.autopilot(true); window.__NS.teleport(s, 1.85, 20); }, at);
    await sleep(3000);
    const r = await page.evaluate(() => {
      const pre = /^(tunnel-|portal-|approach-|overpass-|pylon-|bridge-|walls-|posts)/;
      const per = new Map();
      window.__NS.engine.scene.traverse((o) => {
        if (!o.isMesh || !pre.test(o.name) || !o.visible) return;
        const g = o.geometry;
        const t = (g.index ? g.index.count : g.attributes.position.count) / 3;
        const inst = o.isInstancedMesh ? o.count : 1;
        const key = o.parent?.uuid?.slice(0, 4) ?? '?';
        const e = per.get(key) || { calls: 0, tris: 0, names: [] };
        e.calls++;
        e.tris += t * inst;
        e.names.push(o.name);
        per.set(key, e);
      });
      return [...per.values()].map((e) => `calls=${e.calls} tris=${Math.round(e.tris)} [${[...new Set(e.names)].join(',')}]`);
    });
    for (const l of r) log(`at ${at}: ${l}`);
  }
};
