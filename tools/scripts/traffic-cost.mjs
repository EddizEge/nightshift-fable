/**
 * Exact traffic render cost in the real game (agent "traffic"): wraps onBeforeRender of every traffic vehicle
 * mesh and counts draws + triangles per frame (all passes: main view, road reflection, env probe, shadows).
 *   node tools/shot.mjs --page "index.html?debug" --script tools/scripts/traffic-cost.mjs --label traffic [--at 700]
 * Phase 1: ambient traffic (default density) at --at.  Phase 2: 4 of each type spawned 25..80 m ahead.
 */
export default async ({ page, sleep, log, args }) => {
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 20000 });
  await page.evaluate(() => {
    const W = window;
    W.__tc = { draws: 0, tris: 0, byType: {}, frames: 0 };
    const tag = new WeakSet();
    W.__tcInstrument = () => {
      for (const v of W.__NS.ctx.traffic.vehicles) {
        v.visual.object.traverse((o) => {
          if (!o.isMesh || tag.has(o)) return;
          tag.add(o);
          const prev = o.onBeforeRender;
          const tris = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
          const type = v.type;
          o.onBeforeRender = function (...a) {
            const c = W.__tc;
            c.draws++; c.tris += tris;
            const b = (c.byType[type] ??= { draws: 0, tris: 0 });
            b.draws++; b.tris += tris;
            return prev.apply(this, a);
          };
        });
      }
    };
    const tick = () => { W.__tc.frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const measure = async (label) => {
    await page.evaluate(() => { window.__tcInstrument(); Object.assign(window.__tc, { draws: 0, tris: 0, byType: {}, frames: 0 }); });
    await sleep(1500);
    const r = await page.evaluate(() => {
      const c = window.__tc;
      const vs = window.__NS.ctx.traffic.vehicles;
      const types = {};
      for (const v of vs) types[v.type] = (types[v.type] ?? 0) + 1;
      return { ...c, n: vs.length, types, st: window.__NS.stats() };
    });
    const f = Math.max(1, r.frames);
    const per = Object.entries(r.byType).map(([t, b]) => `${t}:${(b.draws / f / r.types[t]).toFixed(2)}dc/${Math.round(b.tris / f / r.types[t])}t`).join(' ');
    log(`${label}: vehicles=${r.n} traffic draws/frame=${(r.draws / f).toFixed(1)} traffic tris/frame=${Math.round(r.tris / f)} | frame total calls=${r.st.calls} tris=${r.st.triangles} | per vehicle ${per}`);
  };
  const at = Number(args.at ?? 700);
  await page.evaluate((at) => { const NS = window.__NS; NS.autopilot(true); NS.teleport(at, 1.85, 30); }, at);
  await sleep(4000);
  await measure('ambient');
  for (const type of ['sedan', 'sports', 'boxtruck', 'semi', 'tanker']) {
    await page.evaluate((at) => { const NS = window.__NS; NS.ctx.traffic.setDensity(0); NS.teleport(at, 1.85, 28); }, at);
    await sleep(1500);
    await page.evaluate(([type]) => {
      const NS = window.__NS;
      const ps = NS.game.player.state.s;
      const lanes = [0, 2, 3, 1];
      for (let i = 0; i < 4; i++) NS.ctx.traffic.spawn(type, ps + 25 + i * 18, lanes[i], 28);
    }, [type, at]);
    await sleep(800);
    await measure(`4x ${type}`);
  }
};
